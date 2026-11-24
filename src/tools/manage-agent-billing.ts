import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WiroClient } from '../client.js';
import {
  ApiResultError,
  asString,
  errorResult,
  errorText,
  hasErrorCode,
  isPlainObject,
  requireApiSuccess,
  toNumber,
  unixToIso,
  type ApiEnvelope,
} from '../utils/api.js';
import { daysLeftText, readPlanChange, underOneDayLeft, workspaceHint, type PlanChange } from '../utils/agent-config.js';
import { DEFAULT_WAIT_SECONDS } from '../utils/poll.js';
import { isPlainTeamMember, teamAgentBillingRefused } from '../utils/workspace.js';
import {
  AGENT_PLANS,
  AMOUNT_TOLERANCE_USD,
  WALLET_NOT_READ_NOTE,
  agentDashboardUrl,
  agentSummarySchema,
  addFundsText,
  asPlan,
  balanceShortfall,
  cardPlanOnceMoreNote,
  centsToUsd,
  comparePlans,
  formatAgentSummaryLines,
  formatUsd,
  isTransitionalStatus,
  isUnsettledPlan,
  isWalletNotRead,
  outcomeUnknown,
  planBalanceName,
  planLineText,
  planName,
  readAgentDetail,
  renewalMoment,
  roundUsd,
  sameAmount,
  shortBalanceNote,
  toAgentDetail,
  toAgentSummary,
  toPlanPricing,
  unsettledPlanText,
  type AgentDetail,
  type AgentPlan,
  type AgentSummary,
  type NextAction,
  type PlanPrice,
} from '../utils/user-agent.js';
import { nextActionSchema, strictInput } from './schemas.js';

// buy_credits is retired with the extra credit packs: it is still answered, and charges nothing.
const ACTIONS = ['subscribe', 'change_plan', 'cancel', 'renew', 'buy_credits'] as const;
type BillingAction = typeof ACTIONS[number];
type PaidFrom = 'personal_wallet' | 'team_wallet' | 'card';
type Outcome = 'quote' | 'done' | 'not_needed' | 'refused';

const quoteSchema = z.object({
  chargeNowUsd: z.number().nullable(),
  estimated: z.boolean(),
  maxChargeUsd: z.number().optional(),
  recurringUsd: z.number().nullable().optional(),
  includedUsageUsd: z.number().nullable().optional()
    .describe('The AI usage the plan includes each month, in USD, from every renewal.'),
  includedUsageNowUsd: z.number().optional()
    .describe('change_plan to a larger plan: the included AI usage this period gains now, in USD. includedUsageUsd is what every renewal includes.'),
  paidFrom: z.enum(['personal_wallet', 'team_wallet', 'card']),
  plan: z.enum(AGENT_PLANS).optional()
    .describe('subscribe and change_plan: the plan this quote is for. renew: the plan it renews on.'),
  change: z.enum(['upgrade', 'downgrade', 'undo_downgrade']).optional()
    .describe('change_plan: upgrade (a larger plan, now), downgrade (a smaller plan, from the next renewal) or undo_downgrade (keep the plan, and undo the move set for the next renewal).'),
  startsAt: z.string().optional()
    .describe('change_plan to a smaller plan: when the period ends, as Wiro shows it (never a moment gone by); the new plan starts with the renewal after it.'),
});

type Quote = z.infer<typeof quoteSchema>;

const resultSchema = z.object({
  chargedUsd: z.number().nullable().optional(),
  monthlyPriceUsd: z.number().optional(),
  includedUsageUsd: z.number().optional()
    .describe('The AI usage the plan includes each month, in USD, from every renewal.'),
  includedUsageNowUsd: z.number().optional()
    .describe('change_plan to a larger plan: the included AI usage this period gained with it, in USD.'),
  plan: z.string().optional(),
  previousPlan: z.string().optional(),
  nextPlan: z.string().nullable().optional()
    .describe('change_plan: the plan set for the next renewal, or null when none is.'),
  change: z.enum(['upgrade', 'downgrade', 'undo_downgrade']).optional(),
  startsAt: z.string().optional(),
  cancelsAt: z.string().optional(),
  renewal: z.enum(['undo_cancel', 'renewed']).optional(),
});

type Result = z.infer<typeof resultSchema>;

interface Performed {
  outcome: 'done' | 'refused';
  message: string;
  result?: Result;
  nextAction?: NextAction;
}

interface Plan {
  outcome: 'quote' | 'not_needed' | 'refused';
  /** Replaces the outcome's usual heading when that heading would misdescribe the answer. */
  heading?: string;
  message: string;
  quote?: Quote;
  nextAction?: NextAction;
  confirmReason?: string;
  perform?: (signal: AbortSignal) => Promise<Performed>;
  /** After it was performed: a sentence when the agent read again does not show the change yet. */
  verify?: (after: AgentSummary) => string | null;
}

type BillingEnvelope = ApiEnvelope & Record<string, unknown>;

const CHARGE_REASON = 'Ask the user to approve this charge first.';

function billingCall(guid: string, action: string, extra: Record<string, unknown> = {}): NextAction {
  return {
    tool: 'manage_agent_billing',
    arguments: { agent_guid: guid, action, ...extra },
    reason: 'This returns the price first; nothing is charged without confirm: true.',
  };
}

function waitAction(guid: string, reason: string): NextAction {
  return {
    tool: 'get_my_agent',
    arguments: { agent_guid: guid, wait_seconds: DEFAULT_WAIT_SECONDS },
    reason,
  };
}

/**
 * The wait after a plan change or a renewal, which keep a running agent up:
 * only an agent on its way, one that was stopping (it starts again) or one queued
 * or starting, is worth waiting for.
 */
function waitIfStarting(agent: Pick<AgentDetail, 'guid' | 'status'>): NextAction | undefined {
  return isTransitionalStatus(agent.status)
    ? waitAction(agent.guid, 'Wait until the agent is running.')
    : undefined;
}

/** After a renewal, Wiro queues a stopped or failed agent; a running one keeps running. */
function renewWait(agent: Pick<AgentDetail, 'guid' | 'status'>): NextAction | undefined {
  if (agent.status === 0 || agent.status === 5) return waitAction(agent.guid, 'Wait until the agent is running again.');
  return waitIfStarting(agent);
}

/**
 * A new plan queues a stopped or failed agent, and one waiting for setup; a
 * running one keeps running, and one that was stopping starts again.
 */
function subscribeStarts(status: number | null): boolean {
  return status !== 4;
}

function subscribeQuoteNote(status: number | null): string {
  switch (status) {
    case 4:
      return 'The agent keeps running: a new plan does not restart it.';
    case 3:
      return 'The agent is starting, and a new plan does not restart it.';
    case 1:
      return 'The agent is stopping, and it starts again right after the payment.';
    case 2:
      return 'The agent is already queued to start.';
    default:
      return 'The agent is queued to start right after the payment.';
  }
}

function subscribeWait(agent: Pick<AgentDetail, 'guid' | 'status'>): NextAction | undefined {
  return subscribeStarts(agent.status) ? waitAction(agent.guid, 'Wait until the agent is running.') : undefined;
}

/**
 * What a move to a larger plan does to this period's included AI usage, in USD. An amount above the new plan's is
 * cut to it for the time left.
 */
