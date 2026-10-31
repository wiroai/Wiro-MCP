import { WiroApiError, type WiroClient } from '../client.js';
import {
  asString,
  isPlainObject,
  requireApiSuccess,
  toInteger,
  truncate,
  type ApiEnvelope,
} from './api.js';
import {
  fullSlugOf,
  isStrictlyEmpty,
  parseJsonValue,
  SENSITIVE_INPUT_KEY,
  workflowInputs,
  workflowOutputs,
  workflowState,
  workflowTags,
  workflowUrl,
  type WorkflowInputSummary,
  type WorkflowState,
} from './workflow.js';

// Saving a workflow graph that was written outside the Wiro editor. Wiro's
// /Workflow/Prepare runs the editor's own preparation (catalog defaults, input
// shapes, run-readiness checks, layout) so the saved workflow runs and opens
// cleanly in the editor; this module adds what only a caller can know: the
// stored row's Start values and hidden secrets, and the concurrency guard.

export interface PrepareIssue {
  code?: string;
  message: string;
  nodeId?: string;
  input?: string;
  /** For a graph over the size limit: its size in bytes, and the limit. */
  bytes?: number;
  limit?: number;
}

export class WorkflowPrepareError extends Error {
  readonly issues: PrepareIssue[];
  readonly warnings: PrepareIssue[];

  constructor(issues: PrepareIssue[], warnings: PrepareIssue[]) {
    super(issues.map(issue => (issue.nodeId ? `${issue.nodeId}: ${issue.message}` : issue.message)).join('\n')
      || 'The workflow could not be prepared.');
    this.name = 'WorkflowPrepareError';
    this.issues = issues;
    this.warnings = warnings;
  }
}

export class WorkflowConflictError extends Error {
  readonly currentUpdatetime?: string;

  constructor(message: string, currentUpdatetime?: string) {
    super(message);
    this.name = 'WorkflowConflictError';
    this.currentUpdatetime = currentUpdatetime;
  }
}

interface PrepareResponse extends ApiEnvelope {
  contents?: Record<string, unknown>;
  issues?: unknown[];
  warnings?: unknown[];
}

interface WorkflowRowResponse extends ApiEnvelope {
  workflow?: Array<Record<string, unknown>>;
  currentUpdatetime?: string | number;
}

function toIssues(value: unknown): PrepareIssue[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isPlainObject).map(issue => ({
    message: asString(issue.message) ?? 'Invalid workflow.',
    ...(asString(issue.code) ? { code: asString(issue.code) } : {}),
    ...(asString(issue.nodeId) ? { nodeId: asString(issue.nodeId) } : {}),
    ...(asString(issue.input) ? { input: asString(issue.input) } : {}),
    ...(typeof issue.bytes === 'number' && Number.isFinite(issue.bytes) ? { bytes: issue.bytes } : {}),
    ...(typeof issue.limit === 'number' && Number.isFinite(issue.limit) ? { limit: issue.limit } : {}),
  }));
}

export async function prepareWorkflowContents(
  client: WiroClient,
  contents: Record<string, unknown>,
  mode: 'create' | 'apply',
  anchorNodeIds: string[] = [],
  signal?: AbortSignal,
): Promise<{ contents: Record<string, unknown>; warnings: PrepareIssue[] }> {
  let response: PrepareResponse;
  try {
    response = await client.post<PrepareResponse>(
      '/Workflow/Prepare',
      { contents, mode, ...(mode === 'apply' ? { anchorNodeIds } : {}) },
      signal,
    );
  } catch (error) {
    if (error instanceof WiroApiError && error.status === 404) {
      throw new Error('This Wiro API does not support preparing workflows yet, so the workflow was not saved.');
    }
    throw error;
  }
  const warnings = toIssues(response.warnings);
  if (response.result !== true || !isPlainObject(response.contents)) {
    const issues = toIssues(response.issues);
    if (issues.length === 0) {
      issues.push(...toIssues(response.errors));
    }
    throw new WorkflowPrepareError(issues, warnings);
  }
  return { contents: response.contents, warnings };
}

// Prepare fills every model parameter a step leaves out with its catalog default,
// as the editor does on its canvas. For some models those defaults are the samples
// from the model's page (a prompt, input images), which every run then uses, so
// the caller is told what was filled.
const SAMPLE_FILE_PATH = /\/sampleinputs\//;

function isSampleFile(value: unknown): boolean {
  if (typeof value === 'string') return SAMPLE_FILE_PATH.test(value);
  return Array.isArray(value) && value.some(entry => typeof entry === 'string' && SAMPLE_FILE_PATH.test(entry));
}

