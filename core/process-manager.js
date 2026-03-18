/**
 * Long-lived Cursor `agent acp` process pool.
 *
 * Each ACP session maps to a dedicated child process.  Processes are
 * reused by sessionKey, reclaimed after idle timeout, and capped by a
 * concurrency limit.
 */

import { spawn } from 'node:child_process';
import { JsonRpcTransport } from './jsonrpc.js';
import { resolveAuthArgs } from './auth.js';
import { resolvePermission } from './permissions.js';
import { registerCursorExtensions } from './cursor-extensions.js';

/**
 * @typedef {object} ManagedProcess
 * @property {import('node:child_process').ChildProcess} child
 * @property {JsonRpcTransport} transport
 * @property {string} sessionKey
 * @property {number} lastActivity  epoch ms
 * @property {boolean} initialized  whether ACP initialize handshake is done
 */

export class ProcessManager {
  /** @type {Map<string, ManagedProcess>} */
  #pool = new Map();
  #config;
  #log;
  /** @type {ReturnType<typeof setInterval>|null} */
  #reapTimer = null;

  /**
   * @param {import('./config.js').ResolvedConfig} config
   * @param {{ log?: Function }} [opts]
   */
  constructor(config, opts = {}) {
    this.#config = config;
    this.#log = opts.log ?? (() => {});
    this.#startReaper();
  }

  /**
   * Get an existing process for the given sessionKey, or spawn a new one.
   * @param {string} sessionKey
   * @param {{ cwd?: string }} [opts]
   * @returns {Promise<ManagedProcess>}
   */
  async getOrSpawn(sessionKey, opts = {}) {
    const existing = this.#pool.get(sessionKey);
    if (existing && !existing.transport.closed) {
      existing.lastActivity = Date.now();
      return existing;
    }

    if (this.#pool.size >= this.#config.maxSessions) {
      // Evict the oldest idle process
      this.#evictOldest();
      if (this.#pool.size >= this.#config.maxSessions) {
        throw new Error(
          `Max concurrent Cursor agent sessions (${this.#config.maxSessions}) reached. Close a session first.`,
        );
      }
    }

    return this.#spawn(sessionKey, opts);
  }

  /**
   * Get an existing managed process (or null).
   * @param {string} sessionKey
   * @returns {ManagedProcess|null}
   */
  get(sessionKey) {
    const entry = this.#pool.get(sessionKey);
    if (entry && !entry.transport.closed) {
      return entry;
    }
    return null;
  }

  /** @returns {Map<string, ManagedProcess>} */
  list() {
    // Clean dead entries first
    for (const [key, entry] of this.#pool) {
      if (entry.transport.closed) this.#pool.delete(key);
    }
    return new Map(this.#pool);
  }

  /**
   * Kill and remove a session's process.
   * @param {string} sessionKey
   */
  kill(sessionKey) {
    const entry = this.#pool.get(sessionKey);
    if (!entry) return;
    this.#pool.delete(sessionKey);
    this.#killChild(entry);
    this.#log(`[process-manager] killed session "${sessionKey}"`);
  }

  /** Kill all managed processes. */
  killAll() {
    for (const [key, entry] of this.#pool) {
      this.#killChild(entry);
    }
    this.#pool.clear();
    if (this.#reapTimer) {
      clearInterval(this.#reapTimer);
      this.#reapTimer = null;
    }
  }

  // ── internals ──────────────────────────────────────────────────────

  /**
   * @param {string} sessionKey
   * @param {{ cwd?: string }} opts
   * @returns {Promise<ManagedProcess>}
   */
  async #spawn(sessionKey, opts) {
    const authArgs = resolveAuthArgs(this.#config);
    const cwd = opts.cwd || process.cwd();

    const args = [...authArgs, 'acp'];

    this.#log(`[process-manager] spawning: ${this.#config.command} ${args.join(' ')}`);

    const child = spawn(this.#config.command, args, {
      stdio: ['pipe', 'pipe', 'inherit'],
      cwd,
      env: { ...process.env },
    });

    child.stdin.on('error', () => {
      // Ignore EPIPE if child exits before stdin flush
    });

    const transport = new JsonRpcTransport(child, { log: this.#log });

    // Wire permission auto-handler
    transport.onRequest('session/request_permission', (params) => {
      return resolvePermission(params, this.#config.permissionMode, { log: this.#log });
    });

    // Wire Cursor extension methods
    registerCursorExtensions(transport, { log: this.#log });

    const entry = {
      child,
      transport,
      sessionKey,
      lastActivity: Date.now(),
      initialized: false,
    };

    this.#pool.set(sessionKey, entry);

    // Auto-cleanup on exit
    child.on('exit', () => {
      this.#pool.delete(sessionKey);
      this.#log(`[process-manager] process for "${sessionKey}" exited`);
    });

    return entry;
  }

  /** @param {ManagedProcess} entry */
  #killChild(entry) {
    entry.transport.destroy();
    try { entry.child.kill(); } catch { /* already dead */ }
  }

  #evictOldest() {
    let oldest = null;
    let oldestKey = null;
    for (const [key, entry] of this.#pool) {
      if (!oldest || entry.lastActivity < oldest.lastActivity) {
        oldest = entry;
        oldestKey = key;
      }
    }
    if (oldestKey) {
      this.kill(oldestKey);
    }
  }

  #startReaper() {
    const intervalMs = 60_000; // check every minute
    this.#reapTimer = setInterval(() => {
      const ttlMs = this.#config.idleTtlMinutes * 60_000;
      const now = Date.now();
      for (const [key, entry] of this.#pool) {
        if (entry.transport.closed) {
          this.#pool.delete(key);
          continue;
        }
        if (now - entry.lastActivity > ttlMs) {
          this.#log(`[process-manager] reaping idle session "${key}"`);
          this.kill(key);
        }
      }
    }, intervalMs);
    // Don't keep the Node process alive just for the reaper
    if (this.#reapTimer.unref) this.#reapTimer.unref();
  }
}
