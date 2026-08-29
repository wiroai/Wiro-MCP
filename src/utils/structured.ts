import type {
  ExploreCategory,
  FileUploadItem,
  Task,
  TaskFinishReason,
  TaskOutput,
  TaskSegment,
  TaskUsage,
  ToolListItem,
} from '../types.js';
import { formatPricing } from './format.js';
import {
  isToolCallSegment,
  normalizeTaskRawContent,
} from './task-segments.js';

export type TaskState =
  | 'submitted'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface NextAction {
  tool: string;
  arguments: Record<string, unknown>;
  reason: string;
}

export interface StructuredTaskOutput {
  name?: string;
  mimeType: string;
  sizeBytes: number | null;
  url?: string;
  kind: 'image' | 'video' | 'audio' | 'text' | 'file';
  text?: string;
  segments?: TaskSegment[];
  finishreason?: TaskFinishReason;
  usage?: TaskUsage;
}

type TaskOutputProjectionState = 'none' | 'valid' | 'invalid';

interface TaskOutputProjection {
  output: StructuredTaskOutput;
  state: TaskOutputProjectionState;
}

export interface StructuredTaskReference {
  id?: string;
  token?: string;
  model?: string;
  status?: string;
  exitCode?: string;
  durationSeconds?: number | null;
  costUsd?: number | null;
}

export interface StructuredTaskResult {
  [key: string]: unknown;
  state: TaskState;
  task: StructuredTaskReference;
  outputs: StructuredTaskOutput[];
  response?: string;
  error?: string;
  nextAction?: NextAction;
}

export interface StructuredModelSummary {
  slug: string;
  title: string;
  description?: string;
  categories: string[];
  pricing?: string;
  estimatedCostUsd?: number | null;
}

export type TaskContentBlock =
  | {
    type: 'text';
    text: string;
    annotations?: {
      audience?: Array<'assistant' | 'user'>;
      priority?: number;
    };
  }
  | {
    type: 'resource_link';
    uri: string;
    name: string;
    description?: string;
    mimeType?: string;
    annotations?: {
      audience?: Array<'assistant' | 'user'>;
      priority?: number;
    };
  };

export function getTaskState(task: Task): TaskState {
  if (task.status === 'task_cancel') return 'cancelled';
  if (task.status === 'task_postprocess_end') {
    return task.pexit === '0' ? 'completed' : 'failed';
  }
  return 'running';
}

export function toTaskReference(
  task?: Task,
  fallback: { taskid?: string; tasktoken?: string; model?: string } = {},
): StructuredTaskReference {
  const model = task?.modelslugowner && task.modelslugproject
    ? `${task.modelslugowner}/${task.modelslugproject}`
    : fallback.model;
  const durationSeconds = parseNullableNumber(task?.elapsedseconds);
  const costUsd = parseNullableNumber(task?.totalcost);

  return compact({
    id: asOptionalString(task?.id || fallback.taskid),
    token: asOptionalString(
      task?.socketaccesstoken || fallback.tasktoken,
    ),
    model,
    status: asOptionalString(task?.status),
    exitCode: asOptionalString(task?.pexit || undefined),
    durationSeconds,
    costUsd,
  });
}

export function toStructuredTaskResult(
  task: Task,
  fallback: { taskid?: string; tasktoken?: string; model?: string } = {},
): StructuredTaskResult {
  const state = getTaskState(task);
  const requireCompleteTurn = state !== 'running';
  const outputProjections = task.outputs?.map(
    output => toStructuredTaskOutputProjection(output, requireCompleteTurn),
  ) ?? [];
  const hasInvalidProjection = outputProjections.some(
    projection => projection.state === 'invalid',
  );
  const typedProjection = outputProjections.find(
    projection => projection.state === 'valid'
      && projection.output.segments !== undefined,
  ) ?? outputProjections.find(projection => projection.state === 'valid');
  const result: StructuredTaskResult = {
    state,
    task: toTaskReference(task, fallback),
    outputs: outputProjections.map(projection => projection.output),
  };

  if (!hasInvalidProjection && typedProjection) {
    const answer = (typedProjection.output.segments ?? [])
      .flatMap(segment => segment.type === 'answer' ? [segment.text] : [])
      .join('');
    if (answer) result.response = answer;
  } else if (!hasInvalidProjection && task.debugoutput) {
    result.response = task.debugoutput;
  }
  if (task.debugerror) result.error = task.debugerror;
  if (!hasInvalidProjection && state === 'running') {
    result.nextAction = createWaitNextAction(result.task);
  } else if (!hasInvalidProjection && state === 'completed') {
    const continuation = createToolContinuationNextAction(
      result.task,
      result.outputs,
      task.parameters,
    );
    if (continuation) result.nextAction = continuation;
  }

  return result;
}