function shortValue(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(truncate(value, 60));
  if (Array.isArray(value)) return `(${value.length} value${value.length === 1 ? '' : 's'})`;
  return truncate(JSON.stringify(value) ?? '', 60);
}

function holdsReference(value: unknown): boolean {
  if (typeof value === 'string') return value.startsWith('$input.') || value.startsWith('$node-');
  return Array.isArray(value) && value.some(holdsReference);
}

/** One note per model step that Prepare filled from the catalog. */
export function filledDefaultNotes(
  submitted: Record<string, unknown>,
  prepared: Record<string, unknown>,
): PrepareIssue[] {
  const notes: PrepareIssue[] = [];
  const before = isPlainObject(submitted.nodes) ? submitted.nodes : {};
  const after = isPlainObject(prepared.nodes) ? prepared.nodes : {};
  for (const [nodeId, node] of Object.entries(after)) {
    if (!isPlainObject(node) || node.type !== 'run' || !isPlainObject(node.input)) continue;
    if (typeof node.tool !== 'string' || node.tool.startsWith('workflow-utilities/')) continue;
    const original = before[nodeId];
    const authored = isPlainObject(original) && isPlainObject(original.input) ? original.input : {};
    const input = node.input;
    // Prepare moves a reference wired into a legacy multi-file input (<x>Multiple) to
    // its URL field (<x>UrlMultiple) and records the pair in metadata.multifileActiveParam.
    // That value is the caller's own wiring, as is any reference: no default is one.
    const moved = isPlainObject(node.metadata) && isPlainObject(node.metadata.multifileActiveParam)
      ? node.metadata.multifileActiveParam
      : {};
    const filled = Object.keys(input).filter(key => {
      if (Object.prototype.hasOwnProperty.call(authored, key)) return false;
      const parent = moved[key];
      if (typeof parent === 'string' && Object.prototype.hasOwnProperty.call(authored, parent)) return false;
      return !holdsReference(input[key]);
    });
    if (filled.length === 0) continue;

    const samples = filled.filter(key => key === 'prompt' || isSampleFile(input[key]));
    const defaults = filled.filter(key => !samples.includes(key));
    const parts: string[] = [];
    if (samples.length > 0) {
      const described = samples.map(key => (key === 'prompt' && !isSampleFile(input[key])
        ? `\`${key}\` (the sample text ${shortValue(input[key])})`
        : `\`${key}\` (sample files)`));
      parts.push(`Wiro filled ${described.join(' and ')} from the model's page, and every run uses `
        + `${samples.length === 1 ? 'it' : 'them'} as is. Set your own value, or an empty one ("" or []) to leave a file input out.`);
    }
    if (defaults.length > 0) {
      parts.push(`${samples.length > 0 ? 'Also filled' : 'Filled'} with the model's defaults: `
        + `${defaults.map(key => `\`${key}\` ${shortValue(input[key])}`).join(', ')}.`);
    }
    notes.push({ code: samples.length > 0 ? 'sample-defaults-filled' : 'defaults-filled', nodeId, message: parts.join(' ') });
  }
  return notes;
}

/**
 * Start field parts the caller changed that Wiro saves the editor's way instead
 * (a description, examples, required, name), as "`key` (part, part)".
 */
export function droppedStartFieldChanges(sent: Record<string, unknown>, prepared: Record<string, unknown>): string[] {
  const fieldsOf = (contents: Record<string, unknown>) => (isPlainObject(contents.schema) && isPlainObject(contents.schema.input)
    ? contents.schema.input
    : {});
  const after = fieldsOf(prepared);
  const dropped: string[] = [];
  for (const [key, field] of Object.entries(fieldsOf(sent))) {
    const kept = after[key];
    if (!isPlainObject(field) || !isPlainObject(kept)) continue;
    const parts = Object.keys(field).filter(part => JSON.stringify(field[part]) !== JSON.stringify(kept[part]));
    if (parts.length > 0) dropped.push(`\`${key}\` (${parts.join(', ')})`);
  }
  return dropped;
}

/** The editor's title-to-slug rule; the server adds the 5-character id. */
export function titleToSlug(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 200)
    .replace(/-$/, '');
  return slug || `workflow-${Date.now().toString(36)}`;
}

export function tagProblem(tags: string[]): string | null {
  if (tags.length > 20) return 'A workflow can have at most 20 tags.';
  for (const tag of tags) {
    if (!tag.trim()) return 'Tags cannot be empty.';
    if (tag.trim().toLowerCase().startsWith('wiro-')) return 'Tags that start with "wiro-" are reserved for Wiro.';
  }
  return null;
}

export interface SavedWorkflow {
  fullSlug: string;
  url: string;
  title: string;
  renamed: boolean;
  state?: WorkflowState;
  updatetime?: string;
  inputs: WorkflowInputSummary[];
  outputs: Record<string, unknown>;
  warnings: PrepareIssue[];
}

