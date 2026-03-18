/**
 * Cursor CLI authentication helpers.
 *
 * Resolves CLI arguments for spawning `agent acp` with credentials,
 * and provides a basic auth-status check.
 */

import { spawn } from 'node:child_process';

/**
 * Build CLI auth arguments for the `agent acp` spawn.
 * @param {import('./config.js').ResolvedConfig} config
 * @returns {string[]}
 */
export function resolveAuthArgs(config) {
  const args = [];

  if (config.endpoint) {
    args.push('-e', config.endpoint);
  }

  if (config.model) {
    args.push('--model', config.model);
  }

  if (config.apiKey) {
    args.push('--api-key', config.apiKey);
    return args;
  }

  if (config.authToken) {
    args.push('--auth-token', config.authToken);
    return args;
  }

  // No explicit credentials — rely on prior `agent login`
  return args;
}

/**
 * Check whether the Cursor CLI is reachable and authenticated.
 * @param {import('./config.js').ResolvedConfig} config
 * @returns {Promise<{ ok: boolean, message: string }>}
 */
export async function checkAuthStatus(config) {
  try {
    const result = await spawnAndCollect(config.command, ['--version']);
    if (result.code !== 0) {
      return { ok: false, message: `agent exited with code ${result.code}: ${result.stderr.trim()}` };
    }
    const version = result.stdout.trim();
    return { ok: true, message: `Cursor CLI reachable (${version || 'version unknown'})` };
  } catch (err) {
    return { ok: false, message: `Cannot reach Cursor CLI "${config.command}": ${err.message}` };
  }
}

/**
 * @param {string} command
 * @param {string[]} args
 * @returns {Promise<{code: number|null, stdout: string, stderr: string}>}
 */
function spawnAndCollect(command, args) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let cmd = command;
    let cmdArgs = args;
    if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(command)) {
      cmd = 'cmd';
      cmdArgs = ['/c', command, ...args];
    }
    const child = spawn(cmd, cmdArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}
