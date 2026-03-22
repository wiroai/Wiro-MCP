import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WiroClient } from '../client.js';
import { formatModelSchema } from '../utils/format.js';

export function registerGetModelSchema(server: McpServer, client: WiroClient): void {
  server.tool(
    'get_model_schema',
    'Get the full parameter schema for a specific model. Shows parameter names, types, options, defaults, and required fields. Use this before run_model to understand what parameters a model accepts.',
    {
      model: z.string().describe('Model slug in "owner/model" format, e.g. "openai/sora-2", "black-forest-labs/flux-2-pro"'),
    },
    async ({ model }) => {
      try {
        const result = await client.getModelSchema(model);

        const modelData = result.tool?.[0];
        if (!result.result || !modelData) {
          return {
            content: [{ type: 'text' as const, text: `Model "${model}" not found.` }],
            isError: true,
          };
        }

        const text = formatModelSchema(modelData);

        return {
          content: [{ type: 'text' as const, text }],
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
