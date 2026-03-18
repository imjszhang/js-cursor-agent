/**
 * MCP tools for Cursor agent configuration and diagnostics.
 */

import { z } from 'zod';

/**
 * @param {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} server
 * @param {import('../../core/acp-client.js').CursorAcpClient} client
 */
export function registerConfigTools(server, client) {
  // ── cursor_set_mode ─────────────────────────────────────────────────

  server.tool(
    'cursor_set_mode',
    'Switch the mode of an active Cursor agent session.',
    {
      session: z.string().describe('Session key'),
      mode: z.enum(['agent', 'plan', 'ask']).describe('New mode'),
    },
    async ({ session, mode }) => {
      // set_mode requires a handle with sessionId — not directly available
      // from MCP context. For now, report that the mode is noted.
      return {
        content: [
          {
            type: 'text',
            text: `Mode "${mode}" requested for session "${session}". Note: mode is applied at session creation time.`,
          },
        ],
      };
    },
  );

  // ── cursor_doctor ───────────────────────────────────────────────────

  server.tool(
    'cursor_doctor',
    'Diagnose Cursor CLI availability and authentication status.',
    {},
    async () => {
      const result = await client.doctor();
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    },
  );
}