export async function createWorkflow(
  client: WiroClient,
  params: {
    title: string;
    contents: Record<string, unknown>;
    description?: string;
    tags?: string[];
    slug?: string;
  },
  signal?: AbortSignal,
): Promise<SavedWorkflow> {
  const title = params.title.trim();
  const prepared = await prepareWorkflowContents(client, params.contents, 'create', [], signal);
  const body: Record<string, unknown> = {
    slug: params.slug ? titleToSlug(params.slug) : titleToSlug(title),
    title,
    contents: JSON.stringify(prepared.contents),
  };
  if (params.description?.trim()) body.description = params.description.trim();
  if (params.tags && params.tags.length > 0) body.tags = JSON.stringify(params.tags.map(tag => tag.trim()));

  const result = requireApiSuccess(
    await client.post<WorkflowRowResponse>('/Workflow/Add', body, signal),
    'The workflow could not be created.',
  );
  const row = result.workflow?.[0] ?? {};
  const fullSlug = fullSlugOf(row);
  if (!fullSlug) throw new Error('The workflow was created but its slug did not come back. Find it with list_workflows.');
  const savedTitle = asString(row.title) ?? title;

  return {
    fullSlug,
    url: workflowUrl(fullSlug),
    title: savedTitle,
    renamed: savedTitle !== title,
    state: 'private',
    ...(asString(row.updatetime) ? { updatetime: asString(row.updatetime) } : {}),
    inputs: workflowInputs(prepared.contents),
    outputs: workflowOutputs(prepared.contents),
    warnings: [...prepared.warnings, ...filledDefaultNotes(params.contents, prepared.contents)],
  };
}

// When Wiro shows a workflow to an agent, it replaces the value under any
// secret-looking key (at any depth of a step's input, and the default of a Start
// field with such a name) with one of the first two markers. "[hidden]" is the
// mask this package itself shows in input summaries.
const HIDDEN_VALUES = new Set(['[REDACTED]', '[OMITTED]', '[hidden]']);

function collectHidden(value: unknown, path: string, found: string[]): void {
  if (typeof value === 'string') {
    if (HIDDEN_VALUES.has(value)) found.push(path);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => collectHidden(entry, `${path}[${index}]`, found));
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, entry] of Object.entries(value)) collectHidden(entry, `${path}.${key}`, found);
  }
}

/** Places in a graph that hold a hidden-secret marker instead of a value. */
export function findHiddenValues(contents: Record<string, unknown>): string[] {
  const found: string[] = [];
  if (isPlainObject(contents.nodes)) {
    for (const [nodeId, node] of Object.entries(contents.nodes)) {
      if (isPlainObject(node)) collectHidden(node.input, `step ${nodeId} input`, found);
    }
  }
  const schema = isPlainObject(contents.schema) ? contents.schema : {};
  if (isPlainObject(schema.input)) {
    for (const [key, field] of Object.entries(schema.input)) collectHidden(field, `Start field ${key}`, found);
  }
  const values = savedStartValues(contents);
  for (const [key, value] of Object.entries(values)) collectHidden(value, `saved value of Start field ${key}`, found);
  return found;
}

/** The Start values saved with a graph (metadata.input.values). */
function savedStartValues(contents: Record<string, unknown>): Record<string, unknown> {
  const metadata = isPlainObject(contents.metadata) ? contents.metadata : {};
  const input = isPlainObject(metadata.input) ? metadata.input : {};
  return isPlainObject(input.values) ? input.values : {};
}

function restoreHidden(next: unknown, stored: unknown, path: string): unknown {
  if (typeof next === 'string' && HIDDEN_VALUES.has(next)) {
    if (stored === undefined) {
      throw new Error(`${path} is hidden ("${next}") and the saved workflow has no value to restore there. Set it explicitly.`);
    }
    return JSON.parse(JSON.stringify(stored));
  }
  if (Array.isArray(next)) {
    return next.map((entry, index) => restoreHidden(entry, Array.isArray(stored) ? stored[index] : undefined, `${path}[${index}]`));
  }
  if (isPlainObject(next)) {
    return Object.fromEntries(Object.entries(next).map(([key, entry]) => [
      key,
      restoreHidden(entry, isPlainObject(stored) ? stored[key] : undefined, `${path}.${key}`),
    ]));
  }
  return next;
}

/** The step a "$node-<id>.<port>" reference reads, if it is one. */
function referencedStep(value: string): string | undefined {
  if (!value.startsWith('$node-')) return undefined;
  const dot = value.indexOf('.', 1);
  return dot > 1 ? value.slice(1, dot) : undefined;
}

