import { z } from 'zod';
import { WiroApiError, type WiroClient } from '../client.js';
import { nextActionSchema } from '../tools/schemas.js';
import type { NextAction } from './structured.js';
import {
  ApiResultError,
  asString,
  isPlainObject,
  toNumber,
  truncate,
  unixToIso,
} from './api.js';
import {
  agentMessageSchema,
  extractMediaUrls,
  extractReply,
  formatAgentMessage,
  isEarlyNotFound,
  isTerminalMessageStatus,
  messageState,
  toAgentMessage,
  type AgentMessage,
} from './agent-message.js';
import {
  BARE_UNAVAILABLE_PATTERN,
  agentRequestBody,
  callAgent,
  isBackgroundHandOff,
  readAgentMessage,
  type AgentTarget,
} from './agent-targets.js';
import { createMediaContent, guessMimeType, isWiroHostedUrl, type MediaItem } from './media.js';
import { defaultInterval, pollUntil, reportProgress, type ToolCallContext } from './poll.js';
import {
  STUDIO_RUNS_MAX,
  formatStudioRun,
  readStudioRunPage,
  studioRunSchema,
  type StudioRun,
  type StudioRunWindow,
} from './studio-runs.js';
import {
  attachedWorkflowSchema,
  listWorkflowsForAgent,
  summarizeWorkflowReply,
  workflowArtifactSummarySchema,
  workflowListResultSchema,
  workflowModelsText,
  workflowReplyProse,
  type AttachedWorkflow,
  type WorkflowArtifactSummary,
  type WorkflowListResult,
} from './workflow-agent.js';

// One agent turn as send_agent_message and get_agent_message report it: wait
// for the message within the caller's budget, then add what only some agents
// have (Studio's model runs, the Workflow Agent's artifacts) and the next step.

const MAX_REPLY_LENGTH = 20_000;
const MAX_PARTIAL_LENGTH = 2_000;
// Runs are stamped by the same server clock as the message; the slack only
// absorbs rounding to whole seconds.
const RUN_WINDOW_BEFORE_SECONDS = 5;
const RUN_WINDOW_AFTER_SECONDS = 30;
// Work handed to the background starts its runs after the turn has ended, and
// runs are matched to a turn by time. A hand-off's runs are therefore counted
// until the next message in its session, and for at most this long. Until then get_agent_message keeps pointing to itself while no
// run has appeared; a text-only result cannot keep an assistant polling forever.
const BACKGROUND_FOLLOW_UP_SECONDS = 30 * 60;
// One short page of the session's history finds its next message.
const NEXT_MESSAGE_HISTORY_LIMIT = 20;
// A small page of Studio's recent runs covers most turns, so the largest page
// is read only when the small one does not reach back to the start of the turn.
const STUDIO_RUNS_PAGE = 30;
// The first run of a hand-off is looked for less often: the reply has already
// said that its results come later.
const BACKGROUND_RUN_POLL_MS = 15_000;
// A read that has not found the message yet is repeated past the 10 seconds a
// new message can take to become visible.
const NOT_VISIBLE_RETRY_WAIT_SECONDS = 15;
// Not a status of Wiro's: the message cannot be read yet.
const NOT_VISIBLE_STATUS = 'not_visible';

const STUDIO_RUNS_NOTE = 'These model runs were started by Studio and belong to it: get_task, cancel_task and kill_task '
  + 'cannot read or stop them. Use get_agent_message or list_studio_results to follow them.';

export const agentTurnOutputSchema = {
  agent: z.string(),
  agentKind: z.enum(['studio', 'workflow-agent', 'deployed']),
  session: z.string(),
  sessionCreated: z.boolean().optional(),
  done: z.boolean(),
  message: agentMessageSchema,
  partialReply: z.string().optional(),
  background: z.boolean().optional(),
  modelChange: z.object({
    fromModel: z.string().optional(),
    toModel: z.string().optional(),
  }).optional(),
  llmCostUsd: z.number().nullable().optional(),
  modelRuns: z.array(studioRunSchema).optional(),
  modelRunsPending: z.boolean().optional(),
  attachedWorkflow: attachedWorkflowSchema.optional(),
  workflows: z.array(workflowArtifactSummarySchema).optional(),
  workflowList: workflowListResultSchema.optional(),
  notes: z.array(z.string()),
  nextAction: nextActionSchema.optional(),
};

