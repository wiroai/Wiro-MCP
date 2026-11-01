import { z } from 'zod';
import { quotedSpan } from '../utils/quoted-text.js';

// Other names assistants try for an argument, written as argumentKey() writes them.
const ARGUMENT_ALIASES: Record<string, string[]> = {
  taskid: ['id', 'task', 'taskguid', 'guid'],
  tasktoken: ['token', 'accesstoken', 'socketaccesstoken'],
  wait_seconds: ['timeout', 'timeoutseconds', 'wait', 'waittime'],
  timeout_seconds: ['timeout', 'waitseconds', 'waittime'],
  start: ['offset', 'skip'],
  limit: ['count', 'size', 'pagesize'],
  model: ['modelslug'],
  workflow: ['slug', 'fullslug', 'workflowslug'],
  params: ['parameters', 'input', 'inputs', 'args', 'arguments'],
  input: ['inputs', 'params', 'parameters', 'args', 'arguments'],
  session: ['sessionid', 'sessionkey', 'sessionname', 'conversation', 'conversationid'],
  attachment_urls: ['attachments', 'attachment', 'files', 'images', 'urls'],
  recent_transactions: ['transactions', 'transactioncount'],
  search: ['query', 'q', 'keywords'],
  workflowtoken: ['token', 'runtoken', 'run'],
  breakpoint_node_id: ['breakpoint', 'breakpointnode', 'stopafter'],
  project_id: ['project', 'id'],
};

function argumentKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** The argument a wrong name most likely means, among the ones the tool takes. */
function rightArgument(name: string, known: string[]): string | undefined {
  const key = argumentKey(name);
  return known.find(candidate => argumentKey(candidate) === key)
    ?? known.find(candidate => ARGUMENT_ALIASES[candidate]?.includes(key));
}

