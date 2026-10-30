import { z } from 'zod';
import type { WiroClient } from '../client.js';
import {
  asString,
  isPlainObject,
  requireApiSuccess,
  toNumber,
  unixToIso,
} from './api.js';
import {
  WORKFLOW_LIST_LIMIT_MAX,
  WORKFLOW_LIST_LIMIT_MIN,
  WORKFLOW_LIST_SEARCH_MAX_LENGTH,
  parseAgentChatArtifacts,
  utf8ByteLength,
  type AgentChatArtifactSegment,
  type WorkflowListRequest,
} from './workflow-artifacts.js';

// The Workflow Agent cannot read or save the user's workflows itself. The
// caller attaches the workflow to edit, reads the artifacts out of the reply,
// and runs the one read-only "list my workflows" request the agent may make.

export const WORKFLOW_CONTEXT_MAX_BYTES = 40 * 1024;
const WORKFLOW_URL_BASE = 'https://wiro.ai/workflows/';
const FULL_SLUG_PATTERN = /^[A-Za-z0-9-]+-[A-Za-z0-9]{5}$/;
const MAX_ISSUES = 4;

export interface WorkflowAgentContext {
  protocolVersion: 1;
  source: {
    slug: string;
    slugid: string;
    fullSlug: string;
    title: string;
    description: string;
    updatetime: string;
    workspace: 'personal' | 'team';
  };
  contents: Record<string, unknown>;
}

export const attachedWorkflowSchema = z.object({
  fullSlug: z.string(),
  // Known when the workflow was attached; get_agent_message only carries the slug along.
  title: z.string().optional(),
  updatetime: z.string(),
  url: z.string(),
});

export type AttachedWorkflow = z.infer<typeof attachedWorkflowSchema>;

export const workflowArtifactSummarySchema = z.object({
  index: z.number().int().nonnegative(),
  status: z.enum(['valid', 'invalid', 'oversize', 'incomplete']),
  valid: z.boolean(),
  artifactHash: z.string().optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  nodeCount: z.number().int().nonnegative().optional(),
  issues: z.array(z.string()),
  issueCount: z.number().int().nonnegative(),
});

export type WorkflowArtifactSummary = z.infer<typeof workflowArtifactSummarySchema>;

export const workflowListResultSchema = z.object({
  search: z.string().optional(),
  limit: z.number().int().positive(),
  total: z.number().int().nonnegative().optional(),
  rows: z.array(z.object({
    title: z.string(),
    fullSlug: z.string(),
    updatedAt: z.string().optional(),
    url: z.string(),
  })),
  instruction: z.string(),
  error: z.string().optional(),
});

export type WorkflowListResult = z.infer<typeof workflowListResultSchema>;

/** A full slug ("my-flow-a1B2c") from a slug or a wiro.ai workflow URL. */
export function parseWorkflowReference(reference: string): string {
  const value = reference.trim();
  let candidate = value;
  if (/^https?:\/\//i.test(value)) {
    let segments: string[] = [];
    try {
      segments = new URL(value).pathname.split('/').filter(Boolean).map(decodeURIComponent);
    } catch {
      segments = [];
    }
    const marker = segments.findIndex(segment => segment === 'workflows' || segment === 'workflow');
    candidate = (marker >= 0 ? segments[marker + 1] : segments[segments.length - 1]) ?? '';
  }
  if (!FULL_SLUG_PATTERN.test(candidate) || candidate.length > 360) {
    throw new Error('workflow must be a full workflow slug such as "product-shots-a1B2c" (from list_workflows) '
      + 'or a wiro.ai/workflows/... link.');
  }
  return candidate;
}

export function workflowUrl(fullSlug: string): string {
  return `${WORKFLOW_URL_BASE}${fullSlug}`;
}

/**
 * The workflow a message was sent with, carried from send_agent_message to
 * get_agent_message so the save step still applies the proposal to it.
 */
export function carriedAttachedWorkflow(
  workflow: string | undefined,
  loadedUpdatetime: string | undefined,
): AttachedWorkflow | undefined {
  const updatetime = loadedUpdatetime?.trim() ?? '';
  if (!workflow?.trim() && !updatetime) return undefined;
  if (!workflow?.trim() || !updatetime) {
    throw new Error('Pass workflow and loaded_updatetime together, both from the attachedWorkflow that '
      + 'send_agent_message returned for this message.');
  }
  const fullSlug = parseWorkflowReference(workflow);
  return { fullSlug, updatetime, url: workflowUrl(fullSlug) };
}