function readsValue(value: unknown, reference: string, carriers: Set<string>): boolean {
  if (typeof value === 'string') {
    if (value === reference) return true;
    const step = referencedStep(value);
    return step !== undefined && carriers.has(step);
  }
  if (Array.isArray(value)) return value.some(entry => readsValue(entry, reference, carriers));
  if (isPlainObject(value)) return Object.values(value).some(entry => readsValue(entry, reference, carriers));
  return false;
}

/**
 * Every place that receives the value of $input.<key> when the workflow runs:
 * "step (model) param" for a step input that reads it directly or through
 * utility steps (they pass text on as it is), and "End field <name>" for a result.
 */
function startFieldConsumers(contents: Record<string, unknown>, key: string): Set<string> {
  const consumers = new Set<string>();
  const reference = `$input.${key}`;
  if (!isPlainObject(contents.nodes)) return consumers;
  const nodes = contents.nodes;
  // Utility steps that carry the value, read directly or from another such step.
  const carriers = new Set<string>();
  let grew: boolean;
  do {
    grew = false;
    for (const [nodeId, node] of Object.entries(nodes)) {
      if (nodeId === 'output' || carriers.has(nodeId) || !isPlainObject(node)) continue;
      if (typeof node.tool !== 'string' || !node.tool.startsWith('workflow-utilities/')) continue;
      if (readsValue(node.input, reference, carriers)) {
        carriers.add(nodeId);
        grew = true;
      }
    }
  } while (grew);
  for (const [nodeId, node] of Object.entries(nodes)) {
    if (nodeId === 'output' || !isPlainObject(node) || !isPlainObject(node.input)) continue;
    for (const [param, value] of Object.entries(node.input)) {
      if (readsValue(value, reference, carriers)) consumers.add(`${nodeId} (${String(node.tool)}) ${param}`);
    }
  }
  const end = nodes.output;
  if (isPlainObject(end) && isPlainObject(end.fields)) {
    for (const [field, value] of Object.entries(end.fields)) {
      if (readsValue(value, reference, carriers)) consumers.add(`End field ${field}`);
    }
  }
  return consumers;
}

/**
 * Brings back what a graph written from a shared copy cannot carry: the stored
 * Start values (kept only for fields that still exist) and every value that was
 * hidden when the graph was shown to an agent. A step's hidden secret is only
 * restored into the same model it was saved for, so a key never moves to another
 * provider.
 */
export function restoreStoredValues(
  next: Record<string, unknown>,
  stored: Record<string, unknown>,
): Record<string, unknown> {
  const contents = JSON.parse(JSON.stringify(next)) as Record<string, unknown>;

  const storedNodes = isPlainObject(stored.nodes) ? stored.nodes : {};
  if (isPlainObject(contents.nodes)) {
    for (const [nodeId, node] of Object.entries(contents.nodes)) {
      if (!isPlainObject(node) || node.input === undefined) continue;
      const hidden: string[] = [];
      collectHidden(node.input, `Step ${nodeId} input`, hidden);
      if (hidden.length === 0) continue;
      const storedNode = storedNodes[nodeId];
      if (!isPlainObject(storedNode)) {
        throw new Error(`${hidden[0]} is hidden, but ${nodeId} is a new step, so the saved workflow has no value to restore there. Set it explicitly.`);
      }
      if (storedNode.tool !== node.tool) {
        throw new Error(`${hidden[0]} is hidden and step ${nodeId} does not keep the same model as the saved workflow, so it cannot be restored. Set it explicitly.`);
      }
      node.input = restoreHidden(node.input, storedNode.input, `Step ${nodeId} input`);
    }
  }

  const schema = isPlainObject(contents.schema) ? contents.schema : {};
  const fields = isPlainObject(schema.input) ? schema.input : {};
  const storedSchema = isPlainObject(stored.schema) ? stored.schema : {};
  const storedFields = isPlainObject(storedSchema.input) ? storedSchema.input : {};
  // A hidden Start value is only restored while it still reaches the same step
  // inputs (directly or through utility steps) and End fields it reached before,
  // so a proposal cannot reroute it to another provider or into a result.
  const refuseIfMoved = (key: string, hiddenPath: string) => {
    const before = startFieldConsumers(stored, key);
    const moved = [...startFieldConsumers(contents, key)].filter(consumer => !before.has(consumer));
    if (moved.length > 0) {
      throw new Error(`${hiddenPath} is hidden and the new steps use it in a different place (${moved.join(', ')}), so it cannot be restored. Set it explicitly.`);
    }
  };
  for (const [key, field] of Object.entries(fields)) {
    const hidden: string[] = [];
    collectHidden(field, `Start field ${key}`, hidden);
    if (hidden.length === 0) continue;
    refuseIfMoved(key, hidden[0]);
    fields[key] = restoreHidden(field, storedFields[key], `Start field ${key}`);
  }
  const metadata = isPlainObject(contents.metadata) ? contents.metadata : (contents.metadata = {}) as Record<string, unknown>;
  const inputMetadata = isPlainObject(metadata.input)
    ? metadata.input
    : (metadata.input = { position: { x: 0, y: 0 } }) as Record<string, unknown>;
  const storedValues = savedStartValues(stored);
  if (!isPlainObject(inputMetadata.values)) {
    // A graph without saved values (every Workflow Agent proposal) gets the stored
    // ones back, but a secret one only while it reaches the same places.
    const kept: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(storedValues)) {
      if (!Object.prototype.hasOwnProperty.call(fields, key)) continue;
      if (SENSITIVE_INPUT_KEY.test(key) && !isStrictlyEmpty(value)) refuseIfMoved(key, `Saved value of Start field ${key}`);
      kept[key] = value;
    }
    if (Object.keys(kept).length > 0) inputMetadata.values = kept;
  } else {
    // Saved values come back hidden too, under a secret-looking Start field.
    const values = inputMetadata.values;
    for (const [key, value] of Object.entries(values)) {
      const hidden: string[] = [];
      collectHidden(value, `Saved value of Start field ${key}`, hidden);
      if (hidden.length === 0) continue;
      refuseIfMoved(key, hidden[0]);
      values[key] = restoreHidden(value, storedValues[key], `Saved value of Start field ${key}`);
    }
  }
  return contents;
}

