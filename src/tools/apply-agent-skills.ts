import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WiroClient } from '../client.js';
import {
  asString,
  errorResult,
  errorText,
  isPlainObject,
  requireApiSuccess,
  toNumber,
  unixToIso,
  type ApiEnvelope,
} from '../utils/api.js';
import {
  agentStatusLabel,
  agentStatusOf,
  checkSkillSet,
  credentialsNeededFor,
  customSkillEntries,
  daysLeftText,
  describeSkillsApplyError,
  diffSkills,
  enabledSkillNames,
  formatUsd,
  isAgentRunning,
  loadSkillRegistry,
  newSkillChangeKey,
  parseSkillChangeKey,
  planBilling,
  planSkillChanges,
  readPlanChange,
  readUserAgent,
  underOneDayLeft,
  restartNote,
  skillChangeDigest,
  skillPriceTag,
  workspaceHint,
  type PlanBilling,
  type PlanChange,
  type SkillDiff,
} from '../utils/agent-config.js';
import { asTier, bindProjectStep, formatCredits, outcomeUnknown, toTierPricing, WIRO_PROJECT_CREDENTIAL } from '../utils/user-agent.js';
import { DEFAULT_WAIT_SECONDS } from '../utils/poll.js';
import { isPlainTeamMember, teamAgentBillingRefused } from '../utils/workspace.js';
import { nextActionSchema, strictInput } from './schemas.js';

const pricingSchema = z.object({
  currentMonthlyUsd: z.number().nullable(),
  newMonthlyUsd: z.number().nullable(),
  deltaMonthlyUsd: z.number().nullable(),
  currentMonthlyCredits: z.number().nullable()
    .describe('The monthly credits each renewal grants now.'),
  newMonthlyCredits: z.number().nullable()
    .describe('The monthly credits each renewal grants after the change.'),
  deltaMonthlyCredits: z.number().nullable(),
  creditsNow: z.number().optional()
    .describe('The credits this period gains now, below 0 when it loses them: the change counts for the time left in the period.'),
  creditsThisPeriod: z.number().optional()
    .describe('The monthly credits this period grants in all after the change.'),
  creditsFromRenewal: z.number().optional()
    .describe('The monthly credits every renewal grants after the change.'),
  periodEnd: z.string().optional()
    .describe('When the current period ends.'),
  note: z.string().optional(),
});

const outputSchema = {
  agentGuid: z.string(),
  status: z.enum(['quote', 'applied', 'no_change', 'refused']),
  idempotencyKey: z.string().optional(),
  priceChanged: z.boolean().optional(),
  changes: z.object({
    enable: z.array(z.string()),
    disable: z.array(z.string()),
    addedDependencies: z.array(z.string()),
    alreadySet: z.array(z.string()),
  }),
  tier: z.object({
    current: z.string().nullable(),
    next: z.string().nullable(),
  }),
  pricing: pricingSchema.optional(),
  billing: z.object({
    plan: z.enum(['prepaid', 'card', 'none']),
    subscriptionStatus: z.string().nullable(),
    wallet: z.enum(['team', 'personal']),
    estimatedChargeNowUsd: z.number().nullable().optional()
      .describe('What a wallet plan pays now at list price, as Wiro works it out, before any discount on the wallet; 0 on a card plan, whose difference goes to the card subscription.'),
    creditNowUsd: z.number().nullable().optional()
      .describe('For a drop on a wallet plan, what goes back to the balances that paid; null when it is worked out when the change is applied.'),
    usedCreditsUsd: z.number().nullable().optional()
      .describe('The part of a credit that comes off for credits already used above what the plan keeps.'),
    chargedNowUsd: z.number().nullable().optional(),
    note: z.string(),
  }),
  enabledSkills: z.array(z.string()).optional(),
  credentialsNeeded: z.array(z.object({
    skill: z.string(),
    credentials: z.array(z.string()),
  })),
  scheduledTasks: z.object({
    stop: z.array(z.string())
      .describe('Scheduled tasks that stop running because the change turns off every skill that brings them. Their text, schedule and on/off state stay while they wait, and get_my_agent names the skills to turn on to run them again.'),
    resume: z.array(z.string())
      .describe('Scheduled tasks that run again because the change turns on the skills they wait for, one from each list in their offSkills, while the services they need are connected.'),
  }).optional()
    .describe('Quote: the scheduled tasks that are on and that the change stops or brings back.'),
  agentStatus: z.string(),
  restart: z.string(),
  error: z.object({
    code: z.number().nullable(),
    message: z.string(),
    deps: z.array(z.object({ skill: z.string(), requires: z.string() })).optional(),
    conflicts: z.array(z.object({ a: z.string(), b: z.string() })).optional(),
    requiredUsd: z.number().nullable().optional(),
    availableUsd: z.number().nullable().optional(),
  }).optional(),
  nextAction: nextActionSchema.optional(),
};

type Row = Record<string, unknown>;

type PricingPreviewBody = ApiEnvelope & {
  tier?: string;
  totalPriceUsd?: unknown;
  totalMonthlyCredits?: unknown;
  enabledSkills?: unknown;
  planChange?: unknown;
};

type SkillsApplyBody = ApiEnvelope & {
  noOp?: boolean;
  pricing?: Record<string, unknown>;
  tier?: string;
  stripeProrationApplied?: boolean;
  prepaidWalletDelta?: unknown;
  prepaidCreditParts?: unknown;
  usedCreditsUsd?: unknown;
  prepaidCreditFailedUsd?: unknown;
  restartTriggered?: unknown;
  warnings?: unknown;
};

const UNCHANGED_RESTART = 'Nothing changed, so the agent does not restart.';
// The tier and the price live with Wiro, and the agent reads neither: only a skill that turns on or off restarts it.
const TIER_ONLY_RESTART = 'No skill turns on or off, so a change of the tier alone does not restart the agent.';

function roundCents(usd: number): number {
  return Math.round(usd * 100) / 100;
}

/**
 * How long an applied credit lasts, from the parts Wiro says it split into. Each
 * part went back to the balance that paid it and keeps that balance's end date,
 * except the part whose source has ended since (each ...UntilPeriodEndUsd): that
 * part lasts until the plan's current period ends. The two amounts add up to the
 * credit, and parts that come to nothing say nothing.
 */