function unknownArgumentsText(names: string[], known: string[], hint: string): string {
  const named = names.map(name => {
    const right = rightArgument(name, known);
    return right ? `${quotedSpan(name)} (use \`${right}\`)` : quotedSpan(name);
  });
  return `Unknown argument${names.length > 1 ? 's' : ''} ${named.join(', ')}. This tool takes `
    + `${known.map(key => `\`${key}\``).join(', ')}. Nothing was run.${hint ? ` ${hint}` : ''}`;
}

/**
 * An input schema that refuses an argument it does not know instead of dropping
 * it, naming the right one. The advertised schema stays the same: it already
 * says additionalProperties false.
 */
export function strictInput<T extends z.ZodRawShape>(shape: T, hint = '') {
  const schema = z.object(shape, {
    errorMap: (issue, context) => ({
      message: issue.code === 'unrecognized_keys'
        ? unknownArgumentsText(issue.keys, Object.keys(shape), hint)
        : context.defaultError,
    }),
  }).strict();
  // A client that adds toolCallId to the arguments also adds other keys of its
  // own, and the assistant cannot take them out, so only the known ones are read.
  const parse = schema._parse.bind(schema);
  schema._parse = input => {
    const { data } = input;
    if (!data || typeof data !== 'object' || Array.isArray(data)
      || !Object.hasOwn(data, 'toolCallId') || Object.hasOwn(shape, 'toolCallId')) {
      return parse(input);
    }
    return parse({
      ...input,
      data: Object.fromEntries(Object.entries(data).filter(([key]) => Object.hasOwn(shape, key))),
    });
  };
  return schema;
}

export const taskStateSchema = z.enum([
  'submitted',
  'running',
  'completed',
  'failed',
  'cancelled',
]);

export const nextActionSchema = z.object({
  tool: z.string(),
  arguments: z.record(z.string(), z.unknown()),
  reason: z.string(),
});

export const taskReferenceSchema = z.object({
  id: z.string().optional(),
  token: z.string().optional(),
  model: z.string().optional(),
  status: z.string().optional(),
  exitCode: z.string().optional(),
  durationSeconds: z.number().nullable().optional(),
  costUsd: z.number().nullable().optional()
    .describe('The model\'s list price for this task.'),
  chargedUsd: z.number().nullable().optional()
    .describe('What the payer was charged, after any discount.'),
});

export const taskFinishReasonSchema = z.enum([
  'stop',
  'tool_calls',
  'length',
  'content_filter',
  'error',
]);

export const taskToolCallStatusSchema = z.enum([
  'in_progress',
  'completed',
  'incomplete',
]);

const usageCounterSchema = z.number()
  .int()
  .nonnegative()
  .max(1_000_000_000_000_000);

export const taskUsageSchema = z.object({
  input_tokens: usageCounterSchema,
  input_tokens_details: z.object({
    cached_tokens: usageCounterSchema.optional(),
    cache_write_tokens: usageCounterSchema.optional(),
    cache_write_5m_tokens: usageCounterSchema.optional(),
    cache_write_1h_tokens: usageCounterSchema.optional(),
    text_tokens: usageCounterSchema.optional(),
    audio_tokens: usageCounterSchema.optional(),
    image_tokens: usageCounterSchema.optional(),
    video_tokens: usageCounterSchema.optional(),
  }).optional(),
  output_tokens: usageCounterSchema,
  output_tokens_details: z.object({
    reasoning_tokens: usageCounterSchema.optional(),
    text_tokens: usageCounterSchema.optional(),
    audio_tokens: usageCounterSchema.optional(),
    image_tokens: usageCounterSchema.optional(),
    video_tokens: usageCounterSchema.optional(),
    accepted_prediction_tokens: usageCounterSchema.optional(),
    rejected_prediction_tokens: usageCounterSchema.optional(),
  }).optional(),
  total_tokens: usageCounterSchema,
  server_tool_use: z.object({
    web_search_requests: usageCounterSchema.optional(),
    web_fetch_requests: usageCounterSchema.optional(),
    code_execution_requests: usageCounterSchema.optional(),
    bash_code_execution_requests: usageCounterSchema.optional(),
    text_editor_code_execution_requests: usageCounterSchema.optional(),
    computer_use_requests: usageCounterSchema.optional(),
    file_search_requests: usageCounterSchema.optional(),
    image_generation_requests: usageCounterSchema.optional(),
  }).optional(),
});

export const taskSegmentSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.enum(['thinking', 'answer']),
    text: z.string(),
  }),
  z.object({
    type: z.literal('function_call'),
    id: z.string(),
    call_id: z.string(),
    name: z.string(),
    arguments: z.string(),
    status: taskToolCallStatusSchema,
  }),
  z.object({
    type: z.literal('custom_tool_call'),
    id: z.string(),
    call_id: z.string(),
    name: z.string(),
    input: z.string(),
    status: taskToolCallStatusSchema,
  }),
]);

export const taskOutputSchema = z.object({
  name: z.string().optional(),
  mimeType: z.string(),
  sizeBytes: z.number().int().nonnegative().nullable(),
  // A link keeps the file name the model wrote, so no uri format is declared.
  url: z.string().optional(),
  kind: z.enum(['image', 'video', 'audio', 'text', 'file']),
  text: z.string().optional(),
  segments: z.array(taskSegmentSchema).optional(),
  finishreason: taskFinishReasonSchema.optional(),
  usage: taskUsageSchema.optional(),
});

export const taskResultOutputSchema = {
  state: taskStateSchema,
  task: taskReferenceSchema,
  outputs: z.array(taskOutputSchema),
  response: z.string().optional(),
  error: z.string().optional(),
  nextAction: nextActionSchema.optional(),
};

const taskListItemOutputSchema = taskOutputSchema.omit({
  text: true,
  segments: true,
  finishreason: true,
});

export const taskListOutputSchema = {
  tasks: z.array(z.object({
    state: taskStateSchema,
    task: taskReferenceSchema,
    outputs: z.array(taskListItemOutputSchema),
  })),
  total: z.number().int().nonnegative(),
  start: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  nextStart: z.number().int().nonnegative().nullable(),
  nextAction: nextActionSchema.optional(),
};

export const modelSummarySchema = z.object({
  slug: z.string(),
  title: z.string(),
  description: z.string().optional(),
  categories: z.array(z.string()),
  pricing: z.string().optional(),
  estimatedCostUsd: z.number().nullable().optional()
    .describe('Estimated USD cost of one run: the average of past runs for a model billed by run time, or the listed estimate of a price set when the run ends. Null when there is no such estimate, as for a model priced by its options: see pricing.'),
  discountPercent: z.number().optional()
    .describe('Your discount on this model, in percent. It comes off the part of a charge paid from deposits; coupon credit and store revenue pay first, at the list price in pricing.'),
});

export const modelListOutputSchema = {
  models: z.array(modelSummarySchema),
  total: z.number().int().nonnegative(),
  start: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  nextStart: z.number().int().nonnegative().nullable(),
  nextAction: nextActionSchema.optional(),
};

export const modelParameterSchema = z.object({
  id: z.string(),
  type: z.string(),
  label: z.string(),
  description: z.string().optional(),
  default: z.string().optional()
    .describe('What a run uses when the parameter is left out.'),
  sample: z.string().optional()
    .describe('The value from the model\'s page. A workflow step that leaves the parameter out gets it. A run does not: it leaves an optional parameter empty (a seed is picked at random) and refuses a required one that is left out.'),
  required: z.boolean(),
  placeholder: z.string().optional(),
  note: z.string().optional(),
  options: z.array(z.object({
    label: z.string(),
    value: z.string(),
  })),
  min: z.number().optional(),
  max: z.number().optional(),
  step: z.number().optional(),
  advanced: z.boolean(),
  jsonSchema: z.record(z.string(), z.unknown()).optional(),
});

export const modelDetailOutputSchema = {
  model: modelSummarySchema.extend({
    pricingNotes: z.array(z.string()).optional()
      .describe('Notes from the model\'s price list, as its page shows them, such as the rates behind a price or the setting it applies to.'),
    parameters: z.array(z.object({
      title: z.string(),
      items: z.array(modelParameterSchema),
    })),
    // Workflow utilities only: the output ports other steps can reference.
    outputs: z.array(z.object({
      id: z.string(),
      label: z.string(),
      type: z.string(),
    })).optional(),
    dynamicOutputs: z.boolean().optional(),
  }),
  nextAction: nextActionSchema,
};

export const exploreOutputSchema = {
  categories: z.array(z.object({
    title: z.string(),
    total: z.number().int().nonnegative(),
    models: z.array(modelSummarySchema),
  })),
  nextAction: nextActionSchema.optional(),
};

export const taskPriceOutputSchema = {
  state: taskStateSchema,
  task: taskReferenceSchema,
  billed: z.boolean().nullable(),
  costUsd: z.number().nullable()
    .describe('The amount charged so far; null while the task is active or a successful task\'s charge is not recorded yet. While billed is null, a later charge is still possible.'),
  nextAction: nextActionSchema.optional(),
};

export const taskActionOutputSchema = {
  action: z.enum(['cancel', 'kill']),
  success: z.boolean(),
  task: z.object({
    id: z.string().optional(),
    token: z.string().optional(),
  }),
  message: z.string(),
};

export const uploadedFileOutputSchema = {
  file: z.object({
    id: z.string(),
    name: z.string(),
    mimeType: z.string(),
    sizeBytes: z.number().int().nonnegative().nullable(),
    url: z.string(),
  }),
};

export const docsSearchOutputSchema = {
  query: z.string(),
  matches: z.array(z.object({
    title: z.string(),
    text: z.string(),
  })),
  docsUrl: z.string().url(),
};