export function toPendingTaskResult(params: {
  taskid?: string;
  tasktoken?: string;
  model?: string;
  status?: string;
  task?: Task;
  reason?: string;
}): StructuredTaskResult {
  const taskReference = params.task
    ? toTaskReference(params.task, params)
    : compact({
      id: params.taskid,
      token: params.tasktoken,
      model: params.model,
      status: params.status,
    });

  return {
    state: params.status ? 'running' : 'submitted',
    task: taskReference,
    outputs: [],
    ...(params.reason ? { error: params.reason } : {}),
    nextAction: createWaitNextAction(taskReference),
  };
}

export function createTaskContent(text: string, task?: Task): TaskContentBlock[] {
  const content: TaskContentBlock[] = [{ type: 'text', text }];
  const linkedOutputs = (task?.outputs ?? []).filter(output => output.url);

  if (task && getTaskState(task) === 'completed' && linkedOutputs.length > 0) {
    content.push({
      type: 'text',
      text: 'Present every generated media output in your user-facing response now. '
        + 'For images, render the resource URL inline with Markdown image syntax and '
        + 'keep it clickable. For video, audio, and other files, provide a clickable '
        + 'link. Do not return only task metadata or merely say that media was generated.',
      annotations: {
        audience: ['assistant'],
        priority: 1,
      },
    });
  }

  for (const output of linkedOutputs) {
    content.push({
      type: 'resource_link',
      uri: output.url!,
      name: output.name || 'Wiro output',
      description: 'Generated by Wiro. Present this media in the user-facing response.',
      ...(output.contenttype ? { mimeType: output.contenttype } : {}),
      annotations: {
        audience: ['user', 'assistant'],
        priority: 1,
      },
    });
  }

  return content;
}

export function toStructuredModel(model: ToolListItem): StructuredModelSummary {
  const estimatedCost = parseNullableNumber(model.approximatelycost);
  const pricing = formatPricing(model);

  return compact({
    slug: `${model.cleanslugowner}/${model.cleanslugproject}`,
    title: model.title || `${model.cleanslugowner}/${model.cleanslugproject}`,
    description: model.seodescription || model.description || undefined,
    categories: model.categories?.filter(category => category !== 'tool') ?? [],
    pricing: pricing || undefined,
    estimatedCostUsd: estimatedCost,
  });
}

export function toStructuredModelDetail(model: ToolListItem): {
  model: StructuredModelSummary & {
    parameters: Array<{
      title: string;
      items: Array<{
        id: string;
        type: string;
        label: string;
        description?: string;
        default?: string;
        required: boolean;
        placeholder?: string;
        note?: string;
        options: Array<{ label: string; value: string }>;
        min?: number;
        max?: number;
        step?: number;
        advanced: boolean;
        jsonSchema?: Record<string, unknown>;
      }>;
    }>;
  };
  nextAction: NextAction;
} {
  const summary = toStructuredModel(model);
  return {
    model: {
      ...summary,
      parameters: (model.parameters ?? []).map(group => ({
        title: group.title || '',
        items: group.items.map(item => compact({
          id: String(item.id),
          type: String(item.type),
          label: item.label ? String(item.label) : String(item.id),
          description: item.description || undefined,
          default: item.default == null ? undefined : String(item.default),
          required: item.required === true || String(item.required) === 'true',
          placeholder: item.placeholder == null ? undefined : String(item.placeholder),
          note: item.note == null ? undefined : String(item.note),
          options: (item.options ?? []).map(option => ({
            label: String(option.label),
            value: String(option.value),
          })),
          min: finiteNumber(item.min),
          max: finiteNumber(item.max),
          step: finiteNumber(item.step),
          advanced: item.advanced === true || String(item.advanced) === 'true',
          jsonSchema: parseJsonObject(item.jsonschema),
        })),
      })),
    },
    nextAction: {
      tool: 'run_model',
      arguments: {
        model: summary.slug,
        params: {},
      },
      reason: 'Fill the required model parameters, then submit one generation.',
    },
  };
}

export function toStructuredExplore(categories: ExploreCategory[]): {
  categories: Array<{
    title: string;
    total: number;
    models: StructuredModelSummary[];
  }>;
  nextAction?: NextAction;
} {
  const structuredCategories = categories
    .filter(category => category.tools?.length)
    .map(category => ({
      title: category.title || 'Models',
      total: nonNegativeInteger(category.total, category.tools.length),
      models: category.tools.map(tool => ({
        slug: `${tool.cleanslugowner}/${tool.cleanslugproject}`,
        title: `${tool.cleanslugowner}/${tool.cleanslugproject}`,
        description: tool.description || undefined,
        categories: tool.categories?.filter(categoryName => categoryName !== 'tool') ?? [],
      })),
    }));
  const firstModel = structuredCategories[0]?.models[0];

  return {
    categories: structuredCategories,
    ...(firstModel
      ? {
        nextAction: {
          tool: 'get_model_schema',
          arguments: { model: firstModel.slug },
          reason: 'Inspect a model schema before running it.',
        },
      }
      : {}),
  };
}

