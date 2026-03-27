/**
 * OpenClaw plugin entry point for js-cursor-agent.
 *
 * Registers the Cursor ACP runtime backend so OpenClaw can drive Cursor
 * via `/acp spawn cursor`.
 */

import { resolveConfig } from '../core/config.js';
import { CursorAcpClient } from '../core/acp-client.js';
import { registerAcpRuntimeBackend, unregisterAcpRuntimeBackend } from 'openclaw/plugin-sdk/acp-runtime';

const BACKEND_ID = 'cursor';

/**
 * CursorRuntime — implements the OpenClaw AcpRuntime interface by
 * delegating to the shared core CursorAcpClient.
 */
class CursorRuntime {
  #client;
  #log;
  #healthy = false;

  /**
   * @param {import('../core/config.js').ResolvedConfig} config
   * @param {{ log?: Function }} [opts]
   */
  constructor(config, opts = {}) {
    this.#log = opts.log ?? (() => {});
    this.#client = new CursorAcpClient(config, { log: this.#log });
  }

  isHealthy() {
    return this.#healthy;
  }

  async probeAvailability() {
    const report = await this.#client.doctor();
    this.#healthy = report.ok;
    if (report.ok) {
      this.#log('[cursor-runtime] probe OK');
    } else {
      this.#log(`[cursor-runtime] probe FAIL: ${report.message}`);
    }
  }

  // ── AcpRuntime interface ─────────────────────────────────────────

  /**
   * @param {object} input
   * @param {string} input.sessionKey
   * @param {string} [input.agent]
   * @param {string} [input.mode]
   * @param {string} [input.cwd]
   * @returns {Promise<object>}  AcpRuntimeHandle
   */
  async ensureSession(input) {
    const handle = await this.#client.getOrCreateSession(input.sessionKey, {
      cwd: input.cwd,
      mode: input.mode === 'persistent' ? undefined : input.mode,
    });

    return {
      sessionKey: input.sessionKey,
      backend: BACKEND_ID,
      runtimeSessionName: handle.sessionId,
      cwd: input.cwd,
      backendSessionId: handle.sessionId,
    };
  }

  /**
   * @param {object} input
   * @param {object} input.handle  AcpRuntimeHandle
   * @param {string} input.text
   * @param {AbortSignal} [input.signal]
   * @returns {AsyncIterable<object>}  AcpRuntimeEvent
   */
  async *runTurn(input) {
    const clientHandle = {
      sessionKey: input.handle.sessionKey,
      sessionId: input.handle.backendSessionId ?? input.handle.runtimeSessionName,
    };

    for await (const event of this.#client.prompt(clientHandle, input.text, { signal: input.signal })) {
      switch (event.type) {
        case 'text_delta':
          yield {
            type: 'text_delta',
            text: event.text,
            stream: event.stream === 'thought' ? 'thought' : 'output',
          };
          break;
        case 'tool_call':
          yield {
            type: 'tool_call',
            text: event.title ?? event.text,
            toolCallId: event.toolCallId,
            status: event.status,
            title: event.title,
          };
          break;
        case 'status':
          yield { type: 'status', text: event.text };
          break;
        case 'done':
          yield { type: 'done', stopReason: event.stopReason };
          break;
        case 'error':
          yield { type: 'error', message: event.message };
          break;
      }
    }
  }

  /**
   * @returns {object}  AcpRuntimeCapabilities
   */
  getCapabilities() {
    return {
      controls: ['session/set_mode'],
    };
  }

  /**
   * @param {object} input
   * @param {object} input.handle
   * @returns {Promise<object>}  AcpRuntimeStatus
   */
  async getStatus(input) {
    const sessions = this.#client.listSessions();
    const session = sessions.find((s) => s.sessionKey === input.handle.sessionKey);
    return {
      summary: session ? (session.alive ? 'active' : 'dead') : 'unknown',
      backendSessionId: input.handle.backendSessionId,
    };
  }

  /**
   * @param {object} input
   * @param {object} input.handle
   * @param {string} input.mode
   */
  async setMode(input) {
    const clientHandle = {
      sessionKey: input.handle.sessionKey,
      sessionId: input.handle.backendSessionId ?? input.handle.runtimeSessionName,
    };
    await this.#client.setMode(clientHandle, input.mode);
  }

  /**
   * @returns {Promise<object>}  AcpRuntimeDoctorReport
   */
  async doctor() {
    return this.#client.doctor();
  }

  /**
   * @param {object} input
   * @param {object} input.handle
   */
  async cancel(input) {
    const clientHandle = {
      sessionKey: input.handle.sessionKey,
      sessionId: input.handle.backendSessionId ?? input.handle.runtimeSessionName,
    };
    await this.#client.cancel(clientHandle);
  }

  /**
   * @param {object} input
   * @param {object} input.handle
   */
  async close(input) {
    this.#client.close(input.handle.sessionKey);
  }

  /** Shutdown all managed processes. */
  shutdown() {
    this.#client.shutdown();
  }
}

// ── Plugin export ────────────────────────────────────────────────────

