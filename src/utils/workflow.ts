import { z } from 'zod';
import {
  asString,
  isPlainObject,
  toInteger,
  toNumber,
  truncate,
  unixToIso,
} from './api.js';
import type { MediaItem } from './media.js';

// Workflow rows and runs as the Wiro API returns them, projected to what an
// assistant needs. Owner, team and moderator identities are dropped, and run
// outputs are resolved from the End node the same way the run engine does.

export const WORKFLOW_PAGE_URL = 'https://wiro.ai/workflows/';
export const RUN_TERMINAL_STATUSES = ['completed', 'failed', 'cancelled', 'stopped'] as const;

export class WorkflowInputError extends Error {}

// What the workflow tools hide, and where. A secret-looking name matches
// SENSITIVE_INPUT_KEY (the Workflow Agent's own rule); a key-looking value
// matches looksLikeSecretValue.
// - Input lists (get_workflow and the save results): a Start field's default and
//   saved value show as "[hidden]" under a secret-looking name or when the value
//   looks like a key, for every caller.
// - get_workflow contents, for every caller: a saved value (metadata.input.values)
//   or Start field default under a secret-looking name or that looks like a key
//   shows as "[hidden]". For a caller outside the workflow's workspace, values
//   under a secret-looking key at any depth of a step's input also show as
//   "[REDACTED]". "$" references are wiring, not values, and stay as they are.
// - wait_for_workflow_run debug_node_id: the inputs a step received, under a
//   secret-looking key at any depth ("[hidden]").
// update_workflow restores "[hidden]" and "[REDACTED]" from the saved workflow.
export const SENSITIVE_INPUT_KEY = /(^|[-_])(password|secret|api[-_]?key|authorization|credentials?|private[-_]?key|access[-_]?token|refresh[-_]?token|client[-_]?secret|bearer[-_]?token|token)([-_]|$)/i;

// The shapes of common provider API keys, which a name check alone misses
// (an "openai_key" field, say).
const PROVIDER_KEY_SHAPES = [
  /^sk-[A-Za-z0-9_-]{20,}$/, // OpenAI, Anthropic
  /^AIza[0-9A-Za-z_-]{30,}$/, // Google API
  /^(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}$/, // GitHub
  /^github_pat_[A-Za-z0-9_]{20,}$/, // GitHub fine-grained
  /^xox[abprs]-[A-Za-z0-9-]{10,}$/, // Slack
  /^AKIA[0-9A-Z]{16}$/, // AWS access key id
  /^hf_[A-Za-z0-9]{30,}$/, // Hugging Face
  /^r8_[A-Za-z0-9]{30,}$/, // Replicate
  /^(sk|rk)_(live|test)_[A-Za-z0-9]{16,}$/, // Stripe
];

/** True for a string shaped like a known provider's API key, whatever field holds it. */
export function looksLikeSecretValue(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  return PROVIDER_KEY_SHAPES.some(shape => shape.test(text));
}

function isFilledValue(value: unknown): boolean {
  return value !== '' && value !== null && value !== undefined;
}

/** Whether a Start field's default or saved value is shown as "[hidden]". */
function hidesStartValue(key: string, value: unknown): boolean {
  return isFilledValue(value) && (looksLikeSecretValue(value) || SENSITIVE_INPUT_KEY.test(key));
}

