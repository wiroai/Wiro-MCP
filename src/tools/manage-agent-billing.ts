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
import { DEFAULT_WAIT_SECONDS } from '../utils/poll.js';
import {
  AMOUNT_TOLERANCE_USD,
  agentDashboardUrl,
  agentSummarySchema,
  asTier,
  chargeRoute,
  formatAgentSummaryLines,
  formatCredits,
  formatUsd,
  outcomeUnknown,
  readAgentDetail,
  roundUsd,
  sameAmount,
  toAgentDetail,
  toAgentSummary,
  type AgentDetail,
  type NextAction,
} from '../utils/user-agent.js';
import { nextActionSchema } from './schemas.js';

const ACTIONS = ['subscribe', 'upgrade_to_pro', 'cancel', 'renew', 'buy_credits'] as const;
type BillingAction = typeof ACTIONS[number];
type PaidFrom = 'personal_wallet' | 'team_wallet' | 'card';
type Outcome = 'quote' | 'done' | 'not_needed' | 'refused';

const quoteSchema = z.object({
  chargeNowUsd: z.number().nullable(),
  estimated: z.boolean(),
  maxChargeUsd: z.number().optional(),
  recurringUsd: z.number().nullable().optional(),
  monthlyCredits: z.number().nullable().optional(),
  creditsAdded: z.number().optional(),
  paidFrom: z.enum(['personal_wallet', 'team_wallet', 'card']),
  tier: z.enum(['starter', 'pro']).optional(),
  pack: z.string().optional(),
});

type Quote = z.infer<typeof quoteSchema>;

