import type {
  TaskFinishReason,
  TaskOutputRawContent,
  TaskSegment,
  TaskToolCallSegment,
  TaskToolCallStatus,
  TaskUsage,
} from '../types.js';

const MAX_SEGMENTS = 1024;
const MAX_TEXT_BYTES = 8 * 1024 * 1024;
const MAX_TOOL_INPUT_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_SEGMENT_BYTES = 64 * 1024 * 1024;
const MAX_USAGE_COUNTER = 1_000_000_000_000_000;
const SAFE_IDENTIFIER = /^[A-Za-z0-9_.:-]{1,256}$/;
const SAFE_TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const INPUT_USAGE_DETAIL_KEYS = [
  'cached_tokens',
  'cache_write_tokens',
  'cache_write_5m_tokens',
  'cache_write_1h_tokens',
  'text_tokens',
  'audio_tokens',
  'image_tokens',
  'video_tokens',
] as const;
const OUTPUT_USAGE_DETAIL_KEYS = [
  'reasoning_tokens',
  'text_tokens',
  'audio_tokens',
  'image_tokens',
  'video_tokens',
  'accepted_prediction_tokens',
  'rejected_prediction_tokens',
] as const;
const SERVER_TOOL_USAGE_KEYS = [
  'web_search_requests',
  'web_fetch_requests',
  'code_execution_requests',
  'bash_code_execution_requests',
  'text_editor_code_execution_requests',
  'computer_use_requests',
  'file_search_requests',
  'image_generation_requests',
] as const;
const FINISH_REASONS = new Set<TaskFinishReason>([
  'stop',
  'tool_calls',
  'length',
  'content_filter',
  'error',
]);
const TOOL_CALL_STATUSES = new Set<TaskToolCallStatus>([
  'in_progress',
  'completed',
  'incomplete',
]);

export interface NormalizedTaskRawContent {
  hasSegments: boolean;
  segments: TaskSegment[];
  finishreason?: TaskFinishReason;
  usage?: TaskUsage;
  malformed: boolean;
}

export function normalizeTaskRawContent(
  content: TaskOutputRawContent | undefined,
  options: { requireCompleteTurn?: boolean } = {},
): NormalizedTaskRawContent {
  if (!isRecord(content)) {
    return {
      hasSegments: false,
      segments: [],
      malformed: false,
    };
  }

  const rawSegments = content['segments'];
  const hasSegments = Array.isArray(rawSegments);
  let malformed = false;
  let segments: TaskSegment[] = [];

  if (rawSegments !== undefined && rawSegments !== null) {
    if (!Array.isArray(rawSegments) || rawSegments.length > MAX_SEGMENTS) {
      malformed = true;
    } else {
      let totalBytes = 0;
      for (const value of rawSegments) {
        const segment = normalizeTaskSegment(value);
        if (!segment) {
          malformed = true;
          break;
        }
        totalBytes += Buffer.byteLength(JSON.stringify(segment), 'utf8');
        if (totalBytes > MAX_TOTAL_SEGMENT_BYTES) {
          malformed = true;
          break;
        }
        segments.push(segment);
      }
    }
  }

  const finishreason = normalizeFinishReason(content['finishreason']);
  const usage = normalizeTaskUsage(content['usage']);
  if (content['finishreason'] !== undefined
    && content['finishreason'] !== null
    && !finishreason) {
    malformed = true;
  }
  if (content['usage'] !== undefined
    && content['usage'] !== null
    && !usage) {
    malformed = true;
  }

  const toolCalls = segments.filter(isToolCallSegment);
  if (new Set(toolCalls.map(call => call.id)).size !== toolCalls.length
    || new Set(toolCalls.map(call => call.call_id)).size !== toolCalls.length) {
    malformed = true;
  }

  if (options.requireCompleteTurn && hasSegments) {
    const completedCalls = toolCalls.filter(call => call.status === 'completed');

    if (toolCalls.length > 0 && !finishreason) {
      malformed = true;
    } else if (finishreason === 'tool_calls'
      && (toolCalls.length === 0 || completedCalls.length !== toolCalls.length)) {
      malformed = true;
    } else if (finishreason !== 'tool_calls' && completedCalls.length > 0) {
      malformed = true;
    }
  }

  return {
    hasSegments,
    segments: malformed ? [] : segments,
    ...(malformed ? {} : { finishreason, usage }),
    malformed,
  };
}

export function isToolCallSegment(
  segment: TaskSegment,
): segment is TaskToolCallSegment {
  return segment.type === 'function_call'
    || segment.type === 'custom_tool_call';
}

