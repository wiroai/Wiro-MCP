import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WiroClient } from '../client.js';
import { formatModelList } from '../utils/format.js';
import { toStructuredModel } from '../utils/structured.js';
import { modelListOutputSchema } from './schemas.js';

export function registerRecommendModel(server: McpServer, client: WiroClient): void {
  server.registerTool(
    'recommend_model',
    {
      title: 'Recommend Wiro models',
      description: 'Describe a generation goal in natural language and receive '
        + 'ranked model recommendations. Follow the returned '
        + '`get_model_schema` next action before running a model.',
      inputSchema: {
        task: z.string().describe('What you want to do, e.g. "generate a photorealistic portrait", "upscale an image to 4K", "transcribe audio to text".'),
      },
      outputSchema: modelListOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ task }) => {
      try {
        const result = await client.searchModels({
          search: task,
          sort: 'relevance',
          limit: 10,
        });

        if (!result.result) {
          const message = result.errors?.map(error => error.message).join(', ')
            || 'Model recommendation failed.';
          return {
            content: [{ type: 'text' as const, text: `## Error\n\n${message}` }],
            isError: true,
          };
        }

        const models = result.tool ?? [];
        const total = Number.parseInt(String(result.total ?? models.length), 10) || models.length;
        const firstModel = models[0];

        if (!models.length) {
          return {
            content: [{
              type: 'text' as const,
              text: `No models found for "${task}". Try a different description or use \`search_models\` with specific categories.`,
            }],
            structuredContent: {
              models: [],
              total,
              start: 0,
              limit: 10,
              nextStart: null,
            },
          };
        }

        const text = formatModelList(models, `## Recommended Models for "${task}" (${models.length} results)`);
        const footer = `\n\n*Use \`get_model_schema\` to see full parameters and pricing for any model.*`;

        return {
          content: [{ type: 'text' as const, text: text + footer }],
          structuredContent: {
            models: models.map(toStructuredModel),
            total,
            start: 0,
            limit: 10,
            nextStart: null,
            nextAction: {
              tool: 'get_model_schema',
              arguments: {
                model: `${firstModel.cleanslugowner}/${firstModel.cleanslugproject}`,
              },
              reason: 'Inspect the selected model parameters before running it.',
            },
          },
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `## Error\n\n${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    },
  );
}
