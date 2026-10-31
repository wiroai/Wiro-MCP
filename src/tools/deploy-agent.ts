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
  type ApiEnvelope,
} from '../utils/api.js';
import { DEFAULT_WAIT_SECONDS } from '../utils/poll.js';
import {
  deployedAgentSchema,
  describeAgentStatus,
  formatCredits,
  formatUsd,
  isGuid,
  nextStepForAgent,
  outcomeUnknown,
  readAgentDetail,
  sameAmount,
  toAgentDetail,
  toDeployedAgent,
  toStringArray,
  type AgentDetail,
  type AgentTier,
} from '../utils/user-agent.js';
import { resolveDeployCustomSkills, type DeployCustomSkill, type TemplateCustomSkill } from '../utils/agent-config.js';
import { toSkillSummary, toTemplateDetail } from '../utils/agent-catalog.js';
import { nextActionSchema } from './schemas.js';

const PAID_FROM = 'The Wiro wallet of the workspace this API key belongs to: the team wallet for a team '
  + 'project\'s key, otherwise the personal wallet.';

const quoteCustomSkillSchema = z.object({
  key: z.string(),
  kind: z.enum(['skill', 'scheduled_task']),
  interval: z.string().optional(),
  enabled: z.boolean().optional(),
  replacesTemplateEntry: z.boolean(),
});

const quoteSchema = z.object({
  kind: z.enum(['template', 'custom']),
  template: z.object({ guid: z.string(), slug: z.string(), title: z.string() }).optional(),
  title: z.string(),
  tier: z.enum(['starter', 'pro']),
  priceUsd: z.number(),
  monthlyCredits: z.number(),
  paidFrom: z.string(),
  skills: z.array(z.string()).optional(),
  credentialsNeeded: z.array(z.object({ key: z.string(), title: z.string() })),
  customSkills: z.array(quoteCustomSkillSchema).optional(),
});

type Quote = z.infer<typeof quoteSchema>;

const customSkillSchema = z.object({
  key: z.string().min(1).max(70)
    .describe('The entry\'s key: a full key (cs-... or cs-cron-...) or a bare slug such as "weekly-report" (lowercase letters, digits, single dashes). A bare slug names the template\'s own entry of that name when it has one; otherwise it becomes cs-<slug>, or cs-cron-<slug> with interval.'),
  value: z.string().max(20_000).optional()
    .describe('The instruction text the agent follows, or the prompt a scheduled task runs. Required for a new entry. Leave it out for an entry that comes with the template: a custom skill then keeps the template\'s text, and a scheduled task always runs the template\'s own prompt, so only its interval and enabled can change.'),
  description: z.string().max(500).optional()
    .describe('Short description shown in the dashboard.'),
  interval: z.string().max(100).optional()
    .describe('A 5-field cron expression in the agent\'s timezone (UTC until changed with update_agent), for example "0 9 * * 1-5". Setting it makes the entry a scheduled task. Left out, a scheduled task that comes with the template keeps the template\'s schedule.'),
  enabled: z.boolean().optional()
    .describe('Whether the entry is on (default true). false turns off a scheduled task that comes with the template.'),
});

const deployedCustomSkillSchema = z.object({
  key: z.string(),
  kind: z.enum(['skill', 'scheduled_task']),
  interval: z.string().nullable().optional(),
  enabled: z.boolean().optional(),
  onAgent: z.boolean(),
});

type DeployEnvelope = ApiEnvelope & { useragents?: unknown; existingUserAgentGuid?: unknown };

function customSkillLine(skill: { key: string; kind: string; interval?: string | null; enabled?: boolean }, fromTemplate?: boolean): string {
  const details = [
    skill.kind === 'scheduled_task' ? 'scheduled task' : 'custom skill',
    skill.interval ? `runs on "${skill.interval}"` : null,
    skill.enabled === false ? 'turned off' : null,
    fromTemplate ? 'replaces the template\'s entry' : null,
  ].filter(Boolean).join(', ');
  return `\`${skill.key}\` (${details})`;
}