export interface AgentTurnResult {
  [key: string]: unknown;
  agent: string;
  agentKind: AgentTarget['kind'];
  session: string;
  sessionCreated?: boolean;
  done: boolean;
  message: AgentMessage;
  partialReply?: string;
  background?: boolean;
  modelChange?: { fromModel?: string; toModel?: string };
  llmCostUsd?: number | null;
  modelRuns?: StudioRun[];
  modelRunsPending?: boolean;
  attachedWorkflow?: AttachedWorkflow;
  workflows?: WorkflowArtifactSummary[];
  workflowList?: WorkflowListResult;
  notes: string[];
  nextAction?: NextAction;
}

export interface CollectTurnOptions {
  client: WiroClient;
  target: AgentTarget;
  messageId: string;
  /** The session Detail is addressed with; undefined only for deployed agents. */
  session: string | undefined;
  waitSeconds: number;
  extra?: ToolCallContext;
  /** Set by send: the status Send reported, used until the row is readable. */
  sentStatus?: string;
  /** Unix seconds just before Send, for when the row has no createdat yet. */
  sentAt?: number;
  /** Send with wait_seconds 0 returns without reading the row. */
  skipRead?: boolean;
  /** Set by send when reading the queued turn failed: it is reported as pending, never as an error. */
  readFailure?: unknown;
  includeUserText?: boolean;
  sessionCreated?: boolean;
  modelChange?: { fromModel?: string; toModel?: string };
  attachedWorkflow?: AttachedWorkflow;
}

export function notFoundMessage(target: AgentTarget): string {
  if (target.kind === 'deployed') {
    return 'Message not found. Check message_id and agent; a message is visible only to the API key owner who sent it.';
  }
  return 'Message not found. Pass the same session the message was sent in (send_agent_message returns it); '
    + 'without one, the session "default" is searched.'
    + (target.kind === 'workflow-agent'
      ? ' A Workflow Agent message is visible only to API keys of the project that sent it: one sent with another'
        + ' project\'s key, or on wiro.ai, cannot be read here.'
      : '');
}

function isMessageNotFound(error: unknown): error is ApiResultError {
  return error instanceof ApiResultError && /message not found/i.test(error.message);
}

/** A short reason for a failed read, without response bodies. */
function readFailureReason(error: unknown): string {
  if (isMessageNotFound(error)) return 'Wiro does not show it yet';
  if (error instanceof WiroApiError) return `HTTP ${error.status}`;
  const text = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').trim();
  // The server's own "please try again" would contradict "do not send it again" next to it.
  if (BARE_UNAVAILABLE_PATTERN.test(text)) return 'Wiro answered that it is temporarily unavailable';
  return truncate(text.replace(/\s*Please try again\b[^.]*\.?/gi, '').trim() || 'Wiro gave no reason', 200);
}

function pendingMessage(messageId: string, status: string, state = messageState(status)): AgentMessage {
  return {
    messageId,
    state,
    status,
    mediaUrls: [],
    toolsUsed: [],
    attachments: [],
  };
}

interface ProjectedMessage {
  message: AgentMessage;
  partialReply?: string;
  workflowReply?: ReturnType<typeof summarizeWorkflowReply>;
}