function parseContents(value: unknown): Record<string, unknown> | null {
  let parsed = value;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return null;
    }
  }
  if (!isPlainObject(parsed)) return null;
  return JSON.parse(JSON.stringify(parsed)) as Record<string, unknown>;
}

/**
 * The envelope the Workflow Agent reads as "the workflow being edited". Saved
 * Start values are the user's data and never reach the agent.
 */
export function buildWorkflowAgentContext(row: Record<string, unknown>): {
  context: WorkflowAgentContext;
  workflow: AttachedWorkflow & { title: string };
} {
  const slug = asString(row.slug) ?? '';
  const slugid = asString(row.slugid) ?? '';
  if (!slug || !slugid) throw new Error('The workflow came back without its slug, so it cannot be attached.');
  // A protected copy arrives with its graph removed; the agent would edit an empty shell.
  if (row.estimatedcost !== undefined && row.estimatedcost !== null) {
    throw new Error('This workflow is a protected copy. Its graph is hidden, so the Workflow Agent cannot edit it.');
  }
  const contents = parseContents(row.contents);
  if (!contents) throw new Error('The workflow has no readable definition, so it cannot be attached.');
  if (isPlainObject(contents.metadata)) {
    if (isPlainObject(contents.metadata.input)) delete contents.metadata.input.values;
    delete contents.metadata.browser;
    delete contents.metadata.browserState;
    delete contents.metadata.runtime;
  }

  const fullSlug = `${slug}-${slugid}`;
  const title = asString(row.title) ?? fullSlug;
  const updatetime = asString(row.updatetime) ?? '';
  if (!updatetime) throw new Error('The workflow came back without its update time, so it cannot be attached.');
  // The agent refuses a source whose title or description is longer than these.
  const context: WorkflowAgentContext = {
    protocolVersion: 1,
    source: {
      slug,
      slugid,
      fullSlug,
      title: title.slice(0, 300),
      description: (asString(row.description) ?? '').slice(0, 2_000),
      updatetime,
      workspace: asString(row.teamguid) ? 'team' : 'personal',
    },
    contents,
  };
  if (utf8ByteLength(JSON.stringify(context)) > WORKFLOW_CONTEXT_MAX_BYTES) {
    throw new Error('This workflow is too large for the Workflow Agent to edit: its definition is over 40 KB.');
  }
  return { context, workflow: { fullSlug, title, updatetime, url: workflowUrl(fullSlug) } };
}

export async function loadWorkflowAgentContext(
  client: WiroClient,
  reference: string,
  signal?: AbortSignal,
): Promise<ReturnType<typeof buildWorkflowAgentContext>> {
  const slug = parseWorkflowReference(reference);
  const body = requireApiSuccess(
    await client.post<Record<string, unknown> & { result?: boolean }>('/Workflow/Detail', { slug }, signal),
    'Could not load the workflow.',
  );
  const row = Array.isArray(body.workflow) ? body.workflow[0] : undefined;
  if (!isPlainObject(row)) throw new Error(`Workflow "${slug}" was not found.`);
  return buildWorkflowAgentContext(row);
}

// ─── Reading a reply ────────────────────────────────────────────────

function rawArtifactPreview(raw: string | undefined): { title?: string; nodeCount?: number } {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isPlainObject(parsed)) return {};
    const title = typeof parsed.title === 'string' && parsed.title.trim()
      ? parsed.title.trim().slice(0, 160)
      : undefined;
    const nodes = isPlainObject(parsed.contents) && isPlainObject(parsed.contents.nodes)
      ? Object.keys(parsed.contents.nodes).filter(key => key !== 'output').length
      : undefined;
    return { ...(title ? { title } : {}), ...(nodes !== undefined ? { nodeCount: nodes } : {}) };
  } catch {
    return {};
  }
}

