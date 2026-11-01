import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WiroClient } from '../client.js';
import { ApiResultError, errorResult, requireApiSuccess } from '../utils/api.js';
import { DEFAULT_WAIT_SECONDS, MAX_WAIT_SECONDS } from '../utils/poll.js';
import {
  agentStatusLabel,
  agentStatusLabelSchema,
  agentSummarySchema,
  describeAgentStatus,
  isTransitionalStatus,
  MEMBER_SETUP_HELP,
  missingCredentialStep,
  nextStepForAgent,
  readAgentDetail,
  readAgentStatus,
  settledStatusAdvice,
  toAgentDetail,
  toAgentSummary,
  waitForAgentToSettle,
  type AgentDetail,
  type AgentSubscription,
  type NextAction,
} from '../utils/user-agent.js';
import { isPlainTeamMember } from '../utils/workspace.js';
import { nextActionSchema, strictInput } from './schemas.js';

type Outcome = 'requested' | 'not_needed' | 'refused';

interface Decision {
  outcome: Outcome;
  message: string;
  nextAction?: NextAction;
}

/** What a stop means for the agent's plan, as the plan stood before the stop. */
function planAfterStop(plan: AgentSubscription | null): string {
  if (plan?.status !== 'active') return 'The agent has no active plan, so no renewal starts it again.';
  const periodEnd = plan.periodEndsAt ?? 'the current period';
  if (plan.atPeriodEnd === 'ends') {
    return `The plan is already cancelled: it ends after ${periodEnd} and does not renew, so nothing starts the agent `
      + 'again by itself.';
  }
  if (plan.billing === 'wallet' || plan.switchingToWallet) {
    return 'Stopping does not pause the plan: a wallet plan still renews every 30 days and starts the agent again. '
      + 'Cancel it with manage_agent_billing to stop paying.';
  }
  const state = plan.atPeriodEnd === 'renews' ? `renews after ${periodEnd}` : `is paid through ${periodEnd}`;
  return `Stopping does not pause the plan: it is billed by card and ${state}. Card plans are managed in the Wiro dashboard.`;
}

function waitAction(guid: string): NextAction {
  return {
    tool: 'get_my_agent',
    arguments: { agent_guid: guid, wait_seconds: DEFAULT_WAIT_SECONDS },
    reason: 'Wait until the agent has settled. Do not repeat the action that started it.',
  };
}

function setupRefusal(agent: AgentDetail, plainMember = false): Decision {
  if (plainMember) {
    return {
      outcome: 'refused',
      message: `The agent cannot start until it has a paid plan and its setup is finished. ${MEMBER_SETUP_HELP}`,
    };
  }
  if (agent.subscription?.status !== 'active') {
    return {
      outcome: 'refused',
      message: 'The agent has no paid plan, so it cannot start. manage_agent_billing with action subscribe '
        + 'pays for it and starts it.',
      nextAction: {
        tool: 'manage_agent_billing',
        arguments: { agent_guid: agent.guid, action: 'subscribe' },
        reason: 'This returns the price first; nothing is charged without confirm: true.',
      },
    };
  }
  const missing = agent.missingCredentials;
  return {
    outcome: 'refused',
    message: `The agent cannot start until its setup is finished${missing.length > 0 ? `: missing ${missing.map(item => item.title).join(', ')}` : ''}. `
      + 'After the credentials are set, call update_agent with only agent_guid to refresh its setup status, then start it.',
    nextAction: missingCredentialStep(agent) ?? {
      tool: 'update_agent',
      arguments: { agent_guid: agent.guid },
      reason: 'Refresh the setup status so the agent can be started.',
    },
  };
}