/** The public message; for the Workflow Agent the reply keeps only the prose. */
export function projectAgentMessage(
  target: AgentTarget,
  row: Record<string, unknown>,
  includeUserText: boolean,
): ProjectedMessage {
  const message = toAgentMessage(row, { includeUserText });
  // A voice call keeps only its id, status and times; its text names the caller.
  if (message.kind === 'voice_call') return { message };
  const terminal = isTerminalMessageStatus(row.status);
  if (!terminal) {
    const full = extractReply(row);
    const partial = target.kind === 'workflow-agent' ? workflowReplyProse(full) : full;
    return partial ? { message, partialReply: truncate(partial, MAX_PARTIAL_LENGTH) } : { message };
  }
  if (target.kind !== 'workflow-agent' || row.status !== 'agent_end') return { message };

  // The fenced JSON can be 40 KB; the reply keeps only the prose around it.
  const workflowReply = summarizeWorkflowReply(extractReply(row));
  const reply = truncate(workflowReply.prose, MAX_REPLY_LENGTH);
  const { reply: _reply, replyTruncated: _truncated, ...rest } = message;
  return {
    message: {
      ...rest,
      ...(reply ? { reply } : {}),
      ...(reply.length < workflowReply.prose.length ? { replyTruncated: true } : {}),
      mediaUrls: extractMediaUrls(workflowReply.prose),
    },
    workflowReply,
  };
}

function turnCreatedAt(options: CollectTurnOptions, row: Record<string, unknown>): number {
  return toNumber(row.createdat) ?? options.sentAt ?? Math.floor(Date.now() / 1000);
}

interface CollectedRuns {
  /** Undefined when the runs could not be read. */
  runs?: StudioRun[];
  pending: boolean;
  /** Set for a hand-off once runs that start from now on are no longer counted. */
  closedBy?: 'next message' | 'time';
}

/** When the next user message in the turn's session was created, from one short history page. */
async function nextUserMessageAt(options: CollectTurnOptions, createdAt: number): Promise<number | undefined> {
  const { client, target, session, messageId, extra } = options;
  if (session === undefined) return undefined;
  try {
    const response = await callAgent(
      client,
      target,
      'history',
      agentRequestBody(target, session, { limit: NEXT_MESSAGE_HISTORY_LIMIT }),
      extra?.signal,
    );
    const data = response.result === true && isPlainObject(response.data) ? response.data : {};
    const rows = Array.isArray(data.messages) ? data.messages.filter(isPlainObject) : [];
    // Results, notices and model switches have no user text of their own.
    const later = rows
      .filter(item => asString(item.guid) !== messageId && asString(item.content)?.trim())
      .map(item => toNumber(item.createdat))
      .filter((at): at is number => at !== null && at > createdAt);
    return later.length > 0 ? Math.min(...later) : undefined;
  } catch (error) {
    if (extra?.signal.aborted) throw error;
    // The fixed limit still bounds the window.
    return undefined;
  }
}