export interface UpdateWorkflowParams {
  fullSlug: string;
  title?: string;
  description?: string;
  tags?: string[];
  contents?: Record<string, unknown>;
  loadedUpdatetime?: string;
  force?: boolean;
  acknowledgeReviewReset?: boolean;
  /** Work out the change and return it without saving. */
  preview?: boolean;
}

export interface WorkflowChangeSummary {
  stepsAdded: string[];
  stepsRemoved: string[];
  stepsChanged: string[];
  inputsAdded: string[];
  inputsRemoved: string[];
  inputsChanged: string[];
  savedValuesChanged: string[];
  outputsChanged: boolean;
  /** True when the graphs differ only in step positions. */
  layoutOnly: boolean;
  titleChange?: { from: string; to: string };
  descriptionChanged: boolean;
  tagsChanged: boolean;
}

export interface UpdatedWorkflow extends SavedWorkflow {
  reviewReset: boolean;
  contentsChanged: boolean;
  /** True when nothing needed saving because the workflow already matched. */
  unchanged: boolean;
  /** With unchanged: Start field changes Wiro does not keep, which is why nothing changed. */
  discarded?: string[];
  /** Set on a preview: nothing was saved. */
  preview?: boolean;
  changes?: WorkflowChangeSummary;
}

function describeStep(node: unknown): string {
  if (!isPlainObject(node)) return '';
  return JSON.stringify({ tool: node.tool, depends: node.depends, input: node.input });
}

type GraphChange = Pick<WorkflowChangeSummary,
  'stepsAdded' | 'stepsRemoved' | 'stepsChanged' | 'inputsAdded' | 'inputsRemoved'
  | 'inputsChanged' | 'savedValuesChanged' | 'outputsChanged' | 'layoutOnly'>;

function withoutPositions(contents: Record<string, unknown>): string {
  const copy = JSON.parse(JSON.stringify(contents)) as Record<string, unknown>;
  if (isPlainObject(copy.nodes)) {
    for (const node of Object.values(copy.nodes)) {
      if (isPlainObject(node) && isPlainObject(node.metadata)) delete node.metadata.position;
    }
  }
  if (isPlainObject(copy.metadata) && isPlainObject(copy.metadata.input)) delete copy.metadata.input.position;
  return JSON.stringify(copy);
}