function normalizeTaskSegment(value: unknown): TaskSegment | null {
  if (!isRecord(value)) return null;

  if (value['type'] === 'thinking' || value['type'] === 'answer') {
    const text = boundedString(value['text'], MAX_TEXT_BYTES);
    return text === null
      ? null
      : { type: value['type'], text };
  }

  if (value['type'] === 'function_call') {
    const common = normalizeToolCallFields(value);
    const argumentsValue = boundedString(
      value['arguments'],
      MAX_TOOL_INPUT_BYTES,
    );
    if (!common || argumentsValue === null) return null;
    return {
      type: 'function_call',
      ...common,
      arguments: argumentsValue,
    };
  }

  if (value['type'] === 'custom_tool_call') {
    const common = normalizeToolCallFields(value);
    const input = boundedString(value['input'], MAX_TOOL_INPUT_BYTES);
    if (!common || input === null) return null;
    return {
      type: 'custom_tool_call',
      ...common,
      input,
    };
  }

  return null;
}

function normalizeToolCallFields(value: Record<string, unknown>): {
  id: string;
  call_id: string;
  name: string;
  status: TaskToolCallStatus;
} | null {
  const id = normalizeIdentifier(value['id']);
  const callId = normalizeIdentifier(value['call_id']);
  const name = typeof value['name'] === 'string'
    && SAFE_TOOL_NAME.test(value['name'])
    ? value['name']
    : null;
  const status = typeof value['status'] === 'string'
    && TOOL_CALL_STATUSES.has(value['status'] as TaskToolCallStatus)
    ? value['status'] as TaskToolCallStatus
    : null;

  return id && callId && name && status
    ? {
      id,
      call_id: callId,
      name,
      status,
    }
    : null;
}

function normalizeIdentifier(value: unknown): string | null {
  return typeof value === 'string' && SAFE_IDENTIFIER.test(value)
    ? value
    : null;
}

function normalizeFinishReason(value: unknown): TaskFinishReason | undefined {
  return typeof value === 'string'
    && FINISH_REASONS.has(value as TaskFinishReason)
    ? value as TaskFinishReason
    : undefined;
}

function normalizeTaskUsage(value: unknown): TaskUsage | undefined {
  if (!isRecord(value)) return undefined;

  const inputTokens = normalizeUsageCounter(value['input_tokens']);
  const outputTokens = normalizeUsageCounter(value['output_tokens']);
  const totalTokens = normalizeUsageCounter(value['total_tokens']);
  if (inputTokens === undefined
    || outputTokens === undefined
    || totalTokens === undefined
    || inputTokens + outputTokens !== totalTokens) {
    return undefined;
  }

  const inputDetails = normalizeUsageCounters(
    value['input_tokens_details'],
    INPUT_USAGE_DETAIL_KEYS,
  );
  const outputDetails = normalizeUsageCounters(
    value['output_tokens_details'],
    OUTPUT_USAGE_DETAIL_KEYS,
  );
  const serverToolUse = normalizeUsageCounters(
    value['server_tool_use'],
    SERVER_TOOL_USAGE_KEYS,
  );
  if (inputDetails === undefined
    || outputDetails === undefined
    || serverToolUse === undefined) {
    return undefined;
  }
  if ((inputDetails['cached_tokens'] ?? 0)
      + (inputDetails['cache_write_tokens'] ?? 0) > inputTokens
    || (inputDetails['cache_write_5m_tokens'] ?? 0)
      + (inputDetails['cache_write_1h_tokens'] ?? 0)
      > (inputDetails['cache_write_tokens'] ?? 0)
    || (outputDetails['reasoning_tokens'] ?? 0) > outputTokens) {
    return undefined;
  }

  return {
    input_tokens: inputTokens,
    ...(Object.keys(inputDetails).length > 0
      ? { input_tokens_details: inputDetails }
      : {}),
    output_tokens: outputTokens,
    ...(Object.keys(outputDetails).length > 0
      ? { output_tokens_details: outputDetails }
      : {}),
    total_tokens: totalTokens,
    ...(Object.keys(serverToolUse).length > 0
      ? { server_tool_use: serverToolUse }
      : {}),
  };
}

function normalizeUsageCounters(
  value: unknown,
  allowedKeys: readonly string[],
): Record<string, number> | undefined {
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) return undefined;

  const normalized: Record<string, number> = {};
  for (const key of allowedKeys) {
    if (value[key] === undefined || value[key] === null) continue;
    const counter = normalizeUsageCounter(value[key]);
    if (counter === undefined) return undefined;
    normalized[key] = counter;
  }
  return normalized;
}

function normalizeUsageCounter(value: unknown): number | undefined {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0
    && value <= MAX_USAGE_COUNTER
    ? value
    : undefined;
}

function boundedString(value: unknown, maxBytes: number): string | null {
  return typeof value === 'string'
    && Buffer.byteLength(value, 'utf8') <= maxBytes
    ? value
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value);
}
