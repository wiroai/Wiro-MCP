import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WiroClient } from '../client.js';
import { errorResult, requireApiSuccess, type ApiEnvelope } from '../utils/api.js';
import {
  formatWorkflowInputs,
  parseWorkflowSlug,
  toWorkflowDetail,
  workflowDetailSchema,
} from '../utils/workflow.js';
import { nextActionSchema } from './schemas.js';

export interface WorkflowDetailResponse extends ApiEnvelope {
  workflow?: Array<Record<string, unknown>>;
}

export async function fetchWorkflowRow(
  client: WiroClient,
  fullSlug: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const result = requireApiSuccess(
    await client.post<WorkflowDetailResponse>('/Workflow/Detail', { slug: fullSlug }, signal),
    'Workflow not found.',
  );
  const row = result.workflow?.[0];
  if (!row) throw new Error('Workflow not found.');
  return row;
}

export function registerGetWorkflow(server: McpServer, client: WiroClient): void {
  server.registerTool(
    'get_workflow',
    {
      title: 'Get a Wiro workflow',
      description: 'Read one workflow: its inputs (the keys run_workflow takes), outputs, '
        + 'state, and the full step graph when you are allowed to see it. Read this before '
        + 'running a workflow, and before editing one with update_workflow (pass the returned '
        + '`updatetime` back as `loaded_updatetime`). Protected workflows from other creators '
        + 'show only their inputs, but they can still be run. Input lists and saved values hide '
        + 'the values of fields named like api_key, token, secret or password, and values that '
        + 'look like a provider key. Other saved values come back as saved: never repeat a key '
        + 'you see there.',
      inputSchema: {
        slug: z.string().min(1)
          .describe('The full workflow slug ("<name>-<5 character id>") or the workflow page URL.'),
        include_graph: z.boolean().default(true)
          .describe('Include the step graph (contents). Set false for a short answer.'),
      },
      outputSchema: {
        workflow: workflowDetailSchema,
        nextAction: nextActionSchema.optional(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ slug, include_graph }, extra) => {
      try {
        const fullSlug = parseWorkflowSlug(slug);
        const row = await fetchWorkflowRow(client, fullSlug, extra.signal);
        const workflow = toWorkflowDetail(row, { includeGraph: include_graph });

        // Wiro shows a protected workflow's graph only inside its own workspace. A
        // run keeps the saved values for the owner and the team's members, whatever
        // workspace their key is in, and leaves them out for anyone else. A caller
        // outside the workflow's workspace can still own it or be in its team, so
        // the text names both cases.
        const leftOut = workflow.graphHidden && !workflow.insider
          ? 'This protected workflow is outside this key\'s workspace. Unless you own it or are in its team, a key you leave out uses its default, not its saved value, so pass the saved values you want.'
          : 'A key you leave out uses its saved value or default.';
        const lines = [`## ${workflow.title}`, ''];
        lines.push(`**Slug:** \`${workflow.fullSlug}\``);
        lines.push(`**Page:** ${workflow.url}`);
        if (workflow.state) lines.push(`**State:** ${workflow.state}`);
        if (workflow.updatetime && workflow.insider) lines.push(`**updatetime:** \`${workflow.updatetime}\` (pass it as loaded_updatetime when editing)`);
        const count = workflow.stepCount !== undefined ? `${workflow.stepCount}, ` : '';
        lines.push(`**Steps:** ${!workflow.graphHidden
          ? workflow.stepCount
          : workflow.isClone
            ? `${count}hidden. This is a copy of a protected workflow, so its steps stay hidden, even from you. You can run it and change its title, description and tags.`
            : `${count}hidden by the creator`}`);
        if (workflow.description) lines.push('', workflow.description);
        lines.push('', '### Inputs', '', ...formatWorkflowInputs(workflow.inputs));
        if (workflow.graphHidden && !workflow.insider && workflow.inputs.length > 0) lines.push('', leftOut);
        const outputs = Object.keys(workflow.outputs);
        if (outputs.length > 0) lines.push('', `### Outputs`, '', ...outputs.map(key => `- \`${key}\``));
        if (workflow.estimatedCost?.valueUsd !== undefined && workflow.estimatedCost.valueUsd !== null) {
          lines.push('', `**Estimated cost per run:** about $${workflow.estimatedCost.valueUsd}`);
        }
        if (workflow.contents) {
          lines.push('', 'The full step graph is in the structured result under `workflow.contents`.');
        }

        return {
          content: [{ type: 'text' as const, text: lines.join('\n') }],
          structuredContent: {
            workflow,
            nextAction: {
              tool: 'run_workflow',
              arguments: { slug: workflow.fullSlug },
              reason: 'Run it only if the user asked for a run, after telling them the estimate; otherwise ask the user first (each model step is charged). Pass input values'
                + (workflow.inputs.length > 0
                  ? ` for: ${workflow.inputs.map(input => input.key).join(', ')}. ${leftOut}`
                  : '. It has no inputs.'),
            },
          },
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