function quoteText(quote: Quote): string {
  const what = quote.kind === 'template'
    ? `${quote.title}, from the template ${quote.template?.title ?? ''} (\`${quote.template?.slug ?? ''}\`)`
    : `${quote.title}, a custom build${quote.skills?.length ? ` with ${quote.skills.join(', ')}` : ' with no extra skills'}`;
  const lines = [
    '## Deployment quote (nothing charged yet)',
    '',
    `- Agent: ${what}`,
    `- Tier: ${quote.tier === 'pro' ? 'Pro' : 'Starter'}`,
    `- Price: ${formatUsd(quote.priceUsd)} now, then ${formatUsd(quote.priceUsd)} every 30 days until the plan is cancelled`,
    `- Monthly credits: ${formatCredits(quote.monthlyCredits)}. They pay for the agent's chat and scheduled tasks (100 credits = $1). Image and video runs it starts are billed to the wallet of the Wiro key saved on it.`,
    `- Paid from: ${quote.paidFrom} get_account shows the balance.`,
  ];
  if (quote.customSkills?.length) {
    const scheduled = quote.customSkills.some(skill => skill.kind === 'scheduled_task');
    lines.push(`- Custom skills and scheduled tasks: ${quote.customSkills.map(skill => customSkillLine(skill, skill.replacesTemplateEntry)).join('; ')}.${scheduled ? ' Scheduled tasks run in UTC until the time zone is changed, and every run spends the agent\'s credits.' : ''}`);
  }
  if (quote.credentialsNeeded.length > 0) {
    lines.push(`- After deployment the user must provide: ${quote.credentialsNeeded.map(item => `${item.title} (\`${item.key}\`)`).join(', ')}`);
  }
  return lines.join('\n');
}

/** Where each requested custom skill ended up on the new agent. */
function deployedCustomSkills(agent: AgentDetail, requested: DeployCustomSkill[]): Array<z.infer<typeof deployedCustomSkillSchema>> {
  const tasks = [...agent.scheduledTasks, ...agent.customInstructions];
  return requested.map(skill => {
    const found = tasks.find(task => task.key === skill.key);
    return {
      key: skill.key,
      kind: skill.kind,
      ...(found ? { interval: found.interval ?? null, enabled: found.enabled } : {}),
      onAgent: found !== undefined,
    };
  });
}

function deployedText(agent: AgentDetail, quote: Quote, chargedUsd: number | null, customSkills: Array<z.infer<typeof deployedCustomSkillSchema>>): string {
  const lines = [
    '## Agent deployed',
    '',
    `- Agent: ${agent.title} (\`${agent.guid}\`)`,
    `- Status: ${describeAgentStatus(agent.status)}. It starts on its own; get_my_agent with wait_seconds follows it.`,
    `- Charged: ${formatUsd(chargedUsd ?? quote.priceUsd)} from the wallet. The plan renews every 30 days until it is cancelled.`,
    `- Monthly credits: ${formatCredits(agent.credits.monthly || quote.monthlyCredits)}`,
  ];
  const saved = customSkills.filter(skill => skill.onAgent);
  const missing = customSkills.filter(skill => !skill.onAgent);
  if (saved.length > 0) lines.push(`- Custom skills saved: ${saved.map(skill => customSkillLine(skill)).join('; ')}`);
  if (missing.length > 0) {
    lines.push(`- Not found on the new agent: ${missing.map(skill => `\`${skill.key}\``).join(', ')}. get_my_agent shows its custom skills; manage_agent_custom_skill adds them.`);
  }
  if (agent.missingCredentials.length > 0) {
    lines.push(`- Missing credentials: ${agent.missingCredentials.map(item => `${item.title} (\`${item.key}\`)`).join(', ')}. Skills that need them fail until they are set.`);
  }
  lines.push(`- Dashboard: ${agent.dashboardUrl}`);
  return lines.join('\n');
}

export function registerDeployAgent(server: McpServer, client: WiroClient): void {
  server.registerTool(
    'deploy_agent',
    {
      title: 'Deploy a Wiro agent',
      description: 'Deploy a new agent from a template or as a custom build from chosen skills. In a team '
        + 'workspace only a team admin can deploy; anyone else is refused before anything is created or charged. This costs '
        + 'money: the first 30 days are paid from the Wiro wallet of the workspace this API key belongs to '
        + '(a team project\'s key pays from the team wallet), and the plan renews from that wallet every 30 '
        + 'days until it is cancelled. Without confirm: true the tool only returns the exact quote. Show it to '
        + 'the user, get their approval, then repeat the call with confirm: true and confirm_charge_usd set to '
        + 'the quoted price; if the price changed in between, nothing is charged and a new quote comes back. '
        + 'Never repeat a confirmed deploy that timed out or whose outcome is unknown without checking '
        + 'list_my_agents first. A refusal that says nothing was created or charged, such as one for balance, '
        + 'can be confirmed again once its cause is fixed and the user says yes. The '
        + 'agent starts on its own after deployment. Credentials can be added later with set_agent_credentials '
        + 'or connect_agent_oauth, but skills that need them do not work until then. A custom build also gets '
        + 'the scheduled tasks its skills come with, or a starter task on Mondays at 10:00. To change a template\'s '
        + 'skills, deploy it first and then use apply_agent_skills. get_playbook describes the whole flow.',
      inputSchema: {
        template: z.string().min(1).max(200).optional()
          .describe('Template slug or guid from list_agent_templates. Leave it out for a custom build.'),
        custom: z.boolean().default(false)
          .describe('true for a custom build from `skills` instead of a template.'),
        skills: z.array(z.string().min(1).max(100)).max(60).optional()
          .describe('Custom build only: skill names from list_agent_skills. Skills they depend on are added and priced automatically. An empty list deploys an agent with no extra skills at the minimum price.'),
        title: z.string().trim().min(1).max(200).optional()
          .describe('Name of the new agent. Required for a custom build. A template deploy defaults to the template title.'),
        tier: z.enum(['starter', 'pro'])
          .describe('Plan tier. Pro has a larger monthly credit pool and is the only tier that can buy extra credit packs.'),
        description: z.string().max(5_000).optional()
          .describe('Optional description of the agent.'),
        cover: z.string().url().max(2_048).optional()
          .describe('Optional https image URL for the agent cover. A template deploy shows the template cover when it is left out.'),
        credentials: z.record(z.string(), z.record(z.string(), z.unknown())).optional()
          .describe('Optional credential values stored at deployment, keyed by credential key and then field key, for example {"telegram": {"bottoken": "...", "allowedusers": ["123456789"]}}. A chat channel group must contain every required field. Values are never shown back. Other credentials are better set after deployment with set_agent_credentials, which reports field errors.'),
        custom_skills: z.array(customSkillSchema).max(20).optional()
          .describe('Optional custom instructions or scheduled tasks added at deployment, or changes to the ones the template comes with. They are checked before the quote.'),
        confirm_charge_usd: z.number().min(0).max(100_000).optional()
          .describe('With confirm: true, the price the user approved, from the quote\'s nextAction (quote.priceUsd). Required to deploy. If a fresh quote no longer matches it, nothing is charged and the new quote is returned.'),
        confirm: z.boolean().default(false)
          .describe('false returns only the quote. true deploys the agent and charges the wallet. Set it only after the user approved the quoted price.'),
      },
      outputSchema: {
        stage: z.enum(['quote', 'deployed', 'duplicate', 'retry_later']),
        quote: quoteSchema,
        priceChanged: z.boolean().optional(),
        agent: deployedAgentSchema.optional(),
        existingAgentGuid: z.string().optional(),
        chargedUsd: z.number().nullable().optional(),
        customSkills: z.array(deployedCustomSkillSchema).optional(),
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
    async (args, extra) => {
      let deploySent = false;
      try {
        const { template, custom, tier, confirm } = args;
        const templateRef = template?.trim();
        if (templateRef && custom) throw new Error('Pass either template or custom: true, not both.');
        if (!templateRef && !custom) {
          throw new Error('Pass template (a slug or guid from list_agent_templates), or custom: true with skills from list_agent_skills.');
        }
        if (args.skills && !custom) {
          throw new Error('skills are only used for a custom build. Deploy the template first, then change its skills with apply_agent_skills.');
        }
        if (custom && !args.title) throw new Error('title is required for a custom build.');

        const requestedCustomSkills = args.custom_skills ?? [];
        // Keys, schedules and empty texts are checked before anything is read.
        const syntax = resolveDeployCustomSkills(requestedCustomSkills, null);
        if (syntax.errors.length > 0) {
          throw new Error(`Nothing was deployed. Fix custom_skills:\n\n- ${syntax.errors.join('\n- ')}`);
        }

        let quote: Quote;
        let agentGuid: string | undefined;
        let templateTasks: TemplateCustomSkill[] = [];
        const skillNames = [...new Set(args.skills ?? [])];

        if (templateRef) {
          const body = requireApiSuccess(
            await client.post<ApiEnvelope & { agents?: unknown }>('/Agent/Detail', {
              ...(isGuid(templateRef) ? { guid: templateRef } : { slug: templateRef }),
              ...(requestedCustomSkills.length > 0 ? { type: 'full' } : {}),
            }, extra.signal),
            'The agent template could not be read.',
          );
          const row = Array.isArray(body.agents) ? body.agents.find(isPlainObject) : undefined;
          if (!row) throw new Error(`No agent template was found for "${templateRef}".`);
          const detail = toTemplateDetail(row);
          if (!detail.pricing) {
            throw new Error('This template cannot be priced right now, so it cannot be deployed. Try again later.');
          }
          agentGuid = detail.guid;
          templateTasks = [...(detail.scheduledTasks ?? []), ...(detail.customInstructions ?? [])];
          const price = detail.pricing[tier as AgentTier];
          quote = {
            kind: 'template',
            template: { guid: detail.guid, slug: detail.slug, title: detail.title },
            title: args.title ?? detail.title,
            tier,
            priceUsd: price.priceUsd,
            monthlyCredits: price.monthlyCredits,
            paidFrom: PAID_FROM,
            credentialsNeeded: detail.requiredCredentials.map(item => ({ key: item.key, title: item.title })),
          };
        } else {
          const credentialsNeeded = new Map<string, string>();
          if (skillNames.length > 0) {
            // Deploy stores unknown skill names without checking them and then
            // fails half way, so every name is checked against the registry first.
            const list = requireApiSuccess(
              await client.post<ApiEnvelope & { skills?: unknown }>('/Skills/List', { name_in: skillNames }, extra.signal),
              'The skill list could not be read.',
            );
            const found = new Map((Array.isArray(list.skills) ? list.skills : [])
              .filter(isPlainObject)
              .map(toSkillSummary)
              .map(skill => [skill.name, skill]));
            const unknown = skillNames.filter(name => !found.has(name));
            if (unknown.length > 0) {
              throw new Error(`Unknown skill${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}. Use names from list_agent_skills.`);
            }
            const deprecated = skillNames.filter(name => found.get(name)?.deprecated);
            if (deprecated.length > 0) {
              throw new Error(`Deprecated skill${deprecated.length > 1 ? 's' : ''}: ${deprecated.map(name => {
                const replacement = found.get(name)?.replacement;
                return replacement ? `${name} (use ${replacement})` : name;
              }).join(', ')}.`);
            }
            for (const name of skillNames) {
              const skill = found.get(name);
              if (skill?.requiresCredentials && skill.credentialKey && !credentialsNeeded.has(skill.credentialKey)) {
                credentialsNeeded.set(skill.credentialKey, `${skill.title} credentials`);
              }
            }
          }
          const preview = requireApiSuccess(
            await client.post<ApiEnvelope & Record<string, unknown>>('/UserAgent/PricingPreview', {
              draft: true,
              skills: skillNames,
              tier,
            }, extra.signal),
            'The price of this build could not be computed.',
          );
          const priceUsd = toNumber(preview.totalPriceUsd);
          const monthlyCredits = toNumber(preview.totalMonthlyCredits);
          if (priceUsd === null || monthlyCredits === null) {
            throw new Error('The price of this build could not be computed. Try again later.');
          }
          const enabled = toStringArray(preview.enabledSkills);
          quote = {
            kind: 'custom',
            title: args.title ?? '',
            tier,
            priceUsd,
            monthlyCredits,
            paidFrom: PAID_FROM,
            skills: enabled.length > 0 ? enabled : skillNames,
            credentialsNeeded: [...credentialsNeeded].map(([key, title]) => ({ key, title })),
          };
        }

        const resolved = resolveDeployCustomSkills(requestedCustomSkills, templateTasks);
        if (resolved.errors.length > 0) {
          throw new Error(`Nothing was deployed. Fix custom_skills:\n\n- ${resolved.errors.join('\n- ')}`);
        }
        const customSkills = resolved.skills;
        if (customSkills.length > 0) {
          quote.customSkills = customSkills.map(skill => ({
            key: skill.key,
            kind: skill.kind,
            ...(skill.interval !== undefined ? { interval: skill.interval } : {}),
            ...(skill.enabled !== undefined ? { enabled: skill.enabled } : {}),
            replacesTemplateEntry: skill.fromTemplate,
          }));
        }

        const { credentials, confirm: _confirm, ...repeat } = args;
        const hasCredentials = credentials !== undefined && Object.keys(credentials).length > 0;
        const credentialsNote = hasCredentials ? ' Pass the same credentials again; they are not repeated here.' : '';
        const confirmCall = (reason: string) => ({
          tool: 'deploy_agent',
          arguments: { ...repeat, confirm_charge_usd: quote.priceUsd, confirm: true },
          reason: `${reason}${credentialsNote}`,
        });

        const approved = args.confirm_charge_usd;
        const priceChanged = confirm && approved !== undefined && !sameAmount(quote.priceUsd, approved);
        if (!confirm || approved === undefined || priceChanged) {
          const lead = !confirm
            ? ''
            : priceChanged
              ? `The price changed since the quote: it is now ${formatUsd(quote.priceUsd)}, and the user approved ${formatUsd(approved)}. Nothing was deployed or charged. Show the new price to the user and ask again.\n\n`
              : 'Nothing was deployed: confirm_charge_usd is missing. It is the price the user approved, and it must be sent with confirm: true.\n\n';
          return {
            content: [{
              type: 'text' as const,
              text: `${lead}${quoteText(quote)}\n\nAsk the user to approve this charge. Then call deploy_agent again with the same arguments plus confirm_charge_usd ${quote.priceUsd} and confirm: true.${credentialsNote}`,
            }],
            structuredContent: {
              stage: 'quote' as const,
              quote,
              ...(priceChanged ? { priceChanged: true } : {}),
              message: priceChanged
                ? 'Nothing was charged. The price changed since the quote; this is the new price of the deployment.'
                : 'Nothing was charged. This is the exact price of the deployment.',
              nextAction: confirmCall('Ask the user to approve this charge first.'),
            },
          };
        }

        const deployBody: Record<string, unknown> = {
          ...(agentGuid ? { agentguid: agentGuid } : { custom: true }),
          title: quote.title,
          tier,
          useprepaid: true,
          ...(args.description ? { description: args.description } : {}),
          ...(args.cover ? { cover: args.cover } : {}),
          ...(custom ? { skills: Object.fromEntries(skillNames.map(name => [name, true])) } : {}),
          ...(credentials && Object.keys(credentials).length > 0 ? { credentials } : {}),
          ...(customSkills.length > 0
            ? {
              customskills: customSkills.map(entry => ({
                key: entry.key,
                ...(entry.value !== undefined ? { value: entry.value } : {}),
                ...(entry.description !== undefined ? { description: entry.description } : {}),
                ...(entry.interval !== undefined ? { interval: entry.interval } : {}),
                ...(entry.enabled !== undefined ? { enabled: entry.enabled } : {}),
                // A key the template already has overrides it; any other key is the user's own.
                _user_created: !entry.fromTemplate,
              })),
            }
            : {}),
        };

        deploySent = true;
        const response = await client.post<DeployEnvelope>('/UserAgent/Deploy', deployBody, extra.signal);
        let body: DeployEnvelope;
        try {
          body = requireApiSuccess(response, 'The agent could not be deployed.');
        } catch (error) {
          if (!hasErrorCode(error, 99)) throw error;
          const existingGuid = asString((error as ApiResultError).body.existingUserAgentGuid);
          let existing: AgentDetail | undefined;
          if (existingGuid) {
            try {
              existing = toAgentDetail(await readAgentDetail(client, existingGuid, extra.signal));
            } catch {
              // The guid is still worth reporting when the row cannot be read.
            }
          }
          // For a template, Wiro's 10-second guard ignores the title, so a second
          // agent the user named differently is refused too although it is a
          // new agent. Without a title of its own it counts as a repeat.
          const existingTitle = existing?.title ?? /identical agent \("([^"]*)"\)/.exec((error as ApiResultError).message)?.[1];
          if (quote.kind === 'template' && args.title !== undefined && existingTitle !== undefined && existingTitle !== quote.title) {
            const message = `Wiro refused this deploy because another agent from the same template ("${existingTitle}") was deployed a few seconds ago. That check only blocks deploys made within about 10 seconds of each other, so nothing was created or charged for "${quote.title}". Wait about 10 seconds, then repeat the call.`;
            return {
              content: [{ type: 'text' as const, text: `## Deploy not made yet\n\n${message}` }],
              structuredContent: {
                stage: 'retry_later' as const,
                quote,
                message,
                nextAction: confirmCall(`Wait about 10 seconds first. The user already approved this charge, and it was not made.`),
              },
            };
          }
          const unpaid = existing && existing.status === 6 && !existing.subscription;
          const message = 'Wiro refused this deploy because an identical one was made a few seconds ago, so '
            + 'nothing new was created or charged. Do not call deploy_agent again for it.'
            + (existingGuid ? ` The existing agent is ${existingGuid}.` : '')
            + (unpaid
              ? ' It has no paid plan: manage_agent_billing with action subscribe pays for it, or delete_agent removes it.'
              : '');
          return {
            content: [{ type: 'text' as const, text: `## Duplicate deploy\n\n${message}${existing ? `\n\nStatus: ${describeAgentStatus(existing.status)}` : ''}` }],
            structuredContent: {
              stage: 'duplicate' as const,
              quote,
              ...(existing ? { agent: toDeployedAgent(existing) } : {}),
              ...(existingGuid ? { existingAgentGuid: existingGuid } : {}),
              message,
              ...(existingGuid
                ? {
                  nextAction: {
                    tool: 'get_my_agent',
                    arguments: { agent_guid: existingGuid },
                    reason: 'Check the agent that already exists instead of deploying again.',
                  },
                }
                : {}),
            },
          };
        }

        const created = Array.isArray(body.useragents) ? body.useragents.find(isPlainObject) : undefined;
        const createdGuid = created ? asString(created.guid) : undefined;
        if (!created || !createdGuid) {
          throw new Error('Wiro reported a successful deploy but returned no agent. Check list_my_agents before trying again.');
        }
        let row: Record<string, unknown> = created;
        try {
          row = await readAgentDetail(client, createdGuid, extra.signal);
        } catch {
          // The deploy response already describes the new agent.
        }
        const agent = toAgentDetail(row);
        const chargedUsd = toNumber(created.monthlypriceusd) ?? quote.priceUsd;
        const nextStep = nextStepForAgent(agent, DEFAULT_WAIT_SECONDS);
        const savedCustomSkills = deployedCustomSkills(agent, customSkills);

        return {
          content: [{ type: 'text' as const, text: deployedText(agent, quote, chargedUsd, savedCustomSkills) }],
          structuredContent: {
            stage: 'deployed' as const,
            quote,
            agent: toDeployedAgent(agent),
            chargedUsd,
            ...(savedCustomSkills.length > 0 ? { customSkills: savedCustomSkills } : {}),
            message: `Deployed and charged ${formatUsd(chargedUsd)}. The plan renews every 30 days until it is cancelled.`,
            ...(nextStep ? { nextAction: nextStep } : {}),
          },
        };
      } catch (error) {
        if (deploySent && !extra.signal.aborted && outcomeUnknown(error)) {
          return errorResult(new Error(
            `${errorText(error)}\n\nThe deploy request was sent and the answer does not show whether it went through, so the agent may have been created and charged. `
            + 'Check list_my_agents before trying again.',
          ));
        }
        if (error instanceof ApiResultError && /insufficient wallet balance/i.test(error.message)) {
          return errorResult(new Error(`${error.message}\n\nNothing was created or charged. Give the user the amounts above. Funds are added at https://wiro.ai/panel/wallet/deposit/credit-card; once the user has added them and says yes, confirm the same quote again.`));
        }
        return errorResult(error);
      }
    },
  );
}
