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
  SENSITIVE_INPUT_KEY,
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
      reason: 'Resuming runs the unfinished steps again and charges for them: ask the user first, unless they asked you to continue this run.',
    };
  }

  let text = formatWorkflowRun(run);
  if (debug) text += `\n\n${formatStepDebug(debug)}`;
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

// A step's inputs can hold whole chat histories or files as data URLs, so
// debug_node_id shortens them before they are returned.
const DEBUG_STRING_MAX = 500;
const DEBUG_LIST_MAX = 10;
const DEBUG_DEPTH_MAX = 6;
const DEBUG_TEXT_MAX = 8_000;

function isFilled(value: unknown): boolean {
  return value !== '' && value !== null && value !== undefined;
}

/** Cuts long strings and lists, summarises deep nesting and hides secret-looking values at every level. */
function shortenStepInput(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return truncate(value, DEBUG_STRING_MAX);
  if (Array.isArray(value)) {
    if (depth >= DEBUG_DEPTH_MAX) return `(a list of ${value.length} items)`;
    const kept = value.slice(0, DEBUG_LIST_MAX).map(item => shortenStepInput(item, depth + 1));
    return value.length > DEBUG_LIST_MAX ? [...kept, `(+${value.length - DEBUG_LIST_MAX} more)`] : kept;
  }
  if (value !== null && typeof value === 'object') {
    if (depth >= DEBUG_DEPTH_MAX) return '(an object)';
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => [key, SENSITIVE_INPUT_KEY.test(key) && isFilled(item)
        ? '[hidden]'
        : shortenStepInput(item, depth + 1)]));
  }
  return value;
}

/** The step details debug_node_id asked for, as text for clients that show only text. */
function formatStepDebug(debug: Record<string, unknown>): string {
  const lines = [`### Step \`${String(debug.nodeId ?? '')}\``, ''];
  if (debug.available !== true) {
    lines.push(typeof debug.reason === 'string' ? debug.reason : 'No details are available for this step.');
    return lines.join('\n');
  }
  if (typeof debug.model === 'string') lines.push(`**Model:** \`${debug.model}\``);
  if (typeof debug.taskStatus === 'string') lines.push(`**Task status:** ${debug.taskStatus}`);
  const block = (language: string, value: string): string[] => {
    let fence = '```';
    while (value.includes(fence)) fence += '`';
    return [`${fence}${language}`, value, fence];
  };
  if (debug.parameters && typeof debug.parameters === 'object') {
    const json = JSON.stringify(debug.parameters, null, 2);
    const cut = json.length > DEBUG_TEXT_MAX;
    lines.push('**Inputs its model received:**', ...block('json', cut ? `${json.slice(0, DEBUG_TEXT_MAX)}\n...` : json));
    if (cut) {
      lines.push(`This list stops after about ${DEBUG_TEXT_MAX / 1000} KB. The structured result has every input under \`debug.parameters\`, with long values shortened.`);
    }
  }
  if (typeof debug.output === 'string' && debug.output) {
    lines.push('**Output:**', ...block('text', debug.output));
  }
  return lines.join('\n');
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
    ? shortenStepInput(detail.parameters) as Record<string, unknown>
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
