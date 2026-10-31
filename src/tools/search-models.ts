import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WiroClient } from '../client.js';
import { formatModelList } from '../utils/format.js';
import { toStructuredModel } from '../utils/structured.js';
import { modelListOutputSchema } from './schemas.js';

export function registerSearchModels(server: McpServer, client: WiroClient): void {
  server.registerTool(
    'search_models',
    {
      title: 'Search Wiro models',
      description: 'Search and browse AI models on Wiro. Each row shows the model\'s price; '
        + '`get_model_schema` shows how it depends on settings such as resolution. Choose a '
        + 'model and call the returned `get_model_schema` next action before using `run_model`.',
      inputSchema: {
        search: z.string().optional().describe('One to three key words, e.g. "flux", "upscale" or "remove background"; each extra word narrows the results. It looks at each model\'s name and owner, its description, its parameters (id, label, placeholder, notes and help) and the option names of a selectwithcover field, such as an effect. Case, spaces, dots, dashes and underscores are ignored, and a short stem such as "timestamp" also finds the longer words that contain it.'),
        categories: z.array(z.string()).optional().describe(
          'Filter by categories. Available: "text-to-image", "image-to-image", "image-editing", '
          + '"text-to-video", "image-to-video", "speech-to-video", "talking-head", '
          + '"text-to-speech", "speech-to-text", "text-to-music", "text-to-song", "voice-clone", "realtime-conversation", '
          + '"3d-generation", "chat", "llm", "llm-reasoning", "rag".',
        ),
        slugowner: z.string().optional().describe('Filter by model owner slug.'),
        sort: z.enum(['relevance', 'time', 'ratedusercount', 'commentcount', 'averagepoint']).default('relevance')
          .describe('Sort by relevance, newest (time), number of ratings (ratedusercount), comments (commentcount) or average rating (averagepoint).'),
        start: z.number().int().min(0).default(0).describe('Pagination offset (default 0).'),
        limit: z.number().int().min(1).max(100).default(20).describe('Maximum results (default 20, max 100).'),
      },
      outputSchema: modelListOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ search, categories, slugowner, sort, start, limit }) => {
      try {
        const result = await client.searchModels({ search, categories, slugowner, sort, start, limit });

        if (!result.result) {
          const message = result.errors?.map(error => error.message).join(', ')
            || 'Model search failed.';
          return {
            content: [{ type: 'text' as const, text: `## Error\n\n${message}` }],
            isError: true,
          };
        }

        const models = result.tool ?? [];
        const total = Number.parseInt(String(result.total ?? '0'), 10) || 0;
        const nextStart = start + models.length < total
          ? start + models.length
          : null;
        const firstModel = models[0];

        if (!models.length) {
          return {
            content: [{ type: 'text' as const, text: 'No models found matching your criteria.' }],
            structuredContent: {
              models: [],
              total,
              start,
              limit,
              nextStart,
            },
          };
        }

        const text = formatModelList(models);
        const totalNote = result.total ? `\n\n*Total available: ${result.total}*` : '';

        return {
          content: [{ type: 'text' as const, text: text + totalNote }],
          structuredContent: {
            models: models.map(toStructuredModel),
            total,
            start,
            limit,
            nextStart,
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
