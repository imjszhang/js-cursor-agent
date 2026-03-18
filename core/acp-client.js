/**
 * High-level ACP client — business-semantic operations over Cursor `agent acp`.
 *
 * Wraps ProcessManager + JsonRpcTransport into createSession / prompt / cancel
 * / setMode / close / doctor primitives shared by CLI, MCP Server, and
 * OpenClaw plugin.
 */

import { ProcessManager } from './process-manager.js';
import { checkAuthStatus } from './auth.js';
import { resolveConfig } from './config.js';

const ACP_PROTOCOL_VERSION = 1;
const CLIENT_INFO = { name: 'js-cursor-agent', version: '1.0.0' };
const CLIENT_CAPABILITIES = {
  fs: { readTextFile: false, writeTextFile: false },
  terminal: false,
};

/**
 * @typedef {object} SessionHandle
 * @property {string} sessionKey
 * @property {string} sessionId
 */

export class CursorAcpClient {
  #pm;
  #config;
  #log;
  /** @type {Map<string, SessionHandle>} */
  #sessions = new Map();

  /**
   * @param {import('./config.js').ResolvedConfig} [config]
   * @param {{ log?: Function }} [opts]
   */
  constructor(config, opts = {}) {
    this.#config = config ?? resolveConfig();
    this.#log = opts.log ?? (() => {});
    this.#pm = new ProcessManager(this.#config, { log: this.#log });
  }

  /**
   * Create (or reconnect to) an ACP session.
   * @param {string} sessionKey
   * @param {{ cwd?: string, mode?: string }} [opts]
   * @returns {Promise<SessionHandle>}
   */
  async createSession(sessionKey, opts = {}) {
    const cwd = opts.cwd || process.cwd();
    const mode = opts.mode || this.#config.defaultMode;
    const entry = await this.#pm.getOrSpawn(sessionKey, { cwd });

    // Initialize handshake (only once per process)
    if (!entry.initialized) {
      await entry.transport.send('initialize', {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: CLIENT_CAPABILITIES,
        clientInfo: CLIENT_INFO,
      });

      // Authenticate
      try {
        await entry.transport.send('authenticate', { methodId: 'cursor_login' });
      } catch {
        // Some setups (api-key / auth-token) may not need explicit auth
        this.#log('[acp-client] authenticate skipped or already done');
      }

      entry.initialized = true;
    }

    // Create a new session
    const result = await entry.transport.send('session/new', {
      cwd,
      mcpServers: [],
    });

    const sessionId = result?.sessionId;
    if (!sessionId) {
      throw new Error('session/new did not return a sessionId');
    }

    // Set initial mode if not default
    if (mode !== 'agent') {
      try {
        await entry.transport.send('session/set_mode', {
          sessionId,
          mode: { id: mode },
        });
      } catch {
        this.#log(`[acp-client] set_mode to "${mode}" failed, continuing with default`);
      }
    }

    entry.lastActivity = Date.now();
    const handle = { sessionKey, sessionId };
    this.#sessions.set(sessionKey, handle);
    return handle;
  }

  /**
   * Return an existing session handle, or create a new one if none exists.
   * This is the primary method for multi-turn conversation support.
   * @param {string} sessionKey
   * @param {{ cwd?: string, mode?: string }} [opts]
   * @returns {Promise<SessionHandle>}
   */
  async getOrCreateSession(sessionKey, opts = {}) {
    const cached = this.#sessions.get(sessionKey);
    if (cached) {
      const entry = this.#pm.get(sessionKey);
      if (entry && !entry.transport.closed) {
        entry.lastActivity = Date.now();
        return cached;
      }
      this.#sessions.delete(sessionKey);
    }
    return this.createSession(sessionKey, opts);
  }

