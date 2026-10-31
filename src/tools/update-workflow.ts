import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WiroClient } from '../client.js';
import { errorResult } from '../utils/api.js';
import { formatWorkflowInputs, parseWorkflowSlug } from '../utils/workflow.js';
import {
  formatWorkflowChanges,
  prepareIssuesText,
  tagProblem,
  updateWorkflow,
  WorkflowConflictError,
  WorkflowPrepareError,
  type UpdatedWorkflow,
} from '../utils/workflow-save.js';
import { savedWorkflowSchema, workflowContentsInputSchema } from './create-workflow.js';

export const workflowChangesSchema = z.object({
  stepsAdded: z.array(z.string()),
  stepsRemoved: z.array(z.string()),
  stepsChanged: z.array(z.string()),
  inputsAdded: z.array(z.string()),
  inputsRemoved: z.array(z.string()),
  inputsChanged: z.array(z.string()),
  savedValuesChanged: z.array(z.string()),
  outputsChanged: z.boolean(),
  layoutOnly: z.boolean(),
  titleChange: z.object({ from: z.string(), to: z.string() }).optional(),
  descriptionChanged: z.boolean(),
  tagsChanged: z.boolean(),
});

export const updatedWorkflowSchema = {
  ...savedWorkflowSchema,
  reviewReset: z.boolean(),
  contentsChanged: z.boolean(),
  unchanged: z.boolean(),
  discarded: z.array(z.string()).optional()
    .describe('With unchanged: Start field changes Wiro does not keep, because it saves Start fields the way the wiro.ai editor writes them.'),
  preview: z.boolean().optional(),
  changes: workflowChangesSchema.optional(),
};

