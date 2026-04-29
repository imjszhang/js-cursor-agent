#!/usr/bin/env node
/**
 * cursor-adapter.js — ACPX adapter for Cursor CLI
 *
 * Bridges acpx to Cursor CLI (`agent acp`) JSON-RPC 2.0 protocol.
 * Single-invocation design: reads prompt text from stdin, outputs NDJSON
 * events to stdout, exits when the turn completes.
 *
 * Usage (managed by acpx):
 *   acpx sessions ensure --name cursor-sess --agent "node cursor-adapter.js"
 *   acpx prompt --session cursor-sess --file -   # pipes prompt text to stdin
 *
 * Input  (stdin):  Raw text prompt
 * Output (stdout): NDJSON — { type: "text"|"tool"|"done"|"error", ... }
 *
 * Environment variables:
 *   CURSOR_COMMAND         — CLI command path (default: "agent")
 *   CURSOR_API_KEY         — API key
 *   CURSOR_AUTH_TOKEN      — Auth token
 *   CURSOR_ENDPOINT        — API endpoint
 *   CURSOR_MODEL           — Model (default: "composer-1.5")
 *   CURSOR_PERMISSION_MODE — approve-all|approve-reads|deny-all (default: "approve-all")
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { env, exit, platform, cwd as processCwd } from "node:process";

// ── Config ───────────────────────────────────────────────────────────

const config = {
  command: env.CURSOR_COMMAND || "agent",
  apiKey: env.CURSOR_API_KEY || "",
  authToken: env.CURSOR_AUTH_TOKEN || "",
  endpoint: env.CURSOR_ENDPOINT || "",
  model: env.CURSOR_MODEL || "composer-1.5",
  permissionMode: env.CURSOR_PERMISSION_MODE || "approve-all",
  cwd: processCwd(),
};

// ── Auth args ────────────────────────────────────────────────────────

function buildAuthArgs() {
  const args = [];
  if (config.endpoint) args.push("-e", config.endpoint);
  args.push("--model", config.model);
  if (config.apiKey) { args.push("--api-key", config.apiKey); return args; }
  if (config.authToken) { args.push("--auth-token", config.authToken); return args; }
  return args;
}

// ── JSON-RPC Transport ──────────────────────────────────────────────

class JsonRpcTransport {
  #child;
  #nextId = 1;
  #pending = new Map();
  #notificationHandlers = new Map();
  #requestHandlers = new Map();
  #closed = false;

  constructor(child) {
    this.#child = child;
    this.#wireStdout();
    this.#wireExit();
  }

  send(method, params, opts = {}) {
    return new Promise((resolve, reject) => {
      if (this.#closed) { reject(new Error(`transport closed: ${method}`)); return; }
      const id = this.#nextId++;
      const timeoutMs = opts.timeoutMs ?? 86_400_000;
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`JSON-RPC ${method} (id=${id}) timed out`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      this.#write({ jsonrpc: "2.0", id, method, params });
    });
  }

  respond(id, result) { this.#write({ jsonrpc: "2.0", id, result }); }
  respondError(id, message, code = -1) { this.#write({ jsonrpc: "2.0", id, error: { code, message } }); }

  onNotification(method, handler) {
    let list = this.#notificationHandlers.get(method);
    if (!list) { list = []; this.#notificationHandlers.set(method, list); }
    list.push(handler);
  }

  offNotification(method, handler) {
    const list = this.#notificationHandlers.get(method);
    if (list) { const idx = list.indexOf(handler); if (idx !== -1) list.splice(idx, 1); }
  }

  onRequest(method, handler) { this.#requestHandlers.set(method, handler); }

  get closed() { return this.#closed; }

  #write(msg) {
    if (this.#closed) return;
    try { this.#child.stdin.write(JSON.stringify(msg) + "\n"); } catch { /* stdin closed */ }
  }

  #wireStdout() {
    if (!this.#child.stdout) return;
    const rl = createInterface({ input: this.#child.stdout });
    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let msg;
      try { msg = JSON.parse(trimmed); } catch { return; }
      this.#dispatch(msg);
    });
  }

  #wireExit() {
    this.#child.on("exit", (code) => { this.#teardown(`child exited with code ${code ?? "unknown"}`); });
    this.#child.on("error", (err) => { this.#teardown(`child error: ${err.message}`); });
  }

  #dispatch(msg) {
    // Response to our request
    if (msg.id != null && (msg.result !== undefined || msg.error !== undefined)) {
      const entry = this.#pending.get(msg.id);
      if (!entry) return;
      this.#pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.error) entry.reject(new Error(msg.error.message ?? "unknown error"));
      else entry.resolve(msg.result);
      return;
    }
    // Server-initiated request (has id + method)
    if (msg.id != null && msg.method) {
      const handler = this.#requestHandlers.get(msg.method);
      if (handler) {
        Promise.resolve().then(() => handler(msg.params))
          .then((result) => this.respond(msg.id, result))
          .catch((err) => this.respondError(msg.id, String(err?.message ?? err)));
      } else {
        this.respondError(msg.id, `unhandled request: ${msg.method}`, -32601);
      }
      return;
    }
    // Notification
    if (msg.method) {
      const handlers = this.#notificationHandlers.get(msg.method);
      if (handlers) { for (const fn of handlers) { try { fn(msg.params); } catch { /* swallow */ } } }
    }
  }

  #teardown(reason) {
    if (this.#closed) return;
    this.#closed = true;
    for (const [, entry] of this.#pending) { clearTimeout(entry.timer); entry.reject(new Error(`transport: ${reason}`)); }
    this.#pending.clear();
  }

  destroy() { this.#teardown("destroyed"); }
}

// ── Permission auto-approval ────────────────────────────────────────

function resolvePermission(params, mode) {
  const action = (params?.permission?.action || "").toLowerCase();
  if (mode === "approve-all") return { approved: true };
  if (mode === "deny-all") return { approved: false };
  // approve-reads: approve reads, deny writes/exec
  const isRead = action.includes("read") || action.includes("view") || action.includes("get");
  return { approved: isRead };
}

// ── Spawn Cursor CLI ────────────────────────────────────────────────

function spawnCursor() {
  const authArgs = buildAuthArgs();
  const args = [...authArgs, "acp"];
  let cmd = config.command;
  let cmdArgs = args;
  if (platform === "win32" && /\.(cmd|bat)$/i.test(cmd)) {
    cmd = "cmd";
    cmdArgs = ["/c", config.command, ...args];
  }
  return spawn(cmd, cmdArgs, { stdio: ["pipe", "pipe", "inherit"], cwd: config.cwd });
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  // 1. Read entire prompt from stdin
  const rl = createInterface({ input: process.stdin });
  const lines = [];
  for await (const line of rl) { lines.push(line); }
  const promptText = lines.join("\n");

  if (!promptText.trim()) {
    process.stdout.write(JSON.stringify({ type: "error", message: "empty prompt" }) + "\n");
    exit(0);
  }

  // 2. Spawn Cursor CLI
  const child = spawnCursor();
  child.stdin.on("error", () => { /* EPIPE */ });
  const transport = new JsonRpcTransport(child);

  // Wire permission requests
  transport.onRequest("session/request_permission", (params) => {
    return resolvePermission(params, config.permissionMode);
  });

  // Handle cancellation signals
  let cancelled = false;
  process.on("SIGTERM", async () => {
    cancelled = true;
    try {
      if (sessionId) await transport.send("session/cancel", { sessionId });
    } catch {}
    transport.destroy();
    child.kill();
    exit(1);
  });
  process.on("SIGINT", () => process.emit("SIGTERM"));

  // 3. Handshake
  await transport.send("initialize", {
    protocolVersion: 1,
    clientCapabilities: {
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
    },
    clientInfo: { name: "cursor-adapter", version: "1.0.0" },
  });

  // 4. Auth (may fail if using pre-login, continue anyway)
  try { await transport.send("authenticate", { methodId: "cursor_login" }); } catch {}

  // 5. Create session
  const newResult = await transport.send("session/new", {
    cwd: config.cwd,
    mcpServers: [],
  });
  const sessionId = newResult?.sessionId;
  if (!sessionId) {
    process.stdout.write(JSON.stringify({ type: "error", message: "session/new returned no sessionId" }) + "\n");
    exit(1);
  }

  // 6. Send prompt and stream events
  const events = [];
  let promptDone = false;

  const updateHandler = (params) => {
    const update = params?.update;
    if (!update) return;
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        if (update.content?.type === "text" && update.content.text) {
          events.push({ type: "text", text: update.content.text });
        }
        break;
      case "tool_call":
        events.push({
          type: "tool",
          name: update.title ?? "unknown",
          status: update.status ?? "call",
          toolCallId: update.toolCallId,
        });
        break;
      case "tool_call_update":
        if (update.status) {
          events.push({ type: "tool", name: update.toolCallId ?? "unknown", status: update.status });
        }
        break;
      case "agent_thought_chunk":
        if (update.content?.type === "text" && update.content.text) {
          events.push({ type: "text", text: update.content.text });
        }
        break;
    }
  };

  transport.onNotification("session/update", updateHandler);

  const promptPromise = transport.send("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text: promptText }],
  });

  promptPromise
    .then((result) => {
      events.push({ type: "done", stopReason: result?.stopReason ?? "stop" });
      promptDone = true;
    })
    .catch((err) => {
      if (!cancelled) {
        events.push({ type: "error", message: err.message });
      }
      promptDone = true;
    });

  // 7. Yield events as they arrive
  let lastIdx = 0;
  while (!promptDone || lastIdx < events.length) {
    if (lastIdx < events.length) {
      process.stdout.write(JSON.stringify(events[lastIdx++]) + "\n");
    } else {
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  transport.offNotification("session/update", updateHandler);
  transport.destroy();
  try { child.kill(); } catch {}

  exit(0);
}

main().catch((err) => {
  process.stderr.write(`[cursor-adapter] fatal: ${err.message}\n`);
  exit(1);
});