function creditTerms(parts: unknown): string {
  if (!isPlainObject(parts)) return '';
  const usd = (key: string) => toNumber(parts[key]) ?? 0;
  const untilEnd = roundCents(usd('couponUntilPeriodEndUsd') + usd('storeUntilPeriodEndUsd') + usd('depositUntilPeriodEndUsd'));
  const keepsEnd = roundCents(roundCents(usd('couponUsd') + usd('storeUsd') + usd('depositUsd')) - untilEnd);
  if (keepsEnd > 0 && untilEnd > 0) {
    return `${formatUsd(keepsEnd)} of it went back to the balances that paid and keeps their end dates, and ${formatUsd(untilEnd)} lasts until this period ends, because the credit that paid it has ended.`;
  }
  if (keepsEnd > 0) return 'It went back to the balances that paid and keeps their end dates.';
  return untilEnd > 0 ? 'It lasts until this period ends, because the credit that paid it has ended.' : '';
}

/** A count of credits with its sign, such as +97 or -690. */
function signedCredits(credits: number): string {
  return `${credits > 0 ? '+' : ''}${formatCredits(credits)}`;
}

/** The fields of Wiro's plan change that the pricing output carries. */
function periodFields(change: PlanChange | null) {
  if (!change) return {};
  const periodEnd = unixToIso(change.periodEnd);
  return {
    ...(change.creditsNow !== null ? { creditsNow: change.creditsNow } : {}),
    ...(change.creditsThisPeriod !== null ? { creditsThisPeriod: change.creditsThisPeriod } : {}),
    ...(change.creditsFromRenewal !== null ? { creditsFromRenewal: change.creditsFromRenewal } : {}),
    ...(periodEnd ? { periodEnd } : {}),
  };
}

/**
 * What a change does to this period's credits when none come with it: those it takes away end for the
 * time left, and the period keeps the rest. A plan priced again at today's rates can also keep its
 * credits, or gain some, while its price drops.
 */
function creditsEndNote(skillsOff: number, creditsNow: number | null, creditsThisPeriod: number | null): string {
  if (creditsNow !== null && creditsNow > 0) {
    return `This period gains ${formatCredits(creditsNow)} credits for the time left${creditsThisPeriod !== null ? `, ${formatCredits(creditsThisPeriod)} in all` : ''}.`;
  }
  if (creditsNow === 0) {
    return creditsThisPeriod !== null ? `This period keeps its ${formatCredits(creditsThisPeriod)} credits.` : 'This period keeps its credits.';
  }
  const keeps = creditsThisPeriod !== null ? `, and this period keeps ${formatCredits(creditsThisPeriod)}` : '';
  if (skillsOff === 0) return `The credits the change takes away end now for the time left${keeps}.`;
  return `${skillsOff === 1 ? 'Its' : 'Their'} credits for the time left end now${keeps}.`;
}

function difference(next: number | null, current: number | null): number | null {
  return next === null || current === null ? null : Math.round((next - current) * 100) / 100;
}

/**
 * A skill change prices the plan at today's prices for all its skills, so a
 * plan that started at other prices also changes for the skills it already
 * has, and so do its monthly credits. The agent's tiers carry today's prices
 * and credits for those skills. They are the base of the new price, not a price
 * the plan reaches. An agent without an active plan cannot take the change yet,
 * and a move to Pro prices the whole plan at today's Pro prices, which the quote
 * already shows.
 */
function todayPriceNote(row: Row, billing: PlanBilling, currentPrice: number | null, currentCredits: number | null, tierChange: string | undefined): string | null {
  if (tierChange) return null;
  const tier = asTier(row.tier);
  const tiers = toTierPricing(isPlainObject(row.agent) ? row.agent.tiers : undefined);
  const today = tier && tiers ? tiers[tier] : null;
  if (billing.status !== 'active' || currentPrice === null || today === null || !difference(today.priceUsd, currentPrice)) return null;
  const versus = currentCredits !== null && today.monthlyCredits !== currentCredits
    ? ` with ${formatCredits(today.monthlyCredits)} monthly credits, not its current ${formatUsd(currentPrice)} and ${formatCredits(currentCredits)}`
    : `, not its current ${formatUsd(currentPrice)}`;
  return `Today's ${tier === 'pro' ? 'Pro' : 'Starter'} price for the skills this plan already has is ${formatUsd(today.priceUsd)} a month${versus}. A skill change counts from today's price, and the new price in this quote already includes that.`;
}

/**
 * The wallet of the agent's workspace, which Wiro charges or credits for a
 * skill change: the team's for a team agent, else its owner's personal wallet.
 * Only the owner can change a personal agent's skills, so that wallet is the
 * caller's own.
 */
function walletName(billing: PlanBilling): string {
  return billing.wallet === 'team' ? 'the team wallet' : 'your personal wallet';
}

/** When the new monthly credits come: a plan set to end renews only if it is kept, and an agent without a plan gets them once it is subscribed. */
function creditsWhen(billing: PlanBilling): string {
  if (billing.plan === 'none') return 'a month once it is subscribed';
  return billing.status === 'active' && billing.cancelAtPeriodEnd === true
    ? 'at each renewal after the change, if the plan is kept'
    : 'at each renewal after the change';
}

/** When an active plan's next renewal gives the new monthly credits. A card plan whose renewal is not known names it as a condition. */
function renewalWhen(billing: PlanBilling): string {
  if (billing.cancelAtPeriodEnd === true) return 'from the next renewal, if the plan is kept';
  return billing.cancelAtPeriodEnd === null ? 'from the next renewal, if the plan renews' : 'from the next renewal';
}

/** What renewals give after an applied change: a plan that may not renew names it as a condition, as its quote did. */
function renewalGives(billing: PlanBilling, credits: number): string {
  return billing.cancelAtPeriodEnd === false ? `every renewal gives ${formatCredits(credits)}` : `${formatCredits(credits)} ${renewalWhen(billing)}`;
}

/** For a cancelled plan, a skill change only covers the time left: nothing renews at the new price. */
function cancelledNote(billing: PlanBilling): string {
  const end = billing.periodEnd !== null ? unixToIso(billing.periodEnd) : undefined;
  if (billing.plan === 'card') {
    return `The plan is set to end${end ? ` after ${end}` : ' with this period'} and does not renew.`;
  }
  return `The plan is cancelled and ends about a day after ${end ?? 'the end of this period'}, so this covers only the time left and the new price is not renewed. Undo the cancellation with manage_agent_billing (renew) to keep the plan.`;
}

/** A card subscription that ends with this period: the plan is set to end, or it moves to wallet billing. */
function cardEndsWithPeriod(billing: PlanBilling): boolean {
  return billing.plan === 'card' && (billing.cancelAtPeriodEnd === true || billing.switchingToWallet);
}

function walletSwitchNote(billing: PlanBilling, price: number | null): string {
  return `When this period ends, the plan moves to wallet billing and renews from ${walletName(billing)}${price !== null ? ` at ${formatUsd(price)} a month` : ''}.`;
}

