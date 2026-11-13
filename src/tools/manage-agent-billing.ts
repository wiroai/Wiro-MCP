import { randomUUID } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WiroClient } from '../client.js';
import {
  ApiResultError,
  asString,
  errorResult,
  errorText,
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
  asPlan,
  chargeRoute,
  comparePlans,
  formatAgentSummaryLines,
  formatCredits,
  formatUsd,
  isTransitionalStatus,
  isUnsettledPlan,
  isWalletNotRead,
  outcomeUnknown,
  planLineText,
  planName,
  readAgentDetail,
  roundUsd,
  sameAmount,
  toAgentDetail,
  toAgentSummary,
  unsettledPlanText,
  type AgentDetail,
  type AgentPlan,
  type AgentSummary,
  type NextAction,
  type PlanPrice,
} from '../utils/user-agent.js';
import { nextActionSchema, strictInput } from './schemas.js';

const ACTIONS = ['subscribe', 'change_plan', 'cancel', 'renew', 'buy_credits'] as const;
type BillingAction = typeof ACTIONS[number];
type PaidFrom = 'personal_wallet' | 'team_wallet' | 'card';
type Outcome = 'quote' | 'done' | 'not_needed' | 'refused';

const quoteSchema = z.object({
  chargeNowUsd: z.number().nullable(),
  estimated: z.boolean(),
  maxChargeUsd: z.number().optional(),
  recurringUsd: z.number().nullable().optional(),
  monthlyCredits: z.number().nullable().optional(),
  creditsNow: z.number().optional()
    .describe('change_plan to a larger plan: the credits this period gains now. monthlyCredits is what every renewal gives.'),
  creditsAdded: z.number().optional(),
  paidFrom: z.enum(['personal_wallet', 'team_wallet', 'card']),
  plan: z.enum(AGENT_PLANS).optional()
    .describe('subscribe and change_plan: the plan this quote is for.'),
  change: z.enum(['upgrade', 'downgrade', 'undo_downgrade']).optional()
    .describe('change_plan: upgrade (a larger plan, now), downgrade (a smaller plan, from the next renewal) or undo_downgrade (keep the plan, and undo the move set for the next renewal).'),
  startsAt: z.string().optional()
    .describe('change_plan to a smaller plan: when the period ends; the new plan starts with the renewal after it.'),
  pack: z.string().optional(),
});

type Quote = z.infer<typeof quoteSchema>;

