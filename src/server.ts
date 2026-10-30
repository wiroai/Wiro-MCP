import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { WiroClient } from './client.js';
import { SERVER_INSTRUCTIONS } from './instructions.js';
import { registerPrompts } from './prompts.js';
import { registerTools, type RegisterToolsOptions } from './tools/index.js';
import { withJsonSchema2020_12 } from './utils/json-schema-dialect.js';

export { WiroClient } from './client.js';
export { SERVER_INSTRUCTIONS } from './instructions.js';
export { registerTools, parseToolsets, TOOLSETS } from './tools/index.js';
export type { RegisterToolsOptions, Toolset, ToolHandler, ToolInfo, ToolWrapper } from './tools/index.js';
export type {
  Task,
  TaskCustomToolCallSegment,
  TaskFinishReason,
  TaskFunctionCallSegment,
  TaskOutput,
  TaskOutputRawContent,
  TaskSegment,
  TaskTextSegment,
  TaskToolCallSegment,
  TaskToolCallStatus,
  TaskUsage,
  WiroCredentials,
} from './types.js';

const require = createRequire(import.meta.url);
const { version } = require('../package.json') as { version: string };

export interface CreateMcpServerOptions extends RegisterToolsOptions {
  /** Guidance sent to the client when it connects. Defaults to Wiro's own. */
  instructions?: string;
}

export function createMcpServer(
  client: WiroClient,
  options: CreateMcpServerOptions = {},
): McpServer {
  const server = new McpServer(
    {
      name: 'wiro-mcp-server',
      version,
    },
    {
      instructions: options.instructions ?? SERVER_INSTRUCTIONS,
    },
  );

  registerTools(server, client, { toolsets: options.toolsets, wrapTool: options.wrapTool });
  registerPrompts(server, options.toolsets);

  // Claude and other 2020-12-only MCP clients reject the SDK's draft-07 $schema.
  const originalConnect = server.connect.bind(server);
  server.connect = (transport: Transport) =>
    originalConnect(withJsonSchema2020_12(transport));

  return server;
}