/** Accepts '<slug>-<slugid>' or a wiro.ai workflow URL and returns the full slug. */
export function parseWorkflowSlug(input: string): string {
  let value = input.trim();
  if (/^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      value = url.pathname.split('/').filter(Boolean).pop() ?? '';
    } catch {
      throw new WorkflowInputError(`"${input}" is not a valid workflow URL.`);
    }
  }
  value = decodeURIComponent(value.split(/[?#]/)[0] ?? '');
  const separator = value.lastIndexOf('-');
  const slugid = separator > 0 ? value.slice(separator + 1) : '';
  if (value.length < 7 || separator <= 0 || !/^[A-Za-z0-9]{5}$/.test(slugid)) {
    throw new WorkflowInputError(
      `"${input}" is not a full workflow slug. Use the "fullSlug" from list_workflows `
      + 'or get_workflow (it ends with a dash and a 5-character id), or the workflow page URL.',
    );
  }
  return value;
}

export function fullSlugOf(row: Record<string, unknown>): string | undefined {
  const slug = asString(row.slug);
  const slugid = asString(row.slugid);
  return slug && slugid ? `${slug}-${slugid}` : undefined;
}

export function workflowUrl(fullSlug: string): string {
  return `${WORKFLOW_PAGE_URL}${fullSlug}`;
}

export function parseJsonValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

export function workflowTags(row: Record<string, unknown>): string[] {
  const tags = parseJsonValue(row.tags);
  return Array.isArray(tags) ? tags.filter((tag): tag is string => typeof tag === 'string') : [];
}

export type WorkflowState = 'private' | 'pending_review' | 'published' | 'rejected';

export function workflowState(row: Record<string, unknown>): WorkflowState {
  if (toInteger(row.ispublic) !== 1) return 'private';
  const status = toInteger(row.status, 1);
  if (status === 2) return 'published';
  if (status === 3) return 'rejected';
  return 'pending_review';
}

export const workflowInputSchema = z.object({
  key: z.string(),
  label: z.string(),
  type: z.string(),
  field: z.string().optional(),
  options: z.array(z.object({ value: z.string(), text: z.string() })).optional(),
  default: z.unknown().optional(),
  savedValue: z.unknown().optional(),
});

export type WorkflowInputSummary = z.infer<typeof workflowInputSchema>;

/** The Start fields a run takes, keyed exactly as /Workflow/Run expects. */
export function workflowInputs(contents: unknown): WorkflowInputSummary[] {
  if (!isPlainObject(contents)) return [];
  const schema = isPlainObject(contents.schema) ? contents.schema : {};
  const fields = isPlainObject(schema.input) ? schema.input : {};
  const metadata = isPlainObject(contents.metadata) ? contents.metadata : {};
  const inputMetadata = isPlainObject(metadata.input) ? metadata.input : {};
  const values = isPlainObject(inputMetadata.values) ? inputMetadata.values : {};

  return Object.entries(fields).map(([key, rawField]) => {
    const field = isPlainObject(rawField) ? rawField : {};
    const ui = isPlainObject(field.ui) ? field.ui : {};
    const options = Array.isArray(ui.options)
      ? ui.options
        .filter(isPlainObject)
        .map(option => ({
          value: String(option.value ?? ''),
          text: String(option.text ?? option.value ?? ''),
        }))
      : undefined;
    // A summary is for showing the inputs, so a secret-looking field's value and
    // a value that looks like a key are masked here, for every caller.
    const shown = (value: unknown) => (hidesStartValue(key, value) ? '[hidden]' : value);
    return {
      key,
      label: asString(field.label) || asString(field.name) || key,
      type: asString(field.type) || 'string',
      ...(asString(ui.field) ? { field: asString(ui.field) } : {}),
      ...(options && options.length > 0 ? { options } : {}),
      ...(Object.prototype.hasOwnProperty.call(field, 'defaultValue') ? { default: shown(field.defaultValue) } : {}),
      ...(Object.prototype.hasOwnProperty.call(values, key) ? { savedValue: shown(values[key]) } : {}),
    };
  });
}

/** End node fields: output label to reference. */
export function workflowOutputs(contents: unknown): Record<string, unknown> {
  if (!isPlainObject(contents) || !isPlainObject(contents.nodes)) return {};
  const end = contents.nodes.output;
  return isPlainObject(end) && isPlainObject(end.fields) ? { ...end.fields } : {};
}

export function workflowStepCount(contents: unknown): number {
  if (!isPlainObject(contents) || !isPlainObject(contents.nodes)) return 0;
  return Object.keys(contents.nodes).filter(key => key !== 'output').length;
}

export const workflowSummarySchema = z.object({
  fullSlug: z.string(),
  url: z.string(),
  title: z.string(),
  description: z.string().optional(),
  tags: z.array(z.string()),
  state: z.enum(['private', 'pending_review', 'published', 'rejected']).optional(),
  rejectReason: z.string().optional(),
  isProtected: z.boolean(),
  isClone: z.boolean().optional(),
  stepCount: z.number().optional(),
  toolCount: z.number().optional(),
  models: z.array(z.string()).optional(),
  creator: z.string().optional(),
  team: z.string().optional(),
  runCount: z.number().optional()
    .describe('Runs while the workflow was in the public gallery, by anyone. Left out when there are none; the owner\'s runs of a private workflow are in list_workflow_runs.'),
  likeCount: z.number().optional(),
  cloneCount: z.number().optional(),
  ratingAverage: z.number().optional(),
  ratingCount: z.number().optional(),
  commentCount: z.number().optional(),
  cover: z.string().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  updatetime: z.string().optional(),
});

export type WorkflowSummary = z.infer<typeof workflowSummarySchema>;

function optionalNumber(value: unknown): number | undefined {
  const parsed = toNumber(value);
  return parsed === null ? undefined : parsed;
}

export function toWorkflowSummary(
  row: Record<string, unknown>,
  options: { includeState?: boolean } = {},
): WorkflowSummary {
  const fullSlug = fullSlugOf(row) ?? '';
  const user = isPlainObject(row.user) ? row.user : undefined;
  const models = Array.isArray(row.tools)
    ? row.tools.filter((tool): tool is string => typeof tool === 'string')
    : undefined;
  const description = asString(row.description);
  const rejectReason = asString(row.rejectreason);

  return {
    fullSlug,
    url: workflowUrl(fullSlug),
    title: asString(row.title) ?? fullSlug,
    ...(description ? { description: truncate(description, 600) } : {}),
    tags: workflowTags(row),
    ...(options.includeState ? { state: workflowState(row) } : {}),
    ...(options.includeState && rejectReason ? { rejectReason } : {}),
    isProtected: toInteger(row.isprotected) === 1,
    ...(row.clonedfromid !== undefined ? { isClone: row.clonedfromid !== null && row.clonedfromid !== '' } : {}),
    ...(optionalNumber(row.stepcount) !== undefined ? { stepCount: optionalNumber(row.stepcount) } : {}),
    ...(optionalNumber(row.toolcount) !== undefined ? { toolCount: optionalNumber(row.toolcount) } : {}),
    ...(models ? { models } : {}),
    ...(user && asString(user.username) ? { creator: asString(user.username) } : {}),
    ...(asString(row.teamname) ? { team: asString(row.teamname) } : {}),
    // Wiro counts runs only while a workflow is in the public gallery, so the
    // owner's runs of a private workflow or a copy are not in it.
    ...((optionalNumber(row.runcount) ?? 0) > 0 ? { runCount: optionalNumber(row.runcount) } : {}),
    ...(optionalNumber(row.likecount) !== undefined ? { likeCount: optionalNumber(row.likecount) } : {}),
    ...(optionalNumber(row.clonecount) !== undefined ? { cloneCount: optionalNumber(row.clonecount) } : {}),
    ...(optionalNumber(row.ratingaverage) !== undefined ? { ratingAverage: optionalNumber(row.ratingaverage) } : {}),
    ...(optionalNumber(row.ratingcount) !== undefined ? { ratingCount: optionalNumber(row.ratingcount) } : {}),
    ...(optionalNumber(row.commentcount) !== undefined ? { commentCount: optionalNumber(row.commentcount) } : {}),
    ...(asString(row.cover) ? { cover: asString(row.cover) } : {}),
    ...(unixToIso(row.createtime) ? { createdAt: unixToIso(row.createtime) } : {}),
    ...(unixToIso(row.updatetime) ? { updatedAt: unixToIso(row.updatetime) } : {}),
    ...(asString(row.updatetime) ? { updatetime: asString(row.updatetime) } : {}),
  };
}


/** Masks, in place, the Start field defaults and saved values under a secret-looking name or that look like a key. */
function maskStartValues(contents: Record<string, unknown>): void {
  const schema = isPlainObject(contents.schema) ? contents.schema : {};
  if (isPlainObject(schema.input)) {
    for (const [key, field] of Object.entries(schema.input)) {
      if (isPlainObject(field) && hidesStartValue(key, field.defaultValue)) field.defaultValue = '[hidden]';
    }
  }
  const metadata = isPlainObject(contents.metadata) ? contents.metadata : {};
  const inputMetadata = isPlainObject(metadata.input) ? metadata.input : {};
  if (isPlainObject(inputMetadata.values)) {
    const values = inputMetadata.values;
    for (const [key, value] of Object.entries(values)) {
      if (hidesStartValue(key, value)) values[key] = '[hidden]';
    }
  }
}

/** A step input with every value under a secret-looking key blanked, at any depth. */
function redactSecretKeys(value: unknown, secret = false): unknown {
  if (typeof value === 'string') return secret && !value.startsWith('$') ? '[REDACTED]' : value;
  if (Array.isArray(value)) return value.map(entry => redactSecretKeys(entry, secret));
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
      key,
      redactSecretKeys(entry, secret || SENSITIVE_INPUT_KEY.test(key)),
    ]));
  }
  return secret && value !== null && value !== undefined ? '[REDACTED]' : value;
}