async function collectStudioRuns(
  options: CollectTurnOptions,
  row: Record<string, unknown>,
  terminal: boolean,
  background: boolean,
  deadline: number,
  notes: string[],
): Promise<CollectedRuns> {
  const createdAt = turnCreatedAt(options, row);
  const endedAt = toNumber(row.endedat);
  // A turn's runs are found by the time they were created.
  const window: StudioRunWindow = { from: createdAt - RUN_WINDOW_BEFORE_SECONDS };
  let endsAtNextMessage = false;
  if (background) {
    const handOff = endedAt ?? createdAt;
    const limit = handOff + BACKGROUND_FOLLOW_UP_SECONDS;
    const nextMessage = await nextUserMessageAt(options, createdAt);
    endsAtNextMessage = nextMessage !== undefined && nextMessage < limit;
    window.to = Math.max(handOff + RUN_WINDOW_AFTER_SECONDS, Math.min(nextMessage ?? limit, limit));
  } else if (terminal && endedAt !== null) {
    window.to = endedAt + RUN_WINDOW_AFTER_SECONDS;
  }
  const windowClosed = (): boolean => window.to !== undefined && Date.now() / 1000 > window.to;

  let pageSize = STUDIO_RUNS_PAGE;
  let mayMissOlder = false;
  let found = 0;
  try {
    const poll = await pollUntil({
      read: async signal => {
        let page = await readStudioRunPage(options.client, pageSize, window, signal);
        if (page.mayMissOlder && pageSize < STUDIO_RUNS_MAX) {
          pageSize = STUDIO_RUNS_MAX;
          page = await readStudioRunPage(options.client, pageSize, window, signal);
        }
        mayMissOlder = page.mayMissOlder;
        found = page.runs.length;
        return page.runs;
      },
      // A hand-off is waited on until its first run shows up or its window closes.
      isDone: runs => !terminal
        || (runs.every(run => run.state !== 'running') && (!background || runs.length > 0 || windowClosed())),
      timeoutMs: terminal ? Math.max(0, deadline - Date.now()) : 0,
      signal: options.extra?.signal,
      interval: elapsedMs => (background && found === 0 ? BACKGROUND_RUN_POLL_MS : defaultInterval(elapsedMs)),
      onPoll: async (runs, elapsedMs) => {
        const running = runs.filter(run => run.state === 'running').length;
        if (running > 0) await reportProgress(options.extra, elapsedMs, `Studio: ${running} model run(s) still running`);
      },
    });
    if (mayMissOlder) {
      notes.push(`Studio lists only its ${STUDIO_RUNS_MAX} most recent model runs, and this turn started before the `
        + 'oldest of them, so some of its runs may be missing here.');
    }
    if (poll.value === undefined) {
      notes.push('The model runs of this turn could not be read just now. Call get_agent_message again to collect '
        + 'them; list_studio_results lists them too.');
      return { pending: false };
    }
    const runs = [...poll.value].reverse();
    return {
      runs,
      pending: runs.some(run => run.state === 'running'),
      ...(background && windowClosed() ? { closedBy: endsAtNextMessage ? 'next message' : 'time' } : {}),
    };
  } catch (error) {
    if (options.extra?.signal.aborted) throw error;
    notes.push(`The model runs of this turn could not be read (${readFailureReason(error)}). Call get_agent_message `
      + 'again to collect them; list_studio_results lists them too.');
    return { pending: false };
  }
}

function backgroundNote(target: AgentTarget): string {
  if (target.kind === 'studio') {
    return 'Studio handed this work to the background, so its results come later. get_agent_message collects the '
      + 'model runs it starts there, and list_studio_results lists them too. A text follow-up can also arrive as a '
      + 'separate message in this session: get_agent_conversation shows it with the API key of a personal project, '
      + 'but not with a team project\'s key. Do not send the request again.';
  }
  return 'The agent handed this work to the background. Its result arrives later as a separate message in this '
    + 'session: read it with get_agent_conversation. Do not send the request again.';
}

const FOLLOW_UP_MINUTES = BACKGROUND_FOLLOW_UP_SECONDS / 60;

const HAND_OFF_RUNS_BY_TIME_NOTE = 'Studio does not record which message started a run, so the runs of a hand-off '
  + 'are matched by time: runs started after this message and before the next message in this session, up to '
  + `${FOLLOW_UP_MINUTES} minutes after the hand-off. A run started from another Studio conversation in that time `
  + 'can show up here too.';

function handOffClosedNote(closedBy: NonNullable<CollectedRuns['closedBy']>, anyRuns: boolean): string {
  if (closedBy === 'next message') {
    return anyRuns
      ? 'Runs started after the next message in this session are not counted for this turn; list_studio_results '
        + 'shows them.'
      : 'No model run appeared before the next message in this session, so the background work may have answered '
        + 'with text only. list_studio_results shows any run it starts later.';
  }
  return anyRuns
    ? `Runs started more than ${FOLLOW_UP_MINUTES} minutes after the hand-off are not counted for this turn; `
      + 'list_studio_results shows them.'
    : `No model run has appeared in the ${FOLLOW_UP_MINUTES} minutes since the hand-off, so the background work may `
      + 'have answered with text only. list_studio_results shows any run it starts later.';
}