const resultSchema = z.object({
  chargedUsd: z.number().nullable().optional(),
  monthlyPriceUsd: z.number().optional(),
  monthlyCredits: z.number().optional(),
  creditsNow: z.number().optional()
    .describe('change_plan to a larger plan: the credits this period gained with it. monthlyCredits is what every renewal gives.'),
  creditsAdded: z.number().optional(),
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

function newRequestId(): string {
  return randomUUID().replace(/-/g, '');
}

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
 * The wait after a plan change, a pack or a renewal, which keep a running agent up:
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
 * running one keeps running, and one that was stopping starts again. An agent
 * without a plan runs only while extra credits last.
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

/** What a move to a larger plan does to this period's credits. An allowance above the new plan's is cut to it for the time left. */
function upgradeCreditsText(creditsNow: number, renewal: string, done: boolean): string {
  if (creditsNow > 0) {
    return `${formatCredits(creditsNow)} credits ${done ? 'came with it' : 'come now'} for the rest of this period${renewal}. `;
  }
  if (creditsNow < 0) return `This period ${done ? 'lost' : 'loses'} ${formatCredits(-creditsNow)} credits for the time left${renewal}. `;
  return `This period ${done ? 'kept' : 'keeps'} the credits it ${done ? 'had' : 'has'}${renewal}. `;
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
      return 'The agent still needs setup; the credits are there once it starts.';
    case 0:
      return 'The agent is stopped; the credits are there when it starts.';
    case 5:
      return 'The agent stopped with an error; the credits are there when it starts.';
    default:
      return 'The credits are there when the agent starts.';
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
    const monthlyCredits = toNumber(body.totalMonthlyCredits);
    return {
      price: priceUsd !== null && monthlyCredits !== null ? { priceUsd, monthlyCredits } : null,
      change: readPlanChange(body.planChange),
    };
  } catch (error) {
    if (signal.aborted) throw error;
    return null;
  }
}

/** A plan's price as said in a sentence: "$30.00 every 30 days with 3,000 monthly credits". */
function planTerms(price: PlanPrice): string {
  return `${formatUsd(price.priceUsd)} every 30 days with ${formatCredits(price.monthlyCredits)} monthly credits`;
}

/**
 * What the next renewal charges and grants: the plan set for it, or the agent's own plan, at today's price.
 * null when the plans' prices cannot be read.
 */
function renewalPlanPrice(agent: Pick<AgentDetail, 'tier' | 'nextPlan' | 'pricing'>): PlanPrice | null {
  const key = asPlan(agent.nextPlan) ?? asPlan(agent.tier);
  return key ? agent.pricing?.[key] ?? null : null;
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
function changedLead(action: BillingAction, quote: Quote | undefined, amount: number | null, approved: number | undefined, callerRequestId: string | undefined): string {
  if (approvedAsCeiling(action, quote)) {
    return `The most this plan change can charge changed since the quote: it is now ${formatUsd(amount)}, and the user approved at most ${formatUsd(approved)}. Nothing was charged. Show the new amount to the user and ask again.`;
  }
  const changed = `The amount changed since the quote: it is now ${formatUsd(amount)}, and the user approved ${formatUsd(approved)}.`;
  if (action === 'buy_credits' && callerRequestId) {
    // Wiro binds a purchase request id to the price of its first attempt.
    return `${changed} Nothing was charged by this call. Show the new amount to the user and ask again. `
      + `If an earlier call with request_id "${callerRequestId}" ended without a clear result, do not approve the new amount for it: this request id works only at its original price. Check get_my_agent and the wallet balance with get_account, and if the balance changed, contact Wiro support.`;
  }
  return `${changed} Nothing was charged. Show the new amount to the user and ask again.`;
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
  input: { plan?: AgentPlan; pack?: string; requestId: string },
  signal: AbortSignal,
): Promise<Plan> {
  const guid = agent.guid;
  const active = raw?.status === 'active';
  const prepaid = raw?.provider === 'prepaid';
  const cancelled = raw?.pendingdowngrade === 'cancel';
  const route = chargeRoute(raw);
  const paidFrom: PaidFrom = agent.workspace === 'team' ? 'team_wallet' : 'personal_wallet';
  const wallet = agent.workspace === 'team' ? 'the team wallet' : 'the personal wallet';
  const periodEnd = agent.subscription?.periodEndsAt ?? 'the end of the current period';
  const cardPlan = (what: string) => `This plan is billed by card, and card payments are made in the Wiro dashboard. Nothing was charged here. To ${what}, open ${agent.dashboardUrl}`;
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
          message: 'This agent already has an active plan. Use renew to undo a cancellation, change_plan to move to another plan, or buy_credits for more credits.',
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
          monthlyCredits: price.monthlyCredits,
          paidFrom,
          plan,
        },
        message: `Subscribe on ${planName(plan)}: ${formatUsd(price.priceUsd)} now from ${wallet}, then every 30 days until the plan is cancelled, with ${formatCredits(price.monthlyCredits)} credits per month. `
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
          const charged = toNumber(body.monthlypriceusd) ?? price.priceUsd;
          const credits = toNumber(body.monthlycredits) ?? price.monthlyCredits;
          return {
            outcome: 'done',
            message: `Subscribed on ${planName(plan)} and charged ${formatUsd(charged)} from ${wallet}. The plan renews every 30 days until it is cancelled. `
              + (subscribeStarts(agent.status) ? 'The agent is starting.' : 'The agent keeps running: a new plan does not restart it.'),
            result: { chargedUsd: charged, monthlyPriceUsd: charged, monthlyCredits: credits, plan },
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
        if (!prepaid) {
          // A card plan can be set to stop at its period end.
          const atPeriodEnd = agent.subscription?.atPeriodEnd;
          return {
            outcome: 'refused',
            message: atPeriodEnd === 'ends'
              ? `This plan is billed by card and is set to stop renewing after ${periodEnd}. Card plans are managed `
                + `from the dashboard, where it can be kept: ${agent.dashboardUrl}`
              : atPeriodEnd === 'renews'
                ? `This plan is billed by card and renews by itself. It is managed from the dashboard: ${agent.dashboardUrl}`
                : `This plan is billed by card and is paid through ${periodEnd}. Card plans are renewed or cancelled `
                  + `from the dashboard: ${agent.dashboardUrl}`,
          };
        }
        if (!cancelled) {
          return { outcome: 'not_needed', message: 'The plan is active and renews by itself. Nothing to do.' };
        }
        // A renewal charges the plan set for it, or the agent's own, at today's price.
        const next = renewalPlanPrice(agent);
        const amount = next?.priceUsd ?? (agent.monthlyPriceUsd || agent.subscription?.amountUsd);
        return {
          outcome: 'quote',
          quote: { chargeNowUsd: 0, estimated: false, recurringUsd: amount, monthlyCredits: next?.monthlyCredits ?? agent.credits.renewal ?? agent.credits.monthly, paidFrom },
          message: `Undo the cancellation: nothing is charged now. The plan then renews from ${wallet} for ${formatUsd(amount)} after ${periodEnd} and every 30 days after that until it is cancelled.`,
          confirmReason: 'Ask the user to confirm first: the plan will charge the wallet again at each renewal.',
          perform: async signal => {
            requireApiSuccess(
              await client.post<BillingEnvelope>('/UserAgent/RenewSubscription', { guid }, signal),
              'The cancellation could not be undone.',
            );
            return {
              outcome: 'done',
              message: 'The cancellation was undone. The plan keeps renewing every 30 days.',
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
      if (!prepaid) {
        return {
          outcome: 'refused',
          message: 'The expired plan was billed by card. Use action subscribe to start a new plan paid from the wallet.',
          nextAction: billingCall(guid, 'subscribe'),
        };
      }
      const own = agent.monthlyPriceUsd ?? toNumber(raw.amount);
      const planKey = asPlan(agent.nextPlan) ?? asPlan(agent.tier);
      // A renewal charges the plan set for it, or the agent's own, at its price today, which can differ
      // from the price the plan ended at.
      const today = renewalPlanPrice(agent);
      const earlier = today && own && own > 0 && !sameAmount(today.priceUsd, own)
        ? ` The plan ended at ${formatUsd(own)} a month; it renews at the ${planName(planKey)} price today, with ${formatCredits(today.monthlyCredits)} credits per month.`
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
          monthlyCredits: today?.monthlyCredits ?? null,
          paidFrom,
          ...(planKey ? { plan: planKey } : {}),
        },
        message: `Renew the expired plan${planKey ? ` on ${planName(planKey)}` : ''}: ${formatUsd(price)} now from ${wallet}, then every 30 days until it is cancelled.${earlier} A stopped or failed agent is queued to start again.`,
        perform: async signal => {
          const body = requireApiSuccess(
            await client.post<BillingEnvelope>('/UserAgent/RenewSubscription', { guid }, signal),
            'The plan could not be renewed.',
          );
          const charged = toNumber(body.amount) ?? price;
          const credits = toNumber(body.monthlycredits);
          return {
            outcome: 'done',
            message: `Renewed and charged ${formatUsd(charged)} from ${wallet}. The plan renews every 30 days until it is cancelled.`,
            result: {
              chargedUsd: charged,
              monthlyPriceUsd: charged,
              ...(credits !== null ? { monthlyCredits: credits } : {}),
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
      // A move set for the next renewal ends with the plan.
      const dropsMove = asPlan(agent.nextPlan) && agent.nextPlan !== agent.tier
        ? ` The move to ${planName(agent.nextPlan)} set for the next renewal is dropped with it.`
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
        // A plan moving to wallet billing has no cancel in the dashboard either: it can be cancelled once the wallet bills it.
        if (raw?.nextprovider === 'prepaid') {
          return {
            outcome: 'refused',
            message: `A switch to wallet billing is already scheduled for this plan, so it cannot be cancelled now. After ${periodEnd} it is billed from the wallet, and action cancel then stops its renewals.`,
          };
        }
        if (agent.workspace === 'personal') {
          return {
            outcome: 'refused',
            message: `This plan is billed by card. Card plans are cancelled from the dashboard: ${agent.dashboardUrl}`,
          };
        }
        if (agent.subscription?.cancelAtPeriodEnd) {
          return { outcome: 'not_needed', message: `The plan is already set to end after ${periodEnd}.` };
        }
        return {
          outcome: 'quote',
          quote: { chargeNowUsd: 0, estimated: false, paidFrom: 'card' },
          message: `Cancel the team's card plan at the end of the current period (${periodEnd}). Nothing is refunded.${dropsMove}`,
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
        message: `Cancel the plan: nothing is refunded and it stops renewing. The agent keeps its monthly credits until about a day after ${periodEnd}; then the monthly credits end and the agent stops unless it has extra credits left. Action renew undoes the cancellation before then.${dropsMove}`,
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
        // A wallet plan that ended comes back with renew on the plan set for its renewal, else on its own
        // plan, so renew answers a target that is that plan; any other target takes a new plan.
        const renewsOn = asPlan(agent.nextPlan) ?? current;
        if (renewsOn === target && raw?.status === 'expired' && prepaid) {
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
      const when = agent.subscription?.periodEndsAt ? `the renewal after ${agent.subscription.periodEndsAt}` : 'the next renewal';
      const move = comparePlans(target, current);
      // Wiro changes a team's card plan only in the dashboard, not with a project's key.
      const teamCard = route === 'card' && agent.workspace === 'team';

      if (move === 0) {
        if (!next || next === current) {
          return {
            outcome: 'not_needed',
            message: next === current
              ? `The agent is already on ${planName(current)}. From ${when} it is billed at today's ${planName(current)} price${agent.pricing?.[current] ? `, ${planTerms(agent.pricing[current] as PlanPrice)}` : ''}. Nothing to do.`
              : `The agent is already on ${planName(current)}. Nothing to do.`,
          };
        }
        // A move to another plan is set for the next renewal: keeping this one undoes it. A team's card
        // plan changes only in the dashboard.
        if (teamCard) return { outcome: 'refused', message: cardPlan(`keep it on ${planName(current)}`) };
        const keep = agent.pricing?.[current];
        return {
          outcome: 'quote',
          quote: {
            chargeNowUsd: 0,
            estimated: false,
            recurringUsd: keep?.priceUsd ?? null,
            monthlyCredits: keep?.monthlyCredits ?? null,
            paidFrom: route === 'card' ? 'card' : paidFrom,
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
            if (asString(body.url)) return { outcome: 'refused', message: cardPlan(`keep it on ${planName(current)}`) };
            // An agent on a price from before the plans keeps its plan with that plan set for its renewal, so
            // the renewal bills the plan's own price.
            if (asPlan(body.nextplan) === current) {
              const at = unixToIso(body.startsAt ?? body.periodEnd) ?? agent.subscription?.periodEndsAt;
              const priceUsd = toNumber(body.newPriceUsd) ?? keep?.priceUsd;
              const monthlyCredits = toNumber(body.newMonthlyCredits) ?? keep?.monthlyCredits;
              const terms = priceUsd !== undefined && monthlyCredits !== undefined ? `, ${planTerms({ priceUsd, monthlyCredits })}` : '';
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
        // No checkout pages are opened for card plans: the user pays them in the dashboard.
        if (route === 'card') return { outcome: 'refused', message: cardPlan(`move it to ${planName(target)}`) };
        const preview = await readPlanPreview(client, guid, target, signal);
        const targetPrice = preview?.price ?? agent.pricing?.[target];
        if (!targetPrice) throw new Error(`The ${planName(target)} price of this agent is not available right now. Try again later.`);
        const ending = `The plan is cancelled, so it ends about a day after ${periodEnd} and does not renew on ${planName(target)}; this charge covers only the time left. To keep the plan, undo the cancellation first with action renew.`;
        const currentPrice = agent.monthlyPriceUsd || agent.subscription?.amountUsd || 0;
        const fullDifference = roundUsd(Math.max(0, targetPrice.priceUsd - currentPrice));
        // A wallet plan pays the amount Wiro works out on it now. A card plan moving to wallet billing is
        // charged from the wallet for the time left of its card period, which Wiro works out at the change.
        const change = preview?.change?.wallet ? preview.change : null;
        const exact = change?.chargeNowUsd ?? null;
        const renewalCredits = change?.creditsFromRenewal ?? targetPrice.monthlyCredits;
        const creditsNow = change?.creditsNow ?? null;
        const days = daysLeftText(change?.secondsLeft ?? null);
        const undoes = next && next !== current ? ` This also undoes the move to ${planName(next)} set for the next renewal.` : '';
        const money = exact !== null
          ? `Move to ${planName(target)}: ${formatUsd(exact)} now from ${wallet} for the rest of this period`
            + `${exact > 0 && underOneDayLeft(change?.secondsLeft ?? null) ? ', at the one-day minimum' : days ? ` (${days})` : ''}. `
          : `Move to ${planName(target)}: the difference for the rest of this period is taken from ${wallet} now. Wiro works it out from the time left when the plan changes, and it is never more than ${formatUsd(fullDifference)}, so that is the amount to approve. `;
        const credits = creditsNow !== null
          ? upgradeCreditsText(creditsNow, cancelled ? '' : `, and every renewal gives ${formatCredits(renewalCredits)}`, false)
          : `The added credits come for the time left in this period${cancelled ? '' : `, and every renewal gives ${formatCredits(renewalCredits)}`}. `;
        return {
          outcome: 'quote',
          quote: {
            chargeNowUsd: exact,
            estimated: exact === null,
            maxChargeUsd: exact ?? fullDifference,
            recurringUsd: cancelled ? null : targetPrice.priceUsd,
            monthlyCredits: renewalCredits,
            ...(creditsNow !== null ? { creditsNow } : {}),
            paidFrom,
            plan: target,
            change: 'upgrade',
          },
          message: money + credits
            + (cancelled ? `${ending} ` : `From the next renewal the plan costs ${formatUsd(targetPrice.priceUsd)} every 30 days. `)
            + `${planChangeAgentNote(agent.status, 'the plan change', true)}${undoes} A move to a smaller plan later starts at the renewal after it is asked for, with nothing refunded.`,
          perform: async signal => {
            const body = requireApiSuccess(
              await client.post<BillingEnvelope>('/UserAgent/UpgradeTier', { guid, targetTier: target }, signal),
              'The plan could not be changed.',
            );
            if (asString(body.url)) {
              // A checkout link means the plan is paid by card, and card payments are made in the dashboard.
              return { outcome: 'refused', message: cardPlan(`move it to ${planName(target)}`) };
            }
            const charged = toNumber(body.proratedCharge) ?? toNumber(body.chargedUsd);
            const newPrice = toNumber(body.newPriceUsd) ?? targetPrice.priceUsd;
            const fromRenewal = toNumber(body.creditsFromRenewal) ?? toNumber(body.newMonthlyCredits) ?? renewalCredits;
            const came = toNumber(body.creditsNow);
            const previous = asString(body.previousTier);
            return {
              outcome: 'done',
              message: `Moved to ${planName(target)} and charged ${formatUsd(charged ?? 0)} from ${wallet}. `
                + (came !== null
                  ? upgradeCreditsText(came, cancelled ? '' : `, and every renewal gives ${formatCredits(fromRenewal)}`, true)
                  : '')
                + (cancelled
                  ? `The plan is still cancelled and ends about a day after ${periodEnd}; action renew undoes the cancellation. `
                  : `The plan now costs ${formatUsd(newPrice)} every 30 days. `)
                + planChangeAgentNote(agent.status, 'the plan change'),
              result: {
                chargedUsd: charged,
                monthlyPriceUsd: newPrice,
                monthlyCredits: fromRenewal,
                ...(came !== null ? { creditsNow: came } : {}),
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
          message: `The plan is set to end after ${periodEnd}, so it does not renew on another plan. To keep the agent on ${planName(target)}, `
            + (route === 'card' && !cancelled
              ? `keep the plan in the dashboard first (${agent.dashboardUrl}), then change the plan.`
              : 'undo the cancellation first with action renew, then change the plan.'),
          ...(cancelled ? { nextAction: billingCall(guid, 'renew') } : {}),
        };
      }
      if (next === target) {
        return {
          outcome: 'not_needed',
          message: `The move to ${planName(target)} is already set: it starts with ${when}. Until then the agent keeps ${planName(current)} and its credits.`,
        };
      }
      if (teamCard) return { outcome: 'refused', message: cardPlan(`move it to ${planName(target)}`) };
      const smaller = agent.pricing?.[target];
      const card = route === 'card';
      const startsAt = agent.subscription?.periodEndsAt;
      return {
        outcome: 'quote',
        quote: {
          chargeNowUsd: 0,
          estimated: false,
          recurringUsd: smaller?.priceUsd ?? null,
          monthlyCredits: smaller?.monthlyCredits ?? null,
          paidFrom: card ? 'card' : paidFrom,
          plan: target,
          change: 'downgrade',
          ...(startsAt ? { startsAt } : {}),
        },
        message: `Move to ${planName(target)} at the next renewal: nothing is charged or refunded now. The agent keeps ${planName(current)} and its credits until ${periodEnd}. `
          + `From ${when} the plan is ${planName(target)}${smaller ? `, ${planTerms(smaller)}` : ''}, ${card ? 'paid by card' : `paid from ${wallet}`}. `
          + `Asking for ${planName(current)} again before then undoes the move.`,
        confirmReason: 'Ask the user to confirm first: from the next renewal the agent has the smaller plan\'s credits.',
        perform: async signal => {
          // Wiro moves an agent to a smaller plan only when the request says so: a bare smaller plan is
          // refused, so an older client that asks for one as an upgrade changes nothing.
          const body = requireApiSuccess(
            await client.post<BillingEnvelope>('/UserAgent/UpgradeTier', { guid, targetTier: target, allowDowngrade: true }, signal),
            'The move to the smaller plan could not be set.',
          );
          if (asString(body.url)) return { outcome: 'refused', message: cardPlan(`move it to ${planName(target)}`) };
          const at = unixToIso(body.startsAt ?? body.effectiveAt ?? body.periodEnd) ?? startsAt;
          return {
            outcome: 'done',
            message: `The move to ${planName(target)} is set: it starts with the renewal after ${at ?? 'this period'}. Until then the agent keeps ${planName(current)} and its credits. Nothing was charged or refunded.`,
            result: { chargedUsd: 0, plan: current, nextPlan: target, change: 'downgrade', ...(at ? { startsAt: at } : {}) },
          };
        },
        verify: after => (after.nextPlan !== target ? `get_my_agent does not show the move to ${planName(target)} yet; check it again in a minute.` : null),
      };
    }

    case 'buy_credits': {
      if (!active) {
        const open = unsettled('Extra credits need an active plan.');
        return { outcome: 'refused', message: open ?? 'Extra credits need an active plan. Use action subscribe or renew first.' };
      }
      if (route === 'card') return { outcome: 'refused', message: cardPlan('buy the pack') };
      const packs = agent.extraCreditPacks;
      const packList = packs.map(item => `${item.pack} (${formatCredits(item.credits)} credits for ${formatUsd(item.priceUsd)})`).join(', ');
      if (!input.pack) {
        return {
          outcome: 'refused',
          ...(packs.length > 0 ? { heading: 'Available packs' } : {}),
          message: packs.length > 0 ? `Choose a pack: ${packList}.` : 'No extra credit packs are available for this agent yet.',
          ...(packs[0] ? { nextAction: billingCall(guid, 'buy_credits', { pack: packs[0].pack }) } : {}),
        };
      }
      const chosen = packs.find(item => item.pack === input.pack);
      if (!chosen) {
        return {
          outcome: 'refused',
          message: `The ${input.pack} pack is not available for this agent.${packList ? ` Available: ${packList}.` : ''}`,
        };
      }
      return {
        outcome: 'quote',
        quote: { chargeNowUsd: chosen.priceUsd, estimated: false, creditsAdded: chosen.credits, paidFrom, pack: chosen.pack },
        message: `Buy the ${chosen.pack} pack: ${formatUsd(chosen.priceUsd)} now from ${wallet} for ${formatCredits(chosen.credits)} extra credits, added at once. Extra credits are used after the monthly credits, do not reset each month and end 6 months (180 days) after purchase. ${planChangeAgentNote(agent.status, 'a credit pack', true)} This is a one-time charge.`,
        perform: async signal => {
          const body = requireApiSuccess(
            await client.post<BillingEnvelope>('/UserAgent/CreateExtraCreditCheckout', {
              useragentguid: guid,
              pack: chosen.pack,
              requestid: input.requestId,
            }, signal),
            'The credit pack could not be bought.',
          );
          if (asString(body.url)) return { outcome: 'refused', message: cardPlan('buy the pack') };
          return {
            outcome: 'done',
            message: `Bought the ${chosen.pack} pack: ${formatCredits(chosen.credits)} credits for ${formatUsd(chosen.priceUsd)} from ${wallet}. The credits are added. ${planChangeAgentNote(agent.status, 'a credit pack')}`,
            result: { chargedUsd: chosen.priceUsd, creditsAdded: chosen.credits },
            nextAction: waitIfStarting(agent),
          };
        },
      };
    }
  }
}

/** The arguments that repeat a quoted action with the user's approval. */
function confirmArguments(guid: string, action: BillingAction, quote: Quote | undefined, requestId: string | undefined): Record<string, unknown> {
  const amount = approvalAmountOf(action, quote);
  return {
    agent_guid: guid,
    action,
    ...((action === 'subscribe' || action === 'change_plan') && quote?.plan ? { plan: quote.plan } : {}),
    ...(quote?.pack ? { pack: quote.pack } : {}),
    ...(requestId ? { request_id: requestId } : {}),
    ...(amount !== null ? { confirm_charge_usd: amount } : {}),
    confirm: true,
  };
}

function retryPurchaseText(guid: string, quote: Quote | undefined, requestId: string): string {
  const amount = chargeOf(quote);
  return `To retry, call manage_agent_billing again with agent_guid "${guid}", action buy_credits, pack "${quote?.pack ?? ''}", request_id "${requestId}"${amount !== null ? `, confirm_charge_usd ${amount}` : ''} and confirm: true. That request id never charges twice, and repeating it completes this same purchase. Do not get a new quote for this purchase: a new request id is a new purchase.`
    + (amount !== null ? ` This request id works only while the pack costs ${formatUsd(amount)}. If the price changes, do not buy again: check get_my_agent and the wallet balance with get_account, and if the balance changed, contact Wiro support.` : '');
}

/**
 * Whether the agent's packs show an active one of this size bought since
 * the request was sent, or null when they cannot be read. A lot is dated
 * when the purchase starts, before the wallet is charged; the margin covers
 * a local clock that differs from Wiro's.
 */
async function freshPackShows(
  client: WiroClient,
  guid: string,
  credits: number,
  sentAtMs: number,
  signal: AbortSignal,
): Promise<boolean | null> {
  try {
    const ledger = requireApiSuccess(
      await client.post<BillingEnvelope>('/UserAgent/TransactionList', { useragentguid: guid, limit: 1, start: 0 }, signal),
      'The credit history could not be read.',
    );
    const summary = isPlainObject(ledger.summary) ? ledger.summary : {};
    const lots = Array.isArray(summary.extrapacks) ? summary.extrapacks.filter(isPlainObject) : [];
    const since = sentAtMs / 1000 - 900;
    return lots.some(lot => lot.status === 'active'
      && toNumber(lot.credits) === credits
      && (toNumber(lot.purchasedat) ?? 0) >= since);
  } catch {
    return null;
  }
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
  requestId: string | undefined,
  sentAtMs: number,
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
    case 'buy_credits': {
      const credits = quote?.creditsAdded ?? 0;
      const rose = after.credits.extra - before.credits.extra;
      const bought: Result = { chargedUsd: charged, creditsAdded: credits };
      if (credits > 0 && rose >= credits / 2) {
        return {
          happened: true,
          row,
          text: `The agent's extra credits rose by ${formatCredits(rose)}, so the purchase went through. Do not buy it again.`,
          result: bought,
          nextAction: waitIfStarting(before),
        };
      }
      const fresh = await freshPackShows(client, before.guid, credits, sentAtMs, signal);
      if (fresh) {
        // The pack shows on the agent. If its credits do not show yet, the same
        // request id completes the purchase without a second charge.
        return {
          happened: true,
          row,
          text: 'A new pack of that size shows on the agent, so the purchase went through. Do not buy it again. '
            + `If get_my_agent does not show its credits in a few minutes, repeat this purchase with the same request_id "${requestId ?? ''}" and confirm_charge_usd ${charged ?? ''}; that request id never charges twice.`,
          result: bought,
          nextAction: waitAction(before.guid, 'Check that the pack\'s credits show on the agent.'),
        };
      }
      return {
        happened: false,
        text: fresh === false ? 'No new pack shows on the agent yet.' : 'The agent\'s packs could not be read to check it.',
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

function annotateKnownRefusal(error: ApiResultError, requestId?: string): Error {
  const text = error.message;
  if (error.codes.some(code => Number(code) === 104)) {
    return new Error(`${text}\n\n${BUSY_NOTE}${requestId ? ` To try again, repeat the call with request_id "${requestId}"; that request id never charges twice.` : ''}`);
  }
  if (isWalletNotRead(error)) return new Error(`${text}\n\n${WALLET_NOT_READ_NOTE}`);
  if (SMALLER_PLAN_REFUSAL.test(text)) {
    // A move this server sent as one to a larger plan: the agent's plan moved up after it was read.
    return new Error(`${text}\n\nNothing was charged: the agent's plan changed after it was read. get_my_agent shows the plan it is on now, and change_plan quotes a move from it.`);
  }
  if (/insufficient wallet balance/i.test(text)) {
    return new Error(`${text}\n\nNothing was charged. Funds are added at https://wiro.ai/panel/wallet/deposit/credit-card (for a team project, select that team in the dashboard first); once the user has added them and says yes, try again. get_account shows the balance.`);
  }
  if (/purchase request id was already used/i.test(text)) {
    return new Error(`${text}\n\nNothing was charged now. This request id belongs to an earlier purchase of another pack or at another price. For a new purchase, get a new quote without request_id. If the earlier purchase with this id ended without a clear result, do not buy again: check get_my_agent and the wallet balance with get_account, and if the balance changed, contact Wiro support.`);
  }
  const hint = workspaceHint(text);
  if (hint) return new Error(`${text}\n\n${hint}`);
  return error;
}

export function registerManageAgentBilling(server: McpServer, client: WiroClient): void {
  server.registerTool(
    'manage_agent_billing',
    {
      title: 'Manage a Wiro agent\'s plan and credits',
      description: 'Pay for, renew, change or cancel a deployed agent\'s plan, or buy extra credits. An agent has '
        + 'one of three plans, smallest first: Starter, Pro or Max. Each has a fixed monthly price and monthly credits, '
        + 'and every plan includes every skill. Charges come from the Wiro wallet of the agent\'s workspace (the team '
        + 'wallet for a team agent); the connected project must belong to that same workspace. Every call without '
        + 'confirm: true only returns what will happen and the amount (for a move to a larger plan, the prorated '
        + 'amount Wiro works out, or the most it can charge when that is worked out only at the change). Show it to '
        + 'the user, get their approval, then repeat the call with confirm: true and, for a charge, confirm_charge_usd '
        + 'set to the quoted amount (for a move to a larger plan, quote.maxChargeUsd); if the price changed in '
        + 'between, nothing is charged and a new quote comes back. Never repeat a confirmed charge that failed or '
        + 'timed out without checking get_my_agent first. '
        + 'subscribe starts a plan for an agent without one; renew undoes a cancellation or renews an expired '
        + 'wallet plan; change_plan moves to another plan: a larger plan starts now and charges the prorated '
        + 'difference for the rest of the period, a smaller plan starts with the next renewal and charges or refunds '
        + 'nothing, and asking for the plan the agent is on undoes a move set for the next renewal; buy_credits adds '
        + 'a credit pack, on any plan; cancel stops renewals with no refund. Plans renew every 30 days until '
        + 'cancelled. Renewals, plan changes and packs leave a running agent running. An agent whose plan is billed '
        + 'by card moves to a larger plan and is topped up in the Wiro dashboard, and a personal card plan is '
        + 'cancelled there; the tool returns the link and charges nothing. A personal card plan can move to a smaller '
        + 'plan here: the card pays the smaller plan from the next renewal; a team\'s card plan changes plans in the '
        + 'dashboard. A card plan that is moving to wallet billing '
        + 'pays change_plan and buy_credits from the wallet, and cancel works once the wallet bills it. A card plan '
        + 'whose last payment did not go through has not ended and takes no new plan: the payment is fixed in the '
        + 'dashboard, and the plan then renews by itself. On a team '
        + 'agent only a team admin, the organization\'s owner or the person who deployed the agent can pay for it or '
        + 'change its plan; other members are refused and nothing is charged.',
      inputSchema: strictInput({
        agent_guid: z.string().min(1).max(100)
          .describe('The deployed agent\'s guid, from list_my_agents or deploy_agent.'),
        action: z.enum(ACTIONS)
          .describe('subscribe, change_plan, cancel, renew or buy_credits.'),
        plan: z.enum(AGENT_PLANS).optional()
          .describe('subscribe: the plan to pay for (default: the agent\'s current plan, else starter). change_plan: the plan to move to; leave it out to get the plans with their prices.'),
        pack: z.enum(['small', 'medium', 'large']).optional()
          .describe('buy_credits only: the credit pack to buy. Leave it out to get the packs with their credits and prices.'),
        request_id: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/).optional()
          .describe('buy_credits only: the id returned by the quote. Repeating a purchase with the same id never charges twice. Every new purchase needs a new quote; an id whose purchase already completed buys nothing.'),
        confirm_charge_usd: z.number().min(0).max(100_000).optional()
          .describe('With confirm: true, the amount the user approved, from the quote\'s nextAction (quote.chargeNowUsd, or quote.maxChargeUsd for a move to a larger plan). Required for every action that charges: subscribe, change_plan to a larger plan, buy_credits and renewing an expired plan. If a fresh quote no longer matches it, nothing is charged and the new quote is returned. For a move to a larger plan it is the most the user agreed to pay now.'),
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
        requestId: z.string().optional(),
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
    async ({ agent_guid, action, plan: planInput, pack, request_id, confirm_charge_usd, confirm }, extra) => {
      const guid = agent_guid.trim();
      const requestId = action === 'buy_credits' ? request_id ?? newRequestId() : undefined;
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
        withRequestId?: boolean;
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
            ...(requestId && payload.withRequestId ? { requestId } : {}),
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
          ...(requestId ? [`request_id "${requestId}"`] : []),
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
            arguments: confirmArguments(guid, action, quoted.quote, requestId),
            reason: quoted.confirmReason ?? CHARGE_REASON,
          },
          agentRow: row,
          withRequestId: true,
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
          const again = await planFor(client, action, agent, raw, { plan: planInput, pack, requestId: requestId ?? '' }, extra.signal);
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
        plan = await planFor(client, action, agent, raw, { plan: planInput, pack, requestId: requestId ?? '' }, extra.signal);

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
            ? `${changedLead(action, plan.quote, amount, confirm_charge_usd, request_id)}\n\n`
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

        // A request id that already completed a purchase is answered with
        // success again, without a new charge or new credits. An older pack can
        // end at the same moment, so the extra credits can grow by less than
        // the pack, and the agent's packs decide.
        const credits = plan.quote?.creditsAdded ?? 0;
        const extraBefore = toNumber(row.extracredits);
        const extraAfter = afterRead ? toNumber(after.extracredits) : null;
        if (action === 'buy_credits' && performed.outcome === 'done' && credits > 0
          && extraBefore !== null && extraAfter !== null && extraAfter - extraBefore < credits / 2) {
          const fresh = await freshPackShows(client, guid, credits, sentAtMs, extra.signal);
          if (fresh === false) {
            return respond({
              outcome: 'not_needed',
              message: `Wiro answered request id "${requestId}" with a purchase that had already completed: the agent's extra credits did not grow and no new pack shows, so nothing new was bought or charged now. For another pack, get a new quote without request_id.`,
              nextAction: billingCall(guid, 'buy_credits', { pack: plan.quote?.pack }),
              agentRow: after,
            });
          }
          // A repeat adds no credits. A new pack can add none only when an older
          // pack ends at the same moment with at least as many left, so an answer
          // with no growth says only what holds in both cases.
          if (fresh && extraAfter <= extraBefore) {
            return respond({
              outcome: 'done',
              heading: 'Pack in place',
              message: `The ${plan.quote?.pack} pack is in place: ${formatCredits(credits)} credits for ${formatUsd(plan.quote?.chargeNowUsd)} from ${agent.workspace === 'team' ? 'the team wallet' : 'the personal wallet'}. This request id is charged only once. The agent's extra credits did not grow in this call, so if the id had already completed in an earlier call, nothing new was bought or charged now. ${planChangeAgentNote(agent.status, 'a credit pack')} For another pack, get a new quote without request_id.`,
              quote: plan.quote,
              result: { chargedUsd: null },
              nextAction: performed.nextAction,
              agentRow: after,
            });
          }
          return respond({
            outcome: 'done',
            message: fresh
              ? `${performed.message} The agent's extra credits grew by less than the pack, which happens when an older pack expires at the same moment. If this request id had already completed in an earlier call, it was charged only that once.`
              : `Wiro accepted request id "${requestId}", but the agent's extra credits did not grow by the pack size and its packs could not be read, so it is not confirmed whether this bought a new pack or repeated a purchase that had already completed. Check get_my_agent and the wallet balance with get_account before buying again.`,
            quote: plan.quote,
            result: fresh ? performed.result : { chargedUsd: null },
            nextAction: performed.nextAction,
            agentRow: after,
          });
        }
        // Without the read-back, the row shows the agent as it was before the change.
        const stale = !afterRead && performed.outcome === 'done';
        // A change the agent read again does not show yet is said, so the result never claims more than it shows.
        const notShown = afterRead && performed.outcome === 'done' && plan.verify ? plan.verify(toAgentSummary(after)) : null;
        return respond({
          outcome: performed.outcome,
          message: stale
            ? `${performed.message} The agent could not be read afterwards; get_my_agent shows its new status, plan and credits.`
            : notShown ? `${performed.message} ${notShown}` : performed.message,
          quote: plan.quote,
          result: performed.result,
          nextAction: performed.nextAction,
          agentRow: after,
          agentStale: stale,
        });
      } catch (error) {
        if (error instanceof ApiResultError && requestId && /still pending\. Retry with the same request id/i.test(error.message)) {
          return errorResult(new Error(`${error.message}\n\n${retryPurchaseText(guid, plan?.quote, requestId)}`));
        }
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
          const observed = await observeOpenOutcome(client, action, before, quote, requestId, sentAtMs, extra.signal);
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
          const retry = action === 'buy_credits' && requestId
            ? retryPurchaseText(guid, quote, requestId)
            : 'Do not repeat the call until this is checked.';
          return errorResult(new Error(`${text}\n\nThe request was sent and the answer does not show whether it went through. ${observed.text} ${retry}`));
        }
        if (error instanceof ApiResultError) return errorResult(annotateKnownRefusal(error, sentAtMs > 0 ? requestId : undefined));
        return errorResult(error);
      }
    },
  );
}
