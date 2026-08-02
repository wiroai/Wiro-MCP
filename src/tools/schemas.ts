import { z } from 'zod';

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
  costUsd: z.number().nullable().optional(),
});

export const taskOutputSchema = z.object({
  name: z.string().optional(),
  mimeType: z.string(),
  sizeBytes: z.number().int().nonnegative().nullable(),
  url: z.string().url().optional(),
  kind: z.enum(['image', 'video', 'audio', 'text', 'file']),
  text: z.string().optional(),
});

export const taskResultOutputSchema = {
  state: taskStateSchema,
  task: taskReferenceSchema,
  outputs: z.array(taskOutputSchema),
  response: z.string().optional(),
  error: z.string().optional(),
  nextAction: nextActionSchema.optional(),
};

export const taskListOutputSchema = {
  tasks: z.array(z.object({
    state: taskStateSchema,
    task: taskReferenceSchema,
    outputs: z.array(taskOutputSchema),
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
  estimatedCostUsd: z.number().nullable().optional(),
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
  default: z.string().optional(),
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
});

export const modelDetailOutputSchema = {
  model: modelSummarySchema.extend({
    parameters: z.array(z.object({
      title: z.string(),
      items: z.array(modelParameterSchema),
    })),
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
  costUsd: z.number().nullable(),
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
    url: z.string().url(),
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