export function toStructuredFile(file: FileUploadItem): {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number | null;
  url: string;
} {
  return {
    id: String(file.id),
    name: String(file.name),
    mimeType: file.contenttype || 'application/octet-stream',
    sizeBytes: parseNullableInteger(file.size),
    url: file.url,
  };
}

function toStructuredTaskOutputProjection(
  output: TaskOutput,
  requireCompleteTurn: boolean,
): TaskOutputProjection {
  const normalized = normalizeTaskRawContent(
    output.contenttype === 'raw' ? output.content : undefined,
    { requireCompleteTurn },
  );
  const hasTypedProjection = output.contenttype === 'raw' && (
    normalized.hasSegments
    || normalized.malformed
    || normalized.finishreason !== undefined
    || normalized.usage !== undefined
  );
  const state: TaskOutputProjectionState = normalized.malformed
    ? 'invalid'
    : hasTypedProjection
      ? 'valid'
      : 'none';
  const segmentText = state === 'valid' && normalized.hasSegments
    ? normalized.segments
      .flatMap(segment => segment.type === 'answer' ? [segment.text] : [])
      .join('')
    : '';
  const rawText = state === 'valid'
    ? segmentText || undefined
    : state === 'none'
      ? getLegacyTaskOutputText(output)
      : undefined;
  const mimeType = output.contenttype === 'raw'
    ? 'text/plain'
    : output.contenttype || 'application/octet-stream';

  return {
    state,
    output: compact({
      name: output.name,
      mimeType,
      sizeBytes: parseNullableInteger(output.size),
      url: output.url,
      kind: getOutputKind(mimeType, rawText),
      text: rawText,
      segments: state === 'valid' && normalized.hasSegments
        ? normalized.segments
        : undefined,
      finishreason: state === 'valid' ? normalized.finishreason : undefined,
      usage: state === 'valid' ? normalized.usage : undefined,
    }),
  };
}

function getLegacyTaskOutputText(output: TaskOutput): string | undefined {
  const answers = output.content?.answer;
  if (Array.isArray(answers)
    && answers.every(answer => typeof answer === 'string')) {
    const text = answers.join('\n');
    if (text) return text;
  }
  return typeof output.content?.raw === 'string' && output.content.raw
    ? output.content.raw
    : undefined;
}

function getOutputKind(
  mimeType: string,
  text?: string,
): StructuredTaskOutput['kind'] {
  if (text || mimeType.startsWith('text/')) return 'text';
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  return 'file';
}

function createWaitNextAction(task: StructuredTaskReference): NextAction {
  const args: Record<string, unknown> = {};
  if (task.token) args.tasktoken = task.token;
  else if (task.id) args.taskid = task.id;

  return {
    tool: 'wait_for_task',
    arguments: args,
    reason: 'Continue this exact task. Do not call run_model again.',
  };
}

function createToolContinuationNextAction(
  task: StructuredTaskReference,
  outputs: StructuredTaskOutput[],
  parameters: Record<string, unknown>,
): NextAction | undefined {
  if (!task.token || !task.model) return undefined;

  const calls = outputs.flatMap(output => {
    if (output.finishreason !== 'tool_calls') {
      return [];
    }
    return (output.segments ?? [])
      .filter(isToolCallSegment)
      .filter(call => call.status === 'completed');
  });
  if (calls.length === 0) return undefined;

  const continuationParams: Record<string, unknown> = {
    previousTaskToken: task.token,
    toolOutputs: calls.map(call => ({
      call_id: call.call_id,
      output: '<tool result>',
    })),
  };
  const sessionValue = parameters.session_id;
  if (typeof sessionValue === 'string' && sessionValue.trim().length > 0) {
    continuationParams.session_id = sessionValue;
  }

  return {
    tool: 'run_model',
    arguments: {
      model: task.model,
      params: continuationParams,
    },
    reason: 'Execute each completed tool call, replace every `<tool result>` '
      + 'placeholder with that call’s result, then continue this task once.',
  };
}

function parseNullableNumber(value?: string): number | null | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseNullableInteger(value?: string): number | null {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function finiteNumber(value?: number): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function nonNegativeInteger(value: unknown, fallback: number): number {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function asOptionalString(value: unknown): string | undefined {
  return value === undefined || value === null || value === ''
    ? undefined
    : String(value);
}

function parseJsonObject(value: unknown): Record<string, unknown> | undefined {
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : undefined;
}

function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as T;
}