export function summarizeWorkflowChange(
  stored: Record<string, unknown>,
  next: Record<string, unknown> | undefined,
): GraphChange {
  if (!next) {
    return {
      stepsAdded: [], stepsRemoved: [], stepsChanged: [], inputsAdded: [], inputsRemoved: [],
      inputsChanged: [], savedValuesChanged: [], outputsChanged: false, layoutOnly: false,
    };
  }
  const storedNodes = isPlainObject(stored.nodes) ? stored.nodes : {};
  const nextNodes = isPlainObject(next.nodes) ? next.nodes : {};
  const steps = (nodes: Record<string, unknown>) => Object.keys(nodes).filter(id => id !== 'output');
  const label = (nodes: Record<string, unknown>, id: string) => {
    const node = nodes[id];
    return isPlainObject(node) && typeof node.tool === 'string' ? `${id} (${node.tool})` : id;
  };
  const storedFields = isPlainObject(stored.schema) && isPlainObject(stored.schema.input) ? stored.schema.input : {};
  const nextFields = isPlainObject(next.schema) && isPlainObject(next.schema.input) ? next.schema.input : {};
  const values = (contents: Record<string, unknown>) => (isPlainObject(contents.metadata)
    && isPlainObject(contents.metadata.input) && isPlainObject(contents.metadata.input.values)
    ? contents.metadata.input.values
    : {});
  const storedValues = values(stored);
  const nextValues = values(next);
  return {
    stepsAdded: steps(nextNodes).filter(id => !(id in storedNodes)).map(id => label(nextNodes, id)),
    stepsRemoved: steps(storedNodes).filter(id => !(id in nextNodes)).map(id => label(storedNodes, id)),
    stepsChanged: steps(nextNodes)
      .filter(id => id in storedNodes && describeStep(storedNodes[id]) !== describeStep(nextNodes[id]))
      .map(id => label(nextNodes, id)),
    inputsAdded: Object.keys(nextFields).filter(key => !(key in storedFields)),
    inputsRemoved: Object.keys(storedFields).filter(key => !(key in nextFields)),
    inputsChanged: Object.keys(nextFields)
      .filter(key => key in storedFields && JSON.stringify(storedFields[key]) !== JSON.stringify(nextFields[key])),
    savedValuesChanged: [...new Set([...Object.keys(storedValues), ...Object.keys(nextValues)])]
      .filter(key => JSON.stringify(storedValues[key]) !== JSON.stringify(nextValues[key])),
    outputsChanged: JSON.stringify(workflowOutputs(stored)) !== JSON.stringify(workflowOutputs(next)),
    layoutOnly: withoutPositions(stored) === withoutPositions(next),
  };
}

async function readEditableRow(
  client: WiroClient,
  fullSlug: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const detail = requireApiSuccess(
    await client.post<WorkflowRowResponse>('/Workflow/Detail', { slug: fullSlug }, signal),
    'Workflow not found.',
  );
  const row = detail.workflow?.[0];
  if (!row) throw new Error('Workflow not found.');
  if (!Object.prototype.hasOwnProperty.call(row, 'rejectreason')) {
    throw new Error('Only the owner or the owner\'s team can edit this workflow. Clone it with clone_workflow to get your own copy.');
  }
  return row;
}

/**
 * Update and Delete may read a replica, so right after a create they can answer
 * "Workflow not found" for a row Detail (which reads the primary) just returned.
 * One retry after a short pause covers that window.
 */
export async function postWithReplicaRetry<T extends ApiEnvelope>(
  client: WiroClient,
  path: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
  const first = await client.post<T>(path, body, signal);
  const notFound = first.result !== true
    && (first.errors ?? []).some(error => /workflow not found/i.test(String(error?.message ?? '')));
  if (!notFound || (first as Record<string, unknown>).currentUpdatetime !== undefined) return first;
  await new Promise(resolve => setTimeout(resolve, 1_500));
  return client.post<T>(path, body, signal);
}