function workflowChoiceNote(rows: WorkflowListResult['rows'], session: string): string {
  const only = rows.length === 1 ? rows[0]! : undefined;
  const send = `send_agent_message with agent "workflow-agent", session "${session}"`;
  return only
    ? `The Workflow Agent needs the workflow attached to edit it. Confirm with the user that they mean "${only.title}", `
      + `then call ${send}, workflow "${only.fullSlug}" and their edit request as message. That is a new, billed turn.`
    : 'The Workflow Agent needs the workflow attached to edit it. Ask the user which of the listed workflows they '
      + `mean, then call ${send}, workflow set to that workflow's fullSlug and their edit request as message. That is `
      + 'a new, billed turn.';
}

interface TurnState {
  /** The wait ended before Wiro showed the message. */
  invisible: boolean;
  /** Set when send's reads failed; the turn stays queued. */
  afterSendFailure: boolean;
  /** A finished Studio turn whose model runs could not be read. */
  runsUnread: boolean;
  /** A Studio hand-off whose runs are still counted and whose first model run has not appeared yet. */
  awaitingBackgroundRuns: boolean;
}

export async function collectTurn(options: CollectTurnOptions): Promise<AgentTurnResult> {
  const { client, target, messageId } = options;
  const deadline = Date.now() + options.waitSeconds * 1000;
  const notes: string[] = [];
  const afterSend = options.sentStatus !== undefined;

  let row: Record<string, unknown> | undefined;
  let done = false;
  let readFailure: unknown = options.readFailure;
  let invisible = false;
  if (!options.skipRead && readFailure === undefined) {
    let lastError: unknown;
    try {
      const poll = await pollUntil({
        read: async signal => {
          try {
            return await readAgentMessage(client, target, messageId, options.session, signal);
          } catch (error) {
            lastError = error;
            throw error;
          }
        },
        isDone: value => isTerminalMessageStatus(value.status),
        timeoutMs: options.waitSeconds * 1000,
        signal: options.extra?.signal,
        // A new message can take a moment to become readable. After Send the
        // message is known to exist, so "not found" is read again for the
        // whole wait; otherwise only for the first seconds.
        isRetryable: (error, elapsedMs) => (afterSend ? isMessageNotFound(error) : isEarlyNotFound(error, elapsedMs)),
        onPoll: (value, elapsedMs) => reportProgress(
          options.extra,
          elapsedMs,
          `${target.name}: ${asString(value.status) ?? 'working'}`,
        ),
      });
      row = poll.value;
      done = poll.done;
    } catch (error) {
      if (options.extra?.signal.aborted) throw error;
      // Once Send has queued the turn, a failed read must not hide its id.
      if (afterSend) readFailure = error;
      else if (isMessageNotFound(error)) throw new ApiResultError(notFoundMessage(target), error.codes, error.body);
      else throw error;
    }
    if (!row && readFailure === undefined && lastError !== undefined) {
      // The wait ended before any read succeeded.
      if (isMessageNotFound(lastError)) invisible = true;
      else if (afterSend) readFailure = lastError;
      else throw lastError;
    }
  }

  if (!row && !afterSend && !invisible) {
    throw new ApiResultError(notFoundMessage(target), [], {});
  }

  const session = options.session
    ?? (target.kind === 'deployed' && row ? asString(row.sessionkey) : undefined)
    ?? 'default';
  const result: AgentTurnResult = {
    agent: target.agent,
    agentKind: target.kind,
    session,
    ...(options.sessionCreated ? { sessionCreated: true } : {}),
    done,
    // Until a row is read, only Send's own answer says anything about the message.
    message: afterSend
      ? pendingMessage(messageId, options.sentStatus ?? 'agent_queue')
      : pendingMessage(messageId, NOT_VISIBLE_STATUS, 'submitted'),
    notes,
    ...(options.modelChange ? { modelChange: options.modelChange } : {}),
    ...(options.attachedWorkflow ? { attachedWorkflow: options.attachedWorkflow } : {}),
  };
  const continueArguments: Record<string, unknown> = {
    agent: target.agent,
    message_id: messageId,
    ...(target.kind !== 'deployed' || options.session !== undefined ? { session } : {}),
    // The attached workflow travels with the wait, so the save step can still apply the proposal to it.
    ...(options.attachedWorkflow
      ? { workflow: options.attachedWorkflow.fullSlug, loaded_updatetime: options.attachedWorkflow.updatetime }
      : {}),
  };
  const state: TurnState = {
    invisible,
    afterSendFailure: readFailure !== undefined,
    runsUnread: false,
    awaitingBackgroundRuns: false,
  };

  if (options.sessionCreated) {
    notes.push(`This message started a new session. Pass session "${session}" to continue the same conversation.`);
  }
  if (readFailure !== undefined) {
    notes.push(`Wiro queued this message (id ${messageId}) but it could not be read just now `
      + `(${readFailureReason(readFailure)}). It may already be running and is billed as usual. Do not send it `
      + 'again: follow nextAction to keep waiting for it.');
  } else if (invisible && afterSend) {
    notes.push(`Wiro queued this message (id ${messageId}) but does not show it yet. Do not send it again: follow `
      + 'nextAction to keep waiting for it.');
  } else if (invisible) {
    notes.push('Wiro does not show this message yet. A message sent moments ago can take a few seconds to appear. '
      + 'If it still cannot be found after 10 seconds, the message id or the session is wrong'
      + (target.kind === 'workflow-agent'
        ? ', or it was sent with another project\'s API key or on wiro.ai, which this key cannot read.'
        : '.'));
  }

  if (row) {
    const projected = projectAgentMessage(target, row, options.includeUserText ?? false);
    result.message = projected.message;
    if (projected.partialReply) result.partialReply = projected.partialReply;
    const voiceCall = result.message.kind === 'voice_call';
    if (voiceCall) notes.push('This is a voice call record. Caller details and transcripts are not returned.');

    if (target.kind !== 'deployed') {
      const credits = toNumber(row.tokencost);
      result.llmCostUsd = credits === null ? null : Math.round(credits * 100) / 10_000;
    }

    const background = done
      && row.status === 'agent_end'
      && !voiceCall
      && isBackgroundHandOff(result.message.reply, result.message.toolsUsed);
    if (background) {
      result.background = true;
      notes.push(backgroundNote(target));
    }

    if (target.kind === 'studio') {
      const collected = await collectStudioRuns(options, row, done, background, deadline, notes);
      if (collected.runs) {
        result.modelRuns = collected.runs;
        if (done && collected.pending) result.modelRunsPending = true;
        if (collected.runs.length > 0) {
          notes.push(STUDIO_RUNS_NOTE);
          if (background) {
            notes.push(HAND_OFF_RUNS_BY_TIME_NOTE);
            if (collected.closedBy) {
              notes.push(handOffClosedNote(collected.closedBy, true));
            } else if (!collected.pending) {
              notes.push('More runs can still start while the background work goes on; get_agent_message and '
                + 'list_studio_results show them.');
            }
          }
        } else if (background) {
          state.awaitingBackgroundRuns = collected.closedBy === undefined;
          if (collected.closedBy) notes.push(handOffClosedNote(collected.closedBy, false));
        } else if (done && row.status === 'agent_end') {
          const since = unixToIso(turnCreatedAt(options, row));
          notes.push('No model runs were found for this turn. If the reply says results will follow later, '
            + `list_studio_results${since ? ` with since "${since}"` : ''} shows the runs Studio starts after this message.`);
        }
      } else if (done) {
        state.runsUnread = true;
      }
    }

    if (projected.workflowReply) {
      const { workflows, listRequest } = projected.workflowReply;
      result.workflows = workflows;
      if (workflows.some(workflow => !workflow.valid)) {
        notes.push('A workflow in this reply is not valid. Send the issues back to the Workflow Agent in the same '
          + 'session and ask it to fix them.');
      }
      if (listRequest) {
        result.workflowList = await listWorkflowsForAgent(client, listRequest, session, options.extra?.signal);
        const rows = result.workflowList.rows;
        // The edit request is the user's own words and the send is a billed
        // turn, so this is said in a note rather than offered as a call.
        if (rows.length > 0 && !workflows.some(workflow => workflow.valid && workflow.artifactHash)) {
          notes.push(workflowChoiceNote(rows, session));
        }
      }
    }

    if (done && row.status === 'agent_error') {
      notes.push('The agent could not finish this turn. Nothing was retried; send the message again if the user wants to.');
    }
  }

  result.nextAction = chooseNextAction(target, result, continueArguments, state, afterSend);
  return result;
}