/** Turns the known refusals of Start and Stop into advice. Anything else stays an error. */
function interpretRefusal(message: string, agent: AgentDetail): Decision | null {
  if (/subscription required/i.test(message)) {
    const renewable = agent.subscription?.status === 'expired' && agent.subscription.billing === 'wallet';
    return {
      outcome: 'refused',
      message: 'Wiro refused the start: the agent has no active plan and no extra credits left. '
        + (renewable
          ? 'Its wallet plan has expired; manage_agent_billing with action renew restarts it.'
          : 'manage_agent_billing with action subscribe pays for a plan and starts the agent.'),
      nextAction: {
        tool: 'manage_agent_billing',
        arguments: { agent_guid: agent.guid, action: renewable ? 'renew' : 'subscribe' },
        reason: 'This returns the price first; nothing is charged without confirm: true.',
      },
    };
  }
  if (/no credits available/i.test(message)) {
    const pro = agent.tier === 'pro';
    return {
      outcome: 'refused',
      message: 'Wiro refused the start: the agent has used all of its credits for this period. '
        + (pro
          ? 'Buy an extra credit pack, or wait for the plan to renew.'
          : 'Upgrade to Pro for a larger monthly pool (Pro can also buy extra packs), or wait for the plan to renew.'),
      nextAction: {
        tool: 'manage_agent_billing',
        arguments: pro
          ? { agent_guid: agent.guid, action: 'buy_credits', pack: 'small' }
          : { agent_guid: agent.guid, action: 'upgrade_to_pro' },
        reason: 'This returns the price first; nothing is charged without confirm: true.',
      },
    };
  }
  if (/setup is not complete/i.test(message)) return setupRefusal(agent);
  if (/already (queued|running)/i.test(message)) {
    return { outcome: 'not_needed', message: 'The agent is already queued or running.' };
  }
  if (/already stopped/i.test(message)) {
    return { outcome: 'not_needed', message: 'The agent is already stopped.' };
  }
  if (/currently stopping/i.test(message)) {
    return {
      outcome: 'refused',
      message: 'The agent is still stopping. Wait until it has stopped, then start it.',
      nextAction: waitAction(agent.guid),
    };
  }
  if (/error state/i.test(message)) {
    return {
      outcome: 'not_needed',
      message: 'The agent is in the error state and nothing is running. control_agent with action start retries it.',
    };
  }
  return null;
}

