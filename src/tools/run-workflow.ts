import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WiroClient } from '../client.js';
import {
  errorResult,
  errorText,
  hasErrorCode,
  isOutcomeUnknown,
  requireApiSuccess,
  type ApiEnvelope,
} from '../utils/api.js';
import { DEFAULT_WAIT_SECONDS, MAX_WAIT_SECONDS } from '../utils/poll.js';
import { parseWorkflowSlug } from '../utils/workflow.js';
import {
  readWorkflowRun,
  waitForWorkflowRun,
  workflowRunOutputSchema,
  workflowRunResult,
} from './wait-for-workflow-run.js';

interface RunResponse extends ApiEnvelope {
  workflowtoken?: string;
}

// Values that stand in for a secret the caller was not shown.
const PLACEHOLDER_VALUES = new Set(['[hidden]', '[REDACTED]', '[OMITTED]']);

/** The slug part a run search matches: the full slug minus its 5-character id. */
function slugWithoutId(fullSlug: string): string {
  return fullSlug.replace(/-[A-Za-z0-9]{5}$/, '');
}

async function findRunStartedSince(
  client: WiroClient,
  fullSlug: string,
  since: number,
  signal?: AbortSignal,
): Promise<string | undefined> {
  try {
    const history = await client.post<ApiEnvelope & { workflowruns?: Array<Record<string, unknown>> }>(
      '/Workflow/RunHistory',
      { search: slugWithoutId(fullSlug), limit: 10, sort: 'id', order: 'DESC' },
      signal,
    );
    if (history.result !== true) return undefined;
    // Allow for a small clock difference between this machine and Wiro.
    const match = (history.workflowruns ?? []).find(run => run.workflowslug === fullSlug
      && typeof run.workflowtoken === 'string'
      && Number(run.startedAt) >= since - 60_000);
    return match ? String(match.workflowtoken) : undefined;
  } catch {
    return undefined;
  }
}

export const workflowInputValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.string()),
]);

export function registerRunWorkflow(server: McpServer, client: WiroClient): void {
  server.registerTool(
    'run_workflow',
    {
      title: 'Run a Wiro workflow',
      description: 'Start a workflow run and wait for it up to `wait_seconds`. Costs money: '
        + 'every model step is charged to the wallet like a normal model run when it '
        + 'finishes, and the run needs at least $0.50 of balance per model step to start. '
        + 'A started run cannot be cancelled, so start it only when the user asked for this '
        + 'run, and tell them the estimate first. To try only the first steps, pass '
        + '`breakpoint_node_id`: the run stops after that step\'s layer and can be '
        + 'continued with resume_workflow_run. Read the input keys with get_workflow '
        + 'first. If the run is still going when the wait ends, continue with '
        + 'wait_for_workflow_run; never call run_workflow again for the same job.',
      inputSchema: {
        slug: z.string().min(1)
          .describe('The full workflow slug ("<name>-<5 character id>") or the workflow page URL.'),
        input: z.record(z.string(), workflowInputValueSchema).optional()
          .describe('Values for the workflow\'s inputs, keyed exactly as get_workflow lists them. '
            + 'File inputs take public http(s) URLs; a file that is only on the user\'s device needs a public link first. '
            + 'Omitted inputs use the saved value, then the default.'),
        breakpoint_node_id: z.string().max(100).optional()
          .describe('Optional step id ("node-...") to stop after, for testing the first steps. '
            + 'Only for workflows you can edit. Not the last step.'),
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
    async ({ slug, input, breakpoint_node_id, wait_seconds }, extra) => {
      try {
        const fullSlug = parseWorkflowSlug(slug);
        const body: Record<string, unknown> = { slug: fullSlug };
        if (input && Object.keys(input).length > 0) {
          const hidden = Object.entries(input)
            .filter(([, value]) => typeof value === 'string' && PLACEHOLDER_VALUES.has(value))
            .map(([key]) => key);
          if (hidden.length > 0) {
            throw new Error(`Input ${hidden.map(key => `"${key}"`).join(', ')} is a placeholder for a hidden value, not a real value. `
              + 'Leave that key out to use its saved value, or pass the real value.');
          }
          body.input = input;
        }
        if (breakpoint_node_id) body.breakpointNodeId = breakpoint_node_id;

        let workflowtoken: string | undefined;
        const requestedAt = Date.now();
        try {
          workflowtoken = requireApiSuccess(
            await client.post<RunResponse>('/Workflow/Run', body, extra.signal),
            'The workflow could not be started.',
          ).workflowtoken;
        } catch (error) {
          if (hasErrorCode(error, 97)) {
            throw new Error(`${(error as Error).message} The wallet does not cover this workflow's `
              + 'minimum balance. Check it with get_account and add funds on wiro.ai.');
          }
          if (!isOutcomeUnknown(error)) throw error;
          // The run may exist even though its answer was lost: look for it before
          // anyone starts (and pays for) a second one.
          workflowtoken = await findRunStartedSince(client, fullSlug, requestedAt, extra.signal);
          if (!workflowtoken) {
            throw new Error(`The run request was sent but no clear answer came back (${errorText(error)}), and no new run `
              + 'of this workflow shows up yet. It may still appear. Before running it again, check list_workflow_runs '
              + `with search "${slugWithoutId(fullSlug)}" for a run of ${fullSlug} that started in the last few minutes.`);
          }
        }
        if (!workflowtoken) throw new Error('The workflow was started but no run token came back.');

        try {
          const { run } = wait_seconds > 0
            ? await waitForWorkflowRun(client, workflowtoken, wait_seconds, extra)
            : await readWorkflowRun(client, workflowtoken, extra.signal);
          return workflowRunResult(run);
        } catch {
          // The run exists and is being charged; hand back its token so the
          // caller keeps waiting instead of starting it a second time.
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
