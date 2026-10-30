import { createHash } from 'node:crypto';

// The Workflow Agent answers in prose and puts workflows in fenced blocks:
// ```wiro-workflow holds a complete workflow definition and
// ```wiro-workflow-request asks the caller to list the user's workflows. These
// are the same rules wiro.ai applies before it offers to save an artifact, so a
// workflow that passes here passes there too. Saving and running still need
// the catalog checks the save tools do.

export const WORKFLOW_ARTIFACT_FENCE = 'wiro-workflow';
export const WORKFLOW_REQUEST_FENCE = 'wiro-workflow-request';
export const WORKFLOW_ARTIFACT_MAX_BYTES = 40 * 1024;
export const WORKFLOW_ASSISTANT_MAX_BYTES = 45 * 1024;
export const WORKFLOW_REQUEST_MAX_BYTES = 2 * 1024;
export const WORKFLOW_REQUEST_ID_MAX_LENGTH = 64;
export const WORKFLOW_LIST_SEARCH_MAX_LENGTH = 120;
export const WORKFLOW_LIST_LIMIT_MIN = 1;
export const WORKFLOW_LIST_LIMIT_MAX = 50;

const WORKFLOW_TITLE_MAX_LENGTH = 160;
const WORKFLOW_DESCRIPTION_MAX_LENGTH = 1_000;
const WORKFLOW_NODE_ID_PATTERN = /^node-[A-Za-z0-9_-]{1,64}$/;
const WORKFLOW_TOOL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}\/[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const WORKFLOW_UTILITY_PATTERN = /^workflow-utilities\/[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const WORKFLOW_UTILITY_OUTPUT_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const WORKFLOW_REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const WORKFLOW_REFERENCE_TOKEN_PATTERN = /\$(?:input\.|node-)/;
const MAX_POSITION_MAGNITUDE = 1_000_000;
const WORKFLOW_JSON_MAX_DEPTH = 32;

// ─── Workflow definition types ──────────────────────────────────────

export interface StartFieldOption {
  value: string | number;
  text: string;
  cover?: string;
}

export interface WorkflowField {
  name: string;
  label: string;
  type: string | { kind: string; elementType: string };
  description: string;
  required: boolean;
  defaultValue: unknown;
  examples: unknown[];
  ui: { field?: string; options?: StartFieldOption[]; min?: number; max?: number; step?: number };
  modelId: string | null;
  sourceParamType?: string | null;
}

export interface WorkflowRunNode {
  type: 'run';
  id: string;
  tool: string;
  depends: string[];
  input: Record<string, unknown>;
  metadata: {
    position: { x: number; y: number };
    multifileActiveParam?: Record<string, string>;
    locked?: boolean;
  };
}

export interface WorkflowDisplayNode {
  type: 'display';
  id: 'output';
  depends: string[];
  input: Record<string, string>;
  fields: Record<string, string>;
  metadata: { position: { x: number; y: number } };
}

export interface WorkflowSchema {
  input: Record<string, WorkflowField>;
  output: Record<string, { type: string }>;
}

export interface WorkflowMetadata {
  input: { position: { x: number; y: number }; values?: Record<string, unknown> };
}

export interface WorkflowContents {
  version: string;
  nodes: Record<string, WorkflowRunNode | WorkflowDisplayNode>;
  output: Record<string, string>;
  schema: WorkflowSchema;
  metadata: WorkflowMetadata;
}

// ─── Artifact and request types ─────────────────────────────────────

export interface WorkflowArtifact {
  artifactVersion: 1;
  title: string;
  description: string;
  contents: WorkflowContents;
}

export interface WorkflowListRequest {
  protocolVersion: 1;
  requestId: string;
  operation: 'workflow.list';
  args: {
    search?: string;
    limit?: number;
  };
}

export interface ArtifactValidationIssue {
  code: string;
  message: string;
  path: string;
}

export interface ArtifactValidationResult<T> {
  valid: boolean;
  status: 'valid' | 'invalid' | 'oversize';
  value?: T;
  issues: ArtifactValidationIssue[];
  byteLength?: number;
}

export type AgentChatArtifactSegment =
  | {
    type: 'prose';
    content: string;
  }
  | {
    type: 'workflow-request';
    status: 'valid' | 'invalid' | 'oversize' | 'incomplete';
    request?: WorkflowListRequest;
    requestHash?: string;
    raw?: string;
    byteLength: number;
    issues: ArtifactValidationIssue[];
  }
  | {
    type: 'workflow';
    status: 'valid' | 'invalid' | 'oversize' | 'incomplete';
    artifact?: WorkflowArtifact;
    artifactHash?: string;
    raw?: string;
    byteLength: number;
    issues: ArtifactValidationIssue[];
  };

export interface AgentChatArtifactParseOptions {
  seenRequestIds?: Iterable<string>;
}

export interface AgentChatArtifactParseResult {
  prose: string;
  segments: AgentChatArtifactSegment[];
  requests: Extract<AgentChatArtifactSegment, { type: 'workflow-request' }>[];
  artifacts: Extract<AgentChatArtifactSegment, { type: 'workflow' }>[];
  streamState: 'complete' | 'loading-workflows' | 'building-workflow';
}

function validationIssue(code: string, message: string, path = '$'): ArtifactValidationIssue {
  return { code, message, path };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function findReservedObjectKey(value: unknown, path = '$'): string | null {
  const stack: Array<{ value: unknown; path: string }> = [{ value, path }];
  while (stack.length > 0) {
    const current = stack.pop() as { value: unknown; path: string };
    if (Array.isArray(current.value)) {
      for (let index = current.value.length - 1; index >= 0; index--) {
        stack.push({ value: current.value[index], path: `${current.path}[${index}]` });
      }
      continue;
    }
    if (!isRecord(current.value)) continue;
    for (const [key, child] of Object.entries(current.value)) {
      if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
        return `${current.path}.${key}`;
      }
      stack.push({ value: child, path: `${current.path}.${key}` });
    }
  }
  return null;
}

function workflowJsonDepth(value: unknown): number {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 1 }];
  let maximum = 1;
  while (stack.length > 0) {
    const current = stack.pop() as { value: unknown; depth: number };
    maximum = Math.max(maximum, current.depth);
    if (maximum > WORKFLOW_JSON_MAX_DEPTH) return maximum;
    if (Array.isArray(current.value)) {
      for (const child of current.value) stack.push({ value: child, depth: current.depth + 1 });
    } else if (isRecord(current.value)) {
      for (const child of Object.values(current.value)) stack.push({ value: child, depth: current.depth + 1 });
    }
  }
  return maximum;
}

