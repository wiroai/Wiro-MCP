import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WiroClient } from '../client.js';
import { errorResult, requireApiSuccess, type ApiEnvelope } from '../utils/api.js';
import { parseWorkflowSlug, toWorkflowDetail } from '../utils/workflow.js';
import { postWithReplicaRetry } from '../utils/workflow-save.js';
import { fetchWorkflowRow } from './get-workflow.js';
import { nextActionSchema } from './schemas.js';

export function registerDeleteWorkflow(server: McpServer, client: WiroClient): void {
  server.registerTool(
    'delete_workflow',
    {
      title: 'Delete a Wiro workflow',
      description: 'Delete a workflow from the API key\'s workspace, for everyone: it leaves '
        + 'every list and the gallery, can no longer be run, and cannot be restored. Runs '
        + 'already started finish, and copies made from it keep working. With a team '
        + 'project\'s key this includes teammates\' workflows. Without `confirm: true` this '
        + 'only describes what would be deleted; ask the user, then call again with '
        + '`confirm: true`.',
      inputSchema: {
        slug: z.string().min(1).describe('The full workflow slug or the workflow page URL.'),
        confirm: z.boolean().default(false).describe('Set true only after the user approved the deletion.'),
      },
      outputSchema: {
        deleted: z.boolean(),
        fullSlug: z.string(),
        title: z.string().optional(),
        message: z.string(),
        nextAction: nextActionSchema.optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ slug, confirm }, extra) => {
      try {
        const fullSlug = parseWorkflowSlug(slug);
        if (!confirm) {
          const workflow = toWorkflowDetail(await fetchWorkflowRow(client, fullSlug, extra.signal), { includeGraph: false });
          const message = `This will permanently delete "${workflow.title}" (${fullSlug})`
            + (workflow.state === 'published' ? ', which is published in the public gallery' : '')
            + '. It cannot be restored.';
          return {
            content: [{ type: 'text' as const, text: `## Confirm deletion\n\n${message}\n\nAsk the user, then call delete_workflow again with confirm: true.` }],
            structuredContent: {
              deleted: false,
              fullSlug,
              title: workflow.title,
              message,
              nextAction: {
                tool: 'delete_workflow',
                arguments: { slug: fullSlug, confirm: true },
                reason: 'Ask the user to approve the deletion first.',
              },
            },
          };
        }

        const response = await postWithReplicaRetry<ApiEnvelope>(client, '/Workflow/Delete', { slug: fullSlug }, extra.signal);
        if (response.result !== true
          && (response.errors ?? []).some(error => /workflow not found/i.test(String(error?.message ?? '')))) {
          // Detail may still find it: report "not deleted yet" rather than "already gone".
          const check = await client.post<ApiEnvelope & { workflow?: unknown[] }>('/Workflow/Detail', { slug: fullSlug }, extra.signal);
          if (check.result === true && Array.isArray(check.workflow) && check.workflow.length > 0) {
            throw new Error('The workflow exists but could not be deleted yet. Try again in a few seconds.');
          }
        }
        requireApiSuccess(response, 'The workflow could not be deleted.');
        const message = `Deleted ${fullSlug}.`;
        return {
          content: [{ type: 'text' as const, text: message }],
          structuredContent: { deleted: true, fullSlug, message },
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
