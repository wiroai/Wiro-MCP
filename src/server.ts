import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WiroClient } from './client.js';
import { registerTools } from './tools/index.js';

export { WiroClient } from './client.js';
export { registerTools } from './tools/index.js';
export type { WiroCredentials } from './types.js';

const require = createRequire(import.meta.url);
const { version } = require('../package.json') as { version: string };

export function createMcpServer(client: WiroClient): McpServer {
  const server = new McpServer({
    name: 'wiro-mcp-server',
    version,
  });

  registerTools(server, client);

  return server;
}