// A card subscription that ends with this period is not renewed by card, so its notes point to no next invoice.
const CARD_ENDS_QUOTE = 'Nothing is charged now. The card subscription is updated to the new price for the rest of this period.';
// A card plan whose renewal is not known may also end with this period, so its next invoice is named only for a plan that renews by card.
const CARD_UNKNOWN_QUOTE = 'Nothing is charged now. The card subscription is updated to the new price, and a plan that renews by card shows the prorated difference on its next invoice.';

/** Only a wallet plan that has ended comes back with renew; any other plan that is not active takes a new one (manage_agent_billing). */
function renewsBack(billing: PlanBilling): boolean {
  return billing.plan === 'prepaid' && billing.status === 'expired';
}

/** What a price drop on a wallet plan gives back now, from Wiro's own plan change. */
function walletCreditNote(change: PlanChange): string {
  const used = change.usedCreditsUsd ?? 0;
  // A credit is at most 1 cent for each credit the change takes away unused, so one that takes none away gives nothing back.
  if (change.creditNowUsd === 0 && used > 0 && change.creditsNow !== null && change.creditsNow >= 0) {
    return 'Nothing comes back: the change takes no credits away.';
  }
  if (change.creditNowUsd === null) {
    return 'What comes back is worked out when the change is applied: what the time left is worth, less 1 cent for each credit already used above what the plan keeps.';
  }
  if (change.creditNowUsd > 0) {
    return `${formatUsd(change.creditNowUsd)} goes back to the balances that paid, and each keeps its own end date.`
      + (used > 0 ? ` ${formatUsd(used)} comes off for credits already used above what the plan keeps.` : '');
  }
  return used > 0
    ? 'Nothing comes back: the credits already used are worth more than the time left.'
    : 'Nothing comes back to the wallet now.';
}

/**
 * The quote's billing line. An active plan's money and credits come from the
 * plan change Wiro works out on the plan as it is now (change); without it,
 * the line says what happens without a number.
 */
function quoteBillingNote(billing: PlanBilling, delta: number | null, change: PlanChange | null, nextPrice: number | null, skillsOff: number): string {
  // A card plan whose renewal is not known gets the new price without a renewal claim.
  const after = billing.cancelAtPeriodEnd === true
    ? ` ${cancelledNote(billing)}`
    : billing.switchingToWallet
      ? ` ${walletSwitchNote(billing, nextPrice)}`
      : nextPrice === null
        ? ''
        : billing.cancelAtPeriodEnd === false
          ? ` The plan then renews at ${formatUsd(nextPrice)} a month.`
          : ` The new monthly price is ${formatUsd(nextPrice)}.`;
  if (billing.plan === 'none') {
    return 'The agent has no subscription yet, so nothing is charged now. The new monthly price applies once it is subscribed.';
  }
  if (billing.status !== 'active') {
    return renewsBack(billing)
      ? `The subscription is ${billing.status ?? 'not active'}. Skills can only change on an active subscription, so renew it with manage_agent_billing first.`
      : `The subscription is ${billing.status ?? 'not active'}. Skills can only change on an active subscription, so start a new plan with manage_agent_billing (subscribe) first.`;
  }
  if (delta !== null && Math.abs(delta) < 0.005) return 'The monthly price does not change, so nothing is charged.';
  if (delta === null || change === null) {
    return billing.plan === 'prepaid'
      ? `The difference for the rest of this period is taken from, or credited to, ${walletName(billing)} when the change is applied. A credit goes back to the balances that paid, and each keeps its own end date.${after}`
      : cardEndsWithPeriod(billing)
        ? `${CARD_ENDS_QUOTE}${after}`
        : billing.cancelAtPeriodEnd === null
          ? `${CARD_UNKNOWN_QUOTE}${after}`
          : `Any prorated difference appears on the next invoice.${after}`;
  }
  const ends = creditsEndNote(skillsOff, change.creditsNow, change.creditsThisPeriod);
  // Credits come with a rise when this period gains them. A plan priced again at today's rates can also
  // lose credits, or keep them, while its price rises.
  const gained = change.creditsNow !== null && change.creditsNow > 0 ? change.creditsNow : null;
  const notGained = change.creditsNow !== null && change.creditsNow <= 0 ? ` ${ends}` : '';
  if (!change.wallet) {
    if (delta > 0) {
      const added = gained !== null ? ` ${formatCredits(gained)} credits come now for the rest of this period.` : notGained;
      if (cardEndsWithPeriod(billing)) return `${CARD_ENDS_QUOTE}${added}${after}`;
      if (billing.cancelAtPeriodEnd === null) return `${CARD_UNKNOWN_QUOTE}${added}${after}`;
      return gained !== null
        ? `Nothing is charged now. The prorated difference appears on the next invoice, and ${formatCredits(gained)} credits come now for the rest of this period.${after}`
        : `Nothing is charged now. The prorated difference appears on the next invoice.${notGained}${after}`;
    }
    if (cardEndsWithPeriod(billing)) return `${CARD_ENDS_QUOTE} ${ends}${after}`;
    if (billing.cancelAtPeriodEnd === null) return `${CARD_UNKNOWN_QUOTE} ${ends}${after}`;
    return `The prorated difference comes off the next invoice. ${ends}${after}`;
  }
  if (delta > 0) {
    const charge = formatUsd(change.chargeNowUsd ?? 0);
    const credits = gained !== null ? `, and ${formatCredits(gained)} credits come with it` : '';
    const days = daysLeftText(change.secondsLeft);
    return underOneDayLeft(change.secondsLeft)
      ? `${charge} is taken from ${walletName(billing)} now at the one-day minimum${credits}.${notGained}${after}`
      : `${charge} is taken from ${walletName(billing)} now for the rest of this period${days ? ` (${days})` : ''}${credits}.${notGained}${after}`;
  }
  return `${walletCreditNote(change)} ${ends}${after}`;
}

