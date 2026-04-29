# Create cursor-adapter.js — ACPX → Cursor CLI Bridge

## Context

We're building an adapter that lets OpenClaw's **acpx** backend drive **Cursor CLI** (`agent acp`) as a coding harness. This means Cursor will appear as a first-class agent in acpx's `allowedAgents` list, alongside codex, claude, gemini, etc.

## Architecture

```
acpx CLI ──stdin/stdout (text prompt in, NDJSON events out)──→ cursor-adapter.js ──JSON-RPC 2.0 NDJSON──→ agent acp
```

acpx calls this adapter via: `node cursor-adapter.js --cwd /path/to/repo`

acpx sends:
- The prompt text via stdin
- Expects NDJSON output on stdout with specific event types

## Reference: Cursor CLI Protocol (from js-cursor-agent/core/)

The existing js-cursor-agent project already has all the Cursor CLI integration code. Read these files for the exact protocol details:

- `D:\github\My\js-cursor-agent\core\acp-client.js` — High-level ACP client (createSession, prompt, cancel, setMode)
- `D:\github\My\js-cursor-agent\core\process-manager.js` — Long-lived process pool (spawn `agent acp`, manage lifecycle)
- `D:\github\My\js-cursor-agent\core\jsonrpc.js` — JSON-RPC 2.0 transport over NDJSON stdio
- `D:\github\My\js-cursor-agent\core\auth.js` — Auth arg resolution (`--api-key`, `--auth-token`, `--model`, `-e`)
- `D:\github\My\js-cursor-agent\core\permissions.js` — Permission auto-approval logic
- `D:\github\My\js-cursor-agent\core\cursor-extensions.js` — Cursor extension methods
- `D:\github\My\js-cursor-agent\core\config.js` — Config resolution (env vars, defaults)

### Key Cursor CLI JSON-RPC methods:

**Client → Server:**
- `initialize` — Handshake with protocolVersion, clientCapabilities, clientInfo
- `authenticate` — Auth with methodId: "cursor_login"
- `session/new` — Create session, params: { cwd, mcpServers: [] }
- `session/prompt` — Send prompt, params: { sessionId, prompt: [{ type: "text", text }] }
- `session/cancel` — Cancel, params: { sessionId }
- `session/set_mode` — Set mode, params: { sessionId, mode: { id: "agent"|"plan"|"ask" } }

**Server → Client (notifications):**
- `session/update` — Streaming events with `update.sessionUpdate`:
  - `"agent_message_chunk"` — Text output (update.content.text)
  - `"tool_call"` — Tool execution events
  - `"tool_call_update"` — Tool status updates
  - `"agent_thought_chunk"` — Thinking text (update.content.text)
- `session/request_permission` — Server-initiated request (has id, expects response)

### Cursor CLI spawn command:

```bash
agent acp [--api-key KEY | --auth-token TOKEN] [--model MODEL] [-e ENDPOINT]
```

On Windows, if the command is a .cmd/.bat, run via `cmd /c`.

## What acpx expects from an agent

acpx spawns the agent with: `acpx prompt --session <name> --file -` (reads prompt from stdin)

It expects NDJSON output on stdout with these event types:
- `{ type: "text", text: "..." }` — Text output
- `{ type: "tool", name: "...", status: "call"|"result", ... }` — Tool events  
- `{ type: "done" }` — Turn completed
- `{ type: "error", message: "..." }` — Error

acpx also sends control commands via separate invocations:
- `acpx cancel --session <name>` — Cancel current turn
- `acpx sessions close <name>` — Close session
- `acpx set-mode <mode> --session <name>` — Set mode
- `acpx status --session <name>` — Get session status

## The adapter needs to:

1. **Parse acpx CLI args** (from the `--agent` command line): `--cwd`, `--session`, mode info
2. **Manage a persistent `agent acp` process** — spawn once, reuse across turns (process pooling)
3. **Translate acpx stdin prompt → Cursor JSON-RPC `session/prompt`**
4. **Translate Cursor `session/update` notifications → acpx NDJSON output events**
5. **Handle Cursor's `session/request_permission`** — auto-approve based on env var or default
6. **Handle acpx control commands** (cancel, close, status, set-mode) via separate process invocations
7. **Process lifecycle** — detect exit, auto-restart if needed, idle timeout

## Session storage

Since acpx calls the adapter as a separate process for each turn, we need external session state. Use a simple file-based approach:
- Store active process PIDs and session IDs in a temp directory
- Use the session name (from `--session` or env) as the key
- On new invocation, check if process exists and is alive

OR: Run as a long-lived server that acpx communicates with. acpx supports `--agent` with a command that stays running.

Actually, looking at how acpx works more carefully:
- `acpx sessions ensure --name <name> --agent <command>` — creates a named session
- `acpx prompt --session <name> --file -` — sends prompt to that session

So the `--agent` command is used during `sessions ensure` to bootstrap, and then acpx manages the session lifecycle. The agent process should stay alive as long as the session is active.

## Design: Long-lived daemon approach

The adapter runs as a long-lived process. When acpx calls `sessions ensure --agent "node cursor-adapter.js"`, it spawns the adapter. The adapter:
1. Spawns `agent acp` as a child process
2. Does JSON-RPC initialize + authenticate handshake
3. Stays alive, reading commands from its own stdin
4. Translates between acpx protocol and Cursor JSON-RPC

