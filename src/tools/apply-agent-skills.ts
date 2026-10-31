import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WiroClient } from '../client.js';
import {
  asString,
  errorResult,
  errorText,
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
  describeSkillsApplyError,
  diffSkills,
  enabledSkillNames,
  estimateProratedUsd,
  formatUsd,
  isAgentRunning,
  loadSkillRegistry,
  newSkillChangeKey,
  parseSkillChangeKey,
  planBilling,
  planSkillChanges,
  readUserAgent,
  restartNote,
  skillChangeDigest,
  skillPriceTag,
  workspaceHint,
  type PlanBilling,
} from '../utils/agent-config.js';
import { outcomeUnknown } from '../utils/user-agent.js';
import { DEFAULT_WAIT_SECONDS } from '../utils/poll.js';
import { nextActionSchema } from './schemas.js';

const pricingSchema = z.object({
  currentMonthlyUsd: z.number().nullable(),
  newMonthlyUsd: z.number().nullable(),
  deltaMonthlyUsd: z.number().nullable(),
  currentMonthlyCredits: z.number().nullable(),
  newMonthlyCredits: z.number().nullable(),
  deltaMonthlyCredits: z.number().nullable(),
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
    estimatedChargeNowUsd: z.number().nullable().optional(),
    chargedNowUsd: z.number().nullable().optional(),
    note: z.string(),
  }),
  enabledSkills: z.array(z.string()).optional(),
  credentialsNeeded: z.array(z.object({
    skill: z.string(),
    credentials: z.array(z.string()),
  })),
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
};

type SkillsApplyBody = ApiEnvelope & {
  noOp?: boolean;
  pricing?: Record<string, unknown>;
  tier?: string;
  stripeProrationApplied?: boolean;
  prepaidWalletDelta?: unknown;
};

const UNCHANGED_RESTART = 'Nothing changed, so the agent does not restart.';

function difference(next: number | null, current: number | null): number | null {
  return next === null || current === null ? null : Math.round((next - current) * 100) / 100;
}

function walletName(billing: PlanBilling): string {
  return billing.wallet === 'team' ? 'the team wallet' : 'your personal wallet';
}

/** For a cancelled plan, a skill change only covers the days left: nothing renews at the new price. */
function cancelledNote(billing: PlanBilling): string {
  const end = billing.periodEnd !== null ? unixToIso(billing.periodEnd) : undefined;
  if (billing.plan === 'card') {
    return `The plan is set to end${end ? ` after ${end}` : ' with this period'} and does not renew.`;
  }
  return `The plan is cancelled and ends about a day after ${end ?? 'the end of this period'}, so this covers only the days left and the new price is not renewed. Undo the cancellation with manage_agent_billing (renew) to keep the plan.`;
}

function quoteBillingNote(billing: PlanBilling, delta: number | null, estimate: number | null, nextPrice: number | null): string {
  const after = billing.cancelAtPeriodEnd
    ? ` ${cancelledNote(billing)}`
    : nextPrice !== null ? ` The plan then renews at ${formatUsd(nextPrice)} a month.` : '';
  if (billing.plan === 'none') {
    return 'The agent has no subscription yet, so nothing is charged now. The new monthly price applies once it is subscribed.';
  }
  if (billing.status !== 'active') {
    return `The subscription is ${billing.status ?? 'not active'}. Skills can only change on an active subscription, so renew it with manage_agent_billing first.`;
  }
  if (delta === null) {
    return billing.plan === 'prepaid'
      ? `The difference for the rest of this period is taken from, or credited to, ${walletName(billing)} when the change is applied.${after}`
      : `Any prorated difference appears on the next invoice.${after}`;
  }
  if (Math.abs(delta) < 0.005) return 'The monthly price does not change, so nothing is charged.';
  if (billing.plan === 'card') {
    return `Nothing is charged now. The card subscription is updated and the prorated difference appears on the next invoice.${after}`;
  }
  const days = billing.daysRemaining !== null ? ` for the ${billing.daysRemaining} days left in this period` : ' for the rest of this period';
  if (delta > 0) {
    return `About ${formatUsd(estimate ?? 0)} is taken from ${walletName(billing)} now${days}.${after}`;
  }
  return `About ${formatUsd(Math.abs(estimate ?? 0))} is credited back to ${walletName(billing)} now${days}.${after}`;
}

