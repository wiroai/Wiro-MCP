import { z } from 'zod';
import type { WiroClient } from '../client.js';
import {
  asString,
  isPlainObject,
  requireApiSuccess,
  toNumber,
  truncate,
  unixToIso,
} from './api.js';

// Model runs that Studio starts on the user's behalf. They are not owned by the
// caller's project, so the task tools (get_task, cancel_task, kill_task) cannot
// see them; /Studio/Tasks is the only way to read them. Run tokens and the full
// request parameters stay out of the projection.

export const studioRunSchema = z.object({
  id: z.string(),
  model: z.string().optional(),
  modelTitle: z.string().optional(),
  status: z.string(),
  state: z.enum(['running', 'completed', 'failed', 'cancelled']),
  outputs: z.array(z.object({
    url: z.string(),
    name: z.string().optional(),
    mimeType: z.string().optional(),
    sizeBytes: z.number().nullable().optional(),
  })),
  text: z.string().optional(),
  prompt: z.string().optional(),
  costUsd: z.number().nullable().optional(),
  createdAt: z.string().optional(),
  endedAt: z.string().optional(),
  elapsedSeconds: z.number().nullable().optional(),
});

export type StudioRun = z.infer<typeof studioRunSchema>;

const TERMINAL_RUN_STATUSES = new Set(['task_postprocess_end', 'task_cancel', 'task_kill', 'task_killed']);
const MAX_RUN_OUTPUTS = 20;
const MAX_RUN_TEXT = 4_000;
const MAX_PROMPT = 500;

function runState(row: Record<string, unknown>): StudioRun['state'] {
  const status = asString(row.status) ?? '';
  const terminal = typeof row.terminal === 'boolean' ? row.terminal : TERMINAL_RUN_STATUSES.has(status);
  if (!terminal) return 'running';
  const success = typeof row.success === 'boolean'
    ? row.success
    : status === 'task_postprocess_end' && toNumber(row.exitCode) === 0;
  if (success) return 'completed';
  return /cancel|kill/i.test(status) ? 'cancelled' : 'failed';
}

