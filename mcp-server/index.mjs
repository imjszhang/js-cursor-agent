#!/usr/bin/env node

/**
 * js-cursor-agent MCP Server
 *
 * Dual-mode startup:
 *   - stdio (default): for Cursor / Claude Desktop subprocess call
 *   - HTTP: for remote MCP clients (--http --port 8080)
 *
 * Exposes tools for managing Cursor ACP sessions, prompts, and configuration.
 */

import 'dotenv/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerSessionTools } from './tools/session-tools.js';
import { registerPromptTools } from './tools/prompt-tools.js';
import { registerConfigTools } from './tools/config-tools.js';
import { resolveConfig } from '../core/config.js';
import { CursorAcpClient } from '../core/acp-client.js';

const config = resolveConfig();
const client = new CursorAcpClient(config, {
  log: (msg) => process.stderr.write(msg + '\n'),
});

// Graceful shutdown
process.on('SIGINT', () => { client.shutdown(); process.exit(0); });
process.on('SIGTERM', () => { client.shutdown(); process.exit(0); });

const server = new McpServer({
  name: 'js-cursor-agent',
  version: '1.0.0',
});

registerSessionTools(server, client);
registerPromptTools(server, client);
registerConfigTools(server, client);

// ── Startup ──────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const useHttp = args.includes('--http');

if (useHttp) {
  const portIdx = args.indexOf('--port');
  const port = portIdx !== -1 ? parseInt(args[portIdx + 1], 10) : 8080;

  const { StreamableHTTPServerTransport } = await import(
    '@modelcontextprotocol/sdk/server/streamableHttp.js'
  );
  const http = await import('node:http');

  const httpServer = http.createServer(async (req, res) => {
    if (req.url === '/mcp') {
      const transport = new StreamableHTTPServerTransport('/mcp');
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  });

  httpServer.listen(port, () => {
    process.stderr.write(`MCP Server (HTTP) listening on http://localhost:${port}/mcp\n`);
  });
} else {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('MCP Server (stdio) started\n');
}