/** Markdown for an update or its preview. */
export function formatUpdatedWorkflow(saved: UpdatedWorkflow, heading: string): string {
  const lines = [heading, ''];
  lines.push(`**Title:** ${saved.title}`);
  lines.push(`**Slug:** \`${saved.fullSlug}\``);
  if (saved.unchanged) {
    lines.push('', saved.discarded?.length
      ? `Wiro saves Start fields the way the wiro.ai editor writes them, so your change to ${saved.discarded.join(', ')} `
        + 'is not kept. Nothing else changed, so nothing was saved. Put guidance for people in '
        + 'the workflow description.'
      : 'The workflow already matches this change, so nothing was saved.');
  }
  if (saved.changes) {
    lines.push('', saved.preview ? '### What will change' : '### What changed', '', ...formatWorkflowChanges(saved.changes));
  }
  if (saved.preview) {
    lines.push('', 'Nothing is saved yet. The new steps replace the current ones and there is no undo.'
      + (saved.reviewReset ? ' The workflow is published, so saving takes it out of the gallery until Wiro reviews it again.' : ''));
  } else if (saved.reviewReset) {
    lines.push('', 'The workflow left the public gallery and is waiting for review again.');
  }
  if (!saved.preview && saved.updatetime) {
    lines.push('', `**updatetime:** \`${saved.updatetime}\` (pass it as loaded_updatetime next time)`);
  }
  if (saved.contentsChanged) lines.push('', '### Inputs', '', ...formatWorkflowInputs(saved.inputs));
  if (saved.warnings.length > 0) {
    lines.push('', '### Notes', '', ...saved.warnings.map(warning => `- ${warning.nodeId ? `\`${warning.nodeId}\`: ` : ''}${warning.message}`));
  }
  return lines.join('\n');
}

export function registerUpdateWorkflow(server: McpServer, client: WiroClient): void {
  server.registerTool(
    'update_workflow',
    {
      title: 'Update a Wiro workflow',
      description: 'Change a workflow you own (or your team owns): title, description, tags '
        + 'and/or its whole step graph. Read it with get_workflow first and send the full '
        + 'edited `contents`, plus that call\'s `updatetime` as `loaded_updatetime` so a '
        + 'newer save by someone else is not overwritten. Leave metadata.input.values out to '
        + 'keep the saved input values; a value shown as [hidden] is restored from the saved '
        + 'workflow. Everyone who can open the workflow can read its saved values, so never '
        + 'save a key or password in one. Wiro checks and prepares the new graph like '
        + 'create_workflow, with the same 40 KB limit on the new graph, also when the saved workflow '
        + 'is larger (removing steps can bring it under). Replacing the steps cannot be undone: without `confirm: true` '
        + 'the call checks the new graph, reports any problems and the defaults it filled, and '
        + 'returns what would change, saving nothing; show it to the user and repeat the call '
        + 'with `confirm: true` after they agree. Editing a published workflow takes it out of '
        + 'the public gallery until Wiro reviews it again, so that also needs '
        + '`acknowledge_review_reset: true`.',
      inputSchema: {
        slug: z.string().min(1).describe('The full workflow slug or the workflow page URL.'),
        title: z.string().trim().min(1).max(160).optional().describe('New title.'),
        description: z.string().min(1).max(1000).optional().describe('New description, 1 to 1000 characters.'),
        tags: z.array(z.string()).max(20).optional().describe('Replaces the tags.'),
        contents: workflowContentsInputSchema.optional(),
        loaded_updatetime: z.string().optional()
          .describe('The `updatetime` from get_workflow (or the last update). Protects against overwriting newer changes.'),
        confirm: z.boolean().default(false)
          .describe('Required to save new `contents`, after the user approved the change summary.'),
        force: z.boolean().default(false)
          .describe('Overwrite a newer version. Only when the user explicitly wants that.'),
        acknowledge_review_reset: z.boolean().default(false)
          .describe('Required to edit a published workflow, after the user agreed it leaves the gallery until reviewed.'),
      },
      outputSchema: updatedWorkflowSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args, extra) => {
      try {
        const problem = args.tags ? tagProblem(args.tags) : null;
        if (problem) throw new Error(problem);
        if (!args.title && !args.description && !args.tags && !args.contents) {
          throw new Error('Nothing to change. Pass title, description, tags or contents.');
        }

        const fullSlug = parseWorkflowSlug(args.slug);
        const saved = await updateWorkflow(client, {
          fullSlug,
          title: args.title,
          description: args.description,
          tags: args.tags,
          contents: args.contents,
          loadedUpdatetime: args.loaded_updatetime,
          force: args.force,
          acknowledgeReviewReset: args.acknowledge_review_reset,
          preview: Boolean(args.contents) && !args.confirm,
        }, extra.signal);

        if (saved.preview) {
          return {
            content: [{ type: 'text' as const, text: formatUpdatedWorkflow(saved, '## Review the change before saving') }],
            structuredContent: {
              ...saved,
              nextAction: {
                tool: 'update_workflow',
                arguments: {
                  slug: fullSlug,
                  ...(args.title ? { title: args.title } : {}),
                  ...(args.description ? { description: args.description } : {}),
                  ...(args.tags ? { tags: args.tags } : {}),
                  contents: args.contents,
                  ...(saved.updatetime ? { loaded_updatetime: args.loaded_updatetime ?? saved.updatetime } : {}),
                  confirm: true,
                  ...(args.force ? { force: true } : {}),
                  ...(saved.reviewReset ? { acknowledge_review_reset: true } : {}),
                },
                reason: 'Show the user what will change and save only after they agree.',
              },
            },
          };
        }

        const heading = saved.unchanged ? (saved.discarded ? '## Nothing saved' : '## No change needed') : '## Workflow updated';
        return {
          content: [{ type: 'text' as const, text: formatUpdatedWorkflow(saved, heading) }],
          structuredContent: { ...saved },
        };
      } catch (error) {
        if (error instanceof WorkflowPrepareError) {
          return { content: [{ type: 'text' as const, text: prepareIssuesText(error) }], isError: true };
        }
        if (error instanceof WorkflowConflictError) {
          return {
            content: [{
              type: 'text' as const,
              text: `## Not saved: newer changes exist\n\n${error.message}`
                + (error.currentUpdatetime ? `\n\nCurrent updatetime: \`${error.currentUpdatetime}\`` : ''),
            }],
            isError: true,
          };
        }
        return errorResult(error);
      }
    },
  );
}
