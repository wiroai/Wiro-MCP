import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WiroClient } from '../client.js';
import { asString, errorResult, requireApiSuccess, truncate, type ApiEnvelope } from '../utils/api.js';
import { createMediaContent } from '../utils/media.js';
import {
  DEFAULT_WAIT_SECONDS,
  MAX_WAIT_SECONDS,
  pollUntil,
  reportProgress,
  slowInterval,
  type ToolCallContext,
} from '../utils/poll.js';
import {
  formatWorkflowRun,
  isRunTerminal,
  runMediaItems,
  toWorkflowRun,
  workflowRunSchema,
  type WorkflowRun,
} from '../utils/workflow.js';
import { nextActionSchema } from './schemas.js';

interface RunDetailResponse extends ApiEnvelope {
  workflowrun?: Record<string, unknown>;
  workflowrunnodes?: Array<Record<string, unknown>>;
}

export const workflowRunOutputSchema = {
  run: workflowRunSchema,
  debug: z.record(z.string(), z.unknown()).optional(),
  nextAction: nextActionSchema.optional(),
};

export async function readWorkflowRun(
  client: WiroClient,
  workflowtoken: string,
  signal?: AbortSignal,
): Promise<{ run: WorkflowRun; nodes: Array<Record<string, unknown>> }> {
  const result = requireApiSuccess(
    await client.post<RunDetailResponse>('/Workflow/RunDetail', { workflowtoken }, signal),
    'Could not read the workflow run.',
  );
  const nodes = result.workflowrunnodes ?? [];
  return { run: toWorkflowRun(result.workflowrun ?? { workflowtoken }, nodes), nodes };
}

/** Polls the run until it ends or the wait runs out. */
export async function waitForWorkflowRun(
  client: WiroClient,
  workflowtoken: string,
  waitSeconds: number,
  extra: ToolCallContext,
): Promise<{ run: WorkflowRun; nodes: Array<Record<string, unknown>> }> {
  const polled = await pollUntil({
    read: signal => readWorkflowRun(client, workflowtoken, signal),
    isDone: value => isRunTerminal(value.run.status),
    timeoutMs: waitSeconds * 1000,
    signal: extra.signal,
    interval: slowInterval,
    onPoll: (value, elapsedMs) => reportProgress(
      extra,
      elapsedMs,
      `Workflow run ${value.run.status}: ${value.run.counts.completed} steps done`,
    ),
  });
  if (polled.value) return polled.value;
  return readWorkflowRun(client, workflowtoken, extra.signal);
}

export function workflowRunResult(
  run: WorkflowRun,
  debug?: Record<string, unknown>,
) {
  const terminal = isRunTerminal(run.status);
  let nextAction: { tool: string; arguments: Record<string, unknown>; reason: string } | undefined;
  if (!terminal) {
    nextAction = {
      tool: 'wait_for_workflow_run',
      arguments: { workflowtoken: run.workflowtoken },
      reason: 'The run is still going. Keep waiting on this run; do not start it again.',
    };
  } else if (run.canResume) {
    nextAction = {
      tool: 'resume_workflow_run',
      arguments: { workflowtoken: run.workflowtoken },
      reason: 'Ask the user first: resuming runs the unfinished steps again and charges for them.',
    };
  }

  let text = formatWorkflowRun(run);
  if (!terminal) {
    text += '\n\nThe run is still in progress. Call `wait_for_workflow_run` with this run token '
      + 'to keep waiting. Do not call `run_workflow` again; that starts a second, separately '
      + 'charged run.';
  }
  return {
    content: createMediaContent(text, terminal ? runMediaItems(run) : []),
    structuredContent: {
      run,
      ...(debug ? { debug } : {}),
      ...(nextAction ? { nextAction } : {}),
    },
  };
}

export function registerWaitForWorkflowRun(server: McpServer, client: WiroClient): void {
  server.registerTool(
    'wait_for_workflow_run',
    {
      title: 'Wait for a Wiro workflow run',
      description: 'Check a workflow run and wait for it to finish, up to `wait_seconds`. '
        + 'Returns its status, the resolved outputs (files and text) and any steps that '
        + 'failed. Use wait_seconds 0 for a single check. When it is still running, call '
        + 'this again with the same run token; never start the run again. When the run is '
        + 'complete, present every returned media resource in the user-facing response.',
      inputSchema: {
        workflowtoken: z.string().min(1).describe('The run token from run_workflow, resume_workflow_run or list_workflow_runs.'),
        wait_seconds: z.number().int().min(0).max(MAX_WAIT_SECONDS).default(DEFAULT_WAIT_SECONDS)
          .describe(`How long to wait for the run to finish (0-${MAX_WAIT_SECONDS} seconds, default ${DEFAULT_WAIT_SECONDS}).`),
        debug_node_id: z.string().optional()
          .describe('Optional step id ("node-...") whose model task details to include, to debug a failed step.'),
      },
      outputSchema: workflowRunOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ workflowtoken, wait_seconds, debug_node_id }, extra) => {
      try {
        const { run, nodes } = wait_seconds > 0
          ? await waitForWorkflowRun(client, workflowtoken, wait_seconds, extra)
          : await readWorkflowRun(client, workflowtoken, extra.signal);

        let debug: Record<string, unknown> | undefined;
        if (debug_node_id) {
          debug = await readStepDebug(client, nodes, debug_node_id, extra.signal);
        }
        return workflowRunResult(run, debug);
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}

async function readStepDebug(
  client: WiroClient,
  nodes: Array<Record<string, unknown>>,
  nodeId: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const node = nodes.find(candidate => candidate.nodeId === nodeId);
  if (!node) return { nodeId, available: false, reason: 'No step with this id in the run.' };
  const tasktoken = asString(node.tasktoken);
  if (!tasktoken) {
    return { nodeId, available: false, reason: 'This step has no model task (utility steps run inside the workflow engine).' };
  }
  const response = await client.post<ApiEnvelope & { workflowrunnode?: Record<string, unknown> }>(
    '/Workflow/RunNodeDetail',
    { tasktoken },
    signal,
  );
  if (response.result !== true) {
    return { nodeId, available: false, reason: 'Step details are not available for this run.' };
  }
  const detail = (response.workflowrunnode?.taskDetail ?? {}) as Record<string, unknown>;
  const parameters = typeof detail.parameters === 'object' && detail.parameters !== null
    ? Object.fromEntries(Object.entries(detail.parameters as Record<string, unknown>)
      .map(([key, value]) => [key, typeof value === 'string' ? truncate(value, 500) : value]))
    : undefined;
  const debugoutput = asString(detail.debugoutput);
  return {
    nodeId,
    available: true,
    ...(asString(detail.taskStatus) ? { taskStatus: asString(detail.taskStatus) } : {}),
    ...(asString(detail.modelslugowner) && asString(detail.modelslugproject)
      ? { model: `${asString(detail.modelslugowner)}/${asString(detail.modelslugproject)}` }
      : {}),
    ...(parameters ? { parameters } : {}),
    ...(debugoutput ? { output: debugoutput.slice(-2_000) } : {}),
  };
}
