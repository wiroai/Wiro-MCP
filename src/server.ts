import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WiroClient } from './client.js';
import { registerTools } from './tools/index.js';

export { WiroClient } from './client.js';
export { registerTools } from './tools/index.js';
export type { WiroCredentials } from './types.js';

export function createMcpServer(client: WiroClient): McpServer {
  const server = new McpServer({
    name: 'wiro-mcp-server',
    version: '1.0.0',
  });

  registerTools(server, client);

  return server;
}
