import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WiroClient } from '../client.js';
import { formatTaskResult } from '../utils/format.js';

export function registerRunModel(server: McpServer, client: WiroClient): void {
  server.tool(
    'run_model',
    'Run any AI model on Wiro. Supports image generation, video generation, LLMs, audio, 3D, and more.\n\n' +
    'Use `get_model_schema` first to discover available parameters.\n\n' +
    'With wait=true (default), polls until completion and returns the result.\n' +
    'With wait=false, returns the task token immediately for async monitoring.',
    {
      model: z.string().describe('Model slug in "owner/model" format, e.g. "openai/sora-2", "google/nano-banana-pro"'),
      params: z.record(z.string(), z.unknown()).describe('Model-specific parameters as key-value pairs. Use get_model_schema to discover available parameters. For file parameters (fileinput, multifileinput, combinefileinput), pass URLs directly — no upload needed. For combinefileinput, pass an array of URLs.'),
      wait: z.boolean().default(true).describe('If true, poll until completion and return result. If false, return task token immediately.'),
      timeout_seconds: z.number().int().min(10).max(600).default(120).describe('Max seconds to wait for completion (only when wait=true)'),
    },
    async ({ model, params, wait, timeout_seconds }) => {
      try {
        const runResult = await client.runModel(model, params);

        if (!runResult.result) {
          const errors = runResult.errors?.map(e => e.message).join(', ') || 'Unknown error';
          return {
            content: [{ type: 'text' as const, text: `## Error\n\nFailed to run model: ${errors}` }],
            isError: true,
          };
        }

        if (!wait) {
          return {
            content: [{
              type: 'text' as const,
              text: `## Task Submitted\n\n` +
                `**Task ID:** ${runResult.taskid}\n` +
                `**Task Token:** ${runResult.socketaccesstoken}\n\n` +
                `Use \`get_task\` with this token to check results.`,
            }],
          };
        }

        const detail = await client.waitForTask(
          runResult.socketaccesstoken,
          timeout_seconds * 1000,
        );

        const task = detail.tasklist?.[0];
        if (!task) {
          return {
            content: [{ type: 'text' as const, text: '## Error\n\nNo task data returned.' }],
            isError: true,
          };
        }

        return {
          content: [{ type: 'text' as const, text: formatTaskResult(task) }],
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