function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: readonly string[]): boolean {
  const allowed = new Set(allowedKeys);
  return Object.keys(value).every(key => allowed.has(key));
}

function isSafeFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isSafePosition(value: unknown): value is { x: number; y: number } {
  if (!isRecord(value) || !isSafeFiniteNumber(value.x) || !isSafeFiniteNumber(value.y)) return false;
  return Math.abs(value.x) <= MAX_POSITION_MAGNITUDE && Math.abs(value.y) <= MAX_POSITION_MAGNITUDE;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every(item => typeof item === 'string');
}

function canonicalSerialize(value: unknown, seen: WeakSet<object>): string {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      return Number.isFinite(value) ? JSON.stringify(value) : 'null';
    case 'undefined':
    case 'function':
    case 'symbol':
      return 'null';
    case 'bigint':
      throw new TypeError('BigInt values cannot be canonicalized as JSON');
    default:
      break;
  }

  const objectValue = value as object;
  if (seen.has(objectValue)) {
    throw new TypeError('Circular values cannot be canonicalized');
  }
  seen.add(objectValue);

  try {
    if (Array.isArray(value)) {
      return `[${value.map(item => canonicalSerialize(item, seen)).join(',')}]`;
    }

    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .filter(key => {
        const itemType = typeof record[key];
        return itemType !== 'undefined' && itemType !== 'function' && itemType !== 'symbol';
      })
      .sort()
      .map(key => `${JSON.stringify(key)}:${canonicalSerialize(record[key], seen)}`);
    return `{${entries.join(',')}}`;
  } finally {
    seen.delete(objectValue);
  }
}

/** Deterministic JSON: object keys are sorted recursively, array order is kept. */
export function canonicalStringify(value: unknown): string {
  return canonicalSerialize(value, new WeakSet<object>());
}

/** Lowercase hex SHA-256 of the canonical JSON, the same value wiro.ai computes. */
export function canonicalHash(value: unknown): string {
  return createHash('sha256').update(canonicalStringify(value), 'utf8').digest('hex');
}

export function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

export function createWorkflowArtifactIdentity(messageGuid: string, artifact: WorkflowArtifact): string {
  return `${encodeURIComponent(messageGuid)}:${canonicalHash(artifact)}`;
}

