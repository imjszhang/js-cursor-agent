/**
 * MCP tools for Cursor agent session management.
 */

import { z } from 'zod';

/**
 * @param {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} server
 * @param {import('../../core/acp-client.js').CursorAcpClient} client
 */
export function registerSessionTools(server, client) {
  // ── cursor_session_new ──────────────────────────────────────────────

  server.tool(
    'cursor_session_new',
    'Create a new Cursor agent ACP session. Returns a session handle that can be used for prompts.',
    {
      session: z.string().optional().describe('Session key (auto-generated if omitted)'),
      cwd: z.string().optional().describe('Working directory for the Cursor agent'),
      mode: z.enum(['agent', 'plan', 'ask']).optional().describe('Session mode (default: agent)'),
    },
    async ({ session, cwd, mode }) => {
      const sessionKey = session || `mcp-${Date.now()}`;
      const handle = await client.createSession(sessionKey, { cwd, mode });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(handle, null, 2),
          },
        ],
      };
    },
  );

  // ── cursor_session_list ─────────────────────────────────────────────

  server.tool(
    'cursor_session_list',
    'List all active Cursor agent sessions.',
    {},
    async () => {
      const sessions = client.listSessions();
      return {
        content: [
          {
            type: 'text',
            text: sessions.length === 0
              ? 'No active sessions.'
              : JSON.stringify(sessions, null, 2),
          },
        ],
      };
    },
  );

  // ── cursor_session_close ────────────────────────────────────────────

  server.tool(
    'cursor_session_close',
    'Close a Cursor agent session and kill its process.',
    {
      session: z.string().describe('Session key to close'),
    },
    async ({ session }) => {
      client.close(session);
      return {
        content: [
          {
            type: 'text',
            text: `Session "${session}" closed.`,
          },
        ],
      };
    },
  );
}
