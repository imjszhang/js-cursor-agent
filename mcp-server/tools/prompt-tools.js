/**
 * MCP tools for Cursor agent prompt interaction.
 */

import { z } from 'zod';

/**
 * @param {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} server
 * @param {import('../../core/acp-client.js').CursorAcpClient} client
 */
export function registerPromptTools(server, client) {
  // ── cursor_prompt ───────────────────────────────────────────────────

  server.tool(
    'cursor_prompt',
    'Send a prompt to Cursor agent and return the full response. Creates a session if needed.',
    {
      text: z.string().describe('The prompt text to send'),
      session: z.string().optional().describe('Session key (auto-generated if omitted)'),
      cwd: z.string().optional().describe('Working directory'),
      mode: z.enum(['agent', 'plan', 'ask']).optional().describe('Session mode'),
    },
    async ({ text, session, cwd, mode }) => {
      const sessionKey = session || `mcp-${Date.now()}`;
      const handle = await client.createSession(sessionKey, { cwd, mode });

      const chunks = [];
      const toolCalls = [];

      for await (const event of client.prompt(handle, text)) {
        switch (event.type) {
          case 'text_delta':
            if (event.stream !== 'thought') {
              chunks.push(event.text);
            }
            break;
          case 'tool_call':
            toolCalls.push({
              title: event.title ?? event.text,
              status: event.status,
            });
            break;
          case 'error':
            return {
              content: [{ type: 'text', text: `Error: ${event.message}` }],
              isError: true,
            };
        }
      }

      const responseText = chunks.join('');
      const parts = [{ type: 'text', text: responseText || '(empty response)' }];

      if (toolCalls.length > 0) {
        parts.push({
          type: 'text',
          text: `\n\n---\nTool calls: ${JSON.stringify(toolCalls)}`,
        });
      }

      return { content: parts };
    },
  );

  // ── cursor_cancel ───────────────────────────────────────────────────

  server.tool(
    'cursor_cancel',
    'Cancel the current turn / close a Cursor agent session.',
    {
      session: z.string().describe('Session key to cancel'),
    },
    async ({ session }) => {
      client.close(session);
      return {
        content: [{ type: 'text', text: `Session "${session}" cancelled.` }],
      };
    },
  );
}