function validateWorkflowSchema(schemaValue: unknown, issues: ArtifactValidationIssue[]): void {
  if (!isRecord(schemaValue)) {
    issues.push(validationIssue('invalid-schema', 'Workflow schema must be an object', '$.contents.schema'));
    return;
  }
  if (!hasOnlyKeys(schemaValue, ['input', 'output'])) {
    issues.push(validationIssue('unsupported-schema-field', 'Workflow schema contains unsupported fields', '$.contents.schema'));
  }

  if (!isRecord(schemaValue.input)) {
    issues.push(validationIssue('invalid-schema-input', 'Workflow schema.input must be an object', '$.contents.schema.input'));
  } else {
    for (const [key, field] of Object.entries(schemaValue.input)) {
      if (!key || !isRecord(field)) {
        issues.push(validationIssue('invalid-schema-field', `Workflow input "${key}" must be an object`, `$.contents.schema.input.${key}`));
        continue;
      }
      if (!hasOnlyKeys(field, ['name', 'label', 'type', 'description', 'required', 'defaultValue', 'examples', 'ui', 'modelId', 'sourceParamType'])) {
        issues.push(validationIssue('unsupported-schema-input-field', `Workflow input "${key}" contains unsupported fields`, `$.contents.schema.input.${key}`));
      }
      if (typeof field.name !== 'string' || !field.name.trim() || typeof field.label !== 'string' || !field.label.trim()) {
        issues.push(validationIssue('invalid-schema-field-name', `Workflow input "${key}" must declare name and label strings`, `$.contents.schema.input.${key}`));
      }
      if (typeof field.description !== 'string') {
        issues.push(validationIssue('invalid-schema-field-description', `Workflow input "${key}" description must be a string`, `$.contents.schema.input.${key}.description`));
      }
      const validType = typeof field.type === 'string' || (isRecord(field.type) && typeof field.type.kind === 'string' && typeof field.type.elementType === 'string');
      if (!validType) {
        issues.push(validationIssue('invalid-schema-field-type', `Workflow input "${key}" has an invalid type`, `$.contents.schema.input.${key}.type`));
      }
      if (!isRecord(field.ui)) {
        issues.push(validationIssue('invalid-schema-field-ui', `Workflow input "${key}" has an invalid ui object`, `$.contents.schema.input.${key}.ui`));
      }
      if (!Array.isArray(field.examples)) {
        issues.push(validationIssue('invalid-schema-field-examples', `Workflow input "${key}" examples must be an array`, `$.contents.schema.input.${key}.examples`));
      }
      if (typeof field.required !== 'boolean') {
        issues.push(validationIssue('invalid-schema-field-required', `Workflow input "${key}" required must be boolean`, `$.contents.schema.input.${key}.required`));
      }
      if (!Object.prototype.hasOwnProperty.call(field, 'defaultValue')) {
        issues.push(validationIssue('missing-schema-field-default', `Workflow input "${key}" must declare defaultValue`, `$.contents.schema.input.${key}.defaultValue`));
      }
      if (field.modelId !== undefined && field.modelId !== null && typeof field.modelId !== 'string' && typeof field.modelId !== 'number') {
        issues.push(validationIssue('invalid-schema-field-model', `Workflow input "${key}" modelId must be a string, number, or null`, `$.contents.schema.input.${key}.modelId`));
      }
      if (field.sourceParamType !== undefined && field.sourceParamType !== null && typeof field.sourceParamType !== 'string') {
        issues.push(validationIssue('invalid-schema-field-source-type', `Workflow input "${key}" sourceParamType must be a string or null`, `$.contents.schema.input.${key}.sourceParamType`));
      }
    }
  }

  if (!isRecord(schemaValue.output)) {
    issues.push(validationIssue('invalid-schema-output', 'Workflow schema.output must be an object', '$.contents.schema.output'));
  } else if (Object.keys(schemaValue.output).length > 0) {
    issues.push(validationIssue('noncanonical-schema-output', 'Workflow schema.output must remain empty; End fields and top-level output own output mappings', '$.contents.schema.output'));
  }
}

function validateWorkflowMetadata(metadataValue: unknown, issues: ArtifactValidationIssue[]): void {
  if (!isRecord(metadataValue) || !isRecord(metadataValue.input)) {
    issues.push(validationIssue('invalid-workflow-metadata', 'Workflow metadata.input must be an object', '$.contents.metadata.input'));
    return;
  }
  if (!hasOnlyKeys(metadataValue, ['input']) || !hasOnlyKeys(metadataValue.input, ['position'])) {
    issues.push(validationIssue('unsupported-workflow-metadata', 'Workflow artifacts may contain only metadata.input.position', '$.contents.metadata'));
  }
  if (!isSafePosition(metadataValue.input.position)) {
    issues.push(validationIssue('invalid-input-position', 'Workflow Start position must contain finite x and y values', '$.contents.metadata.input.position'));
  }
  // Saved Start values belong to the user. An artifact may never set them.
  if (metadataValue.input.values !== undefined) {
    issues.push(validationIssue('protected-input-values-forbidden', 'Workflow artifacts cannot set saved Start input values', '$.contents.metadata.input.values'));
  }
}

function validateRunNodeMetadata(metadataValue: unknown, path: string, issues: ArtifactValidationIssue[]): void {
  if (!isRecord(metadataValue)) {
    issues.push(validationIssue('invalid-node-metadata', 'Run node metadata must be an object', path));
    return;
  }
  if (!hasOnlyKeys(metadataValue, ['position', 'locked', 'multifileActiveParam'])) {
    issues.push(validationIssue('unsupported-node-metadata', 'Run node metadata contains unsupported fields', path));
  }
  if (!isSafePosition(metadataValue.position)) {
    issues.push(validationIssue('invalid-node-position', 'Run node position must contain finite x and y values', `${path}.position`));
  }
  if (metadataValue.locked !== undefined && typeof metadataValue.locked !== 'boolean') {
    issues.push(validationIssue('invalid-node-locked', 'Run node locked metadata must be boolean', `${path}.locked`));
  }
  if (metadataValue.multifileActiveParam !== undefined && !isStringRecord(metadataValue.multifileActiveParam)) {
    issues.push(validationIssue('invalid-node-multifile-metadata', 'Run node multifileActiveParam must map strings to strings', `${path}.multifileActiveParam`));
  }
}