function chooseNextAction(
  target: AgentTarget,
  result: AgentTurnResult,
  continueArguments: Record<string, unknown>,
  state: TurnState,
  afterSend: boolean,
): NextAction | undefined {
  if (!result.done) {
    if (state.invisible && !afterSend) {
      return {
        tool: 'get_agent_message',
        arguments: { ...continueArguments, wait_seconds: NOT_VISIBLE_RETRY_WAIT_SECONDS },
        reason: 'Wiro does not show this message yet. Call this to wait for it; do not send the message again.'
          + (target.kind === 'workflow-agent'
            ? ' A message sent with another project\'s API key or on wiro.ai cannot be read with this key.'
            : ''),
      };
    }
    return {
      tool: 'get_agent_message',
      arguments: continueArguments,
      reason: state.afterSendFailure || state.invisible
        ? `${target.name} has this message queued. Call this to keep waiting for it; do not send the message again.`
        : `${target.name} is still working. Call this to keep waiting; do not send the message again.`,
    };
  }
  if (result.modelRunsPending) {
    return {
      tool: 'get_agent_message',
      arguments: continueArguments,
      reason: 'Model runs started by this turn are still running. Call this to collect their outputs.',
    };
  }
  const savable = result.workflows?.find(workflow => workflow.valid && workflow.artifactHash);
  if (savable) {
    const attached = result.attachedWorkflow;
    return {
      tool: 'save_workflow_from_agent',
      arguments: {
        session: result.session,
        message_id: result.message.messageId,
        artifact_hash: savable.artifactHash,
        ...(attached ? { workflow: attached.fullSlug, loaded_updatetime: attached.updatetime } : {}),
      },
      reason: attached
        ? `This applies the proposal to "${attached.title ?? attached.fullSlug}". The call first returns a summary of `
          + 'the change and changes the workflow only when repeated with confirm: true, after the user agrees. Leave '
          + 'workflow and loaded_updatetime out to save the proposal as a new workflow instead.'
        : 'Show the user what this workflow does and save it only after they agree; it is saved as a new workflow. '
          + 'If a workflow was attached when this message was sent, pass workflow and loaded_updatetime from that '
          + 'send\'s attachedWorkflow to apply the change to it instead.',
    };
  }
  if (state.runsUnread) {
    return {
      tool: 'get_agent_message',
      arguments: continueArguments,
      reason: 'The model runs of this turn could not be read just now. Call this to read them again; do not send the '
        + 'message again.',
    };
  }
  if (result.background) {
    if (target.kind === 'studio') {
      if (!state.awaitingBackgroundRuns) return undefined;
      return {
        tool: 'get_agent_message',
        arguments: continueArguments,
        reason: 'Studio is working on this in the background and has not started a model run yet. Call this to wait '
          + 'for the runs it starts; list_studio_results lists them too. Do not send the request again.',
      };
    }
    return {
      tool: 'get_agent_conversation',
      arguments: { agent: target.agent, session: result.session, limit: 5 },
      reason: 'The result arrives as a later message in this session.',
    };
  }
  return undefined;
}

