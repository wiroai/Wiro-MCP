import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WiroClient } from '../client.js';
import {
  errorResult,
  errorText,
  isOutcomeUnknown,
  requireApiSuccess,
  type ApiEnvelope,
} from '../utils/api.js';
import { DEFAULT_WAIT_SECONDS, MAX_WAIT_SECONDS } from '../utils/poll.js';
import {
  readWorkflowRun,
  waitForWorkflowRun,
  workflowRunOutputSchema,
  workflowRunResult,
} from './wait-for-workflow-run.js';

export function registerResumeWorkflowRun(server: McpServer, client: WiroClient): void {
  server.registerTool(
    'resume_workflow_run',
    {
      title: 'Resume a Wiro workflow run',
      description: 'Continue a workflow run that failed or stopped at a breakpoint, on the '
        + 'same run token. Steps run as the run started them, with the same inputs and '
        + 'settings: changes saved to the workflow since then apply to new runs only. '
        + 'Completed steps are kept and not charged again; failed, skipped '
        + 'and not-yet-run steps run again as new model runs and are charged to the wallet '
        + 'that paid for the original run. Ask the user before resuming, unless they asked you to '
        + 'continue this run: then give the expected cost in one line and resume. Use it only when '
        + 'wait_for_workflow_run reports `canResume: true`.',
      inputSchema: {
        workflowtoken: z.string().min(1).describe('The run token of a failed or stopped run.'),
        breakpoint_node_id: z.string().max(100).nullable().optional()
          .describe('Optional step id to stop after this time. Leave it out and a failed run keeps the '
            + 'breakpoint it started with, while a stopped run runs to the end. Pass null to run to the end.'),
        wait_seconds: z.number().int().min(0).max(MAX_WAIT_SECONDS).default(DEFAULT_WAIT_SECONDS)
          .describe(`How long to wait for the result (0-${MAX_WAIT_SECONDS} seconds, default ${DEFAULT_WAIT_SECONDS}).`),
      },
      outputSchema: workflowRunOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ workflowtoken, breakpoint_node_id, wait_seconds }, extra) => {
      try {
        const body: Record<string, unknown> = { workflowtoken };
        if (breakpoint_node_id !== undefined) body.breakpointNodeId = breakpoint_node_id;
        try {
          requireApiSuccess(
            await client.post<ApiEnvelope>('/Workflow/RunResume', body, extra.signal),
            'The run could not be resumed.',
          );
        } catch (error) {
          if (isOutcomeUnknown(error)) {
            throw new Error(`The resume request was sent but no clear answer came back (${errorText(error)}). `
              + 'The run may already be running again and charging. Check it with wait_for_workflow_run '
              + '(wait_seconds 0) before resuming again.');
          }
          throw error;
        }

        try {
          const { run } = wait_seconds > 0
            ? await waitForWorkflowRun(client, workflowtoken, wait_seconds, extra)
            : await readWorkflowRun(client, workflowtoken, extra.signal);
          return workflowRunResult(run);
        } catch {
          return workflowRunResult({
            workflowtoken,
            status: 'running',
            canResume: false,
            outputs: {},
            steps: [],
            counts: { failed: 0, aborted: 0, cancelled: 0, pending: 0, running: 0, completed: 0 },
          });
        }
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