function upgradeUsageText(nowUsd: number, renewal: string, done: boolean): string {
  if (nowUsd > 0) {
    return `${formatUsd(nowUsd)} of AI usage ${done ? 'came with it' : 'comes now'} for the rest of this period${renewal}. `;
  }
  if (nowUsd < 0) return `This period ${done ? 'lost' : 'loses'} ${formatUsd(-nowUsd)} of included AI usage for the time left${renewal}. `;
  return `This period ${done ? 'kept' : 'keeps'} the AI usage it ${done ? 'included' : 'includes'}${renewal}. `;
}

/** What a change to the plan does to the agent: a running one keeps running, and one that was stopping starts again. */
function planChangeAgentNote(status: number | null, what: string, quote = false): string {
  switch (status) {
    case 4:
      return `The agent keeps running: ${what} does not restart it.`;
    case 3:
      return `The agent is starting, and ${what} does not restart it.`;
    case 1:
      return quote
        ? 'The agent is stopping; if it is still stopping when the payment goes through, it starts again.'
        : 'The agent was stopping, and it starts again.';
    case 2:
      return 'The agent is queued to start.';
    case 6:
      return 'The agent still needs setup; the included AI usage is there once it starts.';
    case 0:
      return 'The agent is stopped; the included AI usage is there when it starts.';
    case 5:
      return 'The agent stopped with an error; the included AI usage is there when it starts.';
    default:
      return 'The included AI usage is there when the agent starts.';
  }
}

interface PlanPreview {
  price: PlanPrice | null;
  change: PlanChange | null;
}

/**
 * The price of the plan asked for and what moving to it does today, as Wiro works it out on the plan the
 * agent has now. null when it cannot be read, or when the answer is for another plan: the quote then falls
 * back to the plan's price the agent shows and to the most the move can charge.
 */
async function readPlanPreview(client: WiroClient, guid: string, plan: AgentPlan, signal: AbortSignal): Promise<PlanPreview | null> {
  try {
    const body = requireApiSuccess(
      await client.post<BillingEnvelope>('/UserAgent/PricingPreview', { useragentguid: guid, tier: plan }, signal),
      `The ${planName(plan)} price could not be read.`,
    );
    const priced = asString(body.tier);
    if (priced !== undefined && priced !== plan) return null;
    const priceUsd = toNumber(body.totalPriceUsd);
    return {
      price: priceUsd !== null ? { priceUsd, includedUsageUsd: toPlanPricing(body)?.[plan]?.includedUsageUsd ?? priceUsd } : null,
      change: readPlanChange(body.planChange),
    };
  } catch (error) {
    if (signal.aborted) throw error;
    return null;
  }
}

/** A plan's price as said in a sentence: "$30.00 every 30 days, including $30.00 of AI usage a month". */
function planTerms(price: PlanPrice): string {
  return `${formatUsd(price.priceUsd)} every 30 days, including ${formatUsd(price.includedUsageUsd)} of AI usage a month`;
}

/**
 * What the next renewal charges and grants: the plan set for it, or the agent's own plan, at today's price.
 * null when the plans' prices cannot be read.
 */
function renewalPlanPrice(agent: Pick<AgentDetail, 'tier' | 'nextPlan' | 'pricing'>): PlanPrice | null {
  const key = asPlan(agent.nextPlan) ?? asPlan(agent.tier);
  return key ? agent.pricing?.[key] ?? null : null;
}

/**
 * What the wallet paid for a plan, as Wiro answers it (chargedUsd), with the plan's price when a discount on the
 * account took the charge below it. Without that answer, the plan's price.
 */
function walletPaid(body: Record<string, unknown>, priceUsd: number): { chargedUsd: number; text: string } {
  const chargedUsd = toNumber(body.chargedUsd) ?? priceUsd;
  const discounted = chargedUsd < priceUsd && !sameAmount(chargedUsd, priceUsd);
  return { chargedUsd, text: `${formatUsd(chargedUsd)}${discounted ? ` (the ${formatUsd(priceUsd)} price after a discount)` : ''}` };
}

/** The amount a confirmed call charges now, or at most when that is worked out only then; null when it charges nothing. */
function chargeOf(quote: Quote | undefined): number | null {
  const amount = quote?.chargeNowUsd ?? quote?.maxChargeUsd ?? null;
  return amount !== null && amount > 0 ? amount : null;
}

/** A move to a larger plan is approved at the most it can charge, a ceiling; every other charge at its exact amount. */
function approvedAsCeiling(action: BillingAction, quote: Quote | undefined): boolean {
  return action === 'change_plan' && quote?.change === 'upgrade';
}

/**
 * The amount the user approves with confirm_charge_usd, or null when the
 * call charges nothing. A move to a larger plan is approved at the most it can
 * charge: the amount Wiro works out for a wallet plan, which only shrinks as the
 * period runs on, or the full price difference when Wiro works the amount out
 * only at the change.
 */
function approvalAmountOf(action: BillingAction, quote: Quote | undefined): number | null {
  if (!approvedAsCeiling(action, quote)) return chargeOf(quote);
  const max = quote?.maxChargeUsd ?? null;
  return max !== null && max > 0 ? max : null;
}

/**
 * Why a confirmed call may not charge yet: the approved amount is missing,
 * or the fresh quote no longer matches it. For a move to a larger plan the
 * approved amount is a ceiling.
 */
function approvalProblem(action: BillingAction, quote: Quote | undefined, approved: number | undefined): 'missing' | 'changed' | null {
  const amount = approvalAmountOf(action, quote);
  if (amount === null) return null;
  if (approved === undefined) return 'missing';
  const fits = approvedAsCeiling(action, quote)
    ? amount <= approved + AMOUNT_TOLERANCE_USD
    : sameAmount(amount, approved);
  return fits ? null : 'changed';
}

/** The first lines of a new quote when the approved amount no longer fits. */
function changedLead(action: BillingAction, quote: Quote | undefined, amount: number | null, approved: number | undefined): string {
  if (approvedAsCeiling(action, quote)) {
    return `The most this plan change can charge changed since the quote: it is now ${formatUsd(amount)}, and the user approved at most ${formatUsd(approved)}. Nothing was charged. Show the new amount to the user and ask again.`;
  }
  return `The amount changed since the quote: it is now ${formatUsd(amount)}, and the user approved ${formatUsd(approved)}. Nothing was charged. Show the new amount to the user and ask again.`;
}

/** The answer to buy_credits, which charges nothing: the packs are retired, and the balance pays after the plan. */
function packsRetiredText(agent: Pick<AgentDetail, 'workspace'>): string {
  const balance = agent.workspace === 'team' ? 'the team\'s Wiro balance' : 'your Wiro balance';
  return 'Extra credit packs are retired, and nothing was charged. The agent uses the AI usage its plan includes '
    + `first, then ${balance}. To keep it running after the included usage, add funds to that balance on wiro.ai. `
    + `${addFundsText(agent.workspace)} A larger plan includes more AI usage each month: action change_plan quotes a move.`;
}

/** The plans with their prices, for a call that did not name one, and the plan the agent is on. */
function plansListing(agent: AgentDetail): string {
  const listed = agent.pricing ? planLineText(agent.pricing) : '';
  const on = agent.tier ? ` The agent is on ${planName(agent.tier)}.` : '';
  return listed
    ? `Choose a plan: ${listed}.${on} A move to a larger plan starts now; a move to a smaller one starts at the next renewal.`
    : `Choose a plan: starter, pro or max.${on} The plans' prices could not be read just now.`;
}