// ─── Text ───────────────────────────────────────────────────────────

/**
 * Files to present once the turn is over: every model run output, and the
 * reply's own URLs when they point at a media file rather than a web page.
 * Only files on Wiro's own hosts count; anything else stays a plain link.
 */
export function turnMediaItems(result: AgentTurnResult): MediaItem[] {
  if (!result.done) return [];
  // Run outputs first: they carry a name and type, and duplicates keep the first entry.
  const items: MediaItem[] = (result.modelRuns ?? []).flatMap(run => run.outputs.map(output => ({
    url: output.url,
    ...(output.name ? { name: output.name } : {}),
    ...(output.mimeType ? { mimeType: output.mimeType } : {}),
  })));
  for (const url of result.message.mediaUrls) {
    if (guessMimeType(url) !== undefined) items.push({ url });
  }
  return items.filter(item => isWiroHostedUrl(item.url));
}

/** The tool result content: the text, then the media as resource links. */
export function turnContent(target: AgentTarget, result: AgentTurnResult) {
  return createMediaContent(formatTurn(target, result), turnMediaItems(result));
}

function heading(target: AgentTarget, result: AgentTurnResult): string {
  if (result.message.status === NOT_VISIBLE_STATUS) return '## Message not visible yet';
  if (!result.done) return `## ${target.name} is still working`;
  switch (result.message.state) {
    case 'completed':
      return `## ${target.name} replied`;
    case 'cancelled':
      return '## The turn was cancelled';
    case 'failed':
      return '## The turn failed';
    default:
      return `## ${target.name}: ${result.message.status}`;
  }
}