/** The graph as a caller outside the workflow's workspace sees it. */
function redactNodeInputs(contents: Record<string, unknown>): Record<string, unknown> {
  const copy = JSON.parse(JSON.stringify(contents)) as Record<string, unknown>;
  if (isPlainObject(copy.nodes)) {
    for (const node of Object.values(copy.nodes)) {
      if (isPlainObject(node) && node.input !== undefined) node.input = redactSecretKeys(node.input);
    }
  }
  maskStartValues(copy);
  return copy;
}

/** The graph as the workflow's own workspace sees it: secret Start values are hidden, step inputs are not. */
function hideStartValues(contents: Record<string, unknown>): Record<string, unknown> {
  const copy = JSON.parse(JSON.stringify(contents)) as Record<string, unknown>;
  maskStartValues(copy);
  return copy;
}

export const workflowDetailSchema = workflowSummarySchema.extend({
  insider: z.boolean(),
  canEditGraph: z.boolean(),
  graphHidden: z.boolean(),
  ownerInactive: z.boolean().optional(),
  inputs: z.array(workflowInputSchema),
  outputs: z.record(z.string(), z.unknown()),
  estimatedCost: z.object({
    type: z.string().optional(),
    valueUsd: z.number().nullable().optional(),
  }).optional(),
  contents: z.record(z.string(), z.unknown()).optional(),
});