async function planFor(
  client: WiroClient,
  action: BillingAction,
  agent: AgentDetail,
  raw: Record<string, unknown> | null,
  input: { plan?: AgentPlan },
  signal: AbortSignal,
): Promise<Plan> {
  const guid = agent.guid;
  const active = raw?.status === 'active';
  const prepaid = raw?.provider === 'prepaid';
  const cancelled = raw?.pendingdowngrade === 'cancel';
  // Agent plans are paid only from the Wiro balance of the agent's workspace: every new charge and every
  // renewal. A card plan from before that is paid by card through its period, then moves to the balance; one
  // whose period ends within 7 days after Wiro's email announcing the move renews once more by card first.
  const paidFrom: PaidFrom = agent.workspace === 'team' ? 'team_wallet' : 'personal_wallet';
  const balance = planBalanceName(agent.workspace);
  // When the active plan renews or ends, as Wiro shows it: its period end, or now once a renewal is due (a wallet
  // plan whose balance cannot pay it stays active while Wiro tries again), never a moment gone by.
  const periodEnd = renewalMoment(agent.subscription) ?? 'the end of the current period';
  // An answer with a card checkout link instead of the change, which an older Wiro gave for a card plan. No
  // checkout is opened here.
  const checkoutAnswer = (what: string) => `Wiro did not ${what}: it answered with a card checkout, which is not opened `
    + `here, and nothing was charged. Agent plans are paid from ${balance}; get_my_agent shows the plan as it is now.`;
  // A plan that has not ended and is not active, such as a card plan whose last payment did not go through
  // (past_due, then unpaid). Wiro counts every status but expired, cancelled and refunded as a plan that has
  // not ended: it starts no new plan beside one, and renews, changes, cancels and tops up only an active plan.
  // lead says what this action cannot do; null for any other plan.
  const unsettled = (lead: string): string | null => (agent.subscription && isUnsettledPlan(agent.subscription)
    ? unsettledPlanText(agent.subscription, agent, lead)
    : null);

  switch (action) {
    case 'subscribe': {
      if (active) {
        return {
          outcome: 'refused',
          message: 'This agent already has an active plan. Use renew to undo a cancellation, or change_plan to move to another plan; a larger plan includes more AI usage each month.',
        };
      }
      // Its payment is fixed instead: a second plan would bill beside it.
      const open = unsettled('A new plan is not started beside it, since both would bill. Nothing was charged.');
      if (open) return { outcome: 'refused', message: open };
      const plan = input.plan ?? asPlan(agent.tier) ?? 'starter';
      const price = agent.pricing?.[plan];
      if (!price) throw new Error(`The ${planName(plan)} plan cannot be priced right now, so the agent cannot be subscribed. Try again later.`);
      const missing = agent.missingCredentials;
      return {
        outcome: 'quote',
        quote: {
          chargeNowUsd: price.priceUsd,
          estimated: false,
          recurringUsd: price.priceUsd,
          includedUsageUsd: price.includedUsageUsd,
          paidFrom,
          plan,
        },
        message: `Subscribe on ${planName(plan)}: ${formatUsd(price.priceUsd)} now, paid from ${balance}, then every 30 days until the plan is cancelled. It includes ${formatUsd(price.includedUsageUsd)} of AI usage a month; after it, the agent uses the same balance. `
          + subscribeQuoteNote(agent.status)
          + (missing.length > 0
            ? ` Missing credentials (${missing.map(item => item.title).join(', ')}) can be added afterwards; until then the skills that need them fail.`
            : ''),
        perform: async signal => {
          const body = requireApiSuccess(
            await client.post<BillingEnvelope>('/UserAgent/CreateSubscriptionCheckout', {
              useragentguid: guid,
              useprepaid: true,
              tier: plan,
            }, signal),
            'The plan could not be started.',
          );
          const monthly = toNumber(body.monthlypriceusd) ?? price.priceUsd;
          const paid = walletPaid(body, monthly);
          return {
            outcome: 'done',
            message: `Subscribed on ${planName(plan)} and charged ${paid.text} from ${balance}. The plan renews from it every 30 days until it is cancelled. `
              + (subscribeStarts(agent.status) ? 'The agent is starting.' : 'The agent keeps running: a new plan does not restart it.'),
            result: { chargedUsd: paid.chargedUsd, monthlyPriceUsd: monthly, includedUsageUsd: price.includedUsageUsd, plan },
            nextAction: subscribeWait(agent),
          };
        },
      };
    }

    case 'renew': {
      if (!raw) {
        return {
          outcome: 'refused',
          message: 'This agent has never had a plan. Use action subscribe.',
          nextAction: billingCall(guid, 'subscribe'),
        };
      }
      if (active) {
        // A card plan is not renewed by card any more: at its period end it moves to the balance by itself (one
        // whose period ends within 7 days after the email announcing the move renews once more by card first),
        // and one that was cancelled moves there when the cancellation is undone.
        const ends = cancelled || agent.subscription?.atPeriodEnd === 'ends';
        if (!ends) {
          return {
            outcome: 'not_needed',
            message: prepaid
              ? 'The plan is active and renews by itself. Nothing to do.'
              : `This plan is paid by card through ${periodEnd}. Then it moves to ${balance} and renews from it every 30 days by itself.`
                + `${cardPlanOnceMoreNote(agent.subscription)} Nothing to do.`,
          };
        }
        // A renewal charges the plan set for it, or the agent's own, at today's price. A wallet cancel keeps a
        // move set for the renewal, so the plan is named: it can be another plan than the agent's.
        const next = renewalPlanPrice(agent);
        const renewsOn = asPlan(agent.nextPlan) ?? asPlan(agent.tier);
        const amount = next?.priceUsd ?? (agent.monthlyPriceUsd || agent.subscription?.amountUsd);
        return {
          outcome: 'quote',
          quote: {
            chargeNowUsd: 0,
            estimated: false,
            recurringUsd: amount,
            includedUsageUsd: next?.includedUsageUsd ?? agent.usage.renewalUsd ?? agent.usage.includedUsd,
            paidFrom,
            ...(renewsOn ? { plan: renewsOn } : {}),
          },
          message: `Undo the cancellation: nothing is charged now.${prepaid ? '' : ` The plan stays paid by card through ${periodEnd}.`} `
            + `The plan then renews${renewsOn ? ` on ${planName(renewsOn)}` : ''} for ${formatUsd(amount)} after ${periodEnd} and every 30 days after that until it is cancelled, paid from ${balance}.`,
          confirmReason: 'Ask the user to confirm first: the plan will charge the Wiro balance again at each renewal.',
          perform: async signal => {
            requireApiSuccess(
              await client.post<BillingEnvelope>('/UserAgent/RenewSubscription', { guid }, signal),
              'The cancellation could not be undone.',
            );
            return {
              outcome: 'done',
              message: prepaid
                ? 'The cancellation was undone. The plan keeps renewing every 30 days.'
                : `The cancellation was undone. The plan is paid by card through ${periodEnd}, then renews from ${balance} every 30 days.`,
              result: { chargedUsd: 0, renewal: 'undo_cancel' },
            };
          },
        };
      }
      const open = unsettled('Action renew brings back only a plan that has ended.');
      if (open) return { outcome: 'refused', message: open };
      if (raw.status !== 'expired') {
        return {
          outcome: 'refused',
          message: `The last plan is ${String(raw.status)}. Use action subscribe to start a new one.`,
          nextAction: billingCall(guid, 'subscribe'),
        };
      }
      // A plan that ended by card starts again from the balance too.
      const own = agent.monthlyPriceUsd ?? toNumber(raw.amount);
      const planKey = asPlan(agent.nextPlan) ?? asPlan(agent.tier);
      // A renewal charges the plan set for it, or the agent's own, at its price today, which can differ
      // from the price the plan ended at.
      const today = renewalPlanPrice(agent);
      const earlier = today && own && own > 0 && !sameAmount(today.priceUsd, own)
        ? ` The plan ended at ${formatUsd(own)} a month; it renews at the ${planName(planKey)} price today, including ${formatUsd(today.includedUsageUsd)} of AI usage a month.`
        : '';
      const price = today?.priceUsd ?? own;
      if (!price || price <= 0) {
        return {
          outcome: 'refused',
          message: 'The renewal price of this plan is unknown. Use action subscribe to start a new plan.',
          nextAction: billingCall(guid, 'subscribe'),
        };
      }
      return {
        outcome: 'quote',
        quote: {
          chargeNowUsd: price,
          estimated: false,
          recurringUsd: price,
          includedUsageUsd: today?.includedUsageUsd ?? null,
          paidFrom,
          ...(planKey ? { plan: planKey } : {}),
        },
        message: `Renew the expired plan${planKey ? ` on ${planName(planKey)}` : ''}: ${formatUsd(price)} now, paid from ${balance}, then every 30 days until it is cancelled.${earlier} A stopped or failed agent is queued to start again.`,
        perform: async signal => {
          const body = requireApiSuccess(
            await client.post<BillingEnvelope>('/UserAgent/RenewSubscription', { guid }, signal),
            'The plan could not be renewed.',
          );
          const monthly = toNumber(body.amount) ?? price;
          const paid = walletPaid(body, monthly);
          // The plan it renewed on, which the wallet line names too.
          const renewedOn = asPlan(body.tier) ?? planKey;
          const included = renewedOn ? agent.pricing?.[renewedOn]?.includedUsageUsd : undefined;
          return {
            outcome: 'done',
            message: `Renewed${renewedOn ? ` on ${planName(renewedOn)}` : ''} and charged ${paid.text} from ${balance}. The plan renews from it every 30 days until it is cancelled.`,
            result: {
              chargedUsd: paid.chargedUsd,
              monthlyPriceUsd: monthly,
              ...(included !== undefined ? { includedUsageUsd: included } : {}),
              ...(renewedOn ? { plan: renewedOn } : {}),
              renewal: 'renewed',
            },
            nextAction: renewWait(agent),
          };
        },
      };
    }

    case 'cancel': {
      if (!active) {
        const open = unsettled('Only an active plan is cancelled here.');
        return open ? { outcome: 'refused', message: open } : { outcome: 'not_needed', message: 'There is no active plan to cancel.' };
      }
      // A move set for the next renewal. A card plan's cancel drops it. A wallet cancel keeps it: an undo
      // renews on it, and the plan's end shows the plan on it, so renew brings it back there.
      const moveSet = asPlan(agent.nextPlan) && agent.nextPlan !== agent.tier ? agent.nextPlan : null;
      const dropsMove = moveSet ? ` The move to ${planName(moveSet)} set for the next renewal is dropped with it.` : '';
      const keepsMove = moveSet
        ? ` The move to ${planName(moveSet)} set for the next renewal stays: if the cancellation is undone, the plan renews on ${planName(moveSet)}, and once it has ended, action renew brings it back on ${planName(moveSet)}.`
        : '';
      const performCancel = async (signal: AbortSignal): Promise<Performed> => {
        const body = requireApiSuccess(
          await client.post<BillingEnvelope>('/UserAgent/CancelSubscription', { guid }, signal),
          'The plan could not be cancelled.',
        );
        const cancelsAt = unixToIso(body.cancelsAt);
        return {
          outcome: 'done',
          message: `The plan is cancelled and stops renewing${cancelsAt ? ` after ${cancelsAt}` : ''}. Nothing was refunded.`,
          result: { chargedUsd: 0, ...(cancelsAt ? { cancelsAt } : {}) },
        };
      };
      if (!prepaid) {
        // A card plan, its owner's or (on a team agent) a billing admin's to cancel: it ends with its period and
        // no longer moves to the balance; renew undoes that before then.
        if (cancelled || agent.subscription?.cancelAtPeriodEnd) {
          return { outcome: 'not_needed', message: `The plan is already set to end after ${periodEnd}.` };
        }
        return {
          outcome: 'quote',
          quote: { chargeNowUsd: 0, estimated: false, paidFrom: 'card' },
          message: `Cancel the card plan at the end of its period (${periodEnd}): nothing is charged or refunded, and `
            + `it does not move to ${balance}. The agent keeps working until then, then stops. Action renew undoes the `
            + `cancellation before then.${dropsMove}`,
          confirmReason: 'Ask the user to confirm the cancellation first.',
          perform: performCancel,
        };
      }
      if (cancelled) {
        return { outcome: 'not_needed', message: `The plan is already cancelled and ends after ${periodEnd}.` };
      }
      return {
        outcome: 'quote',
        quote: { chargeNowUsd: 0, estimated: false, paidFrom },
        // Wiro ends a cancelled wallet plan at its period end, on its first check after it.
        message: `Cancel the plan: nothing is refunded and it stops renewing. The agent keeps its plan and the AI usage it includes until ${periodEnd}; then the plan ends and the agent stops. Action renew undoes the cancellation before then.${keepsMove}`,
        confirmReason: 'Ask the user to confirm the cancellation first.',
        perform: performCancel,
      };
    }

    case 'change_plan': {
      if (!input.plan) {
        const larger = AGENT_PLANS.find(plan => {
          const current = asPlan(agent.tier);
          return current ? comparePlans(plan, current) > 0 : false;
        });
        return {
          outcome: 'refused',
          ...(agent.pricing ? { heading: 'Plans' } : {}),
          message: plansListing(agent),
          ...(active && larger ? { nextAction: billingCall(guid, 'change_plan', { plan: larger }) } : {}),
        };
      }
      const target = input.plan;
      const current = asPlan(agent.tier);
      if (!active) {
        const open = unsettled('A plan change needs an active plan.');
        if (open) return { outcome: 'refused', message: open };
        // A plan that ended, by card or from the wallet, comes back from the balance with renew on the plan set
        // for its renewal, else on its own plan, so renew answers a target that is that plan; any other target
        // takes a new plan. When the plan ends, Wiro writes that plan on the agent: the one set for its renewal,
        // else the one nearest its last price.
        const renewsOn = asPlan(agent.nextPlan) ?? current;
        if (renewsOn === target && raw?.status === 'expired') {
          return {
            outcome: 'refused',
            message: renewsOn === current
              ? `This agent is already on ${planName(target)}, and its plan has ended. Action renew brings the plan back; subscribe starts a new plan.`
              : `This agent's plan has ended, and action renew brings it back on ${planName(target)}, the plan set for its renewal; subscribe starts a new plan.`,
            nextAction: billingCall(guid, 'renew'),
          };
        }
        return {
          outcome: 'refused',
          message: `Changing the plan needs an active plan. Use action subscribe with plan ${target} instead.`,
          nextAction: billingCall(guid, 'subscribe', { plan: target }),
        };
      }
      if (!current) throw new Error('The agent\'s plan could not be read, so it cannot be changed right now. Try again later.');
      const next = asPlan(agent.nextPlan) ?? null;
      const renewsAt = renewalMoment(agent.subscription);
      const when = renewsAt ? `the renewal after ${renewsAt}` : 'the next renewal';
      const move = comparePlans(target, current);

      if (move === 0) {
        if (!next || next === current) {
          return {
            outcome: 'not_needed',
            message: next === current
              ? `The agent is already on ${planName(current)}. From ${when} it is billed at today's ${planName(current)} price${agent.pricing?.[current] ? `, ${planTerms(agent.pricing[current] as PlanPrice)}` : ''}. Nothing to do.`
              : `The agent is already on ${planName(current)}. Nothing to do.`,
          };
        }
        // A move to another plan is set for the next renewal: keeping this one undoes it.
        const keep = agent.pricing?.[current];
        return {
          outcome: 'quote',
          quote: {
            chargeNowUsd: 0,
            estimated: false,
            recurringUsd: keep?.priceUsd ?? null,
            includedUsageUsd: keep?.includedUsageUsd ?? null,
            paidFrom,
            plan: current,
            change: 'undo_downgrade',
          },
          message: `Keep ${planName(current)}: the move to ${planName(next)} set for ${when} is undone, and nothing is charged now. `
            + `The plan then renews on ${planName(current)}${keep ? ` at ${planTerms(keep)}` : ''}.`,
          confirmReason: 'Ask the user to confirm first: the plan then keeps renewing on its current plan.',
          perform: async signal => {
            const body = requireApiSuccess(
              await client.post<BillingEnvelope>('/UserAgent/UpgradeTier', { guid, targetTier: current }, signal),
              'The move set for the next renewal could not be undone.',
            );
            if (asString(body.url)) return { outcome: 'refused', message: checkoutAnswer(`keep the plan on ${planName(current)}`) };
            // An agent on a price from before the plans keeps its plan with that plan set for its renewal, so
            // the renewal bills the plan's own price.
            if (asPlan(body.nextplan) === current) {
              const at = unixToIso(body.startsAt ?? body.periodEnd) ?? renewsAt;
              const priceUsd = toNumber(body.newPriceUsd) ?? keep?.priceUsd;
              const terms = priceUsd !== undefined ? `, ${planTerms({ priceUsd, includedUsageUsd: keep?.includedUsageUsd ?? priceUsd })}` : '';
              return {
                outcome: 'done',
                message: `The move to ${planName(next)} is undone. The agent stays on ${planName(current)}, and nothing was charged. `
                  + `It renews at the ${planName(current)} price ${at ? `from ${at}` : 'from the next renewal'}${terms}.`,
                result: { chargedUsd: 0, plan: current, nextPlan: current, change: 'undo_downgrade', ...(at ? { startsAt: at } : {}) },
              };
            }
            return {
              outcome: 'done',
              message: `The move to ${planName(next)} is undone. The agent stays on ${planName(current)}, and nothing was charged.`,
              result: { chargedUsd: 0, plan: current, nextPlan: null, change: 'undo_downgrade' },
            };
          },
          // Nothing set, or the agent's own plan at its price today, is the move undone.
          verify: after => (after.nextPlan && after.nextPlan !== current
            ? 'get_my_agent still shows the move set for the next renewal; check it again in a minute.'
            : null),
        };
      }

      if (move > 0) {
        const preview = await readPlanPreview(client, guid, target, signal);
        const targetPrice = preview?.price ?? agent.pricing?.[target];
        if (!targetPrice) throw new Error(`The ${planName(target)} price of this agent is not available right now. Try again later.`);
        const ending = `The plan is cancelled, so it ends at ${periodEnd} and does not renew on ${planName(target)}; this charge covers only the time left. To keep the plan, undo the cancellation first with action renew.`;
        const currentPrice = agent.monthlyPriceUsd || agent.subscription?.amountUsd || 0;
        const fullDifference = roundUsd(Math.max(0, targetPrice.priceUsd - currentPrice));
        // A wallet plan pays the amount Wiro works out on it now. A card plan is charged from the balance for
        // the time left of its card period, which Wiro works out at the change.
        const change = preview?.change?.wallet ? preview.change : null;
        const exact = change?.chargeNowUsd ?? null;
        const renewalUsd = change?.includedFromRenewalUsd ?? targetPrice.includedUsageUsd;
        const nowUsd = change?.includedNowUsd ?? null;
        const days = daysLeftText(change?.secondsLeft ?? null);
        const undoes = next && next !== current ? ` This also undoes the move to ${planName(next)} set for the next renewal.` : '';
        const money = exact !== null
          ? `Move to ${planName(target)}: ${formatUsd(exact)} now, paid from ${balance}, for the rest of this period`
            + `${exact > 0 && underOneDayLeft(change?.secondsLeft ?? null) ? ', at the one-day minimum' : days ? ` (${days})` : ''}. `
          : `Move to ${planName(target)}: the difference for the rest of this period is paid from ${balance} now. Wiro works it out from the time left when the plan changes, and it is never more than ${formatUsd(fullDifference)}, so that is the amount to approve. `;
        const usage = nowUsd !== null
          ? upgradeUsageText(nowUsd, cancelled ? '' : `, and every renewal includes ${formatUsd(renewalUsd)}`, false)
          : `The added AI usage comes for the time left in this period${cancelled ? '' : `, and every renewal includes ${formatUsd(renewalUsd)}`}. `;
        return {
          outcome: 'quote',
          quote: {
            chargeNowUsd: exact,
            estimated: exact === null,
            maxChargeUsd: exact ?? fullDifference,
            recurringUsd: cancelled ? null : targetPrice.priceUsd,
            includedUsageUsd: renewalUsd,
            ...(nowUsd !== null ? { includedUsageNowUsd: nowUsd } : {}),
            paidFrom,
            plan: target,
            change: 'upgrade',
          },
          message: money + usage
            + (cancelled ? `${ending} ` : `From the next renewal the plan costs ${formatUsd(targetPrice.priceUsd)} every 30 days. `)
            + `${planChangeAgentNote(agent.status, 'the plan change', true)}${undoes} A move to a smaller plan later starts at the renewal after it is asked for, with nothing refunded.`,
          perform: async signal => {
            const body = requireApiSuccess(
              await client.post<BillingEnvelope>('/UserAgent/UpgradeTier', { guid, targetTier: target }, signal),
              'The plan could not be changed.',
            );
            if (asString(body.url)) return { outcome: 'refused', message: checkoutAnswer(`move the plan to ${planName(target)}`) };
            const charged = toNumber(body.proratedCharge) ?? toNumber(body.chargedUsd);
            const newPrice = toNumber(body.newPriceUsd) ?? targetPrice.priceUsd;
            // Wiro answers the included usage in hundredths of a dollar.
            const fromRenewalCents = toNumber(body.creditsFromRenewal) ?? toNumber(body.newMonthlyCredits);
            const fromRenewal = fromRenewalCents !== null ? centsToUsd(fromRenewalCents) : renewalUsd;
            const cameCents = toNumber(body.creditsNow);
            const came = cameCents !== null ? centsToUsd(cameCents) : null;
            const previous = asString(body.previousTier);
            return {
              outcome: 'done',
              message: `Moved to ${planName(target)} and charged ${formatUsd(charged ?? 0)} from ${balance}. `
                + (came !== null
                  ? upgradeUsageText(came, cancelled ? '' : `, and every renewal includes ${formatUsd(fromRenewal)}`, true)
                  : '')
                + (cancelled
                  ? `The plan is still cancelled and ends at ${periodEnd}; action renew undoes the cancellation. `
                  : `The plan now costs ${formatUsd(newPrice)} every 30 days. `)
                + planChangeAgentNote(agent.status, 'the plan change'),
              result: {
                chargedUsd: charged,
                monthlyPriceUsd: newPrice,
                includedUsageUsd: fromRenewal,
                ...(came !== null ? { includedUsageNowUsd: came } : {}),
                plan: target,
                ...(previous ? { previousPlan: previous } : {}),
                change: 'upgrade',
              },
              nextAction: waitIfStarting(agent),
            };
          },
          verify: after => (after.tier !== target ? `get_my_agent does not show ${planName(target)} yet; check it again in a minute before doing anything else.` : null),
        };
      }

      // A smaller plan starts with the next renewal: nothing moves now, and nothing is refunded.
      if (cancelled || agent.subscription?.atPeriodEnd === 'ends') {
        return {
          outcome: 'refused',
          message: `The plan is set to end after ${periodEnd}, so it does not renew on another plan. To keep the agent on `
            + `${planName(target)}, undo the cancellation first with action renew, then change the plan.`,
          nextAction: billingCall(guid, 'renew'),
        };
      }
      if (next === target) {
        return {
          outcome: 'not_needed',
          message: `The move to ${planName(target)} is already set: it starts with ${when}. Until then the agent keeps ${planName(current)} and the AI usage it includes.`,
        };
      }
      const smaller = agent.pricing?.[target];
      const startsAt = renewsAt;
      return {
        outcome: 'quote',
        quote: {
          chargeNowUsd: 0,
          estimated: false,
          recurringUsd: smaller?.priceUsd ?? null,
          includedUsageUsd: smaller?.includedUsageUsd ?? null,
          paidFrom,
          plan: target,
          change: 'downgrade',
          ...(startsAt ? { startsAt } : {}),
        },
        message: `Move to ${planName(target)} at the next renewal: nothing is charged or refunded now. The agent keeps ${planName(current)} and the AI usage it includes until ${periodEnd}. `
          + `From ${when} the plan is ${planName(target)}${smaller ? `, ${planTerms(smaller)}` : ''}, paid from ${balance}. `
          + `Asking for ${planName(current)} again before then undoes the move.`,
        confirmReason: 'Ask the user to confirm first: from the next renewal the agent has the smaller plan\'s included AI usage.',
        perform: async signal => {
          // Wiro moves an agent to a smaller plan only when the request says so: a bare smaller plan is
          // refused, so an older client that asks for one as an upgrade changes nothing.
          const body = requireApiSuccess(
            await client.post<BillingEnvelope>('/UserAgent/UpgradeTier', { guid, targetTier: target, allowDowngrade: true }, signal),
            'The move to the smaller plan could not be set.',
          );
          if (asString(body.url)) return { outcome: 'refused', message: checkoutAnswer(`move the plan to ${planName(target)}`) };
          const at = unixToIso(body.startsAt ?? body.effectiveAt ?? body.periodEnd) ?? startsAt;
          return {
            outcome: 'done',
            message: `The move to ${planName(target)} is set: it starts with the renewal after ${at ?? 'this period'}. Until then the agent keeps ${planName(current)} and the AI usage it includes. Nothing was charged or refunded.`,
            result: { chargedUsd: 0, plan: current, nextPlan: target, change: 'downgrade', ...(at ? { startsAt: at } : {}) },
          };
        },
        verify: after => (after.nextPlan !== target ? `get_my_agent does not show the move to ${planName(target)} yet; check it again in a minute.` : null),
      };
    }

    case 'buy_credits':
      // Retired: nothing is quoted, sent or charged.
      return { outcome: 'refused', heading: 'Retired', message: packsRetiredText(agent) };
  }
}

