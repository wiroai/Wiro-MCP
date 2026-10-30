import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WiroClient } from '../client.js';
import { errorResult, type ApiEnvelope } from '../utils/api.js';
import { extractReply } from '../utils/agent-message.js';
import { readAgentMessage, resolveAgentTarget } from '../utils/agent-targets.js';
import { parseAgentChatArtifacts, type WorkflowArtifact } from '../utils/workflow-artifacts.js';
import { formatWorkflowInputs, parseWorkflowSlug, workflowUrl } from '../utils/workflow.js';
import {
  createWorkflow,
  findHiddenValues,
  prepareIssuesText,
  tagProblem,
  updateWorkflow,
  WorkflowConflictError,
  WorkflowPrepareError,
  type SavedWorkflow,
} from '../utils/workflow-save.js';
import { formatUpdatedWorkflow, updatedWorkflowSchema } from './update-workflow.js';

// Remembers which proposal was already saved as a new workflow, so a repeated
// call (a retry, or the model asking twice) does not create a copy. Wiro's
// create endpoint has no idempotency key; it would save "Title-1". A create in
// progress is shared with any concurrent call for the same proposal. This is
// best effort: the memory is this process's, for an hour, so a server with
// several processes or a restart can still save a second copy.
const CREATED = new Map<string, { fullSlug?: string; pending?: Promise<SavedWorkflow>; at: number }>();
const CREATED_TTL_MS = 60 * 60 * 1000;
const CREATED_MAX = 500;

function trimCreated(): void {
  while (CREATED.size > CREATED_MAX) {
    const oldest = CREATED.keys().next().value;
    if (oldest === undefined) break;
    CREATED.delete(oldest);
  }
}

function pickArtifact(text: string, artifactHash?: string): { artifact: WorkflowArtifact; hash: string } {
  const parsed = parseAgentChatArtifacts(text);
  const segments = parsed.artifacts;
  const describe = (segment: typeof segments[number]) => segment.issues.slice(0, 4).map(issue => issue.message).join('; ');

  if (artifactHash) {
    const segment = segments.find(candidate => candidate.artifactHash === artifactHash);
    if (!segment) throw new Error('That reply has no workflow with this artifact_hash. Read the reply again with get_agent_message.');
    if (segment.status !== 'valid' || segment.issues.length > 0 || !segment.artifact) {
      throw new Error(`The Workflow Agent's proposal is not valid (${describe(segment)}). Send the problems back to the Workflow Agent in the same session and ask it to fix them.`);
    }
    return { artifact: segment.artifact, hash: artifactHash };
  }

  // Only a segment the parser marked valid with no issues counts; an oversize
  // reply keeps its artifact object while being marked unusable.
  const valid = segments.filter(segment => segment.status === 'valid' && segment.issues.length === 0 && segment.artifact && segment.artifactHash);
  if (valid.length === 1) return { artifact: valid[0]!.artifact!, hash: valid[0]!.artifactHash! };
  if (valid.length > 1) {
    throw new Error(`That reply proposes ${valid.length} workflows. Pass artifact_hash to choose one: `
      + valid.map(segment => `${segment.artifactHash} ("${segment.artifact!.title}")`).join(', '));
  }
  const invalid = segments.find(segment => segment.status !== 'valid' || segment.issues.length > 0);
  if (invalid) {
    throw new Error(`The Workflow Agent's proposal is not valid (${describe(invalid) || invalid.status}). Send the problems back to the Workflow Agent in the same session and ask it to fix them.`);
  }
  throw new Error('That reply does not contain a workflow proposal.');
}

/** Saves the proposal as a new workflow once, sharing an in-flight create. */
async function createOnce(
  client: WiroClient,
  key: string,
  create: () => Promise<SavedWorkflow>,
  signal?: AbortSignal,
): Promise<{ saved?: SavedWorkflow; previous?: string }> {
  const entry = CREATED.get(key);
  if (entry && Date.now() - entry.at <= CREATED_TTL_MS) {
    if (entry.pending) return { saved: await entry.pending };
    if (entry.fullSlug) {
      const detail = await client.post<ApiEnvelope & { workflow?: unknown[]; notFound?: boolean }>(
        '/Workflow/Detail',
        { slug: entry.fullSlug },
        signal,
      );
      if (detail.result === true && Array.isArray(detail.workflow) && detail.workflow.length > 0) {
        return { previous: entry.fullSlug };
      }
      if (detail.notFound !== true) {
        throw new Error(`Could not check whether this proposal was already saved as ${entry.fullSlug}. Look for it with list_workflows before saving again.`);
      }
      // The earlier copy was deleted, so saving again is what the user wants.
    }
  }

  const pending = create();
  CREATED.set(key, { pending, at: Date.now() });
  trimCreated();
  try {
    const saved = await pending;
    CREATED.set(key, { fullSlug: saved.fullSlug, at: Date.now() });
    return { saved };
  } catch (error) {
    CREATED.delete(key);
    throw error;
  }
}

