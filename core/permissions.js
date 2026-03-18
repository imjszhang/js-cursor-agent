/**
 * Automatic permission-request handler for non-interactive ACP sessions.
 *
 * Cursor's `agent acp` sends `session/request_permission` when a tool
 * needs approval. This module auto-responds based on configured policy.
 */

/**
 * Pick the option id for a given kind preference order.
 * @param {Array<{optionId: string, kind: string}>} options
 * @param {string[]} preferredKinds
 * @returns {string|undefined}
 */
function pickOptionId(options, preferredKinds) {
  for (const kind of preferredKinds) {
    const match = options.find((o) => o.kind === kind);
    if (match) return match.optionId;
  }
  return undefined;
}

/**
 * Resolve a permission request according to the configured policy.
 *
 * @param {object} params  The `session/request_permission` params from Cursor
 * @param {string} policy  One of: approve-all, approve-reads, deny-all
 * @param {{ log?: Function }} [opts]
 * @returns {{ outcome: { outcome: string, optionId?: string } }}
 */
export function resolvePermission(params, policy, opts = {}) {
  const log = opts.log ?? (() => {});
  const options = params?.options ?? [];
  const toolTitle = params?.toolCall?.title ?? 'unknown tool';

  if (options.length === 0) {
    log(`[permission cancelled] ${toolTitle}: no options`);
    return { outcome: { outcome: 'cancelled' } };
  }

  const allowId = pickOptionId(options, ['allow_once', 'allow_always']);
  const rejectId = pickOptionId(options, ['reject_once', 'reject_always']);

  if (policy === 'approve-all') {
    if (allowId) {
      log(`[permission auto-approved] ${toolTitle}`);
      return { outcome: { outcome: 'selected', optionId: allowId } };
    }
  }

  if (policy === 'approve-reads') {
    const kind = params?.toolCall?.kind;
    if (kind === 'read' && allowId) {
      log(`[permission auto-approved read] ${toolTitle}`);
      return { outcome: { outcome: 'selected', optionId: allowId } };
    }
    if (rejectId) {
      log(`[permission denied non-read] ${toolTitle}`);
      return { outcome: { outcome: 'selected', optionId: rejectId } };
    }
  }

  if (policy === 'deny-all') {
    if (rejectId) {
      log(`[permission denied] ${toolTitle}`);
      return { outcome: { outcome: 'selected', optionId: rejectId } };
    }
  }

  // Fallback: cancel if no suitable option found
  log(`[permission cancelled] ${toolTitle}: no matching option for policy "${policy}"`);
  return { outcome: { outcome: 'cancelled' } };
}