function validateDisplayNode(nodeValue: unknown, issues: ArtifactValidationIssue[]): void {
  const path = '$.contents.nodes.output';
  if (!isRecord(nodeValue)) {
    issues.push(validationIssue('missing-output-node', 'Workflow nodes.output must be the canonical display node', path));
    return;
  }
  if (!hasOnlyKeys(nodeValue, ['type', 'id', 'depends', 'input', 'fields', 'metadata'])) {
    issues.push(validationIssue('unsupported-output-node-field', 'Workflow output node contains unsupported fields', path));
  }
  if (nodeValue.type !== 'display') {
    issues.push(validationIssue('invalid-output-node-type', 'Workflow nodes.output type must be "display"', `${path}.type`));
  }
  if (nodeValue.id !== 'output') {
    issues.push(validationIssue('invalid-output-node-id', 'Workflow nodes.output id must be "output"', `${path}.id`));
  }
  if (!Array.isArray(nodeValue.depends) || nodeValue.depends.some(item => typeof item !== 'string')) {
    issues.push(validationIssue('invalid-output-depends', 'Workflow output depends must be an array of node ids', `${path}.depends`));
  }
  if (!isRecord(nodeValue.input) || Object.keys(nodeValue.input).length > 0) {
    issues.push(validationIssue('invalid-output-input', 'Workflow output input must be an empty object', `${path}.input`));
  }
  if (!isStringRecord(nodeValue.fields)) {
    issues.push(validationIssue('invalid-output-fields', 'Workflow output fields must map names to references', `${path}.fields`));
  }
  if (!isRecord(nodeValue.metadata) || !isSafePosition(nodeValue.metadata.position)) {
    issues.push(validationIssue('invalid-output-position', 'Workflow End position must contain finite x and y values', `${path}.metadata.position`));
  } else if (!hasOnlyKeys(nodeValue.metadata, ['position'])) {
    issues.push(validationIssue('unsupported-output-metadata', 'Workflow End metadata may contain only position', `${path}.metadata`));
  }
}