export function formatTurn(target: AgentTarget, result: AgentTurnResult): string {
  const lines: string[] = [heading(target, result), ''];
  lines.push(`**Agent:** \`${result.agent}\``);
  lines.push(`**Session:** \`${result.session}\``);
  if (result.llmCostUsd !== undefined && result.llmCostUsd !== null && result.llmCostUsd > 0) {
    lines.push(`**Agent usage:** $${result.llmCostUsd}`);
  }
  if (result.modelChange?.toModel) {
    lines.push(`**Model:** switched to \`${result.modelChange.toModel}\` for this session`);
  }
  if (result.attachedWorkflow) {
    const { title, fullSlug } = result.attachedWorkflow;
    lines.push(`**Attached workflow:** ${title ? `${title} (\`${fullSlug}\`)` : `\`${fullSlug}\``}`);
  }
  lines.push(formatAgentMessage(result.message));
  if (result.partialReply) {
    lines.push('', '### Partial reply', '', result.partialReply);
  }
  if (result.modelRuns && result.modelRuns.length > 0) {
    lines.push('', '### Model runs started by this turn', '');
    for (const run of result.modelRuns) lines.push(formatStudioRun(run));
  }
  if (result.workflows && result.workflows.length > 0) {
    lines.push('', '### Workflows in this reply', '');
    for (const workflow of result.workflows) {
      const name = workflow.title ? `**${workflow.title}**` : `Workflow ${workflow.index + 1}`;
      const details = [
        workflow.nodeCount !== undefined ? `${workflow.nodeCount} step${workflow.nodeCount === 1 ? '' : 's'}` : '',
        workflowModelsText(workflow),
      ].filter(Boolean).join(', ');
      const size = details ? ` (${details})` : '';
      lines.push(`- ${name}${size}: ${workflow.valid ? 'valid' : workflow.status}`
        + (workflow.artifactHash ? `, artifact_hash \`${workflow.artifactHash}\`` : ''));
      for (const issue of workflow.issues) lines.push(`  - ${issue}`);
    }
  }
  if (result.workflowList) {
    lines.push('', '### Your workflows', '');
    if (result.workflowList.error) {
      lines.push(`The list could not be loaded: ${result.workflowList.error}`);
    } else if (result.workflowList.rows.length === 0) {
      lines.push('No workflows matched.');
    } else {
      for (const row of result.workflowList.rows) lines.push(`- **${row.title}**: \`${row.fullSlug}\``);
    }
    lines.push('', result.workflowList.instruction);
  }
  if (result.notes.length > 0) {
    lines.push('', '### Notes', '');
    for (const note of result.notes) lines.push(`- ${note}`);
  }
  if (result.nextAction) {
    lines.push('', `**Next:** \`${result.nextAction.tool}\` with \`${JSON.stringify(result.nextAction.arguments)}\`. ${result.nextAction.reason}`);
  }
  return lines.join('\n');
}
