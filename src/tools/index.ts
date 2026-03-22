import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { WiroClient } from '../client.js';
import { registerSearchModels } from './search-models.js';
import { registerGetModelSchema } from './get-model-schema.js';
import { registerRunModel } from './run-model.js';
import { registerGetTask } from './get-task.js';
import { registerCancelTask } from './cancel-task.js';
import { registerKillTask } from './kill-task.js';
export function registerTools(server: McpServer, client: WiroClient): void {
  registerSearchModels(server, client);
  registerGetModelSchema(server, client);
  registerRunModel(server, client);
  registerGetTask(server, client);
  registerCancelTask(server, client);
  registerKillTask(server, client);
}

export {
  registerSearchModels,
  registerGetModelSchema,
  registerRunModel,
  registerGetTask,
  registerCancelTask,
  registerKillTask,
};