export function registerControlAgent(server: McpServer, client: WiroClient): void {
  server.registerTool(
    'control_agent',
    {
      title: 'Start, stop or restart a Wiro agent',
      description: 'Start, stop or restart a deployed agent. Starting needs an active plan or credits left '
        + 'and charges nothing by itself. Stopping does not pause the plan: a wallet plan that is not cancelled '
        + 'still renews every 30 days and starts the agent again, so cancel the plan with manage_agent_billing to '
        + 'stop paying. The result says what happens with this agent\'s plan. '
        + 'A restart reloads the agent with its current settings. The change finishes in the background: pass '
        + 'wait_seconds, or follow the returned nextAction, to see the result. When a start is refused, the '
        + 'result says what to do next (subscribe, renew, buy credits or finish setup). On a team agent this '
        + 'needs a team admin or the person who deployed it; other team members can read the agent with '
        + 'get_my_agent and message it.',
      inputSchema: strictInput({
        agent_guid: z.string().min(1).max(100)
          .describe('The deployed agent\'s guid, from list_my_agents or deploy_agent.'),
        action: z.enum(['start', 'stop', 'restart'])
          .describe('start queues a stopped or failed agent, stop shuts it down, restart reloads a running agent.'),
        wait_seconds: z.number().int().min(0).max(MAX_WAIT_SECONDS).default(0)
          .describe('Wait up to this many seconds for the agent to finish starting or stopping (0 to 600, default 0). 45 or less is safe for clients with a 60 second tool timeout; follow nextAction to keep waiting.'),
      }),
      outputSchema: {
        action: z.enum(['start', 'stop', 'restart']),
        outcome: z.enum(['requested', 'not_needed', 'refused']),
        previousStatus: z.number().int().nullable(),
        previousStatusLabel: agentStatusLabelSchema,
        status: z.number().int().nullable(),
        statusLabel: agentStatusLabelSchema,
        settled: z.boolean(),
        waitedSeconds: z.number().nonnegative().optional(),
        message: z.string(),
        agent: agentSummarySchema,
        nextAction: nextActionSchema.optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ agent_guid, action, wait_seconds }, extra) => {
      try {
        const guid = agent_guid.trim();
        const before = await readAgentDetail(client, guid, extra.signal);
        const previous = readAgentStatus(before);
        const current = toAgentDetail(before);
        const plainMember = await isPlainTeamMember(client, before, extra.signal);

        let call: { path: string; fallback: string } | null = null;
        let decision: Decision | null = null;
        const stillStopping: Decision = {
          outcome: 'refused',
          message: 'The agent is still stopping. If a restart was requested it starts again by itself; otherwise start it once it has stopped.',
          nextAction: waitAction(guid),
        };

        const start = { path: '/UserAgent/Start', fallback: 'The agent could not be started.' };
        if (action === 'start') {
          if (previous === 2 || previous === 3 || previous === 4) {
            decision = { outcome: 'not_needed', message: `The agent is already ${describeAgentStatus(previous).toLowerCase()}.` };
          } else if (previous === 1) {
            decision = stillStopping;
          } else if (previous === 6) {
            decision = setupRefusal(current, plainMember);
          } else {
            call = start;
          }
        } else if (action === 'stop') {
          if (previous === 0) {
            decision = { outcome: 'not_needed', message: 'The agent is already stopped.' };
          } else if (previous === 6) {
            decision = { outcome: 'not_needed', message: 'The agent has never started, so there is nothing to stop.' };
          } else {
            call = { path: '/UserAgent/Stop', fallback: 'The agent could not be stopped.' };
          }
        } else if (previous === 3 || previous === 4) {
          // A restart is an update: updating a starting or running agent stops
          // it and queues it again. Only the outcome is read from the answer;
          // the status shown comes from Detail.
          call = { path: '/UserAgent/Update', fallback: 'The agent could not be restarted.' };
        } else if (previous === 0 || previous === 5) {
          call = start;
        } else if (previous === 2) {
          decision = { outcome: 'not_needed', message: 'The agent is already queued to start.' };
        } else if (previous === 1) {
          decision = stillStopping;
        } else {
          decision = setupRefusal(current, plainMember);
        }

        if (call) {
          try {
            requireApiSuccess(await client.post(call.path, { guid }, extra.signal), call.fallback);
            const label = call.path === '/UserAgent/Start'
              ? 'Start requested. The agent is queued and starts on its own; this can take a while.'
              : call.path === '/UserAgent/Stop'
                ? `Stop requested. ${planAfterStop(current.subscription)}`
                : 'Restart requested. The agent stops and starts again with its current settings.';
            const missing = current.missingCredentials;
            decision = {
              outcome: 'requested',
              message: label + (call.path !== '/UserAgent/Stop' && missing.length > 0
                ? ` Missing credentials: ${missing.map(item => item.title).join(', ')}. Skills that need them fail until they are set.`
                : ''),
            };
          } catch (error) {
            const refusal = error instanceof ApiResultError ? interpretRefusal(error.message, current) : null;
            if (!refusal) throw error;
            decision = refusal;
          }
        }

        const result = decision ?? { outcome: 'not_needed' as const, message: 'Nothing to do.' };
        let after = before;
        let settled = !isTransitionalStatus(previous);
        let waitedSeconds: number | undefined;
        let readFailed = false;
        if (result.outcome === 'requested' || (wait_seconds > 0 && !settled)) {
          try {
            const waited = await waitForAgentToSettle(client, guid, wait_seconds, extra, before);
            after = waited.row;
            settled = waited.settled;
            if (wait_seconds > 0) waitedSeconds = Math.round(waited.elapsedMs / 1000);
            // Without a new read, the row is the one from before the action.
            if (!waited.fresh) readFailed = true;
          } catch (error) {
            if (extra.signal.aborted) throw error;
            // The action itself went through; only the follow-up read failed.
            readFailed = true;
            settled = false;
          }
        }

        const afterView = toAgentDetail(after);
        const status = readFailed ? null : readAgentStatus(after);
        let message = result.message + (readFailed ? ' The new status could not be read; get_my_agent shows it.' : '');
        let nextAction = result.nextAction;
        if (result.outcome === 'requested' || result.outcome === 'not_needed') {
          if (!settled) {
            nextAction = waitAction(guid);
          } else {
            // A stop that ended stopped needs no advice: the status line says so.
            if (waitedSeconds !== undefined && !(action === 'stop' && status === 0)) {
              message += ` ${settledStatusAdvice(status, plainMember)}`;
            }
            nextAction = action === 'stop' ? undefined : nextAction ?? nextStepForAgent(afterView, DEFAULT_WAIT_SECONDS, plainMember);
          }
        }

        return {
          content: [{
            type: 'text' as const,
            text: `## ${action[0].toUpperCase()}${action.slice(1)}: ${result.outcome.replace('_', ' ')}\n\n${message}\n\n`
              + `**Status:** ${describeAgentStatus(previous)} before, ${describeAgentStatus(status)} now.`,
          }],
          structuredContent: {
            action,
            outcome: result.outcome,
            previousStatus: previous,
            previousStatusLabel: agentStatusLabel(previous),
            status,
            statusLabel: agentStatusLabel(status),
            settled,
            ...(waitedSeconds !== undefined ? { waitedSeconds } : {}),
            message,
            agent: readFailed
              ? { ...toAgentSummary(after), status: null, statusLabel: agentStatusLabel(null) }
              : toAgentSummary(after),
            ...(nextAction ? { nextAction } : {}),
          },
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
