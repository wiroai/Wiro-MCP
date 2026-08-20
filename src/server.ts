import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { WiroClient } from './client.js';
import { registerTools } from './tools/index.js';
import { withJsonSchema2020_12 } from './utils/json-schema-dialect.js';

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

  // Claude and other 2020-12-only MCP clients reject the SDK's draft-07 $schema.
  const originalConnect = server.connect.bind(server);
  server.connect = (transport: Transport) =>
    originalConnect(withJsonSchema2020_12(transport));

  return server;
}