But acpx's agent model may not support persistent bidirectional communication. Let me look at what acpx actually does with `--agent`.

From the acpx source code (runtime-internals/mcp-agent-command.js), the `--agent` flag creates an MCP proxy command. The actual agent process is managed by acpx itself.

**Simpler approach**: The adapter is a standalone script that acpx calls directly. acpx will:
1. `sessions ensure` — the adapter creates the Cursor session
2. `prompt` — acpx sends text to the session, reads NDJSON output

Since acpx manages session lifecycle, the adapter just needs to:
- When invoked, check if there's already an active Cursor process for this session
- If yes, send the prompt to it and relay output
- If no, spawn a new `agent acp` process

Use a simple IPC mechanism: Unix domain socket or named pipe per session, or just keep the process running and use a control file.

**Simplest approach for Windows**: Use a long-lived adapter process that:
1. On first invocation: spawns `agent acp`, writes PID + sessionId to a state file
2. On subsequent invocations: reads the state file, sends prompt to the running process via stdin (using a different channel), waits for output

Actually the cleanest approach is to use **node-ipc** or simple **TCP sockets** for inter-process communication, but that adds dependencies.

**Even simpler**: The adapter IS the long-lived process. When acpx spawns it via `--agent`, it stays alive. acpx communicates with it through its managed session infrastructure.

Let me take the most pragmatic approach:

## Final Design: Self-contained adapter

`cursor-adapter.js` — A single Node.js script (no external dependencies) that:

1. **Mode 1: Bootstrap** (called by `acpx sessions ensure --agent "node cursor-adapter.js"`)
   - Spawn `agent acp` child process
   - Do JSON-RPC initialize + authenticate
   - Create session via `session/new`
   - Write PID and sessionId to a state file (`%TEMP%/cursor-sessions/<sessionName>.json`)
   - Keep the `agent acp` process alive in the background (detached)
   - Exit with success

2. **Mode 2: Prompt** (called by acpx prompt flow)
   - Read state file to find the running `agent acp` process
   - Read prompt text from stdin
   - Send `session/prompt` via stdin to the running process
   - Listen for `session/update` notifications on stdout
   - Translate to acpx NDJSON format and write to stdout
   - On done/error, exit

Wait, this doesn't work because stdin/stdout are already used by acpx.

**Correct design**: The adapter is a **single long-lived process** that acpx manages. When acpx calls `sessions ensure --agent <command>`, it spawns the adapter and keeps it alive. acpx then communicates with this process.

But acpx's agent communication model is: the agent process runs, receives a prompt (via stdin or file), produces output (stdout), and exits. For persistent sessions, acpx has its own session management.

Let me just write a clean adapter that works with the acpx model:

The adapter acts as a **proxy agent**. acpx sees it as a regular agent. The adapter internally manages the Cursor CLI process.

Key insight: acpx's `runTurn` in runtime.ts spawns the agent command with the prompt piped to stdin. The agent's stdout is parsed as NDJSON events.

So the adapter should:
1. Accept prompt text on stdin
2. Spawn/reuse `agent acp` process
3. Send JSON-RPC `session/prompt`
4. Relay `session/update` events as acpx NDJSON
5. Exit when done

For session persistence across turns, use a background daemon that the adapter connects to, or use the `agent acp` process's ability to handle multiple prompts.

**Simplest working design**: Single adapter that manages a persistent `agent acp` process using Node.js IPC. On each invocation:
- Check if daemon is running (via PID file)
- If not, start daemon
- Send prompt to daemon via TCP/pipe
- Daemon sends prompt to `agent acp` via JSON-RPC
- Daemon streams output back

Actually, let me just write it as a single file that keeps the `agent acp` process alive across invocations by not exiting. The adapter:

1. On start: spawns `agent acp`, does handshake, creates session
2. Reads prompt from stdin (one JSON object: `{ type: "prompt", text: "..." }`)
3. Sends `session/prompt` to Cursor
4. Streams events to stdout as NDJSON
5. After done, goes back to step 2 (loop)
6. On stdin EOF or `{ type: "close" }`: clean up and exit

This way acpx can keep the adapter alive and send multiple prompts.

## Environment Variables

- `CURSOR_API_KEY` — Cursor API key (optional, alternative to prior login)
- `CURSOR_AUTH_TOKEN` — Cursor auth token (optional)
- `CURSOR_ENDPOINT` — Custom API endpoint (optional)
- `CURSOR_MODEL` — Model ID (default: composer-1.5)
- `CURSOR_PERMISSION_MODE` — auto-approval: approve-all, approve-reads, deny-all (default: approve-all)
- `CURSOR_COMMAND` — Path to agent CLI (default: agent)
- `ACPX_SESSION_NAME` — Session name from acpx
- `ACPX_CWD` — Working directory from acpx

## Output Format (acpx NDJSON)

Each line is a JSON object:
```json
{"type":"text","text":"Hello"}
{"type":"tool","name":"Read","status":"call"}
{"type":"tool","name":"Read","status":"result"}
{"type":"done"}
{"type":"error","message":"Something failed"}
```

## File to create

`D:\github\My\js-cursor-agent\acpx-adapter\cursor-adapter.js`

Also create a `package.json` in the adapter directory.