function appliedBillingNote(billing: PlanBilling, body: SkillsApplyBody): { note: string; charged: number | null } {
  const charged = toNumber(body.prepaidWalletDelta);
  const cancelled = billing.cancelAtPeriodEnd && billing.status === 'active' ? ` ${cancelledNote(billing)}` : '';
  if (charged !== null && charged > 0) {
    return { charged, note: `${formatUsd(charged)} was taken from ${walletName(billing)} for the rest of this period.${cancelled}` };
  }
  if (charged !== null && charged < 0) {
    return { charged, note: `${formatUsd(Math.abs(charged))} was credited to ${walletName(billing)}.${cancelled}` };
  }
  if (body.stripeProrationApplied === true) {
    return { charged: null, note: `The card subscription was updated; any prorated difference appears on the next invoice.${cancelled}` };
  }
  if (billing.plan === 'none') {
    return { charged: null, note: 'Nothing was charged: the agent has no subscription yet.' };
  }
  return { charged: null, note: `Nothing was charged now.${cancelled}` };
}

function listLine(label: string, names: string[]): string | null {
  return names.length > 0 ? `**${label}:** ${names.join(', ')}` : null;
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
        + 'from Starter to Pro, as one billed change. Skills set the agent\'s monthly price. '
        + 'Steps: 1) call without confirm. The tool checks the names, adds the skills they '
        + 'depend on, and returns the current and new monthly price, an estimate of what is '
        + 'charged now and an idempotency_key. Nothing changes yet. 2) Show the price to the '
        + 'user. 3) After they approve, call again with confirm: true and that idempotency_key. '
        + 'The key is tied to the quoted prices: if the price changed since the quote, nothing '
        + 'is applied and a new quote with a new key comes back. Reusing the key after a timeout '
        + 'is safe, the change is applied once. Billing: on a prepaid plan the monthly difference '
        + 'for the days left in the period is taken from the wallet at once (or credited back '
        + 'when the price drops); on a card plan it is added to the next invoice. A running agent '
        + 'restarts once to load the skills. Newly enabled skills may still need credentials '
        + '(set_agent_credentials, connect_agent_oauth) and do not create scheduled tasks '
        + '(manage_agent_custom_skill does). Find skill names with list_agent_skills and the '
        + 'agent\'s current skills with get_my_agent. The agents playbook (get_playbook) has the '
        + 'full setup walkthrough.',
      inputSchema: {
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
          .describe('With confirm: true, the key from the quote the user approved. It ties the approval to the quoted prices, and repeating the call with it after a timeout never applies the change twice. Omit it to get a quote.'),
      },
      outputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
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
        const nothingToDo = Object.keys(diff.changes).length === 0 && !tierChange;
        const base = {
          agentGuid: agent_guid,
          changes,
          tier: { current: currentTier, next: tierChange ?? currentTier },
          credentialsNeeded,
          agentStatus: agentStatusLabel(status),
        };
        const billingBase = { plan: billing.plan, subscriptionStatus: billing.status, wallet: billing.wallet };

        // An empty change cannot charge anything. With a key issued for this
        // same change, Wiro returns the saved result of an earlier call with
        // it, which is how a retry after a timeout learns what happened.
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
        const currentCredits = toNumber(row.monthlycredits);
        const key = idempotency_key?.trim() ?? '';

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
          const priceTag = skillPriceTag(currentPrice, newPrice);
          const approved = confirm && givenKey !== null && givenKey.priceTag === priceTag;
          if (!approved) {
            const newCredits = toNumber(preview.totalMonthlyCredits);
            const delta = difference(newPrice, currentPrice);
            const estimate = billing.plan === 'prepaid' && billing.status === 'active' && delta !== null
              ? estimateProratedUsd(delta, billing.periodEnd)
              : null;
            const note = quoteBillingNote(billing, delta, estimate, newPrice);
            const quoteKey = givenKey?.priceTag === priceTag ? key : newSkillChangeKey(digest, priceTag);
            const priceChanged = confirm && givenKey !== null;
            const blocked = billing.plan !== 'none' && billing.status !== 'active';
            const restart = restartNote(status, 'new skills');
            const pricing = {
              currentMonthlyUsd: currentPrice,
              newMonthlyUsd: newPrice,
              deltaMonthlyUsd: delta,
              currentMonthlyCredits: currentCredits,
              newMonthlyCredits: newCredits,
              deltaMonthlyCredits: difference(newCredits, currentCredits),
            };
            const nextAction = blocked
              ? {
                tool: 'manage_agent_billing',
                arguments: { agent_guid, action: 'renew' },
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
                ? 'The price changed since the quote, so nothing was applied or charged. This is the new quote with a new idempotency_key; show it to the user and ask again.'
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
              newCredits !== null ? `**Monthly credits:** ${currentCredits ?? 'unknown'} now, ${newCredits} after the change` : null,
              `**Billing:** ${note}`,
              `**Restart:** ${restart}`,
              credentialsNeeded.length > 0
                ? `**Credentials the new skills need:** ${credentialsNeeded.map(entry => `${entry.skill} (${entry.credentials.join(', ')})`).join('; ')}`
                : null,
              '',
              blocked
                ? 'Renew the subscription with manage_agent_billing before applying this change.'
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
                billing: { ...billingBase, estimatedChargeNowUsd: estimate, note },
                ...(Array.isArray(preview.enabledSkills) ? { enabledSkills: preview.enabledSkills.map(String) } : {}),
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
            const failure = describeSkillsApplyError(error);
            const text = [
              '## Skill change not applied',
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
                restart: UNCHANGED_RESTART,
                error: {
                  code: failure.code,
                  message: failure.message,
                  ...(failure.deps ? { deps: failure.deps } : {}),
                  ...(failure.conflicts ? { conflicts: failure.conflicts } : {}),
                  ...(failure.requiredUsd !== undefined ? { requiredUsd: failure.requiredUsd } : {}),
                  ...(failure.availableUsd !== undefined ? { availableUsd: failure.availableUsd } : {}),
                },
              },
              isError: true,
            };
          }

          const message = errorText(error);
          if (sentEmpty) {
            const note = `The agent's skills are already as requested. Wiro answered with an error (${message}) when asked for the result of the earlier call with this idempotency_key, so what that call charged is not shown here; get_agent_activity with kind usage shows it.`;
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

          // Wiro can answer with an error after the change was saved and
          // charged, so the agent is read again before reporting anything.
          const holds = await changeHolds(client, agent_guid, plan.requested, tierChange, extra.signal);
          if (holds === true) {
            const note = `Wiro answered with an error (${message}), but the agent's skills are now as requested, so the change was saved. ${billing.plan === 'prepaid' && billing.status === 'active' ? `The difference for the rest of this period was probably taken from, or credited to, ${walletName(billing)}; get_agent_activity with kind usage and get_account show it.` : 'Any price difference follows the plan\'s usual billing.'} Do not repeat the change.`;
            return {
              content: [{ type: 'text' as const, text: [
                '## Skills updated (with an error report)',
                '',
                `**Agent:** \`${agent_guid}\``,
                listLine('Turned on', changes.enable),
                listLine('Turned off', changes.disable),
                `**Billing:** ${note}`,
                `**Restart:** ${restartNote(status, 'new skills')}`,
              ].filter((line): line is string => line !== null).join('\n') }],
              structuredContent: {
                ...base,
                status: 'applied' as const,
                idempotencyKey: key,
                billing: { ...billingBase, chargedNowUsd: null, note },
                restart: restartNote(status, 'new skills'),
              },
            };
          }
          const unverified = holds === null;
          const note = unverified
            ? `Wiro answered with an error (${message}), and the agent could not be read to check whether the change was saved. Check get_my_agent before trying again. Repeating this call with the same idempotency_key never applies the change twice.`
            : `Wiro answered with an error (${message}) and the agent's skills are unchanged, so the change was not applied. Repeating this call with the same idempotency_key is safe.`;
          return {
            content: [{ type: 'text' as const, text: `## Skill change ${unverified ? 'not confirmed' : 'not applied'}\n\n${note}\n\nidempotency_key: \`${key}\`` }],
            structuredContent: {
              ...base,
              status: 'refused' as const,
              idempotencyKey: key,
              billing: { ...billingBase, note },
              restart: unverified ? 'The agent restarts if the change was saved.' : UNCHANGED_RESTART,
              error: { code: null, message },
            },
            isError: true,
          };
        }

        // Wiro replays the saved answer of an earlier call with the same key,
        // whatever this request asked for, so the live agent is checked.
        const holds = await changeHolds(client, agent_guid, plan.requested, tierChange, extra.signal);
        if (holds === false) {
          const note = 'Wiro answered with the saved result of an earlier call that used this idempotency_key, and the agent\'s skills are not as this change asks, so this change was probably not applied by this call. Check get_my_agent; if the skills are still not as requested, call apply_agent_skills again without idempotency_key to get a new quote.';
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
        const pricing = applied.noOp
          ? undefined
          : {
            currentMonthlyUsd: toNumber(serverPricing.previousPriceUsd),
            newMonthlyUsd: toNumber(serverPricing.newPriceUsd),
            deltaMonthlyUsd: toNumber(serverPricing.deltaUsd),
            currentMonthlyCredits: toNumber(serverPricing.previousMonthlyCredits),
            newMonthlyCredits: toNumber(serverPricing.newMonthlyCredits),
            deltaMonthlyCredits: toNumber(serverPricing.deltaCredits),
          };
        const charge = appliedBillingNote(billing, applied);
        const billingNote = replayed
          ? `This change was already applied by an earlier call with this idempotency_key, and nothing new was charged now. That call's billing: ${charge.note}`
          : charge.note;
        const restart = applied.noOp || replayed
          ? UNCHANGED_RESTART
          : restartNote(status, 'new skills');
        const firstCredential = credentialsNeeded[0]?.credentials[0];
        const nextAction = applied.noOp || replayed
          ? undefined
          : firstCredential
            ? {
              tool: 'set_agent_credentials',
              arguments: { agent_guid, credential: firstCredential },
              reason: `See what ${firstCredential} needs before asking the user for it.`,
            }
            : running
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
          `**Billing:** ${billingNote}`,
          `**Restart:** ${restart}`,
          holds === null ? 'The agent could not be read afterwards to confirm the new skills; get_my_agent shows them.' : null,
          credentialsNeeded.length > 0
            ? `**Still needed:** credentials for ${credentialsNeeded.map(entry => `${entry.skill} (${entry.credentials.join(', ')})`).join('; ')}. Set them with set_agent_credentials or connect_agent_oauth.`
            : null,
        ].filter((line): line is string => line !== null);
        return {
          content: [{ type: 'text' as const, text: lines.join('\n') }],
          structuredContent: {
            ...base,
            status: applied.noOp ? 'no_change' as const : 'applied' as const,
            idempotencyKey: key,
            ...(pricing ? { pricing } : {}),
            billing: { ...billingBase, chargedNowUsd: charge.charged, note: billingNote },
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