export async function updateWorkflow(
  client: WiroClient,
  params: UpdateWorkflowParams,
  signal?: AbortSignal,
): Promise<UpdatedWorkflow> {
  const row = await readEditableRow(client, params.fullSlug, signal);
  const isProtected = toInteger(row.isprotected) === 1;
  const isClone = row.clonedfromid !== undefined && row.clonedfromid !== null && row.clonedfromid !== '';
  if (params.contents && isProtected && isClone) {
    throw new Error('This is a copy of a protected workflow, so its steps cannot be edited. You can still change its title, description and tags.');
  }

  const storedDescription = asString(row.description) ?? '';
  if (params.description !== undefined
    && storedDescription.length > 600
    && params.description.trim() === truncate(storedDescription, 600)) {
    throw new Error('That description is a shortened copy of the saved one. Read the full description with get_workflow before editing it.');
  }

  const storedContents = parseJsonValue(row.contents);
  const stored = isPlainObject(storedContents) ? storedContents : {};
  const currentUpdatetime = asString(row.updatetime);
  const stale = Boolean(params.loadedUpdatetime && currentUpdatetime
    && params.loadedUpdatetime !== currentUpdatetime && !params.force);
  const conflict = () => new WorkflowConflictError(
    'The workflow changed after you read it. Read it again with get_workflow and redo the change, '
    + 'or pass force: true only if the user wants to overwrite the newer version.',
    currentUpdatetime,
  );
  let contentsToSave: Record<string, unknown> | undefined;
  let warnings: PrepareIssue[] = [];
  let discarded: string[] = [];
  if (params.contents) {
    try {
      const restored = restoreStoredValues(params.contents, stored);
      // The saved graph sent back as it is needs no preparation, and one over
      // Prepare's size limit (saved in the editor) could not get it.
      if (JSON.stringify(restored) !== JSON.stringify(stored)) {
        const nodes = isPlainObject(stored.nodes) ? Object.keys(stored.nodes) : [];
        const anchors = ['input', ...nodes.filter(nodeId => nodeId !== 'output')];
        const prepared = await prepareWorkflowContents(client, restored, 'apply', anchors, signal);
        warnings = [...prepared.warnings, ...filledDefaultNotes(restored, prepared.contents)];
        // The server compares contents as text, so an unchanged graph must not be resent.
        if (JSON.stringify(prepared.contents) !== JSON.stringify(stored)) contentsToSave = prepared.contents;
        else discarded = droppedStartFieldChanges(restored, prepared.contents);
      }
    } catch (error) {
      // Against a newer version, problems found while merging are a symptom of
      // that version, so report the version conflict itself.
      if (stale) throw conflict();
      throw error;
    }
  }

  // Only the caller's own tags are compared; Wiro's reserved tags are carried
  // over as they are, so resending the same tags is not a change.
  const isReserved = (tag: string) => tag.trim().toLowerCase().startsWith('wiro-');
  const storedTags = workflowTags(row);
  const regularStoredTags = storedTags.filter(tag => !isReserved(tag)).map(tag => tag.trim());
  const nextRegularTags = params.tags?.map(tag => tag.trim());
  const tagsChanged = nextRegularTags !== undefined
    && JSON.stringify(nextRegularTags) !== JSON.stringify(regularStoredTags);
  const nextTags = tagsChanged ? [...nextRegularTags!, ...storedTags.filter(isReserved)] : undefined;
  const titleChanged = params.title !== undefined && params.title.trim() !== asString(row.title);
  const descriptionChanged = params.description !== undefined && params.description.trim() !== storedDescription;
  const anyChange = titleChanged || descriptionChanged || tagsChanged || contentsToSave !== undefined;

  const state = workflowState(row);
  const fullSlug = fullSlugOf(row) ?? params.fullSlug;
  if (!anyChange) {
    // Nothing to write, including when an earlier call already saved this change.
    return {
      fullSlug,
      url: workflowUrl(fullSlug),
      title: asString(row.title) ?? fullSlug,
      renamed: false,
      state,
      ...(currentUpdatetime ? { updatetime: currentUpdatetime } : {}),
      inputs: workflowInputs(stored),
      outputs: workflowOutputs(stored),
      warnings,
      reviewReset: false,
      contentsChanged: false,
      unchanged: true,
      ...(discarded.length > 0 ? { discarded } : {}),
    };
  }

  if (stale) throw conflict();

  const reviewReset = toInteger(row.ispublic) === 1;
  const changes: WorkflowChangeSummary = {
    ...summarizeWorkflowChange(stored, contentsToSave),
    ...(titleChanged ? { titleChange: { from: asString(row.title) ?? '', to: params.title!.trim() } } : {}),
    descriptionChanged,
    tagsChanged,
  };
  const savedContents = contentsToSave ?? stored;

  if (params.preview) {
    return {
      fullSlug,
      url: workflowUrl(fullSlug),
      title: asString(row.title) ?? fullSlug,
      renamed: false,
      state,
      ...(currentUpdatetime ? { updatetime: currentUpdatetime } : {}),
      inputs: workflowInputs(savedContents),
      outputs: workflowOutputs(savedContents),
      warnings,
      reviewReset,
      contentsChanged: contentsToSave !== undefined,
      unchanged: false,
      preview: true,
      changes,
    };
  }

  if (reviewReset && !params.acknowledgeReviewReset) {
    throw new Error('This workflow is published. Saving this change takes it out of the public gallery until Wiro reviews it again. '
      + 'Ask the user, then call again with acknowledge_review_reset: true.');
  }

  const body: Record<string, unknown> = { slug: fullSlug };
  if (titleChanged) body.title = params.title!.trim();
  if (descriptionChanged && params.description!.trim()) body.description = params.description!.trim();
  if (nextTags) body.tags = JSON.stringify(nextTags);
  if (contentsToSave) body.contents = JSON.stringify(contentsToSave);
  const guard = params.loadedUpdatetime ?? currentUpdatetime;
  if (guard) body.loadedUpdatetime = guard;
  if (params.force) body.force = true;

  const response = await postWithReplicaRetry<WorkflowRowResponse>(client, '/Workflow/Update', body, signal);
  if (response.result !== true) {
    if (response.currentUpdatetime !== undefined) {
      throw new WorkflowConflictError(
        'Someone saved this workflow after you read it. Read it again with get_workflow and redo the change, '
        + 'or pass force: true only if the user wants to overwrite their version.',
        String(response.currentUpdatetime),
      );
    }
    if ((response.errors ?? []).some(error => /workflow not found/i.test(String(error?.message ?? '')))) {
      throw new Error('The workflow exists but could not be updated yet. Try again in a few seconds.');
    }
    requireApiSuccess(response, 'The workflow could not be updated.');
  }
  const updated = response.workflow?.[0] ?? {};
  return {
    fullSlug: fullSlugOf(updated) ?? fullSlug,
    url: workflowUrl(fullSlugOf(updated) ?? fullSlug),
    title: asString(updated.title) ?? asString(row.title) ?? fullSlug,
    renamed: false,
    state: reviewReset ? 'pending_review' : state,
    ...(asString(updated.updatetime) ? { updatetime: asString(updated.updatetime) } : {}),
    inputs: workflowInputs(savedContents),
    outputs: workflowOutputs(savedContents),
    warnings,
    reviewReset,
    contentsChanged: contentsToSave !== undefined,
    unchanged: false,
    changes,
  };
}