function chargeNote(billing: PlanBilling, body: SkillsApplyBody): { note: string; charged: number | null } {
  const charged = toNumber(body.prepaidWalletDelta);
  const used = toNumber(body.usedCreditsUsd) ?? 0;
  const creditsNow = isPlainObject(body.pricing) ? toNumber(body.pricing.creditsNow) : null;
  const cancelled = billing.cancelAtPeriodEnd === true && billing.status === 'active' ? ` ${cancelledNote(billing)}` : '';
  if (charged !== null && charged > 0) {
    const credits = creditsNow !== null && creditsNow > 0 ? `, and ${formatCredits(creditsNow)} credits came with it` : '';
    return { charged, note: `${formatUsd(charged)} was taken from ${walletName(billing)} for the rest of this period${credits}.${cancelled}` };
  }
  if (charged !== null && charged < 0) {
    const terms = creditTerms(body.prepaidCreditParts);
    const usedNote = used > 0 ? ` ${formatUsd(used)} came off for credits already used above what the plan keeps.` : '';
    return { charged, note: `${formatUsd(Math.abs(charged))} was credited to ${walletName(billing)}.${terms ? ` ${terms}` : ''}${usedNote}${cancelled}` };
  }
  // A change that took no credits away had nothing to credit, and nothing failed.
  if (billing.plan === 'prepaid' && used > 0 && creditsNow !== null && creditsNow >= 0) {
    return { charged: null, note: `Nothing came back: the change took no credits away.${cancelled}` };
  }
  // The credits already used came to more than the time left was worth: no credit, and nothing failed.
  // A part Wiro could not add (prepaidCreditFailedUsd) was due all the same: its warning follows, and the
  // credits used took only what Wiro names.
  if (billing.plan === 'prepaid' && used > 0) {
    return (toNumber(body.prepaidCreditFailedUsd) ?? 0) > 0
      ? { charged: null, note: `Nothing came back now. ${formatUsd(used)} came off for credits already used above what the plan keeps.${cancelled}` }
      : { charged: null, note: `Nothing came back: the credits already used were worth more than the time left.${cancelled}` };
  }
  if (body.stripeProrationApplied === true) {
    const moved = isPlainObject(body.pricing) ? toNumber(body.pricing.deltaUsd) : null;
    if (moved !== null && Math.abs(moved) < 0.005) {
      return { charged: null, note: `The monthly price did not change, so nothing was charged.${cancelled}` };
    }
    const added = moved !== null && moved > 0 && creditsNow !== null && creditsNow > 0
      ? ` ${formatCredits(creditsNow)} credits came now for the rest of this period.`
      : '';
    if (cardEndsWithPeriod(billing)) {
      const price = isPlainObject(body.pricing) ? toNumber(body.pricing.newPriceUsd) : null;
      const switching = billing.switchingToWallet ? ` ${walletSwitchNote(billing, price)}` : '';
      return { charged: null, note: `Nothing was charged now. The card subscription was updated to the new price for the rest of this period.${added}${cancelled}${switching}` };
    }
    if (billing.cancelAtPeriodEnd === null) {
      return { charged: null, note: `Nothing was charged now. The card subscription was updated to the new price, and a plan that renews by card shows the prorated difference on its next invoice.${added}` };
    }
    return { charged: null, note: `The card subscription was updated; any prorated difference appears on the next invoice.${added}${cancelled}` };
  }
  if (billing.plan === 'none') {
    return { charged: null, note: 'Nothing was charged: the agent has no subscription yet.' };
  }
  return { charged: null, note: `Nothing was charged now.${cancelled}` };
}

/** What the change charged, then any notes Wiro adds about its billing, as Wiro wrote them. */
function appliedBillingNote(billing: PlanBilling, body: SkillsApplyBody): { note: string; charged: number | null } {
  const result = chargeNote(billing, body);
  const warnings = (Array.isArray(body.warnings) ? body.warnings : [])
    .map(warning => asString(warning)?.trim())
    .filter((warning): warning is string => Boolean(warning));
  return warnings.length > 0 ? { ...result, note: [result.note, ...warnings].join(' ') } : result;
}

/** The sentence for a change whose skills need a Wiro project. */
function bindProjectNote(needed: Array<{ credentials: string[] }>): string {
  return needed.some(entry => entry.credentials.includes(WIRO_PROJECT_CREDENTIAL))
    ? ' bind_agent_project connects a Wiro project, with no key to paste.'
    : '';
}

/** How to give the new skills what they still need. A Wiro project comes first, since it takes no key. */
function stillNeededSteps(needed: Array<{ credentials: string[] }>): string {
  const keys = needed.flatMap(entry => entry.credentials);
  const fields = 'set_agent_credentials or connect_agent_oauth.';
  if (!keys.includes(WIRO_PROJECT_CREDENTIAL)) return `Set them with ${fields}`;
  const others = keys.some(key => key !== WIRO_PROJECT_CREDENTIAL) ? ` Set the others with ${fields}` : '';
  return `Connect the Wiro project with bind_agent_project, with no key to paste.${others}`;
}

function listLine(label: string, names: string[]): string | null {
  return names.length > 0 ? `**${label}:** ${names.join(', ')}` : null;
}

/**
 * The scheduled tasks a change stops, because it turns off every skill that brings them, and the ones it
 * brings back by turning on the skills they wait for. Wiro names the skills that bring each task and, while
 * one is paused, the skills that end the pause as lists: one skill from each list, while a skill that brings
 * it is on. Only tasks that are on count: one that is off stays off either way.
 */
function tasksMoved(row: Row, enabledNow: string[], diff: SkillDiff): { stop: string[]; resume: string[] } {
  const after = new Set(enabledNow);
  for (const name of diff.disable) after.delete(name);
  for (const name of diff.enable) after.add(name);
  const stop: string[] = [];
  const resume: string[] = [];
  for (const task of customSkillEntries(row)) {
    const owners = task.ownerSkills ?? [];
    if (task.kind !== 'scheduled_task' || !task.enabled || owners.length === 0) continue;
    const ownerOn = owners.some(name => after.has(name));
    if (task.skillOff) {
      const groups = task.offSkills ?? [];
      const ends = groups.length > 0 && groups.every(group => group.some(name => after.has(name)));
      if (ownerOn && ends && groups.some(group => group.some(name => diff.enable.includes(name)))) resume.push(task.key);
    } else if (!ownerOn && owners.some(name => diff.disable.includes(name))) {
      stop.push(task.key);
    }
  }
  return { stop, resume };
}

/** The quote's lines for the scheduled tasks the change stops or brings back. */
function movedTaskLines(moved: { stop: string[]; resume: string[] }): string[] {
  const keys = (list: string[]) => list.map(key => `\`${key}\``).join(', ');
  const lines: string[] = [];
  if (moved.stop.length > 0) {
    const one = moved.stop.length === 1;
    lines.push(`**Scheduled tasks that stop:** ${keys(moved.stop)}. The change turns off every skill that brings ${one ? 'it. It keeps its text, schedule and on/off state while it waits' : 'them. They keep their text, schedule and on/off state while they wait'}, and get_my_agent names the skills to turn on to run ${one ? 'it' : 'them'} again.`);
  }
  if (moved.resume.length > 0) {
    const one = moved.resume.length === 1;
    lines.push(`**Scheduled tasks that run again:** ${keys(moved.resume)}. The change turns on the skills ${one ? 'it waits for, and it runs while the services it needs are' : 'they wait for, and they run while the services they need are'} connected.`);
  }
  return lines;
}