export type WorkflowDetail = z.infer<typeof workflowDetailSchema>;

export function toWorkflowDetail(
  row: Record<string, unknown>,
  options: { includeGraph?: boolean } = {},
): WorkflowDetail {
  const contents = parseJsonValue(row.contents);
  const contentsObject = isPlainObject(contents) ? contents : {};
  // Moderation fields are only sent to the owner and the owner's team.
  const insider = Object.prototype.hasOwnProperty.call(row, 'rejectreason');
  const isProtected = toInteger(row.isprotected) === 1;
  const isClone = row.clonedfromid !== undefined && row.clonedfromid !== null && row.clonedfromid !== '';
  const graphHidden = row.estimatedcost !== undefined
    || (isProtected && workflowStepCount(contentsObject) === 0);
  const estimated = isPlainObject(row.estimatedcost) ? row.estimatedcost : undefined;

  const description = asString(row.description);
  return {
    ...toWorkflowSummary(row, { includeState: insider }),
    // The full text: an edit starts from this value, so it must not be shortened.
    ...(description ? { description } : {}),
    // A hidden graph arrives emptied, so its own count would read 0; the row's
    // stepcount, when sent, is kept instead.
    ...(graphHidden ? {} : { stepCount: workflowStepCount(contentsObject) }),
    insider,
    canEditGraph: insider && !graphHidden && !(isClone && isProtected),
    graphHidden,
    ...(row.ownerinactive === true ? { ownerInactive: true } : {}),
    inputs: workflowInputs(contentsObject),
    outputs: workflowOutputs(contentsObject),
    ...(estimated
      ? {
        estimatedCost: {
          ...(asString(estimated.type) ? { type: asString(estimated.type) } : {}),
          valueUsd: toNumber(estimated.value),
        },
      }
      : {}),
    ...(options.includeGraph !== false && !graphHidden && isPlainObject(contents)
      ? { contents: insider ? hideStartValues(contentsObject) : redactNodeInputs(contentsObject) }
      : {}),
  };
}

/** A value for a one-line summary: long text is cut inside its quotes. */
function summaryValue(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(truncate(value, 80));
  return truncate(JSON.stringify(value) ?? '', 80);
}