export function registerSaveWorkflowFromAgent(server: McpServer, client: WiroClient): void {
  server.registerTool(
    'save_workflow_from_agent',
    {
      title: 'Save a workflow from the Workflow Agent',
      description: 'Save the workflow the Workflow Agent proposed in one of its replies. Without '
        + '`workflow` it is saved as a new private workflow. With `workflow` (the workflow that was '
        + 'attached when the agent was asked to edit it) the proposal replaces that workflow\'s '
        + 'steps; its saved input values and hidden secret inputs are kept. Applying needs the '
        + 'attached workflow\'s `loaded_updatetime`, and without `confirm: true` it only returns '
        + 'what would change: show that to the user and repeat the call with `confirm: true` after '
        + 'they agree. The reply is read again from Wiro, so pass its ids, not the JSON. Wiro '
        + 'checks and prepares the graph against the live model catalog first; if it finds '
        + 'problems, send them back to the Workflow Agent in the same session. Save each proposal '
        + 'once: a repeated save is caught only while this server remembers the first one, so it '
        + 'can still create a second copy. Saving is free; running the workflow is charged.',
      inputSchema: {
        message_id: z.string().min(1).describe('The Workflow Agent reply that holds the proposal.'),
        session: z.string().min(1).describe('The session that reply belongs to.'),
        artifact_hash: z.string().optional()
          .describe('Which proposal to save when the reply has more than one (from send_agent_message or get_agent_message).'),
        workflow: z.string().optional()
          .describe('Full slug or URL of the workflow to apply the proposal to. Leave it out to save a new workflow.'),
        loaded_updatetime: z.string().optional()
          .describe('Required with `workflow`: the attached workflow\'s `updatetime` from send_agent_message or get_agent_message. Stops the save if someone changed the workflow since.'),
        tags: z.array(z.string()).max(20).optional().describe('Tags for the workflow.'),
        confirm: z.boolean().default(false)
          .describe('Required to apply a proposal to an existing workflow, after the user approved the change summary.'),
        force: z.boolean().default(false)
          .describe('When applying: overwrite a newer version. Only when the user explicitly wants that.'),
        acknowledge_review_reset: z.boolean().default(false)
          .describe('Required to change a published workflow, after the user agreed it leaves the gallery until reviewed.'),
      },
      outputSchema: {
        ...updatedWorkflowSchema,
        reviewReset: z.boolean().optional(),
        contentsChanged: z.boolean().optional(),
        unchanged: z.boolean().optional(),
        mode: z.enum(['create', 'apply']),
        alreadySaved: z.boolean(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args, extra) => {
      try {
        const problem = args.tags ? tagProblem(args.tags) : null;
        if (problem) throw new Error(problem);
        if (args.workflow && !args.loaded_updatetime) {
          throw new Error('Applying a proposal needs loaded_updatetime: the attached workflow\'s updatetime from the '
            + 'send_agent_message or get_agent_message result. If you do not have it, ask the user whether to apply the '
            + 'proposal onto the current version, then read it with get_workflow and pass that updatetime.');
        }

        const target = resolveAgentTarget('workflow-agent');
        const row = await readAgentMessage(client, target, args.message_id, args.session, extra.signal);
        if (row.status !== 'agent_end') {
          throw new Error(`That reply is not finished (status ${String(row.status)}). Wait for it with get_agent_message first.`);
        }
        const { artifact, hash } = pickArtifact(extractReply(row), args.artifact_hash);
        const contents = JSON.parse(JSON.stringify(artifact.contents)) as Record<string, unknown>;

        if (args.workflow) {
          const fullSlug = parseWorkflowSlug(args.workflow);
          const saved = await updateWorkflow(client, {
            fullSlug,
            title: artifact.title,
            ...(artifact.description ? { description: artifact.description } : {}),
            tags: args.tags,
            contents,
            loadedUpdatetime: args.loaded_updatetime,
            force: args.force,
            acknowledgeReviewReset: args.acknowledge_review_reset,
            preview: !args.confirm,
          }, extra.signal);

          if (saved.preview) {
            return {
              content: [{ type: 'text' as const, text: formatUpdatedWorkflow(saved, '## Review the change before saving') }],
              structuredContent: {
                ...saved,
                mode: 'apply' as const,
                alreadySaved: false,
                nextAction: {
                  tool: 'save_workflow_from_agent',
                  arguments: {
                    message_id: args.message_id,
                    session: args.session,
                    artifact_hash: hash,
                    workflow: fullSlug,
                    loaded_updatetime: args.loaded_updatetime,
                    ...(args.tags ? { tags: args.tags } : {}),
                    confirm: true,
                    ...(args.force ? { force: true } : {}),
                    ...(saved.reviewReset ? { acknowledge_review_reset: true } : {}),
                  },
                  reason: 'Show the user what will change and save only after they agree.',
                },
              },
            };
          }

          const heading = saved.unchanged ? '## Already applied' : '## Workflow updated';
          return {
            content: [{ type: 'text' as const, text: formatUpdatedWorkflow(saved, heading) }],
            structuredContent: {
              ...saved,
              mode: 'apply' as const,
              alreadySaved: saved.unchanged,
              nextAction: {
                tool: 'run_workflow',
                arguments: { slug: saved.fullSlug },
                reason: runReason(saved),
              },
            },
          };
        }

        const hidden = findHiddenValues(contents);
        if (hidden.length > 0) {
          throw new Error(`This proposal still has hidden values copied from the workflow the agent was shown (${hidden.join(', ')}). `
            + 'Apply it to that workflow with `workflow` so the real values are kept, or ask the agent to leave those inputs empty and set them yourself.');
        }
        const key = `${String(client.identity)}:${args.message_id}:${hash}`;
        const outcome = await createOnce(client, key, () => createWorkflow(client, {
          title: artifact.title,
          description: artifact.description,
          contents,
          tags: args.tags,
        }, extra.signal), extra.signal);

        if (outcome.previous) {
          return {
            content: [{ type: 'text' as const, text: `## Already saved\n\nThis proposal was already saved as \`${outcome.previous}\`. Nothing new was created.` }],
            structuredContent: {
              mode: 'create' as const,
              alreadySaved: true,
              fullSlug: outcome.previous,
              url: workflowUrl(outcome.previous),
              title: artifact.title,
              renamed: false,
              inputs: [],
              outputs: {},
              warnings: [],
              nextAction: {
                tool: 'get_workflow',
                arguments: { slug: outcome.previous },
                reason: 'Read the saved workflow.',
              },
            },
          };
        }

        const saved = outcome.saved!;
        const lines = ['## Workflow saved', ''];
        lines.push(`**Title:** ${saved.title}${saved.renamed ? ' (renamed because the title was already used)' : ''}`);
        lines.push(`**Slug:** \`${saved.fullSlug}\``);
        lines.push(`**Page:** ${saved.url}`);
        lines.push('', '### Inputs', '', ...formatWorkflowInputs(saved.inputs));
        if (saved.warnings.length > 0) {
          lines.push('', '### Notes', '', ...saved.warnings.map(warning => `- ${warning.nodeId ? `\`${warning.nodeId}\`: ` : ''}${warning.message}`));
        }
        return {
          content: [{ type: 'text' as const, text: lines.join('\n') }],
          structuredContent: {
            ...saved,
            mode: 'create' as const,
            alreadySaved: false,
            nextAction: {
              tool: 'run_workflow',
              arguments: { slug: saved.fullSlug },
              reason: runReason(saved),
            },
          },
        };
      } catch (error) {
        if (error instanceof WorkflowPrepareError) {
          return {
            content: [{
              type: 'text' as const,
              text: `${prepareIssuesText(error)}\n\nYou can send these problems to the Workflow Agent in the same session (send_agent_message with agent "workflow-agent" and session "${args.session}") and ask it to fix them.`,
            }],
            isError: true,
          };
        }
        if (error instanceof WorkflowConflictError) {
          return {
            content: [{
              type: 'text' as const,
              text: `## Not saved: newer changes exist\n\n${error.message} You can also attach the current version to a new message for the Workflow Agent so it edits the latest steps.`,
            }],
            isError: true,
          };
        }
        return errorResult(error);
      }
    },
  );
}

function runReason(saved: SavedWorkflow): string {
  const keys = saved.inputs.map(input => input.key);
  return 'To try it, ask the user first (each model step is charged), then call run_workflow with input values'
    + (keys.length > 0 ? ` for: ${keys.join(', ')}. A key you leave out uses its saved value or default.` : '.');
}
