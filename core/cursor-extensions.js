/**
 * Handlers for Cursor-specific ACP extension methods.
 *
 * Cursor sends these as server-initiated requests; our client must respond.
 * Phase 1: log and pick reasonable defaults.
 */

/**
 * Register all Cursor extension handlers on a JsonRpcTransport.
 * @param {import('./jsonrpc.js').JsonRpcTransport} transport
 * @param {{ log?: Function }} [opts]
 */
export function registerCursorExtensions(transport, opts = {}) {
  const log = opts.log ?? (() => {});

  // Multiple-choice question — pick the first option
  transport.onRequest('cursor/ask_question', (params) => {
    const questions = params?.questions ?? [];
    const answers = {};
    for (const q of questions) {
      const firstOption = q?.options?.[0];
      if (q?.id && firstOption?.id) {
        answers[q.id] = firstOption.id;
      }
      log(`[cursor/ask_question] "${q?.prompt ?? '?'}" -> auto-selected "${firstOption?.label ?? '?'}"`);
    }
    return { answers };
  });

  // Plan approval — auto-approve
  transport.onRequest('cursor/create_plan', (params) => {
    const title = params?.title ?? 'untitled plan';
    log(`[cursor/create_plan] auto-approved: ${title}`);
    return { approved: true };
  });

  // Todo updates — acknowledge
  transport.onNotification('cursor/update_todos', (params) => {
    const count = Array.isArray(params?.todos) ? params.todos.length : 0;
    log(`[cursor/update_todos] ${count} item(s)`);
  });

  // Subagent task completion — acknowledge
  transport.onNotification('cursor/task', (params) => {
    const description = params?.description ?? 'unknown task';
    log(`[cursor/task] completed: ${description}`);
  });

  // Image generation — acknowledge
  transport.onNotification('cursor/generate_image', (params) => {
    const filename = params?.filename ?? 'unknown';
    log(`[cursor/generate_image] ${filename}`);
  });
}
