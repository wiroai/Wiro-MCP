import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WiroClient } from '../client.js';
import { errorResult, isPlainObject } from '../utils/api.js';
import { formatWorkflowInputs, workflowInputSchema } from '../utils/workflow.js';
import {
  createWorkflow,
  findHiddenValues,
  prepareIssuesText,
  tagProblem,
  WorkflowPrepareError,
} from '../utils/workflow-save.js';
import { nextActionSchema } from './schemas.js';

export const prepareIssueSchema = z.object({
  code: z.string().optional(),
  message: z.string(),
  nodeId: z.string().optional(),
  input: z.string().optional(),
});

export const savedWorkflowSchema = {
  fullSlug: z.string(),
  url: z.string(),
  title: z.string(),
  renamed: z.boolean(),
  state: z.enum(['private', 'pending_review', 'published', 'rejected']).optional(),
  updatetime: z.string().optional(),
  inputs: z.array(workflowInputSchema),
  outputs: z.record(z.string(), z.unknown()),
  warnings: z.array(prepareIssueSchema),
  nextAction: nextActionSchema.optional(),
};

export const workflowContentsInputSchema = z.record(z.string(), z.unknown())
  .describe('The workflow graph (version "1"): {version, nodes, output, schema, metadata}. '
    + 'Read get_playbook topic "workflow-graph" for the format and an example.');

export function registerCreateWorkflow(server: McpServer, client: WiroClient): void {
  server.registerTool(
    'create_workflow',
    {
      title: 'Create a Wiro workflow',
      description: 'Save a new private workflow in the API key\'s workspace from a step graph. '
        + 'Read get_playbook topic "workflow-graph" first: it has the graph format, the reference '
        + 'syntax and examples. Check every model\'s parameter ids with get_model_schema. Wiro '
        + 'checks the graph against the live model catalog, fills catalog defaults and lays the '
        + 'steps out before saving; every problem it finds comes back together, so fix them all '
        + 'and call again. Set every model input you care about: a left-out one gets the model\'s '
        + 'default, which for some models is the sample prompt or sample images from its page '
        + '(the Notes in the result list what was filled). The graph can be at most 40 KB of JSON '
        + 'with those defaults. Free. Each call creates another workflow. The result gives the '
        + 'full slug, the page link and the input keys, so no get_workflow call is needed to run it.',
      inputSchema: {
        title: z.string().trim().min(1).max(160).describe('Workflow title (1-160 characters).'),
        contents: workflowContentsInputSchema,
        description: z.string().max(1000).optional().describe('What the workflow does (up to 1000 characters).'),
        tags: z.array(z.string()).max(20).optional().describe('Up to 20 tags.'),
      },
      outputSchema: savedWorkflowSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ title, contents, description, tags }, extra) => {
      try {
        const problem = tags ? tagProblem(tags) : null;
        if (problem) throw new Error(problem);
        if (!isPlainObject(contents.nodes) || !isPlainObject(contents.nodes.output)) {
          throw new Error('contents.nodes must include the End node "output". See get_playbook topic "workflow-graph".');
        }
        const hidden = findHiddenValues(contents);
        if (hidden.length > 0) {
          throw new Error(`Some values are placeholders for hidden secrets (${hidden.join(', ')}). `
            + 'Set real values or leave those inputs out.');
        }

        const saved = await createWorkflow(client, { title, contents, description, tags }, extra.signal);
        const lines = ['## Workflow created', ''];
        lines.push(`**Title:** ${saved.title}${saved.renamed ? ' (renamed because the title was already used)' : ''}`);
        lines.push(`**Slug:** \`${saved.fullSlug}\``);
        lines.push(`**Page:** ${saved.url}`);
        lines.push('', '### Inputs', '', ...formatWorkflowInputs(saved.inputs));
        if (saved.warnings.length > 0) {
          lines.push('', '### Notes', '', ...saved.warnings.map(warning => `- ${warning.nodeId ? `\`${warning.nodeId}\`: ` : ''}${warning.message}`));
        }

        return {
          content: [{ type: 'text' as const, text: lines.join('\n') }],
          structuredContent: {
            ...saved,
            nextAction: {
              tool: 'run_workflow',
              arguments: { slug: saved.fullSlug },
              reason: 'Run it only if the user asked for a run, after telling them the estimate; otherwise ask the user first (each model step is charged). Pass input values'
                + (saved.inputs.length > 0
                  ? ` for: ${saved.inputs.map(input => input.key).join(', ')}. A key you leave out uses its saved value or default.`
                  : '. It has no inputs.'),
            },
          },
        };
      } catch (error) {
        if (error instanceof WorkflowPrepareError) {
          return {
            content: [{ type: 'text' as const, text: prepareIssuesText(error) }],
            isError: true,
          };
        }
        return errorResult(error);
      }
    },
  );
}