function mediaOutputs(outputs: unknown): StudioRun['outputs'] {
  if (!Array.isArray(outputs)) return [];
  const files: StudioRun['outputs'] = [];
  const visit = (item: unknown): void => {
    if (!isPlainObject(item) || files.length >= MAX_RUN_OUTPUTS) return;
    if (item.contenttype === 'folder' && Array.isArray(item.children)) {
      item.children.forEach(visit);
      return;
    }
    if (item.contenttype === 'raw' || typeof item.url !== 'string' || !/^https?:\/\//i.test(item.url)) return;
    files.push({
      url: item.url,
      ...(typeof item.name === 'string' && item.name ? { name: item.name } : {}),
      ...(typeof item.contenttype === 'string' && item.contenttype ? { mimeType: item.contenttype } : {}),
      sizeBytes: toNumber(item.size),
    });
  };
  outputs.forEach(visit);
  return files;
}

/** The answer of an LLM run: its answer parts, else its answer segments. */
function llmAnswer(outputs: unknown): string {
  if (!Array.isArray(outputs)) return '';
  for (const output of outputs) {
    if (!isPlainObject(output) || output.contenttype !== 'raw' || !isPlainObject(output.content)) continue;
    const { answer, segments } = output.content;
    if (typeof answer === 'string' && answer.trim()) return answer.trim();
    if (Array.isArray(answer)) {
      const joined = answer.filter(part => typeof part === 'string').join('').trim();
      if (joined) return joined;
    }
    if (Array.isArray(segments)) {
      const joined = segments
        .filter(isPlainObject)
        .filter(segment => segment.type === 'answer' && typeof segment.text === 'string')
        .map(segment => segment.text as string)
        .join('')
        .trim();
      if (joined) return joined;
    }
  }
  return '';
}

function runPrompt(parameters: unknown): string | undefined {
  let value = parameters;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  if (!isPlainObject(value) || typeof value.prompt !== 'string' || !value.prompt.trim()) return undefined;
  return truncate(value.prompt.trim(), MAX_PROMPT);
}

export function toStudioRun(row: Record<string, unknown>): StudioRun {
  const model = isPlainObject(row.model) ? row.model : {};
  const owner = asString(model.slugowner);
  const project = asString(model.slugproject);
  const text = llmAnswer(row.outputs);
  const prompt = runPrompt(row.parameters);
  return {
    id: asString(row.id) ?? '',
    ...(owner && project ? { model: `${owner}/${project}` } : {}),
    ...(asString(model.title) ? { modelTitle: asString(model.title) } : {}),
    status: asString(row.status) ?? 'unknown',
    state: runState(row),
    outputs: mediaOutputs(row.outputs),
    ...(text ? { text: truncate(text, MAX_RUN_TEXT) } : {}),
    ...(prompt ? { prompt } : {}),
    costUsd: toNumber(row.totalcost),
    ...(unixToIso(row.createtime) ? { createdAt: unixToIso(row.createtime) } : {}),
    ...(unixToIso(row.endtime) ? { endedAt: unixToIso(row.endtime) } : {}),
    elapsedSeconds: toNumber(row.elapsedseconds),
  };
}

export interface StudioRunWindow {
  /** Unix seconds; runs created before this are left out. */
  from?: number;
  /** Unix seconds; runs created after this are left out. */
  to?: number;
}

/** Studio returns at most this many of its most recent runs, with no way to page further back. */
export const STUDIO_RUNS_MAX = 100;

export interface StudioRunPage {
  /** The runs inside the window, newest first. */
  runs: StudioRun[];
  /** The page was full and starts after window.from, so older runs in the window can be missing. */
  mayMissOlder: boolean;
}

/** Studio's recent runs for this API key's owner and workspace, newest first. */
export async function readStudioRunPage(
  client: WiroClient,
  limit: number,
  window: StudioRunWindow = {},
  signal?: AbortSignal,
): Promise<StudioRunPage> {
  const requested = Math.min(STUDIO_RUNS_MAX, Math.max(1, Math.trunc(limit)));
  const body = requireApiSuccess(
    await client.post<Record<string, unknown> & { result?: boolean }>(
      '/Studio/Tasks',
      { limit: requested },
      signal,
    ),
    'Could not read the Studio results.',
  );
  const rows = Array.isArray(body.tasks) ? body.tasks.filter(isPlainObject) : [];
  const created = rows.map(row => toNumber(row.createtime)).filter((value): value is number => value !== null);
  const oldest = created.length > 0 ? Math.min(...created) : null;
  return {
    runs: rows
      .filter(row => {
        const createdAt = toNumber(row.createtime);
        if (window.from !== undefined && (createdAt === null || createdAt < window.from)) return false;
        if (window.to !== undefined && createdAt !== null && createdAt > window.to) return false;
        return true;
      })
      .map(toStudioRun),
    mayMissOlder: rows.length >= requested && window.from !== undefined && oldest !== null && oldest > window.from,
  };
}

export async function readStudioRuns(
  client: WiroClient,
  limit: number,
  window: StudioRunWindow = {},
  signal?: AbortSignal,
): Promise<StudioRun[]> {
  return (await readStudioRunPage(client, limit, window, signal)).runs;
}

export function formatStudioRun(run: StudioRun): string {
  const label = run.model ?? run.modelTitle ?? 'model';
  const parts = [`- \`${label}\` ${run.state}`];
  if (run.costUsd !== null && run.costUsd !== undefined && run.costUsd > 0) parts.push(`($${run.costUsd})`);
  if (run.createdAt) parts.push(`started ${run.createdAt}`);
  const lines = [parts.join(' ')];
  if (run.prompt) lines.push(`  - Prompt: ${truncate(run.prompt.replace(/\s+/g, ' '), 120)}`);
  for (const output of run.outputs) lines.push(`  - ${output.url}`);
  if (run.text) lines.push(`  - ${truncate(run.text.replace(/\s+/g, ' '), 300)}`);
  return lines.join('\n');
}
