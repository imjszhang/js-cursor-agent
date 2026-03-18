#!/usr/bin/env node

/**
 * js-cursor-agent CLI
 *
 * Usage:
 *   node cli/cli.js <command> [options]
 *
 * Commands:
 *   chat                Interactive multi-turn conversation (REPL)
 *   prompt <text>       Send a prompt to Cursor agent
 *   sessions            List active sessions
 *   session-new         Create a new session
 *   cancel              Cancel the current turn
 *   close               Close a session
 *   set-mode <mode>     Switch mode (agent/plan/ask)
 *   doctor              Diagnose Cursor CLI status
 *   help                Show this help
 *
 * All structured output is JSON to stdout. Logs go to stderr.
 */

import 'dotenv/config';
import { createInterface } from 'node:readline';
import { toJson, toStderr } from './lib/formatters.js';
import { resolveConfig } from '../core/config.js';
import { CursorAcpClient } from '../core/acp-client.js';

// ── Arg parser ───────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = argv.slice(2);
  const command = args[0] || '';
  const positional = [];
  const flags = {};

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { command, positional, flags };
}

// ── Shared client factory ────────────────────────────────────────────

let _client = null;

function getClient(flags = {}) {
  if (_client) return _client;
  const overrides = {};
  if (flags['api-key']) overrides.apiKey = flags['api-key'];
  if (flags['auth-token']) overrides.authToken = flags['auth-token'];
  if (flags.model) overrides.model = flags.model;
  const config = resolveConfig(overrides);
  _client = new CursorAcpClient(config, {
    log: (msg) => toStderr(msg),
  });
  return _client;
}

// ── Commands ─────────────────────────────────────────────────────────

async function cmdDoctor(flags) {
  const client = getClient(flags);
  const result = await client.doctor();
  toJson(result);
}

async function cmdSessionNew(flags) {
  const client = getClient(flags);
  const sessionKey = flags.session || `cli-${Date.now()}`;
  const handle = await client.createSession(sessionKey, {
    cwd: flags.cwd,
    mode: flags.mode,
  });
  toJson(handle);
}

async function cmdSessions(flags) {
  const client = getClient(flags);
  const list = client.listSessions();
  toJson(list);
}

async function cmdPrompt(positional, flags) {
  const text = positional.join(' ');
  if (!text) {
    toStderr('Error: prompt requires text');
    process.exit(1);
  }

  const client = getClient(flags);
  const sessionKey = flags.session || `cli-${Date.now()}`;
  const handle = await client.getOrCreateSession(sessionKey, {
    cwd: flags.cwd,
    mode: flags.mode,
  });

  const jsonMode = !!flags.json;
  const events = [];

  for await (const event of client.prompt(handle, text)) {
    if (jsonMode) {
      events.push(event);
    } else {
      if (event.type === 'text_delta') {
        process.stdout.write(event.text);
      } else if (event.type === 'tool_call') {
        toStderr(`\n[tool] ${event.title ?? event.text} (${event.status ?? ''})`);
      } else if (event.type === 'status') {
        toStderr(`[status] ${event.text}`);
      } else if (event.type === 'done') {
        process.stdout.write('\n');
        toStderr(`[done] stopReason=${event.stopReason}`);
      } else if (event.type === 'error') {
        toStderr(`[error] ${event.message}`);
      }
    }
  }

  if (jsonMode) {
    toJson(events);
  }

  if (!flags.session) {
    client.shutdown();
  }
}

async function cmdCancel(flags) {
  const sessionKey = flags.session;
  if (!sessionKey) {
    toStderr('Error: cancel requires --session <key>');
    process.exit(1);
  }
  const client = getClient(flags);
  // We need a handle with sessionId — for CLI cancel we just kill the process
  client.close(sessionKey);
  toJson({ status: 'cancelled', sessionKey });
}

async function cmdClose(flags) {
  const sessionKey = flags.session;
  if (!sessionKey) {
    toStderr('Error: close requires --session <key>');
    process.exit(1);
  }
  const client = getClient(flags);
  client.close(sessionKey);
  toJson({ status: 'closed', sessionKey });
}

async function cmdSetMode(positional, flags) {
  const mode = positional[0];
  if (!mode || !['agent', 'plan', 'ask'].includes(mode)) {
    toStderr('Error: set-mode requires a mode (agent/plan/ask)');
    process.exit(1);
  }
  const sessionKey = flags.session;
  if (!sessionKey) {
    toStderr('Error: set-mode requires --session <key>');
    process.exit(1);
  }
  toStderr(`Note: set-mode via CLI is only effective on an active prompt session.`);
  toJson({ status: 'mode-set', mode, sessionKey });
}

// ── Stream helper ────────────────────────────────────────────────────

function streamToConsole(eventIter) {
  return (async () => {
    for await (const event of eventIter) {
      if (event.type === 'text_delta') {
        process.stdout.write(event.text);
      } else if (event.type === 'tool_call') {
        toStderr(`\n[tool] ${event.title ?? event.text} (${event.status ?? ''})`);
      } else if (event.type === 'status') {
        toStderr(`[status] ${event.text}`);
      } else if (event.type === 'done') {
        process.stdout.write('\n');
      } else if (event.type === 'error') {
        toStderr(`[error] ${event.message}`);
      }
    }
  })();
}

// ── Chat REPL ────────────────────────────────────────────────────────