export function formatWorkflowInputs(inputs: WorkflowInputSummary[]): string[] {
  if (inputs.length === 0) return ['No inputs. Run it with no `input`.'];
  return inputs.map(input => {
    const kind = input.field ? `${input.type}, ${input.field}` : input.type;
    const fallback = input.savedValue !== undefined
      ? ` (saved value: ${summaryValue(input.savedValue)})`
      : input.default !== undefined && input.default !== ''
        ? ` (default: ${summaryValue(input.default)})`
        : '';
    const options = input.options ? ` options: ${input.options.map(option => option.value).join(', ')}` : '';
    return `- \`${input.key}\` (${kind}): ${input.label}${fallback}${options}`;
  });
}

// ---------------------------------------------------------------------------
// Runs

export const runOutputItemSchema = z.object({
  url: z.string().optional(),
  name: z.string().optional(),
  mimeType: z.string().optional(),
  sizeBytes: z.number().nullable().optional(),
  text: z.string().optional(),
});

export type RunOutputItem = z.infer<typeof runOutputItemSchema>;

export const runStepSchema = z.object({
  nodeId: z.string(),
  tool: z.string().optional(),
  kind: z.string().optional(),
  status: z.string(),
  cause: z.string().optional(),
  error: z.string().optional(),
});

export const workflowRunSchema = z.object({
  workflowtoken: z.string(),
  workflowSlug: z.string().optional(),
  status: z.string(),
  outcome: z.string().optional(),
  canResume: z.boolean(),
  graphMasked: z.boolean().optional(),
  breakpointNodeId: z.string().nullable().optional(),
  startedAt: z.string().optional(),
  resumedAt: z.string().optional(),
  endedAt: z.string().optional(),
  elapsedSeconds: z.number().optional(),
  listPriceUsd: z.number().nullable().optional(),
  chargedUsd: z.number().nullable().optional(),
  discountUsd: z.number().nullable().optional(),
  outputs: z.record(z.string(), z.array(runOutputItemSchema)),
  unresolvedOutputs: z.array(z.object({ field: z.string(), reason: z.string() })).optional(),
  steps: z.array(runStepSchema),
  counts: z.object({
    failed: z.number(),
    aborted: z.number(),
    cancelled: z.number(),
    pending: z.number(),
    running: z.number(),
    completed: z.number(),
  }),
});

export type WorkflowRun = z.infer<typeof workflowRunSchema>;

export function isRunTerminal(status: unknown): boolean {
  return (RUN_TERMINAL_STATUSES as readonly string[]).includes(String(status));
}

function msToIso(value: unknown): string | undefined {
  const ms = toNumber(value);
  return ms !== null && ms > 0 ? new Date(ms).toISOString() : undefined;
}

export function isStrictlyEmpty(value: unknown): boolean {
  if (value === null || value === undefined || value === '') return true;
  if (Array.isArray(value)) return value.length === 0;
  if (isPlainObject(value)) return Object.keys(value).length === 0;
  return false;
}

