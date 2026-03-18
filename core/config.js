/**
 * Unified configuration — env vars > .env > defaults.
 * No external dependencies; dotenv must be loaded by the caller before import.
 */

const DEFAULTS = {
  command: 'agent',
  apiKey: '',
  authToken: '',
  endpoint: '',
  defaultMode: 'agent',
  permissionMode: 'approve-all',
  idleTtlMinutes: 30,
  maxSessions: 4,
};

const VALID_MODES = new Set(['agent', 'plan', 'ask']);
const VALID_PERMISSION_MODES = new Set(['approve-all', 'approve-reads', 'deny-all']);

function trimOrDefault(value, fallback) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed || fallback;
}

function intOrDefault(value, fallback) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Build a resolved config object.
 * @param {Record<string, unknown>} [overrides] CLI flags or plugin config
 * @returns {ResolvedConfig}
 */
export function resolveConfig(overrides = {}) {
  const env = process.env;

  const command = trimOrDefault(
    overrides.command ?? env.CURSOR_AGENT_PATH,
    DEFAULTS.command,
  );

  const apiKey = trimOrDefault(
    overrides.apiKey ?? env.CURSOR_API_KEY,
    DEFAULTS.apiKey,
  );

  const authToken = trimOrDefault(
    overrides.authToken ?? env.CURSOR_AUTH_TOKEN,
    DEFAULTS.authToken,
  );

  const endpoint = trimOrDefault(
    overrides.endpoint ?? env.CURSOR_ENDPOINT,
    DEFAULTS.endpoint,
  );

  let defaultMode = trimOrDefault(
    overrides.defaultMode ?? env.CURSOR_DEFAULT_MODE,
    DEFAULTS.defaultMode,
  );
  if (!VALID_MODES.has(defaultMode)) {
    defaultMode = DEFAULTS.defaultMode;
  }

  let permissionMode = trimOrDefault(
    overrides.permissionMode ?? env.CURSOR_PERMISSION_MODE,
    DEFAULTS.permissionMode,
  );
  if (!VALID_PERMISSION_MODES.has(permissionMode)) {
    permissionMode = DEFAULTS.permissionMode;
  }

  const idleTtlMinutes = intOrDefault(
    overrides.idleTtlMinutes ?? env.CURSOR_IDLE_TTL_MINUTES,
    DEFAULTS.idleTtlMinutes,
  );

  const maxSessions = intOrDefault(
    overrides.maxSessions ?? env.CURSOR_MAX_SESSIONS,
    DEFAULTS.maxSessions,
  );

  return {
    command,
    apiKey,
    authToken,
    endpoint,
    defaultMode,
    permissionMode,
    idleTtlMinutes,
    maxSessions,
  };
}

/**
 * @typedef {object} ResolvedConfig
 * @property {string} command
 * @property {string} apiKey
 * @property {string} authToken
 * @property {string} endpoint
 * @property {string} defaultMode
 * @property {string} permissionMode
 * @property {number} idleTtlMinutes
 * @property {number} maxSessions
 */