const resultSchema = z.object({
  chargedUsd: z.number().nullable().optional(),
  monthlyPriceUsd: z.number().optional(),
  monthlyCredits: z.number().optional(),
  creditsAdded: z.number().optional(),
  tier: z.string().optional(),
  previousTier: z.string().optional(),
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
  message: string;
  quote?: Quote;
  nextAction?: NextAction;
  confirmReason?: string;
  perform?: (signal: AbortSignal) => Promise<Performed>;
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

function tierName(tier: string | undefined): string {
  return tier === 'pro' ? 'Pro' : 'Starter';
}

/** The amount a confirmed call charges now, or null when it charges nothing. */
function chargeOf(quote: Quote | undefined): number | null {
  const amount = quote?.chargeNowUsd ?? null;
  return amount !== null && amount > 0 ? amount : null;
}

/**
 * The amount the user approves with confirm_charge_usd, or null when the
 * call charges nothing. Wiro prorates an upgrade over the real length of
 * the billing period, which the 30-day estimate does not know, so an upgrade
 * is approved at its maximum: the full price difference, which the prorated
 * charge never exceeds.
 */
function approvalAmountOf(action: BillingAction, quote: Quote | undefined): number | null {
  if (action !== 'upgrade_to_pro') return chargeOf(quote);
  const max = quote?.maxChargeUsd ?? null;
  return max !== null && max > 0 ? max : null;
}

/**
 * Why a confirmed call may not charge yet: the approved amount is missing,
 * or the fresh quote no longer matches it. For an upgrade the approved
 * amount is a ceiling.
 */
function approvalProblem(action: BillingAction, quote: Quote | undefined, approved: number | undefined): 'missing' | 'changed' | null {
  const amount = approvalAmountOf(action, quote);
  if (amount === null) return null;
  if (approved === undefined) return 'missing';
  const fits = action === 'upgrade_to_pro'
    ? amount <= approved + AMOUNT_TOLERANCE_USD
    : sameAmount(amount, approved);
  return fits ? null : 'changed';
}

/** The first lines of a new quote when the approved amount no longer fits. */
function changedLead(action: BillingAction, amount: number | null, approved: number | undefined, callerRequestId: string | undefined): string {
  if (action === 'upgrade_to_pro') {
    return `The most this upgrade can charge changed since the quote: it is now ${formatUsd(amount)}, and the user approved at most ${formatUsd(approved)}. Nothing was charged. Show the new amount to the user and ask again.`;
  }
  const changed = `The amount changed since the quote: it is now ${formatUsd(amount)}, and the user approved ${formatUsd(approved)}.`;
  if (action === 'buy_credits' && callerRequestId) {
    // Wiro binds a purchase request id to the price of its first attempt.
    return `${changed} Nothing was charged by this call. Show the new amount to the user and ask again. `
      + `If an earlier call with request_id "${callerRequestId}" said the wallet was charged but the purchase is still pending, that purchase can only be finished at its original price, and Wiro refuses this request id at the new one. Do not approve the new amount for it; ask Wiro support to finish it.`;
  }
  return `${changed} Nothing was charged. Show the new amount to the user and ask again.`;
}

function planFor(
  client: WiroClient,
  action: BillingAction,
  agent: AgentDetail,
  raw: Record<string, unknown> | null,
  input: { tier?: 'starter' | 'pro'; pack?: string; requestId: string },
): Plan {
  const guid = agent.guid;
  const active = raw?.status === 'active';
  const prepaid = raw?.provider === 'prepaid';
  const cancelled = raw?.pendingdowngrade === 'cancel';
  const route = chargeRoute(raw);
  const paidFrom: PaidFrom = agent.workspace === 'team' ? 'team_wallet' : 'personal_wallet';
  const wallet = agent.workspace === 'team' ? 'the team wallet' : 'the personal wallet';
  const periodEnd = agent.subscription?.periodEndsAt ?? 'the end of the current period';
  const cardPlan = (what: string) => `This plan is billed by card, and card payments are made in the Wiro dashboard. Nothing was charged here. To ${what}, open ${agent.dashboardUrl}`;

  switch (action) {
    case 'subscribe': {
      if (active) {
        return {
          outcome: 'refused',
          message: 'This agent already has an active plan. Use renew to undo a cancellation, upgrade_to_pro to move to Pro, or buy_credits for more credits.',
        };
      }
      const tier = input.tier ?? asTier(agent.tier) ?? 'starter';
      const price = agent.pricing?.[tier];
      if (!price) throw new Error('This agent cannot be priced right now, so it cannot be subscribed. Try again later.');
      const missing = agent.missingCredentials;
      return {
        outcome: 'quote',
        quote: {
          chargeNowUsd: price.priceUsd,
          estimated: false,
          recurringUsd: price.priceUsd,
          monthlyCredits: price.monthlyCredits,
          paidFrom,
          tier,
        },
        message: `Subscribe on ${tierName(tier)}: ${formatUsd(price.priceUsd)} now from ${wallet}, then every 30 days until the plan is cancelled, with ${formatCredits(price.monthlyCredits)} credits per month. `
          + 'The agent is queued to start right after the payment.'
          + (missing.length > 0
            ? ` Missing credentials (${missing.map(item => item.title).join(', ')}) can be added afterwards; until then the skills that need them fail.`
            : ''),
        perform: async signal => {
          const body = requireApiSuccess(
            await client.post<BillingEnvelope>('/UserAgent/CreateSubscriptionCheckout', {
              useragentguid: guid,
              useprepaid: true,
              tier,
            }, signal),
            'The plan could not be started.',
          );
          const charged = toNumber(body.monthlypriceusd) ?? price.priceUsd;
          const credits = toNumber(body.monthlycredits) ?? price.monthlyCredits;
          return {
            outcome: 'done',
            message: `Subscribed on ${tierName(tier)} and charged ${formatUsd(charged)} from ${wallet}. The plan renews every 30 days until it is cancelled. The agent is starting.`,
            result: { chargedUsd: charged, monthlyPriceUsd: charged, monthlyCredits: credits, tier },
            nextAction: waitAction(guid, 'Wait until the agent is running.'),
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
          // A card plan can be set to stop at its period end, by its payer or when the
          // payer's account is deleted.
          return {
            outcome: 'refused',
            message: agent.subscription?.cancelAtPeriodEnd
              ? `This plan is billed by card and is set to stop renewing after ${periodEnd}. Card plans are managed `
                + `from the dashboard, where it can be kept: ${agent.dashboardUrl}`
              : `This plan is billed by card and renews by itself. It is managed from the dashboard: ${agent.dashboardUrl}`,
          };
        }
        if (!cancelled) {
          return { outcome: 'not_needed', message: 'The plan is active and renews by itself. Nothing to do.' };
        }
        const amount = agent.subscription?.amountUsd ?? agent.monthlyPriceUsd;
        return {
          outcome: 'quote',
          quote: { chargeNowUsd: 0, estimated: false, recurringUsd: amount, monthlyCredits: agent.credits.monthly, paidFrom },
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
      const price = agent.monthlyPriceUsd ?? toNumber(raw.amount);
      if (!price || price <= 0) {
        return {
          outcome: 'refused',
          message: 'The renewal price of this plan is unknown. Use action subscribe to start a new plan.',
          nextAction: billingCall(guid, 'subscribe'),
        };
      }
      const tier = asTier(agent.tier);
      return {
        outcome: 'quote',
        quote: {
          chargeNowUsd: price,
          estimated: false,
          recurringUsd: price,
          monthlyCredits: tier ? agent.pricing?.[tier].monthlyCredits ?? null : null,
          paidFrom,
          ...(tier ? { tier } : {}),
        },
        message: `Renew the expired plan: ${formatUsd(price)} now from ${wallet}, then every 30 days until it is cancelled. A stopped or failed agent is queued to start again.`,
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
            nextAction: waitAction(guid, 'Wait until the agent is running again.'),
          };
        },
      };
    }

    case 'cancel': {
      if (!active) return { outcome: 'not_needed', message: 'There is no active plan to cancel.' };
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
        if (agent.workspace === 'personal') {
          return {
            outcome: 'refused',
            message: `This plan is billed by card. Card plans are cancelled from the dashboard: ${agent.dashboardUrl}`,
          };
        }
        if (raw?.nextprovider === 'prepaid') {
          return {
            outcome: 'refused',
            message: 'A switch to wallet billing is already scheduled for this plan, so it cannot be cancelled here.',
          };
        }
        if (agent.subscription?.cancelAtPeriodEnd) {
          return { outcome: 'not_needed', message: `The plan is already set to end after ${periodEnd}.` };
        }
        return {
          outcome: 'quote',
          quote: { chargeNowUsd: 0, estimated: false, paidFrom: 'card' },
          message: `Cancel the team's card plan at the end of the current period (${periodEnd}). Nothing is refunded.`,
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
        message: `Cancel the plan: nothing is refunded and it stops renewing. The agent keeps its monthly credits until about a day after ${periodEnd}; then the monthly credits end and the agent stops unless it has extra credits left. Action renew undoes the cancellation before then.`,
        confirmReason: 'Ask the user to confirm the cancellation first.',
        perform: performCancel,
      };
    }

    case 'upgrade_to_pro': {
      if (!active) {
        return {
          outcome: 'refused',
          message: 'Upgrading needs an active plan. Use action subscribe with tier pro instead.',
          nextAction: billingCall(guid, 'subscribe', { tier: 'pro' }),
        };
      }
      if (agent.tier === 'pro') return { outcome: 'not_needed', message: 'The agent is already on Pro.' };
      // No checkout pages are opened for card plans: the user pays them in the dashboard.
      if (route === 'card') return { outcome: 'refused', message: cardPlan('upgrade it to Pro') };
      const pro = agent.pricing?.pro;
      if (!pro) throw new Error('The Pro price of this agent is not available right now. Try again later.');
      const ending = `The plan is cancelled, so it ends about a day after ${periodEnd} and does not renew at the Pro price; this charge covers only the days left. To keep the plan, undo the cancellation first with action renew.`;
      const current = agent.monthlyPriceUsd ?? agent.subscription?.amountUsd ?? 0;
      const periodEndSeconds = toNumber(raw?.currentperiodend);
      const daysLeft = periodEndSeconds !== null
        ? Math.max(0, Math.round((periodEndSeconds - Date.now() / 1000) / 86_400))
        : 30;
      const maxCharge = roundUsd(Math.max(0, pro.priceUsd - current));
      const estimate = roundUsd(Math.max(0, ((pro.priceUsd - current) / 30) * daysLeft));
      return {
        outcome: 'quote',
        quote: {
          chargeNowUsd: estimate,
          estimated: true,
          maxChargeUsd: maxCharge,
          recurringUsd: cancelled ? null : pro.priceUsd,
          monthlyCredits: pro.monthlyCredits,
          paidFrom,
          tier: 'pro',
        },
        message: `Upgrade to Pro: about ${formatUsd(estimate)} now from ${wallet} for the ${daysLeft} days left in this period. `
          + `Wiro works out the exact amount from the real length of the billing period, and it is never more than ${formatUsd(maxCharge)}, so that is the amount to approve. `
          + (cancelled ? `${ending} ` : `From the next renewal the plan costs ${formatUsd(pro.priceUsd)} every 30 days. `)
          + `The monthly pool rises to ${formatCredits(pro.monthlyCredits)} credits at once and the agent restarts. To go back to Starter later, cancel, let the plan end, then subscribe to Starter.`,
        perform: async signal => {
          const body = requireApiSuccess(
            await client.post<BillingEnvelope>('/UserAgent/UpgradeTier', { guid, targetTier: 'pro' }, signal),
            'The plan could not be upgraded.',
          );
          if (asString(body.url)) {
            // Wiro opened a card checkout after all. Its link is a payment page for the owner's card, so it is not passed on.
            return { outcome: 'refused', message: cardPlan('upgrade it to Pro') };
          }
          const charged = toNumber(body.proratedCharge);
          const newPrice = toNumber(body.newPriceUsd) ?? pro.priceUsd;
          const newCredits = toNumber(body.newMonthlyCredits) ?? pro.monthlyCredits;
          const previousTier = asString(body.previousTier);
          return {
            outcome: 'done',
            message: `Upgraded to Pro and charged ${formatUsd(charged ?? 0)} from ${wallet}. `
              + (cancelled
                ? `The plan is still cancelled and ends about a day after ${periodEnd}; action renew undoes the cancellation. `
                : `The plan now costs ${formatUsd(newPrice)} every 30 days. `)
              + `The monthly pool is ${formatCredits(newCredits)} credits. The agent restarts.`,
            result: {
              chargedUsd: charged,
              monthlyPriceUsd: newPrice,
              monthlyCredits: newCredits,
              tier: 'pro',
              ...(previousTier ? { previousTier } : {}),
            },
            nextAction: waitAction(guid, 'Wait until the agent is running again.'),
          };
        },
      };
    }

    case 'buy_credits': {
      if (!active) {
        return { outcome: 'refused', message: 'Extra credits need an active plan. Use action subscribe or renew first.' };
      }
      if (agent.tier !== 'pro') {
        return {
          outcome: 'refused',
          message: 'Extra credit packs are only available on Pro. Upgrade first with action upgrade_to_pro.',
          nextAction: billingCall(guid, 'upgrade_to_pro'),
        };
      }
      if (route === 'card') return { outcome: 'refused', message: cardPlan('buy the pack') };
      const packs = agent.extraCreditPacks;
      const packList = packs.map(item => `${item.pack} (${formatCredits(item.credits)} credits for ${formatUsd(item.priceUsd)})`).join(', ');
      if (!input.pack) {
        return {
          outcome: 'refused',
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
        message: `Buy the ${chosen.pack} pack: ${formatUsd(chosen.priceUsd)} now from ${wallet} for ${formatCredits(chosen.credits)} extra credits, added at once. Extra credits are used after the monthly credits and do not reset each month. The agent restarts to pick them up. This is a one-time charge.`,
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
            message: `Bought the ${chosen.pack} pack: ${formatCredits(chosen.credits)} credits for ${formatUsd(chosen.priceUsd)} from ${wallet}. The credits are added and the agent restarts to pick them up.`,
            result: { chargedUsd: chosen.priceUsd, creditsAdded: chosen.credits },
            nextAction: waitAction(guid, 'Wait until the agent is running again.'),
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
    ...(action === 'subscribe' && quote?.tier ? { tier: quote.tier } : {}),
    ...(quote?.pack ? { pack: quote.pack } : {}),
    ...(requestId ? { request_id: requestId } : {}),
    ...(amount !== null ? { confirm_charge_usd: amount } : {}),
    confirm: true,
  };
}

function retryPurchaseText(guid: string, quote: Quote | undefined, requestId: string): string {
  const amount = chargeOf(quote);
  return `To retry, call manage_agent_billing again with agent_guid "${guid}", action buy_credits, pack "${quote?.pack ?? ''}", request_id "${requestId}"${amount !== null ? `, confirm_charge_usd ${amount}` : ''} and confirm: true. That request id never charges twice, and it finishes a purchase that was charged but not completed. Do not get a new quote for this purchase: a new request id is a new purchase.`
    + (amount !== null ? ` This works only while the pack still costs ${formatUsd(amount)}; Wiro refuses the id at any other price, and then Wiro support has to finish the purchase.` : '');
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
 * After a charging request whose outcome is open, reads the agent again and
 * says what it shows. Wiro can fail after the wallet was charged, and Detail
 * is the only place the result shows up.
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
    return { happened: false, text: 'The agent could not be read afterwards to check it.' };
  }
  const after = toAgentDetail(row);
  const charged = chargeOf(quote);
  const restart = waitAction(before.guid, 'Wait until the agent is running again.');
  switch (action) {
    case 'subscribe':
      return after.subscription?.status === 'active'
        ? {
          happened: true,
          row,
          text: 'The agent now has an active plan, so the payment went through. Do not subscribe again.',
          result: { chargedUsd: charged, ...(quote?.tier ? { tier: quote.tier } : {}) },
          nextAction: waitAction(before.guid, 'Wait until the agent is running.'),
        }
        : { happened: false, text: 'The agent shows no active plan yet. Check get_my_agent again in a minute before trying again.' };
    case 'renew':
      return after.subscription?.status === 'active'
        ? {
          happened: true,
          row,
          text: 'The plan is active again, so the renewal went through. Do not renew it again.',
          result: { chargedUsd: charged, renewal: 'renewed' },
          nextAction: restart,
        }
        : { happened: false, text: 'The plan still shows as expired, but the wallet may have been charged anyway. Compare the wallet balance with get_account before renewing again.' };
    case 'upgrade_to_pro': {
      if (after.tier === 'pro') {
        return {
          happened: true,
          row,
          text: `The agent is on Pro now, so the upgrade went through. Do not upgrade again. The prorated charge is not shown, and it is at most ${formatUsd(quote?.maxChargeUsd)}.`,
          result: { chargedUsd: null, tier: 'pro' },
          nextAction: restart,
        };
      }
      const proPrice = before.pricing?.pro.priceUsd;
      const priced = proPrice !== undefined && [after.monthlyPriceUsd, after.subscription?.amountUsd ?? null]
        .some(value => value !== null && sameAmount(value, proPrice));
      return {
        happened: false,
        text: priced
          ? 'The plan already shows the Pro price but not the Pro tier, so the upgrade was charged and did not finish. Do not upgrade again; ask Wiro support to finish it.'
          : 'The agent still shows Starter, but the wallet may have been charged anyway. Compare the wallet balance with get_account before trying again.',
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
          nextAction: restart,
        };
      }
      const fresh = await freshPackShows(client, before.guid, credits, sentAtMs, signal);
      if (fresh) {
        // The pack is paid for, but its credits are counted only when the
        // purchase finishes, which the same request id does without a charge.
        return {
          happened: true,
          row,
          text: 'A new pack of that size shows on the agent, so the purchase went through and the wallet was charged. Do not buy it again. '
            + `Its credits may not be counted yet. If get_my_agent still does not show them in a few minutes, repeating this purchase with the same request_id "${requestId ?? ''}" and confirm_charge_usd ${charged ?? ''} finishes it without a second charge.`,
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

function annotateKnownRefusal(error: ApiResultError): Error {
  const text = error.message;
  if (/insufficient wallet balance/i.test(text)) {
    return new Error(`${text}\n\nNothing was charged. Funds are added at https://wiro.ai/panel/wallet/deposit/credit-card; once the user has added them and says yes, try again. get_account shows the balance.`);
  }
  if (/purchase request id was already used/i.test(text)) {
    return new Error(`${text}\n\nNothing was charged now. This request id belongs to an earlier purchase of another pack or at another price. For a new purchase, get a new quote without request_id. If an earlier call with this id said the wallet was charged but the purchase is still pending, do not buy again: that purchase can only be finished at its original price, so ask Wiro support to finish it.`);
  }
  if (/switch to (the )?(team|personal) context|personal workspace|different team/i.test(text)) {
    return new Error(`${text}\n\nBilling changes need an API key from the agent's own workspace: a team project's key for a team agent, a personal project's key for a personal agent.`);
  }
  return error;
}

export function registerManageAgentBilling(server: McpServer, client: WiroClient): void {
  server.registerTool(
    'manage_agent_billing',
    {
      title: 'Manage a Wiro agent\'s plan and credits',
      description: 'Pay for, renew, upgrade or cancel a deployed agent\'s plan, or buy extra credits. Charges '
        + 'come from the Wiro wallet of the agent\'s workspace (the team wallet for a team agent); the API key '
        + 'must belong to that same workspace. Every call without confirm: true only returns what will happen '
        + 'and the amount (for a prorated upgrade, an estimate and its maximum). Show it to the user, get '
        + 'their approval, then repeat the call with confirm: true and confirm_charge_usd set to the quoted '
        + 'amount (for an upgrade, its maximum); if the price changed in between, nothing is charged and a '
        + 'new quote comes back. Never repeat a confirmed charge that failed or timed out without checking '
        + 'get_my_agent first. '
        + 'subscribe starts a plan for an agent without one; renew undoes a cancellation or renews an expired '
        + 'wallet plan; upgrade_to_pro charges the prorated difference now; buy_credits adds a credit pack '
        + '(Pro only); cancel stops renewals with no refund. Plans renew every 30 days until cancelled. An '
        + 'agent whose plan is billed by card is upgraded and topped up in the Wiro dashboard, and a personal '
        + 'card plan is cancelled there; the tool returns the link and charges nothing.',
      inputSchema: {
        agent_guid: z.string().min(1).max(100)
          .describe('The deployed agent\'s guid, from list_my_agents or deploy_agent.'),
        action: z.enum(ACTIONS)
          .describe('subscribe, upgrade_to_pro, cancel, renew or buy_credits.'),
        tier: z.enum(['starter', 'pro']).optional()
          .describe('subscribe only: the tier to pay for (default: the agent\'s current tier).'),
        pack: z.enum(['small', 'medium', 'large']).optional()
          .describe('buy_credits only: the credit pack to buy. Leave it out to get the packs with their credits and prices.'),
        request_id: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/).optional()
          .describe('buy_credits only: the id returned by the quote. Repeating a purchase with the same id never charges twice. Every new purchase needs a new quote; an id whose purchase already completed buys nothing.'),
        confirm_charge_usd: z.number().min(0).max(100_000).optional()
          .describe('With confirm: true, the amount the user approved, from the quote\'s nextAction (quote.chargeNowUsd, or quote.maxChargeUsd for upgrade_to_pro). Required for every action that charges: subscribe, upgrade_to_pro, buy_credits and renewing an expired plan. If a fresh quote no longer matches it, nothing is charged and the new quote is returned. For upgrade_to_pro it is the most the user agreed to pay now.'),
        confirm: z.boolean().default(false)
          .describe('false returns only the quote. true performs the action. Set it only after the user approved it.'),
      },
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
    async ({ agent_guid, action, tier, pack, request_id, confirm_charge_usd, confirm }, extra) => {
      const guid = agent_guid.trim();
      const requestId = action === 'buy_credits' ? request_id ?? newRequestId() : undefined;
      let sentAtMs = 0;
      let before: AgentDetail | undefined;
      let plan: Plan | undefined;

      const respond = (payload: {
        outcome: Outcome;
        message: string;
        quote?: Quote;
        priceChanged?: boolean;
        result?: Result;
        nextAction?: NextAction;
        agentRow: Record<string, unknown>;
        withRequestId?: boolean;
      }) => {
        const summary = toAgentSummary(payload.agentRow);
        const dashboardUrl = before?.dashboardUrl ?? agentDashboardUrl(guid);
        const heading = {
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
              ...formatAgentSummaryLines(summary),
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

      try {
        const row = await readAgentDetail(client, guid, extra.signal);
        const agent = toAgentDetail(row);
        before = agent;
        const raw = isPlainObject(row.subscription) ? row.subscription : null;
        plan = planFor(client, action, agent, raw, { tier, pack, requestId: requestId ?? '' });

        if (plan.outcome !== 'quote' || !plan.perform) {
          return respond({ outcome: plan.outcome, message: plan.message, nextAction: plan.nextAction, agentRow: row });
        }
        const problem = confirm ? approvalProblem(action, plan.quote, confirm_charge_usd) : null;
        if (!confirm || problem) {
          const amount = approvalAmountOf(action, plan.quote);
          const lead = problem === 'changed'
            ? `${changedLead(action, amount, confirm_charge_usd, request_id)}\n\n`
            : problem === 'missing'
              ? 'Nothing was charged: confirm_charge_usd is missing. It is the amount the user approved, and it must be sent with confirm: true.\n\n'
              : '';
          const additions = [
            ...(requestId ? [`request_id "${requestId}"`] : []),
            ...(amount !== null ? [`confirm_charge_usd ${amount}`] : []),
            'confirm: true',
          ];
          return respond({
            outcome: 'quote',
            message: `${lead}${plan.message}\n\nNothing has been done yet. To go ahead, call manage_agent_billing again with the same arguments plus ${additions.join(', ')}.`,
            quote: plan.quote,
            ...(problem === 'changed' ? { priceChanged: true } : {}),
            nextAction: {
              tool: 'manage_agent_billing',
              arguments: confirmArguments(guid, action, plan.quote, requestId),
              reason: plan.confirmReason ?? CHARGE_REASON,
            },
            agentRow: row,
            withRequestId: true,
          });
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
        // success again, without a charge and without new credits. The
        // purchase also expires any overdue pack, which can hide the new
        // credits, so the agent's packs decide.
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
        return respond({
          outcome: performed.outcome,
          message: performed.message,
          quote: plan.quote,
          result: performed.result,
          nextAction: performed.nextAction,
          agentRow: after,
        });
      } catch (error) {
        if (error instanceof ApiResultError && requestId && /still pending\. Retry with the same request id/i.test(error.message)) {
          return errorResult(new Error(`${error.message}\n\n${retryPurchaseText(guid, plan?.quote, requestId)}`));
        }
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
              message: `Wiro answered with an error (${text}) after the request was sent, but reading the agent again shows that it went through. ${observed.text}`,
              quote,
              result: observed.result,
              nextAction: observed.nextAction,
              agentRow: observed.row,
            });
          }
          const retry = action === 'buy_credits' && requestId
            ? retryPurchaseText(guid, quote, requestId)
            : 'Do not repeat the call until this is checked.';
          return errorResult(new Error(`${text}\n\nThe request was sent and the answer does not show whether it went through, so the wallet may have been charged. ${observed.text} ${retry}`));
        }
        if (error instanceof ApiResultError) return errorResult(annotateKnownRefusal(error));
        return errorResult(error);
      }
    },
  );
}