function summarizeArtifact(
  segment: Extract<AgentChatArtifactSegment, { type: 'workflow' }>,
  index: number,
): WorkflowArtifactSummary {
  const messages = segment.issues.map(issue => (issue.path && issue.path !== '$'
    ? `${issue.message} (at ${issue.path})`
    : issue.message));
  if (segment.status === 'incomplete') {
    messages.unshift('The workflow response ended before its JSON artifact was complete.');
  }
  const artifact = segment.artifact;
  const preview = artifact ? {} : rawArtifactPreview(segment.raw);
  const nodeCount = artifact
    ? Object.keys(artifact.contents.nodes).filter(key => key !== 'output').length
    : preview.nodeCount;
  return {
    index,
    status: segment.status,
    valid: segment.status === 'valid' && segment.issues.length === 0,
    ...(segment.artifactHash ? { artifactHash: segment.artifactHash } : {}),
    ...(artifact?.title ?? preview.title ? { title: artifact?.title ?? preview.title } : {}),
    ...(artifact?.description ? { description: artifact.description } : {}),
    ...(nodeCount !== undefined ? { nodeCount } : {}),
    issues: messages.slice(0, MAX_ISSUES),
    issueCount: messages.length,
  };
}

export interface WorkflowReplySummary {
  prose: string;
  workflows: WorkflowArtifactSummary[];
  listRequest?: WorkflowListRequest;
}

/** Prose, artifact summaries and the first valid list request of one reply. */
export function summarizeWorkflowReply(text: string): WorkflowReplySummary {
  const parsed = parseAgentChatArtifacts(text);
  const request = parsed.requests.find(segment => segment.status === 'valid'
    && segment.issues.length === 0
    && segment.request !== undefined);
  return {
    prose: parsed.prose,
    workflows: parsed.artifacts.map((segment, index) => summarizeArtifact(segment, index)),
    ...(request?.request ? { listRequest: request.request } : {}),
  };
}

/** Text without the fenced blocks, for replies that are still being written. */
export function workflowReplyProse(text: string): string {
  return parseAgentChatArtifacts(text).prose;
}

export function workflowListInstruction(session: string): string {
  return 'To edit one of these, call send_agent_message again with agent "workflow-agent", '
    + `session "${session}", workflow set to its fullSlug and the edit request. Ask the user when it is `
    + 'not clear which workflow they mean.';
}

/** Runs the agent's read-only workflow.list request once, the way wiro.ai does. */
export async function listWorkflowsForAgent(
  client: WiroClient,
  request: WorkflowListRequest,
  session: string,
  signal?: AbortSignal,
): Promise<WorkflowListResult> {
  const search = String(request.args.search ?? '').trim().slice(0, WORKFLOW_LIST_SEARCH_MAX_LENGTH);
  const limit = Math.min(
    WORKFLOW_LIST_LIMIT_MAX,
    Math.max(WORKFLOW_LIST_LIMIT_MIN, Number(request.args.limit) || WORKFLOW_LIST_LIMIT_MAX),
  );
  const base = {
    ...(search ? { search } : {}),
    limit,
    instruction: workflowListInstruction(session),
  };
  try {
    const body = requireApiSuccess(
      await client.post<Record<string, unknown> & { result?: boolean }>('/Workflow/List', {
        scope: 'my',
        start: '0',
        limit: String(limit),
        summary: true,
        sort: 'updatetime',
        order: 'DESC',
        ...(search ? { search } : {}),
      }, signal),
      'Could not load your workflows.',
    );
    const listed = Array.isArray(body.workflow) ? body.workflow.filter(isPlainObject) : [];
    // Protected copies hide their graph, so the agent could not edit them.
    const visible = listed.filter(row => !((toNumber(row.clonedfromid) ?? 0) > 0 && toNumber(row.isprotected) === 1));
    const rows = visible
      .map(row => {
        const slug = asString(row.slug) ?? '';
        const slugid = asString(row.slugid) ?? '';
        const fullSlug = slugid ? `${slug}-${slugid}` : slug;
        const updatedAt = unixToIso(row.updatetime);
        return {
          title: asString(row.title) ?? fullSlug,
          fullSlug,
          ...(updatedAt ? { updatedAt } : {}),
          url: workflowUrl(fullSlug),
        };
      })
      .filter(row => row.fullSlug);
    const serverTotal = toNumber(body.total) ?? listed.length;
    return {
      ...base,
      total: Math.max(rows.length, serverTotal - (listed.length - visible.length)),
      rows,
    };
  } catch (error) {
    return {
      ...base,
      rows: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
