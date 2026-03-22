import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { WiroClient } from '../client.js';
import { registerSearchModels } from './search-models.js';
import { registerGetModelSchema } from './get-model-schema.js';
import { registerRunModel } from './run-model.js';
import { registerGetTask } from './get-task.js';
import { registerGetTaskPrice } from './get-task-price.js';
import { registerCancelTask } from './cancel-task.js';
import { registerKillTask } from './kill-task.js';
import { registerSearchDocs } from './search-docs.js';
import { registerRecommendModel } from './recommend-model.js';
import { registerExplore } from './explore.js';
import { registerUploadFile } from './upload-file.js';

export function registerTools(server: McpServer, client: WiroClient): void {
  registerSearchModels(server, client);
  registerGetModelSchema(server, client);
  registerRecommendModel(server, client);
  registerExplore(server, client);
  registerRunModel(server, client);
  registerGetTask(server, client);
  registerGetTaskPrice(server, client);
  registerCancelTask(server, client);
  registerKillTask(server, client);
  registerUploadFile(server, client);
  registerSearchDocs(server);
}

export {
  registerSearchModels,
  registerGetModelSchema,
  registerRecommendModel,
  registerExplore,
  registerRunModel,
  registerGetTask,
  registerGetTaskPrice,
  registerCancelTask,
  registerKillTask,
  registerUploadFile,
  registerSearchDocs,
};