function normalizeOutputValue(value: unknown, out: RunOutputItem[], depth = 0): void {
  if (depth > 6 || value === null || value === undefined) return;
  if (Array.isArray(value)) {
    for (const entry of value) normalizeOutputValue(entry, out, depth + 1);
    return;
  }
  if (typeof value === 'string') {
    if (/^https?:\/\//i.test(value.trim())) out.push({ url: value.trim() });
    else if (value) out.push({ text: truncate(value, 20_000) });
    return;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    out.push({ text: String(value) });
    return;
  }
  if (!isPlainObject(value)) return;
  if (Array.isArray(value.children) && value.children.length > 0) {
    normalizeOutputValue(value.children, out, depth + 1);
    return;
  }
  if (value.contenttype === 'raw' && isPlainObject(value.content)) {
    const answer = value.content.answer;
    const text = Array.isArray(answer)
      ? answer.map(part => (typeof part === 'string' ? part : isPlainObject(part) ? asString(part.text) ?? '' : '')).join('')
      : asString(answer) ?? '';
    if (text) out.push({ text: truncate(text, 20_000) });
    return;
  }
  if (typeof value.url === 'string' && value.url) {
    out.push({
      url: value.url,
      ...(asString(value.name) ? { name: asString(value.name) } : {}),
      ...(asString(value.contenttype) ? { mimeType: asString(value.contenttype) } : {}),
      sizeBytes: toNumber(value.size),
    });
  }
}

/**
 * Resolves the End node's fields against the run's step outputs, following the
 * run engine: '$node-X.outputs' is a model step's output list, '$node-X.<port>'
 * a utility port, '$input.<key>' the run's Start value, anything else a literal.
 */
export function resolveRunOutputs(
  contents: unknown,
  nodes: Array<Record<string, unknown>>,
): { outputs: Record<string, RunOutputItem[]>; unresolved: Array<{ field: string; reason: string }> } {
  const outputs: Record<string, RunOutputItem[]> = {};
  const unresolved: Array<{ field: string; reason: string }> = [];
  const fields = workflowOutputs(contents);
  const byId = new Map(nodes.map(node => [asString(node.nodeId) ?? '', node]));
  const contentsObject = isPlainObject(contents) ? contents : {};
  const schema = isPlainObject(contentsObject.schema) ? contentsObject.schema : {};
  const schemaInput = isPlainObject(schema.input) ? schema.input : {};
  const metadata = isPlainObject(contentsObject.metadata) ? contentsObject.metadata : {};
  const metadataInput = isPlainObject(metadata.input) ? metadata.input : {};
  const values = isPlainObject(metadataInput.values) ? metadataInput.values : {};

  for (const [field, reference] of Object.entries(fields)) {
    const references = Array.isArray(reference) ? reference : [reference];
    const items: RunOutputItem[] = [];
    for (const ref of references) {
      if (typeof ref !== 'string' || !ref.startsWith('$')) {
        normalizeOutputValue(ref, items);
        continue;
      }
      if (ref.startsWith('$input.')) {
        const key = ref.slice('$input.'.length);
        const stored = Object.prototype.hasOwnProperty.call(values, key) ? values[key] : undefined;
        const fieldDef = isPlainObject(schemaInput[key]) ? schemaInput[key] as Record<string, unknown> : {};
        normalizeOutputValue(isStrictlyEmpty(stored) ? fieldDef.defaultValue : stored, items);
        continue;
      }
      const match = /^\$(node-[^.]+)\.(.+)$/.exec(ref);
      if (!match) {
        unresolved.push({ field, reason: `Malformed reference ${ref}` });
        continue;
      }
      const node = byId.get(match[1]!);
      if (!node) {
        unresolved.push({ field, reason: `Step ${match[1]} is not part of this run's results` });
        continue;
      }
      if (node.status !== 'completed') {
        unresolved.push({ field, reason: `Step ${match[1]} is ${String(node.status)}` });
        continue;
      }
      const stepOutputs = node.outputs;
      if (match[2] === 'outputs' && Array.isArray(stepOutputs)) {
        normalizeOutputValue(stepOutputs, items);
      } else if (isPlainObject(stepOutputs) && Object.prototype.hasOwnProperty.call(stepOutputs, match[2]!)) {
        normalizeOutputValue(stepOutputs[match[2]!], items);
      } else {
        unresolved.push({ field, reason: `Step ${match[1]} has no output "${match[2]}"` });
      }
    }
    outputs[field] = items;
  }
  return { outputs, unresolved };
}

export function toWorkflowRun(
  run: Record<string, unknown>,
  nodes: Array<Record<string, unknown>>,
): WorkflowRun {
  const status = asString(run.status) ?? 'running';
  const terminal = isRunTerminal(status);
  const resolved = terminal ? resolveRunOutputs(run.contents, nodes) : { outputs: {}, unresolved: [] };
  const counts = { failed: 0, aborted: 0, cancelled: 0, pending: 0, running: 0, completed: 0 };
  const steps: WorkflowRun['steps'] = [];
  for (const node of nodes) {
    const nodeStatus = asString(node.status) ?? 'pending';
    if (nodeStatus in counts) counts[nodeStatus as keyof typeof counts] += 1;
    if (nodeStatus === 'completed') continue;
    const error = asString(node.error);
    steps.push({
      nodeId: asString(node.nodeId) ?? '',
      ...(asString(node.tool) ? { tool: asString(node.tool) } : {}),
      ...(asString(node.kind) ? { kind: asString(node.kind) } : {}),
      status: nodeStatus,
      ...(asString(node.cause) ? { cause: asString(node.cause) } : {}),
      ...(error ? { error: truncate(error, 500) } : {}),
    });
  }

  return {
    workflowtoken: asString(run.workflowtoken) ?? '',
    ...(asString(run.workflowslug) ? { workflowSlug: asString(run.workflowslug) } : {}),
    status,
    ...(asString(run.outcome) ? { outcome: asString(run.outcome) } : {}),
    canResume: run.canresume === true,
    ...(run.graphmasked === true ? { graphMasked: true } : {}),
    ...(run.breakpointnodeid !== undefined ? { breakpointNodeId: asString(run.breakpointnodeid) ?? null } : {}),
    ...(msToIso(run.startedAt) ? { startedAt: msToIso(run.startedAt) } : {}),
    ...(msToIso(run.resumedAt) ? { resumedAt: msToIso(run.resumedAt) } : {}),
    ...(msToIso(run.endedAt) ? { endedAt: msToIso(run.endedAt) } : {}),
    ...(toNumber(run.elapsedseconds) !== null ? { elapsedSeconds: toNumber(run.elapsedseconds)! } : {}),
    ...(run.totalcost !== undefined ? { listPriceUsd: toNumber(run.totalcost) } : {}),
    ...(run.chargedcost !== undefined ? { chargedUsd: toNumber(run.chargedcost) } : {}),
    ...(run.discountamount !== undefined ? { discountUsd: toNumber(run.discountamount) } : {}),
    outputs: resolved.outputs,
    ...(resolved.unresolved.length > 0 ? { unresolvedOutputs: resolved.unresolved } : {}),
    steps,
    counts,
  };
}

export function runMediaItems(run: WorkflowRun): MediaItem[] {
  const items: MediaItem[] = [];
  for (const [field, values] of Object.entries(run.outputs)) {
    for (const value of values) {
      if (value.url) items.push({ url: value.url, name: value.name || field, ...(value.mimeType ? { mimeType: value.mimeType } : {}) });
    }
  }
  return items;
}

export function formatWorkflowRun(run: WorkflowRun): string {
  const lines: string[] = ['## Workflow Run', ''];
  lines.push(`**Status:** ${run.status}`);
  lines.push(`**Run token:** \`${run.workflowtoken}\``);
  if (run.workflowSlug) lines.push(`**Workflow:** ${workflowUrl(run.workflowSlug)}`);
  if (run.elapsedSeconds !== undefined) lines.push(`**Duration:** ${run.elapsedSeconds}s`);
  if (run.chargedUsd !== undefined && run.chargedUsd !== null) {
    lines.push(`**Charged:** $${run.chargedUsd}`);
  } else if (run.listPriceUsd !== undefined && run.listPriceUsd !== null) {
    lines.push(`**Cost so far (list price):** $${run.listPriceUsd}`);
  }

  const fields = Object.entries(run.outputs);
  if (fields.length > 0) {
    lines.push('', '### Outputs', '');
    for (const [field, values] of fields) {
      if (values.length === 0) {
        lines.push(`- **${field}:** (empty)`);
        continue;
      }
      for (const value of values) {
        if (value.url) lines.push(`- **${field}:** ${value.url}`);
        else if (value.text) lines.push(`- **${field}:** ${truncate(value.text, 2_000)}`);
      }
    }
  }
  for (const missing of run.unresolvedOutputs ?? []) {
    lines.push(`- **${missing.field}:** not available (${missing.reason})`);
  }

  const problems = run.steps.filter(step => step.status === 'failed' || step.status === 'aborted' || step.status === 'cancelled');
  if (problems.length > 0) {
    lines.push('', '### Steps that did not finish', '');
    for (const step of problems) {
      const reason = step.status === 'aborted'
        ? 'skipped because an earlier step failed'
        : step.error || step.cause || step.status;
      lines.push(`- \`${step.nodeId}\`${step.tool ? ` (${step.tool})` : ''}: ${step.status}, ${reason}`);
    }
  }
  if (run.canResume) {
    lines.push('', 'This run can be resumed with `resume_workflow_run`. Completed steps are kept and not charged again.');
  }
  return lines.join('\n');
}
