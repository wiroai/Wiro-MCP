#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { WiroClient } from './client.js';
import { createMcpServer } from './server.js';

const apiKey = process.env['WIRO_API_KEY'];
const apiSecret = process.env['WIRO_API_SECRET'];
const baseUrl = process.env['WIRO_API_BASE_URL'];

if (!apiKey) {
  console.error(
    'Error: WIRO_API_KEY environment variable is required.\n\n' +
    'Set it in your MCP server config:\n\n' +
    '  "env": {\n' +
    '    "WIRO_API_KEY": "your-api-key",\n' +
    '    "WIRO_API_SECRET": "your-api-secret"\n' +
    '  }\n\n' +
    'Get your API keys at https://wiro.ai/panel/project/new\n\n' +
    'WIRO_API_SECRET is optional (required for signature auth, not needed for API Key Only auth).',
  );
  process.exit(1);
}

const client = new WiroClient(apiKey, apiSecret, baseUrl);
const server = createMcpServer(client);
const transport = new StdioServerTransport();

await server.connect(transport);
console.error(`Wiro MCP server running on stdio (auth: ${client.authType})`);