function walkInputStrings(value: unknown, path: string, callback: (value: string, path: string) => void, seen = new WeakSet<object>()): void {
  if (typeof value === 'string') {
    callback(value, path);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  if (seen.has(value)) return;
  seen.add(value);

  if (Array.isArray(value)) {
    value.forEach((item, index) => walkInputStrings(item, `${path}[${index}]`, callback, seen));
    return;
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    walkInputStrings(item, `${path}.${key}`, callback, seen);
  }
}

// Lookups use own properties only, so "toString" or "constructor" can never
// pass for a declared input or node.
function validateReference(reference: string, path: string, consumerId: string, consumerDepends: Set<string>, nodes: Record<string, unknown>, schemaInput: Record<string, unknown>, issues: ArtifactValidationIssue[]): void {
  if (reference.startsWith('$input.')) {
    const inputKey = reference.slice('$input.'.length);
    if (!inputKey || !Object.hasOwn(schemaInput, inputKey)) {
      issues.push(validationIssue('unknown-input-reference', `Reference targets unknown workflow input "${inputKey}"`, path));
    }
    if (!consumerDepends.has('input')) {
      issues.push(validationIssue('reference-missing-dependency', `Reference "${reference}" is not represented in depends`, path));
    }
    return;
  }

  if (!reference.startsWith('$node-')) {
    issues.push(validationIssue('malformed-reference', `Unsupported workflow reference "${reference}"`, path));
    return;
  }

  const separatorIndex = reference.indexOf('.', 1);
  if (separatorIndex < 0 || separatorIndex === reference.length - 1) {
    issues.push(validationIssue('malformed-reference', `Malformed workflow node reference "${reference}"`, path));
    return;
  }

  const sourceId = reference.slice(1, separatorIndex);
  const outputKey = reference.slice(separatorIndex + 1);
  const source = nodes[sourceId];
  if (!source || sourceId === 'output' || !isRecord(source) || source.type !== 'run') {
    issues.push(validationIssue('unknown-node-reference', `Reference targets unknown run node "${sourceId}"`, path));
    return;
  }
  if (sourceId === consumerId) {
    issues.push(validationIssue('self-reference', `Node "${consumerId}" cannot reference itself`, path));
  }
  if (!consumerDepends.has(sourceId)) {
    issues.push(validationIssue('reference-missing-dependency', `Reference "${reference}" is not represented in depends`, path));
  }

  const sourceTool = typeof source.tool === 'string' ? source.tool : '';
  if (sourceTool.startsWith('workflow-utilities/')) {
    if (!WORKFLOW_UTILITY_OUTPUT_PATTERN.test(outputKey)) {
      issues.push(validationIssue('invalid-utility-output-reference', `Utility output "${outputKey}" is not a valid port key`, path));
    }
  } else if (outputKey !== 'outputs') {
    issues.push(validationIssue('invalid-tool-output-reference', `Model node "${sourceId}" must be referenced through ".outputs"`, path));
  }
}

function validateDependencyGraph(nodes: Record<string, unknown>, issues: ArtifactValidationIssue[]): void {
  const graphIds = Object.keys(nodes);
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  graphIds.forEach(id => {
    inDegree.set(id, 0);
    dependents.set(id, []);
  });

  for (const [id, nodeValue] of Object.entries(nodes)) {
    if (!isRecord(nodeValue) || !Array.isArray(nodeValue.depends)) continue;
    for (const dependency of nodeValue.depends) {
      if (dependency === 'input' || typeof dependency !== 'string' || !inDegree.has(dependency)) continue;
      inDegree.set(id, (inDegree.get(id) ?? 0) + 1);
      dependents.get(dependency)?.push(id);
    }
  }

  const queue = graphIds.filter(id => inDegree.get(id) === 0);
  let visited = 0;
  while (queue.length > 0) {
    const current = queue.shift() as string;
    visited += 1;
    for (const dependent of dependents.get(current) ?? []) {
      const nextDegree = (inDegree.get(dependent) ?? 0) - 1;
      inDegree.set(dependent, nextDegree);
      if (nextDegree === 0) queue.push(dependent);
    }
  }

  if (visited !== graphIds.length) {
    issues.push(validationIssue('workflow-cycle', 'Workflow dependencies contain a cycle', '$.contents.nodes'));
  }
}

export function validateWorkflowContents(value: unknown): ArtifactValidationResult<WorkflowContents> {
  const issues: ArtifactValidationIssue[] = [];
  if (!isRecord(value)) {
    return {
      valid: false,
      status: 'invalid',
      issues: [validationIssue('invalid-contents', 'Workflow contents must be an object', '$.contents')],
    };
  }
  const reservedPath = findReservedObjectKey(value, '$.contents');
  if (reservedPath) {
    return {
      valid: false,
      status: 'invalid',
      issues: [validationIssue('reserved-object-key', 'Workflow artifacts cannot contain reserved object keys', reservedPath)],
    };
  }
  if (workflowJsonDepth(value) > WORKFLOW_JSON_MAX_DEPTH) {
    return {
      valid: false,
      status: 'invalid',
      issues: [validationIssue('workflow-json-too-deep', `Workflow artifact nesting cannot exceed ${WORKFLOW_JSON_MAX_DEPTH} levels`, '$.contents')],
    };
  }
  if (!hasOnlyKeys(value, ['version', 'nodes', 'output', 'schema', 'metadata'])) {
    issues.push(validationIssue('unsupported-contents-field', 'Workflow contents contains unsupported fields', '$.contents'));
  }

  if (value.version !== '1') {
    issues.push(validationIssue('unsupported-workflow-version', 'Workflow contents.version must be "1"', '$.contents.version'));
  }
  if (!isRecord(value.nodes)) {
    issues.push(validationIssue('invalid-nodes', 'Workflow nodes must be an object, not an array', '$.contents.nodes'));
  }
  if (!isStringRecord(value.output)) {
    issues.push(validationIssue('invalid-top-level-output', 'Workflow output must map names to references', '$.contents.output'));
  }

  validateWorkflowSchema(value.schema, issues);
  validateWorkflowMetadata(value.metadata, issues);

  if (!isRecord(value.nodes)) {
    return { valid: false, status: 'invalid', issues };
  }

  const nodes = value.nodes;
  validateDisplayNode(nodes.output, issues);
  const seenNodeIds = new Set<string>();

  for (const [nodeKey, nodeValue] of Object.entries(nodes)) {
    if (nodeKey === 'output') continue;
    const path = `$.contents.nodes.${nodeKey}`;
    if (!WORKFLOW_NODE_ID_PATTERN.test(nodeKey)) {
      issues.push(validationIssue('invalid-node-key', `Run node key "${nodeKey}" must start with "node-" and contain only safe id characters`, path));
    }
    if (!isRecord(nodeValue)) {
      issues.push(validationIssue('invalid-run-node', `Run node "${nodeKey}" must be an object`, path));
      continue;
    }
    if (!hasOnlyKeys(nodeValue, ['type', 'id', 'tool', 'depends', 'input', 'metadata'])) {
      issues.push(validationIssue('unsupported-run-node-field', `Node "${nodeKey}" contains unsupported fields`, path));
    }
    if (nodeValue.type !== 'run') {
      issues.push(validationIssue('invalid-run-node-type', `Node "${nodeKey}" type must be "run"`, `${path}.type`));
    }
    if (nodeValue.id !== nodeKey) {
      issues.push(validationIssue('node-id-mismatch', `Node "${nodeKey}" id must match its object key`, `${path}.id`));
    }
    if (typeof nodeValue.id === 'string') {
      if (seenNodeIds.has(nodeValue.id)) {
        issues.push(validationIssue('duplicate-node-id', `Node id "${nodeValue.id}" is duplicated`, `${path}.id`));
      }
      seenNodeIds.add(nodeValue.id);
    }

    if (typeof nodeValue.tool !== 'string' || (!WORKFLOW_TOOL_PATTERN.test(nodeValue.tool) && !WORKFLOW_UTILITY_PATTERN.test(nodeValue.tool))) {
      issues.push(validationIssue('invalid-node-tool', `Node "${nodeKey}" must use an owner/model or workflow-utilities/* slug`, `${path}.tool`));
    }
    if (!Array.isArray(nodeValue.depends) || nodeValue.depends.some(dependency => typeof dependency !== 'string')) {
      issues.push(validationIssue('invalid-node-depends', `Node "${nodeKey}" depends must be an array of node ids`, `${path}.depends`));
    } else {
      const dependencySet = new Set<string>();
      for (const dependency of nodeValue.depends as string[]) {
        if (dependencySet.has(dependency)) {
          issues.push(validationIssue('duplicate-node-dependency', `Node "${nodeKey}" contains duplicate dependency "${dependency}"`, `${path}.depends`));
        }
        dependencySet.add(dependency);
        if (dependency === nodeKey) {
          issues.push(validationIssue('self-dependency', `Node "${nodeKey}" cannot depend on itself`, `${path}.depends`));
        } else if (dependency !== 'input' && (dependency === 'output' || !Object.hasOwn(nodes, dependency))) {
          issues.push(validationIssue('unknown-node-dependency', `Node "${nodeKey}" depends on unknown run node "${dependency}"`, `${path}.depends`));
        }
      }
    }
    if (!isRecord(nodeValue.input)) {
      issues.push(validationIssue('invalid-node-input', `Node "${nodeKey}" input must be an object`, `${path}.input`));
    }
    validateRunNodeMetadata(nodeValue.metadata, `${path}.metadata`, issues);
  }

  const outputNode = isRecord(nodes.output) ? nodes.output : null;
  if (outputNode && Array.isArray(outputNode.depends)) {
    const dependencySet = new Set<string>();
    for (const dependency of outputNode.depends) {
      if (typeof dependency !== 'string') continue;
      if (dependencySet.has(dependency)) {
        issues.push(validationIssue('duplicate-output-dependency', `Workflow output contains duplicate dependency "${dependency}"`, '$.contents.nodes.output.depends'));
      }
      dependencySet.add(dependency);
      if (dependency !== 'input' && (dependency === 'output' || !Object.hasOwn(nodes, dependency))) {
        issues.push(validationIssue('unknown-output-dependency', `Workflow output depends on unknown run node "${dependency}"`, '$.contents.nodes.output.depends'));
      }
    }
  }

  const schemaInput = isRecord(value.schema) && isRecord(value.schema.input) ? value.schema.input : {};
  for (const [nodeKey, nodeValue] of Object.entries(nodes)) {
    if (nodeKey === 'output' || !isRecord(nodeValue) || !isRecord(nodeValue.input) || !Array.isArray(nodeValue.depends)) continue;
    const depends = new Set(nodeValue.depends.filter((item): item is string => typeof item === 'string'));
    walkInputStrings(nodeValue.input, `$.contents.nodes.${nodeKey}.input`, (item, path) => {
      if (item.startsWith('$')) {
        validateReference(item, path, nodeKey, depends, nodes, schemaInput, issues);
      } else if (WORKFLOW_REFERENCE_TOKEN_PATTERN.test(item)) {
        issues.push(validationIssue('embedded-workflow-reference', 'Workflow references must occupy the entire JSON string value; use an exact reference or a workflow utility to compose text', path));
      }
    });
  }

  if (outputNode && isStringRecord(outputNode.fields) && Array.isArray(outputNode.depends)) {
    const depends = new Set(outputNode.depends.filter((item): item is string => typeof item === 'string'));
    for (const [key, reference] of Object.entries(outputNode.fields)) {
      if (!reference.startsWith('$')) {
        issues.push(validationIssue('invalid-output-reference', `Workflow output "${key}" must be a workflow reference`, `$.contents.nodes.output.fields.${key}`));
        continue;
      }
      validateReference(reference, `$.contents.nodes.output.fields.${key}`, 'output', depends, nodes, schemaInput, issues);
    }
  }

  if (isStringRecord(value.output) && outputNode && isStringRecord(outputNode.fields) && canonicalStringify(value.output) !== canonicalStringify(outputNode.fields)) {
    issues.push(validationIssue('output-mapping-mismatch', 'Workflow output must exactly match nodes.output.fields', '$.contents.output'));
  }

  validateDependencyGraph(nodes, issues);

  if (issues.length > 0) {
    return { valid: false, status: 'invalid', issues };
  }

  return {
    valid: true,
    status: 'valid',
    value: value as unknown as WorkflowContents,
    issues: [],
  };
}

export function validateWorkflowArtifact(value: unknown): ArtifactValidationResult<WorkflowArtifact> {
  const issues: ArtifactValidationIssue[] = [];
  if (!isRecord(value)) {
    return {
      valid: false,
      status: 'invalid',
      issues: [validationIssue('invalid-artifact', 'Workflow artifact must be an object')],
    };
  }

  if (value.artifactVersion !== 1) {
    issues.push(validationIssue('unsupported-artifact-version', 'Workflow artifactVersion must be 1', '$.artifactVersion'));
  }

  const title = typeof value.title === 'string' ? value.title.trim() : '';
  if (!title || title.length > WORKFLOW_TITLE_MAX_LENGTH) {
    issues.push(validationIssue('invalid-artifact-title', `Workflow title must be 1-${WORKFLOW_TITLE_MAX_LENGTH} characters`, '$.title'));
  }

  const description = value.description === undefined ? '' : typeof value.description === 'string' ? value.description.trim() : '';
  if (value.description !== undefined && typeof value.description !== 'string') {
    issues.push(validationIssue('invalid-artifact-description', 'Workflow description must be a string', '$.description'));
  } else if (description.length > WORKFLOW_DESCRIPTION_MAX_LENGTH) {
    issues.push(validationIssue('artifact-description-too-long', `Workflow description must be at most ${WORKFLOW_DESCRIPTION_MAX_LENGTH} characters`, '$.description'));
  }

  const contentsResult = validateWorkflowContents(value.contents);
  issues.push(...contentsResult.issues);

  if (issues.length > 0 || !contentsResult.value) {
    return { valid: false, status: 'invalid', issues };
  }

  // Copy only the fields the artifact contract defines. Ids or provenance the
  // model adds are never kept or hashed.
  const artifact: WorkflowArtifact = {
    artifactVersion: 1,
    title,
    description,
    contents: contentsResult.value,
  };
  return { valid: true, status: 'valid', value: artifact, issues: [] };
}

export function validateWorkflowArtifactJson(raw: string): ArtifactValidationResult<WorkflowArtifact> {
  const byteLength = utf8ByteLength(raw);
  if (byteLength > WORKFLOW_ARTIFACT_MAX_BYTES) {
    return {
      valid: false,
      status: 'oversize',
      byteLength,
      issues: [validationIssue('workflow-artifact-oversize', `Workflow artifact exceeds the ${WORKFLOW_ARTIFACT_MAX_BYTES}-byte UTF-8 limit`)],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      valid: false,
      status: 'invalid',
      byteLength,
      issues: [validationIssue('malformed-workflow-json', 'Workflow artifact contains malformed JSON')],
    };
  }

  return { ...validateWorkflowArtifact(parsed), byteLength };
}

export function validateWorkflowListRequest(value: unknown): ArtifactValidationResult<WorkflowListRequest> {
  const issues: ArtifactValidationIssue[] = [];
  if (!isRecord(value)) {
    return {
      valid: false,
      status: 'invalid',
      issues: [validationIssue('invalid-workflow-request', 'Workflow request must be an object')],
    };
  }

  if (!hasOnlyKeys(value, ['protocolVersion', 'requestId', 'operation', 'args'])) {
    issues.push(validationIssue('unsupported-workflow-request-field', 'Workflow request contains unsupported fields'));
  }
  if (value.protocolVersion !== 1) {
    issues.push(validationIssue('unsupported-request-version', 'Workflow request protocolVersion must be 1', '$.protocolVersion'));
  }
  if (value.operation !== 'workflow.list') {
    issues.push(validationIssue('unsupported-workflow-operation', 'Only the read-only workflow.list operation is allowed', '$.operation'));
  }

  const requestId = typeof value.requestId === 'string' ? value.requestId : '';
  if (!requestId || requestId.length > WORKFLOW_REQUEST_ID_MAX_LENGTH || !WORKFLOW_REQUEST_ID_PATTERN.test(requestId)) {
    issues.push(validationIssue('invalid-workflow-request-id', `requestId must be a safe 1-${WORKFLOW_REQUEST_ID_MAX_LENGTH} character token`, '$.requestId'));
  }

  if (!isRecord(value.args)) {
    issues.push(validationIssue('invalid-workflow-request-args', 'workflow.list args must be an object', '$.args'));
  } else if (!hasOnlyKeys(value.args, ['search', 'limit'])) {
    issues.push(validationIssue('unsupported-workflow-request-arg', 'workflow.list accepts only search and limit arguments', '$.args'));
  }

  const argsValue = isRecord(value.args) ? value.args : {};
  let search: string | undefined;
  if (argsValue.search !== undefined) {
    if (typeof argsValue.search !== 'string') {
      issues.push(validationIssue('invalid-workflow-search', 'workflow.list search must be a string', '$.args.search'));
    } else {
      search = argsValue.search.trim();
      if (!search || search.length > WORKFLOW_LIST_SEARCH_MAX_LENGTH || /[\u0000-\u001F\u007F]/.test(search)) {
        issues.push(validationIssue('invalid-workflow-search', `workflow.list search must be 1-${WORKFLOW_LIST_SEARCH_MAX_LENGTH} visible characters`, '$.args.search'));
      }
    }
  }

  let limit: number | undefined;
  if (argsValue.limit !== undefined) {
    if (!Number.isInteger(argsValue.limit) || (argsValue.limit as number) < WORKFLOW_LIST_LIMIT_MIN || (argsValue.limit as number) > WORKFLOW_LIST_LIMIT_MAX) {
      issues.push(validationIssue('invalid-workflow-limit', `workflow.list limit must be an integer from ${WORKFLOW_LIST_LIMIT_MIN} to ${WORKFLOW_LIST_LIMIT_MAX}`, '$.args.limit'));
    } else {
      limit = argsValue.limit as number;
    }
  }

  if (issues.length > 0) {
    return { valid: false, status: 'invalid', issues };
  }

  const args: WorkflowListRequest['args'] = {};
  if (search !== undefined) args.search = search;
  if (limit !== undefined) args.limit = limit;
  return {
    valid: true,
    status: 'valid',
    value: {
      protocolVersion: 1,
      requestId,
      operation: 'workflow.list',
      args,
    },
    issues: [],
  };
}

export function validateWorkflowListRequestJson(raw: string): ArtifactValidationResult<WorkflowListRequest> {
  const byteLength = utf8ByteLength(raw);
  if (byteLength > WORKFLOW_REQUEST_MAX_BYTES) {
    return {
      valid: false,
      status: 'oversize',
      byteLength,
      issues: [validationIssue('workflow-request-oversize', `Workflow request exceeds the ${WORKFLOW_REQUEST_MAX_BYTES}-byte UTF-8 limit`)],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      valid: false,
      status: 'invalid',
      byteLength,
      issues: [validationIssue('malformed-workflow-request-json', 'Workflow request contains malformed JSON')],
    };
  }
  return { ...validateWorkflowListRequest(parsed), byteLength };
}

function appendProseSegment(segments: AgentChatArtifactSegment[], content: string): void {
  if (!content) return;
  const previous = segments[segments.length - 1];
  if (previous?.type === 'prose') {
    previous.content += content;
  } else {
    segments.push({ type: 'prose', content });
  }
}

function consumeLineBreak(source: string, offset: number): number {
  if (source.startsWith('\r\n', offset)) return offset + 2;
  if (source.startsWith('\n', offset)) return offset + 1;
  return offset;
}

function stripFenceTrailingLineBreak(value: string): string {
  if (value.endsWith('\r\n')) return value.slice(0, -2);
  if (value.endsWith('\n')) return value.slice(0, -1);
  return value;
}

export function parseAgentChatArtifacts(source: string, options: AgentChatArtifactParseOptions = {}): AgentChatArtifactParseResult {
  const segments: AgentChatArtifactSegment[] = [];
  const openingPattern = /^( {0,3})```(wiro-workflow-request|wiro-workflow)[ \t]*\r?$/gm;
  const seenRequestIds = new Set(options.seenRequestIds ?? []);
  const answerByteLength = utf8ByteLength(source);
  let cursor = 0;
  let streamState: AgentChatArtifactParseResult['streamState'] = 'complete';
  let openingMatch: RegExpExecArray | null;

  while ((openingMatch = openingPattern.exec(source)) !== null) {
    appendProseSegment(segments, source.slice(cursor, openingMatch.index));
    const fenceType = openingMatch[2] as typeof WORKFLOW_ARTIFACT_FENCE | typeof WORKFLOW_REQUEST_FENCE;
    const bodyStart = consumeLineBreak(source, openingPattern.lastIndex);
    const closingPattern = /^( {0,3})```[ \t]*\r?$/gm;
    closingPattern.lastIndex = bodyStart;
    const closingMatch = closingPattern.exec(source);

    if (!closingMatch) {
      const partialBody = source.slice(bodyStart);
      const byteLength = utf8ByteLength(partialBody);
      if (fenceType === WORKFLOW_REQUEST_FENCE) {
        segments.push({
          type: 'workflow-request',
          status: byteLength > WORKFLOW_REQUEST_MAX_BYTES ? 'oversize' : 'incomplete',
          byteLength,
          issues: byteLength > WORKFLOW_REQUEST_MAX_BYTES ? [validationIssue('workflow-request-oversize', `Workflow request exceeds the ${WORKFLOW_REQUEST_MAX_BYTES}-byte UTF-8 limit`)] : [],
        });
        streamState = 'loading-workflows';
      } else {
        segments.push({
          type: 'workflow',
          status: byteLength > WORKFLOW_ARTIFACT_MAX_BYTES ? 'oversize' : 'incomplete',
          byteLength,
          issues: byteLength > WORKFLOW_ARTIFACT_MAX_BYTES ? [validationIssue('workflow-artifact-oversize', `Workflow artifact exceeds the ${WORKFLOW_ARTIFACT_MAX_BYTES}-byte UTF-8 limit`)] : [],
        });
        streamState = 'building-workflow';
      }
      cursor = source.length;
      break;
    }

    const raw = stripFenceTrailingLineBreak(source.slice(bodyStart, closingMatch.index));
    if (fenceType === WORKFLOW_REQUEST_FENCE) {
      const result = validateWorkflowListRequestJson(raw);
      if (result.valid && result.value && seenRequestIds.has(result.value.requestId)) {
        segments.push({
          type: 'workflow-request',
          status: 'invalid',
          raw,
          byteLength: result.byteLength ?? utf8ByteLength(raw),
          issues: [validationIssue('duplicate-workflow-request-id', `requestId "${result.value.requestId}" has already been used`, '$.requestId')],
        });
      } else {
        if (result.value) seenRequestIds.add(result.value.requestId);
        segments.push({
          type: 'workflow-request',
          status: result.status,
          request: result.value,
          requestHash: result.value ? canonicalHash(result.value) : undefined,
          raw,
          byteLength: result.byteLength ?? utf8ByteLength(raw),
          issues: result.issues,
        });
      }
    } else {
      const result = validateWorkflowArtifactJson(raw);
      segments.push({
        type: 'workflow',
        status: result.status,
        artifact: result.value,
        artifactHash: result.value ? canonicalHash(result.value) : undefined,
        raw: result.value ? undefined : raw,
        byteLength: result.byteLength ?? utf8ByteLength(raw),
        issues: result.issues,
      });
    }

    cursor = consumeLineBreak(source, closingPattern.lastIndex);
    openingPattern.lastIndex = cursor;
  }

  if (cursor < source.length) {
    appendProseSegment(segments, source.slice(cursor));
  }

  // Over the whole-answer cap nothing is actionable, but an artifact keeps its
  // value so callers must check status and issues, never the value alone.
  if (answerByteLength > WORKFLOW_ASSISTANT_MAX_BYTES) {
    const issue = validationIssue('workflow-answer-oversize', `Workflow Agent answer exceeds the ${WORKFLOW_ASSISTANT_MAX_BYTES}-byte UTF-8 limit`);
    for (const segment of segments) {
      if (segment.type === 'prose') continue;
      segment.status = 'oversize';
      segment.issues = [...segment.issues, issue];
      if (segment.type === 'workflow-request') segment.request = undefined;
    }
  }

  const requests = segments.filter((segment): segment is Extract<AgentChatArtifactSegment, { type: 'workflow-request' }> => segment.type === 'workflow-request');
  const artifacts = segments.filter((segment): segment is Extract<AgentChatArtifactSegment, { type: 'workflow' }> => segment.type === 'workflow');
  const prose = segments
    .filter((segment): segment is Extract<AgentChatArtifactSegment, { type: 'prose' }> => segment.type === 'prose')
    .map(segment => segment.content)
    .join('')
    .trim();

  return { prose, segments, requests, artifacts, streamState };
}
