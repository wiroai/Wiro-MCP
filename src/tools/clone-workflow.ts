import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WiroClient } from '../client.js';
import { ApiResultError, asString, errorResult, requireApiSuccess, toInteger, type ApiEnvelope } from '../utils/api.js';
import { fullSlugOf, parseWorkflowSlug, workflowUrl } from '../utils/workflow.js';
import { nextActionSchema } from './schemas.js';

interface CloneResponse extends ApiEnvelope {
  workflow?: Array<Record<string, unknown>>;
}

export function registerCloneWorkflow(server: McpServer, client: WiroClient): void {
  server.registerTool(
    'clone_workflow',
    {
      title: 'Clone a public Wiro workflow',
      description: 'Copy a published gallery workflow into the API key\'s workspace as a '
        + 'private workflow. Free. Each call makes another copy. You do not need a copy '
        + 'just to run a public workflow; clone it to keep it or to edit it. A copy of a '
        + 'protected workflow keeps its steps hidden: you can run it and change its title, '
        + 'description and tags, but not its steps.',
      inputSchema: {
        slug: z.string().min(1)
          .describe('The full slug or page URL of a published workflow from list_workflows scope "public".'),
      },
      outputSchema: {
        fullSlug: z.string(),
        url: z.string(),
        title: z.string(),
        isProtected: z.boolean(),
        nextAction: nextActionSchema,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ slug }, extra) => {
      try {
        const result = requireApiSuccess(
          await client.post<CloneResponse>('/Workflow/Clone', { slug: parseWorkflowSlug(slug) }, extra.signal),
          'The workflow could not be cloned.',
        );
        const row = result.workflow?.[0] ?? {};
        const fullSlug = fullSlugOf(row);
        if (!fullSlug) throw new Error('The workflow was cloned but its new slug did not come back. Find it with list_workflows.');
        const title = asString(row.title) ?? fullSlug;
        const isProtected = toInteger(row.isprotected) === 1;

        return {
          content: [{
            type: 'text' as const,
            text: `## Workflow cloned\n\n**Title:** ${title}\n**Slug:** \`${fullSlug}\`\n**Page:** ${workflowUrl(fullSlug)}`
              + (isProtected ? '\n\nThe original is protected, so the copy\'s steps stay hidden. You can still run it.' : ''),
          }],
          structuredContent: {
            fullSlug,
            url: workflowUrl(fullSlug),
            title,
            isProtected,
            nextAction: {
              tool: 'get_workflow',
              arguments: { slug: fullSlug },
              reason: 'Read the copy\'s inputs and steps before running or editing it.',
            },
          },
        };
      } catch (error) {
        if (error instanceof ApiResultError) {
          const duplicate = 'To duplicate a workflow of your own, read it with get_workflow and save its '
            + 'workflow.contents with create_workflow under a new title.';
          // A published original that already lives in this key's workspace: a copy
          // there is a duplicate, not a clone.
          if (/already belongs to this workspace/i.test(error.message)) {
            return errorResult(new Error(`${error.message}\n\nA workflow cannot be cloned into the workspace it `
              + `already belongs to. ${duplicate} To change the workflow itself, use update_workflow.`));
          }
          // Every other refusal (missing, private, a copy, not approved) has one answer, so
          // a private workflow cannot be told from a missing one; the hint is the same too.
          if (/cannot be cloned/i.test(error.message)) {
            return errorResult(new Error(`${error.message}\n\nOnly a published workflow from the public gallery that is not `
              + 'itself a copy can be cloned; list_workflows with scope "public" finds them. To change a workflow of '
              + `your own, edit it with update_workflow. ${duplicate} A copy of a protected workflow cannot be `
              + 'duplicated, because its steps stay hidden.'));
          }
        }
        return errorResult(error);
      }
    },
  );
}