/** The arguments that repeat a quoted action with the user's approval. */
function confirmArguments(guid: string, action: BillingAction, quote: Quote | undefined): Record<string, unknown> {
  const amount = approvalAmountOf(action, quote);
  return {
    agent_guid: guid,
    action,
    ...((action === 'subscribe' || action === 'change_plan') && quote?.plan ? { plan: quote.plan } : {}),
    ...(amount !== null ? { confirm_charge_usd: amount } : {}),
    confirm: true,
  };
}

interface Observation {
  /** Reading the agent again shows that the action went through. */
  happened: boolean;
  text: string;
  row?: Record<string, unknown>;
  result?: Result;
  nextAction?: NextAction;
}

/**
 * After a paid request whose answer did not confirm it, reads the agent again
 * and says what it shows.
 */
async function observeOpenOutcome(
  client: WiroClient,
  action: BillingAction,
  before: AgentDetail,
  quote: Quote | undefined,
  signal: AbortSignal,
): Promise<Observation> {
  let row: Record<string, unknown>;
  try {
    row = await readAgentDetail(client, before.guid, signal);
  } catch {
    return { happened: false, text: 'The agent could not be read afterwards to check it. Check get_my_agent and the wallet balance with get_account first.' };
  }
  const after = toAgentDetail(row);
  const charged = chargeOf(quote);
  switch (action) {
    case 'subscribe':
      return after.subscription?.status === 'active'
        ? {
          happened: true,
          row,
          text: 'The agent now has an active plan, so the payment went through. Do not subscribe again.',
          result: { chargedUsd: charged, ...(quote?.plan ? { plan: quote.plan } : {}) },
          nextAction: subscribeWait(before),
        }
        : { happened: false, text: 'The agent shows no active plan yet. Check get_my_agent again in a minute and the wallet balance with get_account before trying again; if the plan is still not active but the balance changed, contact Wiro support.' };
    case 'renew':
      return after.subscription?.status === 'active'
        ? {
          happened: true,
          row,
          text: 'The plan is active again, so the renewal went through. Do not renew it again.',
          result: { chargedUsd: charged, renewal: 'renewed' },
          nextAction: renewWait(before),
        }
        : { happened: false, text: 'The plan still shows as expired. Check get_my_agent again in a minute and the wallet balance with get_account before renewing again; if the plan is still expired but the balance changed, contact Wiro support.' };
    case 'change_plan': {
      // Only a move to a larger plan charges, so it is the only one checked here.
      const target = quote?.plan;
      if (!target || quote?.change !== 'upgrade') return { happened: false, text: '' };
      if (after.tier === target) {
        return {
          happened: true,
          row,
          text: `The agent is on ${planName(target)} now, so the plan change went through. Do not change it again. The prorated charge is not shown, and it is at most ${formatUsd(quote.maxChargeUsd)}.`,
          result: { chargedUsd: null, plan: target, change: 'upgrade' },
          nextAction: waitIfStarting(before),
        };
      }
      const targetPrice = before.pricing?.[target]?.priceUsd;
      const priced = targetPrice !== undefined && [after.monthlyPriceUsd, after.subscription?.amountUsd ?? null]
        .some(value => value !== null && sameAmount(value, targetPrice));
      return {
        happened: false,
        text: priced
          ? `The agent does not show ${planName(target)} yet. Do not change the plan again: check get_my_agent and the wallet balance with get_account, and if the balance changed, contact Wiro support.`
          : `The agent still shows ${planName(after.tier) || 'its earlier plan'}. Check get_my_agent and the wallet balance with get_account before trying again; if the balance changed, contact Wiro support.`,
      };
    }
    default:
      return { happened: false, text: '' };
  }
}