async function cmdChat(flags) {
  const client = getClient(flags);
  const sessionKey = flags.session || `chat-${Date.now()}`;
  const handle = await client.createSession(sessionKey, {
    cwd: flags.cwd,
    mode: flags.mode,
  });

  toStderr(`[chat] session started (key=${handle.sessionKey}, id=${handle.sessionId})`);
  toStderr('[chat] Type your message. Commands: /quit /mode <m> /new /info');

  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
    prompt: '> ',
    terminal: process.stdin.isTTY ?? false,
  });

  let currentHandle = handle;
  let prompting = false;
  let exiting = false;

  function safePrompt() {
    if (!exiting) try { rl.prompt(); } catch { /* readline closed */ }
  }

  rl.prompt();

  rl.on('line', async (line) => {
    const input = line.trim();
    if (!input) { safePrompt(); return; }

    // Slash commands
    if (input.startsWith('/')) {
      const [cmd, ...rest] = input.slice(1).split(/\s+/);
      switch (cmd) {
        case 'quit':
        case 'exit':
          exiting = true;
          toStderr('[chat] closing session...');
          client.close(currentHandle.sessionKey);
          client.shutdown();
          rl.close();
          return;

        case 'mode': {
          const mode = rest[0];
          if (!mode || !['agent', 'plan', 'ask'].includes(mode)) {
            toStderr('[chat] usage: /mode <agent|plan|ask>');
            safePrompt();
            return;
          }
          try {
            await client.setMode(currentHandle, mode);
            toStderr(`[chat] mode switched to "${mode}"`);
          } catch (err) {
            toStderr(`[chat] set_mode failed: ${err.message}`);
          }
          safePrompt();
          return;
        }

        case 'new':
          toStderr('[chat] creating new session (context reset)...');
          client.close(currentHandle.sessionKey);
          currentHandle = await client.createSession(`chat-${Date.now()}`, {
            cwd: flags.cwd,
            mode: flags.mode,
          });
          toStderr(`[chat] new session (key=${currentHandle.sessionKey}, id=${currentHandle.sessionId})`);
          safePrompt();
          return;

        case 'info':
          toStderr(`[chat] sessionKey=${currentHandle.sessionKey} sessionId=${currentHandle.sessionId}`);
          safePrompt();
          return;

        default:
          toStderr(`[chat] unknown command: /${cmd}`);
          safePrompt();
          return;
      }
    }

    // Regular prompt
    prompting = true;
    try {
      await streamToConsole(client.prompt(currentHandle, input));
    } catch (err) {
      toStderr(`[error] ${err.message}`);
    }
    prompting = false;
    safePrompt();
  });

  rl.on('SIGINT', () => {
    if (prompting) {
      toStderr('\n[chat] cancelling current turn...');
      client.cancel(currentHandle).catch(() => {});
    } else {
      toStderr('\n[chat] Press Ctrl+C again or type /quit to exit.');
      rl.once('SIGINT', () => {
        exiting = true;
        toStderr('[chat] exiting...');
        client.close(currentHandle.sessionKey);
        client.shutdown();
        process.exit(0);
      });
    }
    safePrompt();
  });

  rl.on('close', () => {
    client.shutdown();
  });

  // Keep the process alive until readline closes
  await new Promise((resolve) => rl.on('close', resolve));
}

// ── Usage ────────────────────────────────────────────────────────────

function printUsage() {
  toStderr(`js-cursor-agent CLI — Cursor agent ACP runtime wrapper

Usage:
  node cli/cli.js <command> [options]

Commands:
  chat                  Interactive multi-turn conversation (REPL)
    --session <key>       Session key (default: auto-generated)
    --mode <mode>         Session mode: agent / plan / ask
    --cwd <dir>           Working directory
  prompt <text>         Send a single prompt to Cursor agent
    --session <key>       Session key (default: auto-generated)
    --mode <mode>         Session mode: agent / plan / ask
    --cwd <dir>           Working directory
    --json                Output raw JSON events
  session-new           Create a new session
    --session <key>       Session key
    --cwd <dir>           Working directory
    --mode <mode>         Session mode
  sessions              List active sessions
  cancel                Cancel current turn / kill session
    --session <key>       Session key (required)
  close                 Close a session
    --session <key>       Session key (required)
  set-mode <mode>       Switch mode (agent/plan/ask)
    --session <key>       Session key (required)
  doctor                Diagnose Cursor CLI status
  help                  Show this help

Auth flags (optional):
  --api-key <key>       Cursor API key
  --auth-token <token>  Cursor auth token
  --model <id>          Model to use (e.g. sonnet-4.6, gemini-3-flash)

Examples:
  node cli/cli.js doctor
  node cli/cli.js prompt "Explain the auth module" --cwd /path/to/project
  node cli/cli.js prompt "Fix failing tests" --session my-session --mode agent
  node cli/cli.js prompt "Hello" --model gemini-3-flash
  node cli/cli.js chat --mode plan --cwd /path/to/project
  node cli/cli.js sessions
  node cli/cli.js close --session my-session`);
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  const { command, positional, flags } = parseArgs(process.argv);

  try {
    switch (command) {
      case 'chat':        await cmdChat(flags); break;
      case 'doctor':      await cmdDoctor(flags); break;
      case 'prompt':      await cmdPrompt(positional, flags); break;
      case 'session-new': await cmdSessionNew(flags); break;
      case 'sessions':    await cmdSessions(flags); break;
      case 'cancel':      await cmdCancel(flags); break;
      case 'close':       await cmdClose(flags); break;
      case 'set-mode':    await cmdSetMode(positional, flags); break;
      case 'help': case '--help': case '-h':
        printUsage();
        break;
      case '':
        printUsage();
        process.exit(1);
        break;
      default:
        toStderr(`Error: unknown command "${command}"`);
        toStderr('Run "node cli/cli.js help" for usage.');
        process.exit(1);
    }
  } catch (err) {
    toStderr(`Error: ${err.message}`);
    if (_client) _client.shutdown();
    process.exit(1);
  }
}

main().catch((err) => {
  toStderr(`Fatal: ${err.message}`);
  process.exit(1);
});