/** Whether the agent's live skills and tier are what this change asked for; null when that cannot be read. */
async function changeHolds(
  client: WiroClient,
  agentGuid: string,
  requested: Record<string, boolean>,
  tier: string | undefined,
  signal: AbortSignal,
): Promise<boolean | null> {
  let live: Row;
  try {
    live = await readUserAgent(client, agentGuid, signal);
  } catch {
    return null;
  }
  const enabled = new Set(enabledSkillNames(live));
  const skillsHold = Object.entries(requested).every(([name, on]) => enabled.has(name) === on);
  return skillsHold && (!tier || asString(live.tier) === tier);
}

export function registerApplyAgentSkills(server: McpServer, client: WiroClient): void {
  server.registerTool(
    'apply_agent_skills',
    {
      title: 'Change an agent\'s skills',
      description: 'Turn registry skills on or off for a deployed agent, and optionally move it '
        + 'from Starter to Pro, as one billed change. Skills set the agent\'s monthly price and monthly credits. '
        + 'On a team agent only a team admin or the person who deployed the agent can change its skills; other '
        + 'members are refused and nothing is charged. '
        + 'Steps: 1) call without confirm. The tool checks the names, adds the skills they '
        + 'depend on, and returns the current and new monthly price, what Wiro charges or credits now, '
        + 'the credits this period gains or loses, and an idempotency_key. Nothing changes yet. 2) Show the price to the '
        + 'user. 3) After they approve, call again with confirm: true and that idempotency_key. '
        + 'The key is tied to the quoted prices and, on a prepaid plan, the billing period: if '
        + 'either changed since the quote, nothing is applied and a new quote with a new key comes back. Reusing the key after a timeout '
        + 'is safe, the change is applied once. Billing: on a prepaid plan the monthly difference '
        + 'for the time left in the period is taken from the wallet at once, and the added credits come '
        + 'for that same time; every renewal gives all of them. When the price drops, what the time left '
        + 'is worth goes back to the balances that paid, less 1 cent for each credit already used above '
        + 'what the plan keeps, and each balance keeps its own end date. A skill that comes off loses its '
        + 'credits for the time left; the ones the time already passed paid for stay until the renewal. '
        + 'On a card plan nothing is charged at once: the card subscription is updated to the new price, '
        + 'a plan that renews by card shows the difference on its next invoice, and the added credits come '
        + 'for the time left. A running agent restarts once when a skill turns on or off; a change of the '
        + 'tier alone leaves it running. Newly enabled skills may still need credentials '
        + '(set_agent_credentials, connect_agent_oauth, bind_agent_project for a Wiro project) and do not create scheduled tasks '
        + '(manage_agent_custom_skill does). Find skill names with list_agent_skills and the '
        + 'agent\'s current skills with get_my_agent. The agents playbook (get_playbook) has the '
        + 'full setup walkthrough.',
      inputSchema: strictInput({
        agent_guid: z.string().min(1).describe('The deployed agent\'s guid, from list_my_agents.'),
        skills: z.record(z.string(), z.boolean())
          .describe('Skills to change, as name: true to turn on or name: false to turn off, for example {"int-instagram-post": true}. Registry names only (list_agent_skills). Custom skills and scheduled tasks (cs-...) are managed with manage_agent_custom_skill; channels such as Telegram turn on through set_agent_credentials.'),
        tier: z.enum(['starter', 'pro']).optional()
          .describe('Optional: also move from Starter to Pro in this billed change. To upgrade without a skill change, use manage_agent_billing (upgrade_to_pro).'),
        add_dependencies: z.boolean().default(true)
          .describe('Also turn on the skills that the enabled skills depend on (default true). Without them the change is refused.'),
        confirm: z.boolean().default(false)
          .describe('false (default) only returns the quote. true applies the change and charges it; it needs the idempotency_key from the quote.'),
        idempotency_key: z.string().min(8).max(128).optional()
          .describe('With confirm: true, the key from the quote the user approved. It ties the approval to the quoted prices and, on a prepaid plan, the billing period, and repeating the call with it after a timeout never applies the change twice. Omit it to get a quote.'),
      }),
      outputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ agent_guid, skills, tier, add_dependencies, confirm, idempotency_key }, extra) => {
      try {
        if (Object.keys(skills).length === 0 && !tier) {
          return errorResult(new Error('Nothing to change: pass at least one skill or a tier.'));
        }
        const registry = await loadSkillRegistry(client, extra.signal);
        const plan = planSkillChanges(skills, registry, add_dependencies);
        if (plan.errors.length > 0) {
          return errorResult(new Error(`The change was not sent:\n\n- ${plan.errors.join('\n- ')}`));
        }

        const row = await readUserAgent(client, agent_guid, extra.signal);
        const status = agentStatusOf(row);
        const currentTier = asString(row.tier) ?? null;
        if (tier === 'starter' && currentTier === 'pro') {
          return errorResult(new Error('A Pro plan cannot be moved back to Starter here. Cancel the plan with manage_agent_billing and subscribe again at Starter once it ends.'));
        }
        const tierChange = tier && tier !== currentTier ? tier : undefined;
        const digest = skillChangeDigest(agent_guid, plan.requested, tier);
        const givenKey = idempotency_key ? parseSkillChangeKey(idempotency_key) : null;
        if (givenKey && givenKey.digest !== digest) {
          return errorResult(new Error('This idempotency_key belongs to a different skill change. Omit idempotency_key to start a new change, or repeat the exact change it was issued for.'));
        }

        const enabledNow = enabledSkillNames(row);
        const diff = diffSkills(plan.requested, enabledNow);
        const check = checkSkillSet(enabledNow, diff.changes, registry);
        if (check.deps.length > 0 || check.conflicts.length > 0) {
          const problems = [
            ...check.deps.map(dep => (diff.disable.includes(dep.requires)
              ? `${dep.skill} needs ${dep.requires}. Keep ${dep.requires} on, or also turn off ${dep.skill}.`
              : `${dep.skill} needs ${dep.requires}, which is off. Turn ${dep.requires} on in the same change.`)),
            ...check.conflicts.map(pair => `${pair.a} and ${pair.b} cannot be on together. Keep only one.`),
          ];
          return errorResult(new Error(`The change was not sent:\n\n- ${[...new Set(problems)].join('\n- ')}`));
        }
        const billing = planBilling(row);
        const running = isAgentRunning(status);
        const changes = {
          enable: diff.enable,
          disable: diff.disable,
          addedDependencies: plan.addedDependencies.filter(name => diff.enable.includes(name)),
          alreadySet: diff.alreadySet.filter(name => !plan.addedDependencies.includes(name)),
        };
        const credentialsNeeded = credentialsNeededFor(diff.enable, registry, row);
        // A running agent restarts only for a skill that turns on or off.
        const skillsMove = Object.keys(diff.changes).length > 0;
        const nothingToDo = !skillsMove && !tierChange;
        const base = {
          agentGuid: agent_guid,
          changes,
          tier: { current: currentTier, next: tierChange ?? currentTier },
          credentialsNeeded,
          agentStatus: agentStatusLabel(status),
        };
        const billingBase = { plan: billing.plan, subscriptionStatus: billing.status, wallet: billing.wallet };

        // An empty change cannot charge anything. With a key issued for this
        // same change it is still sent, so a repeated confirm gets the result
        // of the earlier call with that key.
        if (nothingToDo && !(confirm && givenKey)) {
          return {
            content: [{ type: 'text' as const, text: `## No change needed\n\nThe skills${tier ? ' and tier' : ''} are already as requested on agent \`${agent_guid}\`.` }],
            structuredContent: {
              ...base,
              status: 'no_change' as const,
              billing: { ...billingBase, note: 'Nothing is charged.' },
              restart: UNCHANGED_RESTART,
            },
          };
        }

        const currentPrice = toNumber(row.monthlypriceusd);
        // The plan's monthly figure is what each renewal grants. This period's can differ after a change inside it.
        const currentCredits = toNumber(row.renewalcredits) ?? toNumber(row.monthlycredits);
        const key = idempotency_key?.trim() ?? '';

        // Every team member can read a team agent and price a change, but only a
        // team admin or the person who deployed it can apply one. The credit
        // history check refuses the other members up front; the organization's
        // owner passes it and gets Wiro's answer on confirm.
        if (!nothingToDo && await isPlainTeamMember(client, row, extra.signal)
          && await teamAgentBillingRefused(client, agent_guid, extra.signal)) {
          const message = 'Only a team admin or the person who deployed this agent can change its skills, and this '
            + 'connection acts as a team member without those rights. Nothing was quoted, changed or charged. Ask a '
            + 'team admin or the person who deployed the agent to make the change.';
          return {
            content: [{ type: 'text' as const, text: `## Skill change not possible\n\n${message}` }],
            structuredContent: {
              ...base,
              status: 'refused' as const,
              billing: { ...billingBase, note: message },
              restart: UNCHANGED_RESTART,
              error: { code: 97, message },
            },
            isError: true,
          };
        }

        if (!nothingToDo) {
          const preview = requireApiSuccess(
            await client.post<PricingPreviewBody>('/UserAgent/PricingPreview', {
              useragentguid: agent_guid,
              skillOverrides: diff.changes,
              ...(tierChange ? { tier: tierChange } : {}),
            }, extra.signal),
            'Could not price this change.',
          );
          const newPrice = toNumber(preview.totalPriceUsd);
          if (newPrice === null) {
            throw new Error('Wiro did not return the new monthly price of this change, so it cannot be quoted. Try again later.');
          }
          const priceTag = skillPriceTag(currentPrice, newPrice, billing.plan === 'prepaid' ? billing.periodEnd : null);
          const approved = confirm && givenKey !== null && givenKey.priceTag === priceTag;
          if (!approved) {
            const newCredits = toNumber(preview.totalMonthlyCredits);
            const delta = difference(newPrice, currentPrice);
            // What Wiro works out for this change on the plan as it is now. Only an active plan has one.
            const change = billing.plan !== 'none' && billing.status === 'active' ? readPlanChange(preview.planChange) : null;
            const note = quoteBillingNote(billing, delta, change, newPrice, changes.disable.length);
            const walletDrop = change !== null && change.wallet && delta !== null && delta < 0;
            const quoteKey = givenKey?.priceTag === priceTag ? key : newSkillChangeKey(digest, priceTag);
            const priceChanged = confirm && givenKey !== null;
            const blocked = billing.plan !== 'none' && billing.status !== 'active';
            const restart = skillsMove ? restartNote(status, 'skill change') : TIER_ONLY_RESTART;
            const moved = tasksMoved(row, enabledNow, diff);
            const priceNote = todayPriceNote(row, billing, currentPrice, currentCredits, tierChange);
            const pricing = {
              currentMonthlyUsd: currentPrice,
              newMonthlyUsd: newPrice,
              deltaMonthlyUsd: delta,
              currentMonthlyCredits: currentCredits,
              newMonthlyCredits: newCredits,
              deltaMonthlyCredits: difference(newCredits, currentCredits),
              ...periodFields(change),
              ...(priceNote ? { note: priceNote } : {}),
            };
            const nextAction = blocked
              ? {
                tool: 'manage_agent_billing',
                arguments: { agent_guid, action: renewsBack(billing) ? 'renew' : 'subscribe' },
                reason: 'The subscription must be active before skills can change.',
              }
              : {
                tool: 'apply_agent_skills',
                arguments: {
                  agent_guid,
                  skills,
                  ...(tier ? { tier } : {}),
                  add_dependencies,
                  confirm: true,
                  idempotency_key: quoteKey,
                },
                reason: delta === null || delta > 0
                  ? 'Ask the user to approve this charge first.'
                  : 'Ask the user to confirm this change first.',
              };
            const lead = !confirm
              ? null
              : priceChanged
                ? 'The price or the billing period changed since the quote, so nothing was applied or charged. This is the new quote with a new idempotency_key; show it to the user and ask again.'
                : 'Nothing was applied: confirming needs the idempotency_key of a quote, which ties the approval to the price. This is the quote; show it to the user first.';
            const lines = [
              '## Skill change quote',
              '',
              ...(lead ? [lead, ''] : []),
              `**Agent:** \`${agent_guid}\` (${agentStatusLabel(status)})`,
              listLine('Turn on', changes.enable),
              listLine('Added because other skills need them', changes.addedDependencies),
              listLine('Turn off', changes.disable),
              listLine('Already as requested', changes.alreadySet),
              tierChange ? `**Plan:** ${currentTier ?? 'unknown'} to ${tierChange}` : null,
              `**Monthly price:** ${currentPrice !== null ? formatUsd(currentPrice) : 'unknown'} now, ${formatUsd(newPrice)} after the change${delta !== null ? ` (${delta >= 0 ? '+' : ''}${formatUsd(delta)})` : ''}`,
              priceNote ? `**Price update:** ${priceNote}` : null,
              change?.creditsFromRenewal !== null && change?.creditsFromRenewal !== undefined
                ? `**Monthly credits:** ${currentCredits !== null ? formatCredits(currentCredits) : 'unknown'} now, ${formatCredits(change.creditsFromRenewal)} ${renewalWhen(billing)}`
                : newCredits !== null ? `**Monthly credits:** ${currentCredits !== null ? formatCredits(currentCredits) : 'unknown'} now, ${formatCredits(newCredits)} ${creditsWhen(billing)}` : null,
              change && change.creditsNow !== null && change.creditsThisPeriod !== null
                ? `**This period:** ${signedCredits(change.creditsNow)} credits now, ${formatCredits(change.creditsThisPeriod)} in all until ${unixToIso(change.periodEnd) ?? 'the period ends'}`
                : null,
              `**Billing:** ${note}`,
              `**Restart:** ${restart}`,
              ...movedTaskLines(moved),
              credentialsNeeded.length > 0
                ? `**Credentials the new skills need:** ${credentialsNeeded.map(entry => `${entry.skill} (${entry.credentials.join(', ')})`).join('; ')}.${bindProjectNote(credentialsNeeded)}`
                : null,
              '',
              blocked
                ? `${renewsBack(billing) ? 'Renew the subscription' : 'Start a new plan'} with manage_agent_billing before applying this change.`
                : `Nothing has changed yet. After the user approves, call apply_agent_skills again with confirm: true and idempotency_key \`${quoteKey}\`.`,
            ].filter((line): line is string => line !== null);
            return {
              content: [{ type: 'text' as const, text: lines.join('\n') }],
              structuredContent: {
                ...base,
                status: 'quote' as const,
                idempotencyKey: quoteKey,
                ...(priceChanged ? { priceChanged: true } : {}),
                pricing,
                billing: {
                  ...billingBase,
                  estimatedChargeNowUsd: change ? change.chargeNowUsd : null,
                  ...(walletDrop ? { creditNowUsd: change.creditNowUsd, usedCreditsUsd: change.usedCreditsUsd } : {}),
                  note,
                },
                ...(Array.isArray(preview.enabledSkills) ? { enabledSkills: preview.enabledSkills.map(String) } : {}),
                ...(moved.stop.length > 0 || moved.resume.length > 0 ? { scheduledTasks: moved } : {}),
                restart,
                nextAction,
              },
            };
          }
        }

        const sentEmpty = nothingToDo;
        let applied: SkillsApplyBody;
        try {
          applied = requireApiSuccess(
            await client.post<SkillsApplyBody>('/UserAgent/SkillsApply', {
              useragentguid: agent_guid,
              skills: diff.changes,
              idempotencyKey: key,
              ...(tierChange ? { tier: tierChange } : {}),
            }, extra.signal),
            'The skill change was refused.',
          );
        } catch (error) {
          if (extra.signal.aborted) throw error;
          if (!outcomeUnknown(error)) {
            const failure = describeSkillsApplyError(error, billing.plan);
            // Code 110 is the whole outcome: the next step reads the agent, and the call is not repeated.
            const failedChange = failure.code === 110;
            const nextAction = failedChange
              ? { tool: 'get_my_agent', arguments: { agent_guid }, reason: 'Check the agent\'s skills and monthly price. Do not repeat the change.' }
              : failure.code === 107
                ? { tool: 'apply_agent_skills', arguments: { agent_guid, skills, ...(tier ? { tier } : {}), add_dependencies }, reason: 'Get a new quote for this change, with a new key.' }
                : undefined;
            const text = [
              failedChange ? '## Skill change failed' : '## Skill change not applied',
              '',
              failure.message,
              failure.guidance ? `\n${failure.guidance}` : '',
              failure.retrySameKey ? `\nidempotency_key: \`${key}\`` : '',
            ].join('\n').trim();
            return {
              content: [{ type: 'text' as const, text }],
              structuredContent: {
                ...base,
                status: 'refused' as const,
                idempotencyKey: key,
                billing: { ...billingBase, note: failure.guidance || failure.message },
                restart: failedChange ? 'The agent does not restart for this change.' : UNCHANGED_RESTART,
                error: {
                  code: failure.code,
                  message: failure.message,
                  ...(failure.deps ? { deps: failure.deps } : {}),
                  ...(failure.conflicts ? { conflicts: failure.conflicts } : {}),
                  ...(failure.requiredUsd !== undefined ? { requiredUsd: failure.requiredUsd } : {}),
                  ...(failure.availableUsd !== undefined ? { availableUsd: failure.availableUsd } : {}),
                },
                ...(nextAction ? { nextAction } : {}),
              },
              isError: true,
            };
          }

          const message = errorText(error);
          if (sentEmpty) {
            const note = 'The agent\'s skills already match the request, so the change is in place. Do not repeat it. '
              + (billing.plan === 'prepaid'
                ? `What the earlier call with this idempotency_key took from, or credited to, ${walletName(billing)} is not shown here; get_account with recent_transactions shows it.`
                : 'Any price difference follows the plan\'s usual billing.');
            return {
              content: [{ type: 'text' as const, text: `## No change needed\n\n${note}` }],
              structuredContent: {
                ...base,
                status: 'no_change' as const,
                idempotencyKey: key,
                billing: { ...billingBase, note },
                restart: UNCHANGED_RESTART,
              },
            };
          }

          // The agent is read again to see whether the change is in place
          // before anything is reported.
          const holds = await changeHolds(client, agent_guid, plan.requested, tierChange, extra.signal);
          if (holds === true) {
            const note = `The agent's skills now match the request, so the change is in place. Do not repeat it. ${billing.plan === 'prepaid' && billing.status === 'active' ? `The difference for the rest of this period was probably taken from, or credited to, ${walletName(billing)}; a credit goes back to the balances that paid. get_account with recent_transactions shows the amount, and get_agent_activity with kind usage the credits it moved.` : 'Any price difference follows the plan\'s usual billing.'}`;
            return {
              content: [{ type: 'text' as const, text: [
                '## Skills updated',
                '',
                `**Agent:** \`${agent_guid}\``,
                listLine('Turned on', changes.enable),
                listLine('Turned off', changes.disable),
                `**Billing:** ${note}`,
                `**Restart:** ${skillsMove ? restartNote(status, 'skill change') : TIER_ONLY_RESTART}`,
              ].filter((line): line is string => line !== null).join('\n') }],
              structuredContent: {
                ...base,
                status: 'applied' as const,
                idempotencyKey: key,
                billing: { ...billingBase, chargedNowUsd: null, note },
                restart: skillsMove ? restartNote(status, 'skill change') : TIER_ONLY_RESTART,
              },
            };
          }
          const unverified = holds === null;
          const note = unverified
            ? `The change could not be confirmed (${message}). Check get_my_agent to see whether the skills match the request before trying again; repeating this call with the same idempotency_key never applies the change twice.`
            : `The agent's skills are unchanged, so the change was not applied (${message}). Repeating this call with the same idempotency_key is safe.`;
          return {
            content: [{ type: 'text' as const, text: `## Skill change ${unverified ? 'not confirmed' : 'not applied'}\n\n${note}\n\nidempotency_key: \`${key}\`` }],
            structuredContent: {
              ...base,
              status: 'refused' as const,
              idempotencyKey: key,
              billing: { ...billingBase, note },
              restart: !unverified ? UNCHANGED_RESTART : skillsMove ? 'The agent restarts if the change was saved.' : TIER_ONLY_RESTART,
              error: { code: null, message },
            },
            isError: true,
          };
        }

        // The live agent is checked against this change before it is reported
        // as applied.
        const holds = await changeHolds(client, agent_guid, plan.requested, tierChange, extra.signal);
        if (holds === false) {
          const note = 'The agent\'s skills do not match this change, so it is not in place. Check get_my_agent; if they '
            + 'still do not match the request, call apply_agent_skills again without idempotency_key to get a new quote.';
          return {
            content: [{ type: 'text' as const, text: `## Skill change not applied\n\n${note}` }],
            structuredContent: {
              ...base,
              status: 'refused' as const,
              idempotencyKey: key,
              billing: { ...billingBase, note },
              restart: UNCHANGED_RESTART,
              error: { code: null, message: note },
              nextAction: {
                tool: 'apply_agent_skills',
                arguments: { agent_guid, skills, ...(tier ? { tier } : {}), add_dependencies },
                reason: 'Get a new quote for this change.',
              },
            },
            isError: true,
          };
        }

        // An empty request that comes back as a real change is the saved
        // result of the earlier call with this key, not a new charge.
        const replayed = sentEmpty && !applied.noOp;
        const serverPricing = applied.pricing ?? {};
        // An agent with no plan has no period and no renewal yet, as its quote says.
        const appliedChange = billing.plan === 'none' ? null : readPlanChange({
          creditsNow: serverPricing.creditsNow,
          creditsThisPeriod: serverPricing.creditsThisPeriod,
          creditsFromRenewal: serverPricing.creditsFromRenewal,
          periodEnd: serverPricing.periodEnd,
        });
        const pricing = applied.noOp
          ? undefined
          : {
            currentMonthlyUsd: toNumber(serverPricing.previousPriceUsd),
            newMonthlyUsd: toNumber(serverPricing.newPriceUsd),
            deltaMonthlyUsd: toNumber(serverPricing.deltaUsd),
            currentMonthlyCredits: toNumber(serverPricing.previousMonthlyCredits),
            newMonthlyCredits: toNumber(serverPricing.newMonthlyCredits),
            deltaMonthlyCredits: toNumber(serverPricing.deltaCredits),
            ...periodFields(appliedChange),
          };
        const charge = appliedBillingNote(billing, applied);
        const usedCreditsUsd = toNumber(applied.usedCreditsUsd);
        const billingNote = replayed
          ? `This change was already applied by an earlier call with this idempotency_key, and nothing new was charged now. That call's billing: ${charge.note}`
          : charge.note;
        // Wiro says whether this change restarts a running agent; an answer without it goes by the skills that move.
        const restarts = typeof applied.restartTriggered === 'boolean' ? applied.restartTriggered : skillsMove;
        const restart = applied.noOp || replayed
          ? UNCHANGED_RESTART
          : restarts ? restartNote(status, 'skill change') : TIER_ONLY_RESTART;
        const firstCredential = credentialsNeeded[0]?.credentials[0];
        const nextAction = applied.noOp || replayed
          ? undefined
          : firstCredential === WIRO_PROJECT_CREDENTIAL
            ? bindProjectStep(agent_guid, 'Connect the Wiro project the new skills need.')
            : firstCredential
              ? {
                tool: 'set_agent_credentials',
                arguments: { agent_guid, credential: firstCredential },
                reason: `See what ${firstCredential} needs before asking the user for it.`,
              }
              : running && restarts
                ? {
                  tool: 'get_my_agent',
                  arguments: { agent_guid, wait_seconds: DEFAULT_WAIT_SECONDS },
                  reason: 'Check that the agent is running again with the new skills.',
                }
                : undefined;
        const lines = [
          applied.noOp ? '## No change needed' : replayed ? '## Already applied' : '## Skills updated',
          '',
          `**Agent:** \`${agent_guid}\``,
          listLine('Turned on', changes.enable),
          listLine('Turned off', changes.disable),
          applied.noOp || replayed ? listLine('Already as requested', changes.alreadySet) : null,
          tierChange && !applied.noOp ? `**Plan:** now ${asString(applied.tier) ?? tierChange}` : null,
          pricing?.newMonthlyUsd !== undefined && pricing.newMonthlyUsd !== null
            ? `**Monthly price:** ${formatUsd(pricing.newMonthlyUsd)}${pricing.currentMonthlyUsd !== null ? ` (was ${formatUsd(pricing.currentMonthlyUsd)})` : ''}`
            : null,
          pricing && appliedChange?.creditsNow !== null && appliedChange?.creditsNow !== undefined && appliedChange.creditsThisPeriod !== null
            ? `**This period:** ${signedCredits(appliedChange.creditsNow)} credits, ${formatCredits(appliedChange.creditsThisPeriod)} in all until ${unixToIso(appliedChange.periodEnd) ?? 'the period ends'}${appliedChange.creditsFromRenewal !== null ? `; ${renewalGives(billing, appliedChange.creditsFromRenewal)}` : ''}`
            : null,
          `**Billing:** ${billingNote}`,
          `**Restart:** ${restart}`,
          holds === null ? 'The agent could not be read afterwards to confirm the new skills; get_my_agent shows them.' : null,
          credentialsNeeded.length > 0
            ? `**Still needed:** credentials for ${credentialsNeeded.map(entry => `${entry.skill} (${entry.credentials.join(', ')})`).join('; ')}. ${stillNeededSteps(credentialsNeeded)}`
            : null,
        ].filter((line): line is string => line !== null);
        return {
          content: [{ type: 'text' as const, text: lines.join('\n') }],
          structuredContent: {
            ...base,
            status: applied.noOp ? 'no_change' as const : 'applied' as const,
            idempotencyKey: key,
            ...(pricing ? { pricing } : {}),
            // The saved answer of an earlier call: its charge is in the note, and this call charged nothing.
            billing: {
              ...billingBase,
              chargedNowUsd: replayed ? 0 : charge.charged,
              ...(usedCreditsUsd !== null && usedCreditsUsd > 0 ? { usedCreditsUsd } : {}),
              note: billingNote,
            },
            ...(Array.isArray(serverPricing.enabledSkills) ? { enabledSkills: serverPricing.enabledSkills.map(String) } : {}),
            restart,
            ...(nextAction ? { nextAction } : {}),
          },
        };
      } catch (error) {
        const hint = error instanceof Error ? workspaceHint(error.message) : undefined;
        return errorResult(hint && error instanceof Error ? new Error(`${error.message} ${hint}`) : error);
      }
    },
  );
}