// Wiro renews an ended plan at no more than the price the agent shows. When the renewal takes more (its plan
// moved since), Wiro charges nothing, shows the renewal's plan and price on the agent and asks for the renewal
// again. The first group is Wiro's account of it, without its closing request to renew again.
const RENEWAL_REPRICED = /^(This plan now renews on the .+? plan at \$[\d.,]+ a month, not the \$[\d.,]+ it showed\. Nothing was charged\.)/i;

// Wiro's answer to a smaller plan sent as a move to a larger one, which changes nothing.
const SMALLER_PLAN_REFUSAL = /^The \w+ plan is smaller than this agent's \w+ plan, so this is not an upgrade\. Nothing was changed\./i;

// Code 104: another payment from the same wallet, or another change to the agent's plan, was going through.
const BUSY_NOTE = 'Nothing was charged or changed, and it is not a low balance. Offer to try again in a minute.';

/** workspace: the agent's, whose Wiro balance pays for its plan. */
function annotateKnownRefusal(error: ApiResultError, workspace: 'personal' | 'team' | undefined): Error {
  const text = error.message;
  if (hasErrorCode(error, 104)) return new Error(`${text}\n\n${BUSY_NOTE}`);
  if (isWalletNotRead(error)) return new Error(`${text}\n\n${WALLET_NOT_READ_NOTE}`);
  if (SMALLER_PLAN_REFUSAL.test(text)) {
    // A move this server sent as one to a larger plan: the agent's plan moved up after it was read.
    return new Error(`${text}\n\nNothing was charged: the agent's plan changed after it was read. get_my_agent shows the plan it is on now, and change_plan quotes a move from it.`);
  }
  const short = balanceShortfall(error);
  if (short) {
    const team = workspace === 'team' ? 'select the agent\'s team in the dashboard first' : workspace ? '' : 'for a team agent, select its team in the dashboard first';
    return new Error(`${text}\n\n${shortBalanceNote(short.neededUsd, team)} Once the user has added them and says yes, `
      + 'confirm the same quote again. get_account shows the balance.');
  }
  const hint = workspaceHint(text);
  if (hint) return new Error(`${text}\n\n${hint}`);
  return error;
}