  /**
   * Send a prompt and yield streaming events.
   *
   * @param {SessionHandle} handle
   * @param {string} text
   * @param {{ signal?: AbortSignal }} [opts]
   * @returns {AsyncGenerator<AcpEvent>}
   */
  async *prompt(handle, text, opts = {}) {
    const entry = this.#pm.get(handle.sessionKey);
    if (!entry) {
      throw new Error(`No active process for session "${handle.sessionKey}"`);
    }

    entry.lastActivity = Date.now();

    // Collect streaming events via a queue
    const queue = [];
    let queueResolve = null;
    let done = false;

    const push = (event) => {
      queue.push(event);
      if (queueResolve) {
        queueResolve();
        queueResolve = null;
      }
    };

    // Listen for session/update notifications
    const updateHandler = (params) => {
      const update = params?.update;
      if (!update) return;

      switch (update.sessionUpdate) {
        case 'agent_message_chunk':
          if (update.content?.type === 'text' && update.content.text) {
            push({ type: 'text_delta', text: update.content.text });
          }
          break;
        case 'tool_call':
          push({
            type: 'tool_call',
            text: update.title ?? 'tool',
            toolCallId: update.toolCallId,
            status: update.status,
            title: update.title,
          });
          break;
        case 'tool_call_update':
          if (update.status) {
            push({
              type: 'status',
              text: `${update.toolCallId ?? 'tool'}: ${update.status}`,
            });
          }
          break;
        case 'agent_thought_chunk':
          if (update.content?.type === 'text' && update.content.text) {
            push({ type: 'text_delta', text: update.content.text, stream: 'thought' });
          }
          break;
        default:
          break;
      }
    };

    entry.transport.onNotification('session/update', updateHandler);

    // Handle abort
    const abortHandler = () => {
      this.cancel(handle).catch(() => {});
    };
    if (opts.signal) {
      if (opts.signal.aborted) {
        entry.transport.offNotification('session/update', updateHandler);
        await this.cancel(handle).catch(() => {});
        return;
      }
      opts.signal.addEventListener('abort', abortHandler, { once: true });
    }

    // Send prompt (this blocks until the turn completes)
    const promptPromise = entry.transport.send('session/prompt', {
      sessionId: handle.sessionId,
      prompt: [{ type: 'text', text }],
    });

    // Yield events as they arrive while waiting for prompt to resolve
    promptPromise
      .then((result) => {
        push({ type: 'done', stopReason: result?.stopReason ?? 'stop' });
        done = true;
      })
      .catch((err) => {
        push({ type: 'error', message: err.message });
        done = true;
      });

    while (!done || queue.length > 0) {
      if (queue.length > 0) {
        yield queue.shift();
      } else {
        await new Promise((r) => { queueResolve = r; });
      }
    }

    entry.transport.offNotification('session/update', updateHandler);

    if (opts.signal) {
      opts.signal.removeEventListener('abort', abortHandler);
    }

    entry.lastActivity = Date.now();
  }

  /**
   * Cancel the current turn.
   * @param {SessionHandle} handle
   */
  async cancel(handle) {
    const entry = this.#pm.get(handle.sessionKey);
    if (!entry) return;
    try {
      await entry.transport.send('session/cancel', {
        sessionId: handle.sessionId,
      });
    } catch {
      this.#log(`[acp-client] cancel failed for "${handle.sessionKey}"`);
    }
  }

  /**
   * Set the session mode (agent / plan / ask).
   * @param {SessionHandle} handle
   * @param {string} mode
   */
  async setMode(handle, mode) {
    const entry = this.#pm.get(handle.sessionKey);
    if (!entry) throw new Error(`No active process for session "${handle.sessionKey}"`);
    await entry.transport.send('session/set_mode', {
      sessionId: handle.sessionId,
      mode: { id: mode },
    });
  }

  /**
   * Close a session and kill its process.
   * @param {string} sessionKey
   */
  close(sessionKey) {
    this.#sessions.delete(sessionKey);
    this.#pm.kill(sessionKey);
  }

  /** List active sessions. */
  listSessions() {
    const result = [];
    for (const [key, entry] of this.#pm.list()) {
      const cached = this.#sessions.get(key);
      result.push({
        sessionKey: key,
        sessionId: cached?.sessionId ?? null,
        alive: !entry.transport.closed,
        lastActivity: entry.lastActivity,
        initialized: entry.initialized,
      });
    }
    return result;
  }

  /**
   * Diagnose Cursor CLI availability and auth status.
   * @returns {Promise<{ ok: boolean, message: string, details?: string[] }>}
   */
  async doctor() {
    const details = [];
    const auth = await checkAuthStatus(this.#config);
    details.push(auth.message);
    details.push(`Command: ${this.#config.command}`);
    if (this.#config.model) {
      details.push(`Model: ${this.#config.model}`);
    }
    details.push(`Default mode: ${this.#config.defaultMode}`);
    details.push(`Permission mode: ${this.#config.permissionMode}`);
    details.push(`Max sessions: ${this.#config.maxSessions}`);
    details.push(`Idle TTL: ${this.#config.idleTtlMinutes} min`);
    details.push(`Active sessions: ${this.#pm.list().size}`);
    return {
      ok: auth.ok,
      message: auth.ok ? 'Cursor CLI is reachable and configured.' : auth.message,
      details,
    };
  }

  /** Kill all processes. */
  shutdown() {
    this.#sessions.clear();
    this.#pm.killAll();
  }
}

/**
 * @typedef {object} AcpEvent
 * @property {string} type  text_delta | tool_call | status | done | error
 * @property {string} [text]
 * @property {string} [stream]
 * @property {string} [toolCallId]
 * @property {string} [status]
 * @property {string} [title]
 * @property {string} [stopReason]
 * @property {string} [message]
 */
