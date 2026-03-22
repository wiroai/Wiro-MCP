import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WiroClient } from '../client.js';
import { formatModelList } from '../utils/format.js';

export function registerRecommendModel(server: McpServer, client: WiroClient): void {
  server.tool(
    'recommend_model',
    'Describe what you want to build and get model recommendations ranked by relevance. Use natural language like "remove background from product photos" or "generate a 10-second cinematic video".',
    {
      task: z.string().describe('What you want to do, e.g. "generate a photorealistic portrait", "upscale an image to 4K", "transcribe audio to text"'),
    },
    async ({ task }) => {
      try {
        const result = await client.searchModels({
          search: task,
          sort: 'relevance',
          limit: 10,
        });

        if (!result.result || !result.tool?.length) {
          return {
            content: [{
              type: 'text' as const,
              text: `No models found for "${task}". Try a different description or use \`search_models\` with specific categories.`,
            }],
          };
        }

        const text = formatModelList(result.tool, `## Recommended Models for "${task}" (${result.tool.length} results)`);
        const footer = `\n\n*Use \`get_model_schema\` to see full parameters and pricing for any model.*`;

        return {
          content: [{ type: 'text' as const, text: text + footer }],
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