export function registerManageAgentBilling(server: McpServer, client: WiroClient): void {
  server.registerTool(
    'manage_agent_billing',
    {
      title: 'Manage a Wiro agent\'s plan',
      description: 'Pay for, renew, change or cancel a deployed agent\'s plan. An agent has '
        + 'one of three plans, smallest first: Starter, Pro or Max. Each has a fixed monthly price that it also '
        + 'includes as AI usage each month, and every plan includes every '
        + 'skill. After the included usage, the agent uses the Wiro balance of its workspace. Charges come from the Wiro balance of the agent\'s workspace (the team '
        + 'wallet for a team agent); the connected project must belong to that same workspace. Every call without '
        + 'confirm: true only returns what will happen and the amount (for a move to a larger plan, the prorated '
        + 'amount Wiro works out, or the most it can charge when that is worked out only at the change). Show it to '
        + 'the user, get their approval, then repeat the call with confirm: true and, for a charge, confirm_charge_usd '
        + 'set to the quoted amount (for a move to a larger plan, quote.maxChargeUsd); if the price changed in '
        + 'between, nothing is charged and a new quote comes back. Never repeat a confirmed charge that failed or '
        + 'timed out without checking get_my_agent first. '
        + 'subscribe starts a plan for an agent without one; renew undoes a cancellation or renews an expired '
        + 'plan; change_plan moves to another plan: a larger plan starts now and charges the prorated '
        + 'difference for the rest of the period, a smaller plan starts with the next renewal and charges or refunds '
        + 'nothing, and asking for the plan the agent is on undoes a move set for the next renewal; cancel stops '
        + 'renewals with no refund. Extra credit packs are retired: buy_credits only says so and charges nothing, and '
        + 'funds are added to the balance on wiro.ai. Plans renew every 30 days until '
        + 'cancelled. Renewals and plan changes leave a running agent running. Agent plans are paid only from the '
        + 'Wiro balance: no card payment is taken, and a quote refused because the balance is short says how much '
        + 'to add on wiro.ai, with nothing charged. Every plan payment, the automatic renewal included, counts the '
        + 'balance\'s deposits, store revenue and coupon credit that is not limited to certain models; coupon credit '
        + 'limited to models pays no plan. A card plan from before plans were paid from the balance is paid by card '
        + 'through its period, then moves to the balance and renews from it (one whose period ends within 7 days '
        + 'after Wiro\'s email announcing the move renews once more by card first); its plan changes are paid from '
        + 'the balance, cancel ends it with its period instead, and renew undoes that, or brings back a card plan '
        + 'that ended, from the balance. A card plan whose last payment did not go through has not ended and takes no '
        + 'new plan until it ends. On a team '
        + 'agent only a team admin, the organization\'s owner or the person who deployed the agent can pay for it or '
        + 'change its plan; other members are refused and nothing is charged.',
      inputSchema: strictInput({
        agent_guid: z.string().min(1).max(100)
          .describe('The deployed agent\'s guid, from list_my_agents or deploy_agent.'),
        action: z.enum(ACTIONS)
          .describe('subscribe, change_plan, cancel or renew. buy_credits is retired: it says so and charges nothing.'),
        plan: z.enum(AGENT_PLANS).optional()
          .describe('subscribe: the plan to pay for (default: the agent\'s current plan, else starter). change_plan: the plan to move to; leave it out to get the plans with their prices.'),
        pack: z.enum(['small', 'medium', 'large']).optional()
          .describe('Retired with buy_credits: extra credit packs are no longer sold. Ignored.'),
        request_id: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/).optional()
          .describe('Retired with buy_credits. Ignored.'),
        confirm_charge_usd: z.number().min(0).max(100_000).optional()
          .describe('With confirm: true, the amount the user approved, from the quote\'s nextAction (quote.chargeNowUsd, or quote.maxChargeUsd for a move to a larger plan). Required for every action that charges: subscribe, change_plan to a larger plan and renewing an expired plan. If a fresh quote no longer matches it, nothing is charged and the new quote is returned. For a move to a larger plan it is the most the user agreed to pay now.'),
        confirm: z.boolean().default(false)
          .describe('false returns only the quote. true performs the action. Set it only after the user approved it.'),
      }, 'The plan to pay for or move to is the argument plan: starter, pro or max.'),
      outputSchema: {
        action: z.enum(ACTIONS),
        agentGuid: z.string(),
        outcome: z.enum(['quote', 'done', 'not_needed', 'refused']),
        quote: quoteSchema.optional(),
        priceChanged: z.boolean().optional(),
        result: resultSchema.optional(),
        dashboardUrl: z.string(),
        agent: agentSummarySchema,
        message: z.string(),
        nextAction: nextActionSchema.optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ agent_guid, action, plan: planInput, confirm_charge_usd, confirm }, extra) => {
      const guid = agent_guid.trim();
      let sentAtMs = 0;
      let before: AgentDetail | undefined;
      let plan: Plan | undefined;
      let plainMember = false;

      const respond = (payload: {
        outcome: Outcome;
        heading?: string;
        message: string;
        quote?: Quote;
        priceChanged?: boolean;
        result?: Result;
        nextAction?: NextAction;
        agentRow: Record<string, unknown>;
        /** The row is from before the change, so only its identity line is shown. */
        agentStale?: boolean;
      }) => {
        const summary = toAgentSummary(payload.agentRow);
        const summaryLines = formatAgentSummaryLines(summary, plainMember);
        const dashboardUrl = before?.dashboardUrl ?? agentDashboardUrl(guid);
        const heading = payload.heading ?? {
          quote: 'Quote (nothing done yet)',
          done: 'Done',
          not_needed: 'Nothing to do',
          refused: 'Not possible',
        }[payload.outcome];
        return {
          content: [{
            type: 'text' as const,
            text: [
              `## ${action}: ${heading}`,
              '',
              payload.message,
              '',
              ...(payload.agentStale ? summaryLines.slice(0, 1) : summaryLines),
              `Dashboard: ${dashboardUrl}`,
            ].join('\n'),
          }],
          structuredContent: {
            action,
            agentGuid: guid,
            outcome: payload.outcome,
            ...(payload.quote ? { quote: payload.quote } : {}),
            ...(payload.priceChanged ? { priceChanged: true } : {}),
            ...(payload.result ? { result: payload.result } : {}),
            dashboardUrl,
            agent: summary,
            message: payload.message,
            ...(payload.nextAction ? { nextAction: payload.nextAction } : {}),
          },
        };
      };

      /** A quote with the call that confirms it. lead goes before the quote's own text. */
      const quoteResponse = (quoted: Plan, lead: string, row: Record<string, unknown>, priceChanged: boolean) => {
        const amount = approvalAmountOf(action, quoted.quote);
        const additions = [
          ...(amount !== null ? [`confirm_charge_usd ${amount}`] : []),
          'confirm: true',
        ];
        return respond({
          outcome: 'quote',
          message: `${lead}${quoted.message}\n\nNothing has been done yet. To go ahead, call manage_agent_billing again with the same arguments plus ${additions.join(', ')}.`,
          quote: quoted.quote,
          ...(priceChanged ? { priceChanged: true } : {}),
          nextAction: {
            tool: 'manage_agent_billing',
            arguments: confirmArguments(guid, action, quoted.quote),
            reason: quoted.confirmReason ?? CHARGE_REASON,
          },
          agentRow: row,
        });
      };

      /**
       * After Wiro refused a renewal that would charge more than the agent showed: it charged nothing and
       * wrote the plan and the price the renewal takes on the agent. The agent is read again and quoted
       * again, and the user approves the new quote; nothing is renewed on their behalf.
       */
      const quoteRenewalAgain = async (refusal: string) => {
        try {
          const row = await readAgentDetail(client, guid, extra.signal);
          const agent = toAgentDetail(row);
          const raw = isPlainObject(row.subscription) ? row.subscription : null;
          const again = await planFor(client, action, agent, raw, { plan: planInput }, extra.signal);
          if (again.outcome !== 'quote' || !again.perform) {
            return respond({
              outcome: again.outcome,
              heading: again.heading,
              message: `${refusal} The agent was read again.\n\n${again.message}`,
              nextAction: again.nextAction,
              agentRow: row,
            });
          }
          const amount = approvalAmountOf(action, again.quote);
          const changed = amount !== null && (confirm_charge_usd === undefined || !sameAmount(amount, confirm_charge_usd));
          return quoteResponse(
            again,
            `${refusal} The agent was read again for this new quote. Show it to the user and ask again; renew only after they agree to it.\n\n`,
            row,
            changed,
          );
        } catch (readError) {
          if (extra.signal.aborted) return errorResult(readError);
          return errorResult(new Error(`${refusal}\n\nThe agent could not be read again just now. Call manage_agent_billing with action renew and without confirm for the new quote, and show it to the user before renewing.`));
        }
      };

      try {
        const row = await readAgentDetail(client, guid, extra.signal);
        const agent = toAgentDetail(row);
        before = agent;
        plainMember = await isPlainTeamMember(client, row, extra.signal);
        const raw = isPlainObject(row.subscription) ? row.subscription : null;
        plan = await planFor(client, action, agent, raw, { plan: planInput }, extra.signal);

        if (plan.outcome !== 'quote' || !plan.perform) {
          return respond({ outcome: plan.outcome, heading: plan.heading, message: plan.message, nextAction: plan.nextAction, agentRow: row });
        }
        // A team member without admin rights can still be the person who
        // deployed the agent, who may pay for it, so Wiro is asked before a quote.
        if (plainMember && await teamAgentBillingRefused(client, guid, extra.signal)) {
          return respond({
            outcome: 'refused',
            message: 'Only a team admin, the organization\'s owner or the person who deployed this agent can pay for '
              + 'or change its plan, and this connection acts as a team member without those rights. Nothing was '
              + 'quoted or charged. Ask a team admin or the person who deployed the agent to do it.',
            agentRow: row,
          });
        }
        const problem = confirm ? approvalProblem(action, plan.quote, confirm_charge_usd) : null;
        if (!confirm || problem) {
          const amount = approvalAmountOf(action, plan.quote);
          const lead = problem === 'changed'
            ? `${changedLead(action, plan.quote, amount, confirm_charge_usd)}\n\n`
            : problem === 'missing'
              ? 'Nothing was charged: confirm_charge_usd is missing. It is the amount the user approved, and it must be sent with confirm: true.\n\n'
              : '';
          return quoteResponse(plan, lead, row, problem === 'changed');
        }

        sentAtMs = Date.now();
        const performed = await plan.perform(extra.signal);
        let after = row;
        let afterRead = false;
        try {
          after = await readAgentDetail(client, guid, extra.signal);
          afterRead = true;
        } catch {
          // The action went through; the earlier snapshot still identifies the agent.
        }

        // Without the read-back, the row shows the agent as it was before the change.
        const stale = !afterRead && performed.outcome === 'done';
        // A change the agent read again does not show yet is said, so the result never claims more than it shows.
        const notShown = afterRead && performed.outcome === 'done' && plan.verify ? plan.verify(toAgentSummary(after)) : null;
        return respond({
          outcome: performed.outcome,
          message: stale
            ? `${performed.message} The agent could not be read afterwards; get_my_agent shows its new status, plan and AI usage.`
            : notShown ? `${performed.message} ${notShown}` : performed.message,
          quote: plan.quote,
          result: performed.result,
          nextAction: performed.nextAction,
          agentRow: after,
          agentStale: stale,
        });
      } catch (error) {
        const repriced = action === 'renew' && sentAtMs > 0 && error instanceof ApiResultError
          ? RENEWAL_REPRICED.exec(error.message.trim())
          : null;
        if (repriced) return quoteRenewalAgain(repriced[1]);
        if (sentAtMs > 0 && !extra.signal.aborted && outcomeUnknown(error)) {
          const text = errorText(error);
          const quote = plan?.quote;
          if (chargeOf(quote) === null || !before) {
            return errorResult(new Error(`${text}\n\nThe request was sent, so it may have taken effect. Check get_my_agent before trying again.`));
          }
          const observed = await observeOpenOutcome(client, action, before, quote, extra.signal);
          if (observed.happened && observed.row) {
            return respond({
              outcome: 'done',
              message: `The answer did not confirm this request, so the agent was read again. ${observed.text}`,
              quote,
              result: observed.result,
              nextAction: observed.nextAction,
              agentRow: observed.row,
            });
          }
          return errorResult(new Error(`${text}\n\nThe request was sent and the answer does not show whether it went through. ${observed.text} Do not repeat the call until this is checked.`));
        }
        if (error instanceof ApiResultError) return errorResult(annotateKnownRefusal(error, before?.workspace));
        return errorResult(error);
      }
    },
  );
}