export function formatWorkflowChanges(changes: WorkflowChangeSummary): string[] {
  const lines: string[] = [];
  if (changes.titleChange) lines.push(`- Title: "${changes.titleChange.from}" to "${changes.titleChange.to}"`);
  if (changes.descriptionChanged) lines.push('- Description changes');
  if (changes.tagsChanged) lines.push('- Tags change');
  if (changes.stepsAdded.length > 0) lines.push(`- Steps added: ${changes.stepsAdded.join(', ')}`);
  if (changes.stepsRemoved.length > 0) lines.push(`- Steps removed: ${changes.stepsRemoved.join(', ')}`);
  if (changes.stepsChanged.length > 0) lines.push(`- Steps changed: ${changes.stepsChanged.join(', ')}`);
  if (changes.inputsAdded.length > 0) lines.push(`- Inputs added: ${changes.inputsAdded.join(', ')}`);
  if (changes.inputsRemoved.length > 0) lines.push(`- Inputs removed: ${changes.inputsRemoved.join(', ')}`);
  if (changes.inputsChanged.length > 0) lines.push(`- Inputs changed (type, label or default): ${changes.inputsChanged.join(', ')}`);
  if (changes.savedValuesChanged.length > 0) lines.push(`- Saved input values change: ${changes.savedValuesChanged.join(', ')}`);
  if (changes.outputsChanged) lines.push('- Outputs change');
  if (lines.length > 0) return lines;
  return [changes.layoutOnly ? '- Only step positions change' : '- Other graph changes'];
}

/** The most JSON a graph written outside the editor may have, defaults included. */
export const WORKFLOW_MAX_BYTES = 40 * 1024;

export function prepareIssuesText(error: WorkflowPrepareError): string {
  const tooLarge = error.issues.find(issue => issue.code === 'contents-too-large' || issue.code === 'prepared-contents-too-large');
  if (tooLarge) {
    const size = tooLarge.bytes !== undefined ? ` (${(tooLarge.bytes / 1024).toFixed(1)} KB)` : '';
    const cause = tooLarge.code === 'prepared-contents-too-large'
      ? ` It grew past the limit${size} when Wiro filled each model step's left-out inputs with their defaults, `
        + 'which for some models are sample files: set those inputs yourself, or set a file input to [] to leave it out.'
      : ` The graph sent was too large${size}.`;
    return [
      '## The workflow was not saved',
      '',
      `${tooLarge.message}${cause} A workflow written outside the wiro.ai editor can be at most ${WORKFLOW_MAX_BYTES / 1024} KB `
        + 'of JSON, counted after Wiro fills each step\'s defaults. Use fewer steps or shorter values. A larger '
        + 'workflow\'s steps can still be edited in the editor on wiro.ai, and its title, description and tags here.',
    ].join('\n');
  }
  const lines = ['## The workflow was not saved', '', 'Wiro found these problems in the workflow graph:', ''];
  for (const issue of error.issues) {
    // The End and Start nodes name their fields in `input` too.
    const where = issue.nodeId === 'output' ? 'End' : issue.nodeId === 'input' ? 'Start' : issue.nodeId ? `\`${issue.nodeId}\`` : 'Workflow';
    const part = !issue.input ? '' : issue.nodeId === 'output' || issue.nodeId === 'input' ? ` field \`${issue.input}\`` : ` input \`${issue.input}\``;
    lines.push(`- ${where}${part}: ${issue.message}`);
  }
  lines.push('', 'Fix all of them and try again. Use get_model_schema to check a model\'s parameter ids and get_playbook topic "workflow-graph" for the graph format.');
  return lines.join('\n');
}
