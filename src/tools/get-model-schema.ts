import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WiroClient } from '../client.js';
import { formatModelSchema } from '../utils/format.js';
import { toStructuredModelDetail } from '../utils/structured.js';
import { modelDetailOutputSchema } from './schemas.js';

export function registerGetModelSchema(server: McpServer, client: WiroClient): void {
  server.registerTool(
    'get_model_schema',
    {
      title: 'Get a Wiro model schema',
      description: 'Get one model’s typed parameters, options, defaults, required '
        + 'fields, and pricing. Fill its required parameters and follow the '
        + 'returned `run_model` next action exactly once.',
      inputSchema: {
        model: z.string().describe('Model slug in "owner/model" format, e.g. "openai/sora-2", "black-forest-labs/flux-2-pro".'),
      },
      outputSchema: modelDetailOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
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
          structuredContent: toStructuredModelDetail(modelData),
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
