/**
 * JSON-RPC 2.0 transport over a child process's stdin/stdout (NDJSON).
 *
 * Handles request-response pairing, server-to-client requests, and
 * notification dispatch — all multiplexed on a single stdio stream.
 */

import { createInterface } from 'node:readline';

const DEFAULT_REQUEST_TIMEOUT_MS = 86_400_000; // 24 hours

export class JsonRpcTransport {
  #child;
  #nextId = 1;
  /** @type {Map<number, {resolve: Function, reject: Function, timer: ReturnType<typeof setTimeout>}>} */
  #pending = new Map();
  /** @type {Map<string, Function[]>} */
  #notificationHandlers = new Map();
  /** @type {Map<string, Function>} */
  #requestHandlers = new Map();
  #closed = false;
  #log;

  /**
   * @param {import('node:child_process').ChildProcess} child
   * @param {{ log?: Function }} [opts]
   */
  constructor(child, opts = {}) {
    this.#child = child;
    this.#log = opts.log ?? (() => {});
    this.#wireStdout();
    this.#wireExit();
  }

  // ── outgoing ───────────────────────────────────────────────────────

  /**
   * Send a JSON-RPC request and wait for the response.
   * @param {string} method
   * @param {unknown} [params]
   * @param {{ timeoutMs?: number }} [opts]
   * @returns {Promise<unknown>}
   */
  send(method, params, opts = {}) {
    return new Promise((resolve, reject) => {
      if (this.#closed) {
        reject(new Error(`transport closed, cannot send ${method}`));
        return;
      }
      const id = this.#nextId++;
      const timeoutMs = opts.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`JSON-RPC request ${method} (id=${id}) timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.#pending.set(id, { resolve, reject, timer });
      this.#write({ jsonrpc: '2.0', id, method, params });
    });
  }

  /**
   * Respond to a server-initiated request.
   * @param {number|string} id
   * @param {unknown} result
   */
  respond(id, result) {
    this.#write({ jsonrpc: '2.0', id, result });
  }

  /**
   * Respond to a server-initiated request with an error.
   * @param {number|string} id
   * @param {{ code?: number, message: string }} error
   */
  respondError(id, error) {
    this.#write({ jsonrpc: '2.0', id, error: { code: error.code ?? -1, message: error.message } });
  }

  // ── incoming ───────────────────────────────────────────────────────

  /**
   * Register a handler for notifications (no `id` in the message).
   * Multiple handlers per method are supported.
   * @param {string} method
   * @param {(params: unknown) => void} handler
   */
  onNotification(method, handler) {
    let list = this.#notificationHandlers.get(method);
    if (!list) {
      list = [];
      this.#notificationHandlers.set(method, list);
    }
    list.push(handler);
  }

  /**
   * Remove a previously registered notification handler.
   * @param {string} method
   * @param {Function} handler
   */
  offNotification(method, handler) {
    const list = this.#notificationHandlers.get(method);
    if (!list) return;
    const idx = list.indexOf(handler);
    if (idx !== -1) list.splice(idx, 1);
  }

  /**
   * Register a handler for server-initiated requests (has `id`, expects response).
   * Only one handler per method; last registration wins.
   * The handler return value is sent back as the result.
   * @param {string} method
   * @param {(params: unknown) => unknown | Promise<unknown>} handler
   */
  onRequest(method, handler) {
    this.#requestHandlers.set(method, handler);
  }

  /** Whether the transport has been closed. */
  get closed() {
    return this.#closed;
  }

  /** Forcefully close the transport (kills pending requests). */
  destroy() {
    this.#teardown('transport destroyed');
  }

  // ── internals ──────────────────────────────────────────────────────

  #write(msg) {
    if (this.#closed) return;
    try {
      this.#child.stdin.write(JSON.stringify(msg) + '\n');
    } catch {
      // stdin may already be closed
    }
  }

  #wireStdout() {
    if (!this.#child.stdout) return;
    const rl = createInterface({ input: this.#child.stdout });
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let msg;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        this.#log(`[jsonrpc] unparseable line: ${trimmed.slice(0, 200)}`);
        return;
      }
      this.#dispatch(msg);
    });
  }

  #wireExit() {
    this.#child.on('exit', (code) => {
      this.#teardown(`process exited with code ${code ?? 'unknown'}`);
    });
    this.#child.on('error', (err) => {
      this.#teardown(`process error: ${err.message}`);
    });
  }

  #dispatch(msg) {
    // Response to our request
    if (msg.id != null && (msg.result !== undefined || msg.error !== undefined)) {
      const entry = this.#pending.get(msg.id);
      if (!entry) return;
      this.#pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.error) {
        entry.reject(new JsonRpcError(msg.error.message ?? 'unknown error', msg.error.code));
      } else {
        entry.resolve(msg.result);
      }
      return;
    }

    // Server-initiated request (has id + method, expects response)
    if (msg.id != null && msg.method) {
      const handler = this.#requestHandlers.get(msg.method);
      if (handler) {
        Promise.resolve()
          .then(() => handler(msg.params))
          .then((result) => this.respond(msg.id, result))
          .catch((err) => this.respondError(msg.id, { message: String(err?.message ?? err) }));
      } else {
        this.respondError(msg.id, { code: -32601, message: `unhandled request: ${msg.method}` });
      }
      return;
    }

    // Notification (no id, has method)
    if (msg.method) {
      const handlers = this.#notificationHandlers.get(msg.method);
      if (handlers) {
        for (const fn of handlers) {
          try { fn(msg.params); } catch { /* swallow */ }
        }
      }
      return;
    }
  }

  #teardown(reason) {
    if (this.#closed) return;
    this.#closed = true;
    for (const [id, entry] of this.#pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(`JSON-RPC transport closed: ${reason}`));
    }
    this.#pending.clear();
  }
}

export class JsonRpcError extends Error {
  /** @param {string} message @param {number} [code] */
  constructor(message, code) {
    super(message);
    this.name = 'JsonRpcError';
    this.code = code;
  }
}
