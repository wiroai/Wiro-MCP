import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WiroClient } from '../client.js';
import { formatModelList } from '../utils/format.js';
import {
  missingWordsNote,
  partialSearchNote,
  readSearchFallback,
  SEARCH_WORDS_HINT,
  searchFallbackFields,
} from '../utils/search-fallback.js';
import { toStructuredModel } from '../utils/structured.js';
import { modelListOutputSchema, strictInput } from './schemas.js';

export function registerRecommendModel(server: McpServer, client: WiroClient): void {
  server.registerTool(
    'recommend_model',
    {
      title: 'Recommend Wiro models',
      description: 'Find models for a goal from two or three key words that name the task or the model, such as '
        + '"upscale image", "remove background" or "text to image", best matches first. A model matches when one of '
        + 'its fields has every word. Style and subject words, such as "flat illustration" or "coffee cup", describe '
        + 'the output, so they belong in the prompt. A result for only part of the words names the words it left out. '
        + 'For a kind of task, search_models with categories also works. Follow the returned `get_model_schema` '
        + 'next action before running a model.',
      inputSchema: strictInput({
        task: z.string().describe('Two or three key words that name the task or the model, e.g. "upscale image", "remove background", "transcribe audio".'),
      }),
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
        const fallback = readSearchFallback(result);

        if (!models.length) {
          const missing = fallback ? ` ${missingWordsNote(fallback)}` : '';
          return {
            content: [{
              type: 'text' as const,
              text: `No models found for "${task}".${missing} ${SEARCH_WORDS_HINT} For a kind of task, \`search_models\` with categories also works.`,
            }],
            structuredContent: {
              models: [],
              total,
              start: 0,
              limit: 10,
              nextStart: null,
              ...searchFallbackFields(fallback),
            },
          };
        }

        const shownFor = fallback?.used || task;
        const note = fallback ? `${partialSearchNote(task, fallback)}\n\n` : '';
        const text = formatModelList(models, `## Recommended Models for "${shownFor}" (${models.length} results)`);
        const footer = `\n\n*Use \`get_model_schema\` to see full parameters and pricing for any model.*`;

        return {
          content: [{ type: 'text' as const, text: note + text + footer }],
          structuredContent: {
            models: models.map(toStructuredModel),
            total,
            start: 0,
            limit: 10,
            nextStart: null,
            ...searchFallbackFields(fallback),
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