const plugin = {
  id: 'js-cursor-agent',
  name: 'JS Cursor Agent',
  description: 'Cursor CLI ACP runtime backend with long-lived process pooling.',

  /**
   * @param {object} api  OpenClawPluginApi
   */
  register(api) {
    const pluginCfg = api.pluginConfig ?? {};

    // Map plugin config keys to core config env-var equivalents.
    // Running inside OpenClaw Gateway: disable plugin-side concurrency cap
    // and idle reaper — Gateway's ACP runtime manages session lifecycle.
    const overrides = {
      maxSessions: 0,
      idleTtlMinutes: 0,
    };
    if (pluginCfg.command) overrides.command = pluginCfg.command;
    if (pluginCfg.apiKey) overrides.apiKey = pluginCfg.apiKey;
    if (pluginCfg.authToken) overrides.authToken = pluginCfg.authToken;
    if (pluginCfg.endpoint) overrides.endpoint = pluginCfg.endpoint;
    if (pluginCfg.defaultMode) overrides.defaultMode = pluginCfg.defaultMode;
    if (pluginCfg.permissionMode) overrides.permissionMode = pluginCfg.permissionMode;

    const config = resolveConfig(overrides);

    let runtime = null;

    // ── Service: ACP Runtime Backend ─────────────────────────────────

    api.registerService({
      id: 'cursor-runtime',

      async start(ctx) {
        const logger = ctx.logger ?? { info: () => {}, warn: () => {}, error: () => {} };

        // Check ACP configuration and warn if missing
        const gatewayConfig = ctx.config ?? {};
        const acpCfg = gatewayConfig.acp;
        if (!acpCfg?.enabled) {
          logger.warn(
            'ACP runtime is not enabled. Run "openclaw cursor setup" to auto-configure, or set acp.enabled=true and acp.backend=cursor manually.',
          );
        } else if (acpCfg.backend && acpCfg.backend !== BACKEND_ID) {
          logger.warn(
            `ACP backend is set to "${acpCfg.backend}", not "${BACKEND_ID}". This plugin registers backend "${BACKEND_ID}". ` +
            `To use Cursor, set acp.backend=${BACKEND_ID} or run "openclaw cursor setup".`,
          );
        }

        runtime = new CursorRuntime(config, {
          log: (msg) => logger.info(msg),
        });

        registerAcpRuntimeBackend({
          id: BACKEND_ID,
          runtime,
          healthy: () => runtime?.isHealthy() ?? false,
        });

        logger.info(`cursor runtime backend registered (command: ${config.command})`);

        // Background probe
        runtime.probeAvailability().then(() => {
          if (runtime?.isHealthy()) {
            logger.info('cursor runtime backend ready');
          } else {
            logger.warn('cursor runtime backend probe failed — run "openclaw cursor doctor" to diagnose');
          }
        }).catch((err) => {
          logger.warn(`cursor runtime probe error: ${err.message}`);
        });
      },

      async stop() {
        try {
          unregisterAcpRuntimeBackend(BACKEND_ID);
        } catch { /* ignore if unavailable */ }
        if (runtime) {
          runtime.shutdown();
          runtime = null;
        }
      },
    });

    // ── CLI subcommands ──────────────────────────────────────────────

    api.registerCli(({ program }) => {
      const cursor = program.command('cursor').description('JS Cursor Agent');

      cursor
        .command('setup')
        .description('Auto-configure ACP runtime for Cursor backend')
        .option('--dry-run', 'Print commands without executing')
        .action(async (opts) => {
          const { execSync } = await import('node:child_process');
          const dryRun = !!opts.dryRun;

          const configPairs = [
            ['acp.enabled', 'true'],
            ['acp.backend', BACKEND_ID],
            ['acp.defaultAgent', BACKEND_ID],
            ['acp.maxConcurrentSessions', String(config.maxSessions)],
            ['acp.runtime.ttlMinutes', String(config.idleTtlMinutes)],
          ];

          console.log(dryRun ? '=== Dry run ===' : '=== Configuring ACP for Cursor backend ===');
          console.log();

          for (const [key, value] of configPairs) {
            const cmd = `openclaw config set ${key} ${value}`;
            if (dryRun) {
              console.log(`  ${cmd}`);
            } else {
              try {
                execSync(cmd, { stdio: 'pipe' });
                console.log(`  ✓ ${key} = ${value}`);
              } catch (err) {
                console.error(`  ✗ ${key}: ${err.message}`);
              }
            }
          }

          // allowedAgents is an array — needs JSON value
          const allowedCmd = `openclaw config set acp.allowedAgents '["${BACKEND_ID}"]'`;
          if (dryRun) {
            console.log(`  ${allowedCmd}`);
          } else {
            try {
              execSync(allowedCmd, { stdio: 'pipe' });
              console.log(`  ✓ acp.allowedAgents = ["${BACKEND_ID}"]`);
            } catch (err) {
              console.error(`  ✗ acp.allowedAgents: ${err.message}`);
            }
          }

          console.log();
          if (!dryRun) {
            console.log('ACP configuration complete. Restart the gateway to apply.');
            console.log('Then verify with: openclaw cursor doctor');
          }
        });

      cursor
        .command('doctor')
        .description('Diagnose Cursor CLI status')
        .action(async () => {
          const rt = runtime ?? new CursorRuntime(config, { log: console.error });
          const report = await rt.doctor();
          console.log(JSON.stringify(report, null, 2));
        });

      cursor
        .command('sessions')
        .description('List active Cursor agent sessions')
        .action(async () => {
          if (!runtime) {
            console.log('[]');
            return;
          }
          const client = runtime;
          const report = await client.doctor();
          console.log(JSON.stringify({ ...report, hint: 'Sessions visible only while gateway is running.' }, null, 2));
        });
    }, { commands: ['cursor'] });

    // ── Tools (optional) ─────────────────────────────────────────────

    api.registerTool({
      name: 'cursor_doctor',
      description: 'Diagnose Cursor CLI availability and authentication status.',
      inputSchema: { type: 'object', properties: {} },
      async execute() {
        const rt = runtime ?? new CursorRuntime(config, { log: () => {} });
        const report = await rt.doctor();
        return { content: [{ type: 'text', text: JSON.stringify(report, null, 2) }] };
      },
    });
  },
};

export default plugin;
