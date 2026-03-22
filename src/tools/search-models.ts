import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WiroClient } from '../client.js';
import { formatModelList } from '../utils/format.js';

export function registerSearchModels(server: McpServer, client: WiroClient): void {
  server.tool(
    'search_models',
    'Search and browse AI models on Wiro. Returns model names, slugs, descriptions, and categories. Use this to discover available models before running them.',
    {
      search: z.string().optional().describe('Search keyword, e.g. "flux", "video generation", "upscale"'),
      categories: z.array(z.string()).optional().describe('Filter by categories, e.g. ["text-to-image", "text-to-video", "llm"]'),
      start: z.number().int().min(0).optional().describe('Pagination offset (default 0)'),
      limit: z.number().int().min(1).max(100).optional().describe('Max results to return (default 20, max 100)'),
    },
    async ({ search, categories, start, limit }) => {
      try {
        const result = await client.searchModels({ search, categories, start, limit });

        if (!result.result || !result.tool?.length) {
          return {
            content: [{ type: 'text' as const, text: 'No models found matching your criteria.' }],
          };
        }

        const text = formatModelList(result.tool);
        const total = result.total ? `\n\n*Total available: ${result.total}*` : '';

        return {
          content: [{ type: 'text' as const, text: text + total }],
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
