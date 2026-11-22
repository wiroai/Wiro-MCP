import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WiroClient } from '../client.js';
import {
  asString,
  errorResult,
  errorText,
  requireApiSuccess,
  type ApiEnvelope,
} from '../utils/api.js';
import {
  agentStatusLabel,
  agentStatusOf,
  checkSkillSet,
  credentialLabel,
  credentialTitles,
  credentialsNeededFor,
  customSkillEntries,
  describeSkillsApplyError,
  diffSkills,
  enabledSkillNames,
  isAgentRunning,
  loadSkillRegistry,
  newSkillChangeKey,
  parseSkillChangeKey,
  pausedSkillTitles,
  planSkillChanges,
  readUserAgent,
  registryTitles,
  restartNote,
  skillChangeDigest,
  workspaceHint,
  type CustomSkillEntry,
} from '../utils/agent-config.js';
import { AGENT_AI_USAGE, bindProjectStep, outcomeUnknown, skillLabel, skillOffTasksNote, WIRO_PROJECT_CREDENTIAL } from '../utils/user-agent.js';
import { DEFAULT_WAIT_SECONDS } from '../utils/poll.js';
import { isPlainTeamMember, teamAgentBillingRefused } from '../utils/workspace.js';
import { nextActionSchema, strictInput } from './schemas.js';

// Every plan includes every skill, so a skill change moves no money and leaves the plan as it is.
const FREE_NOTE = 'A skill change costs nothing: the plan keeps its price and the AI usage it includes.';
// Turning a skill on is free, but the work it does is not.
const WORK_NOTE = `The skills' work uses ${AGENT_AI_USAGE}, and model runs they start are billed to the wallet `
  + 'of the workspace that owns the Wiro project connected to the agent.';

const outputSchema = {
  agentGuid: z.string(),
  status: z.enum(['applied', 'no_change', 'refused']),
  idempotencyKey: z.string().optional()
    .describe('The key of this change. If the answer to it does not arrive, repeating the same change with this key never applies it twice.'),
  changes: z.object({
    enable: z.array(z.string()),
    disable: z.array(z.string()),
    addedDependencies: z.array(z.string()),
    alreadySet: z.array(z.string()),
  }),
  note: z.string()
    .describe('What the change does to the plan and its cost: nothing, since every plan includes every skill.'),
  enabledSkills: z.array(z.string()).optional(),
  credentialsNeeded: z.array(z.object({
    skill: z.string(),
    credentials: z.array(z.string()),
  })),
  pausedTasks: z.array(z.string()).optional()
    .describe('After an applied change: the scheduled tasks it paused, which wait for skills that are off. get_my_agent names those skills.'),
  agentStatus: z.string(),
  restart: z.string(),
  error: z.object({
    code: z.number().nullable(),
    message: z.string(),
    deps: z.array(z.object({ skill: z.string(), requires: z.string() })).optional(),
    conflicts: z.array(z.object({ a: z.string(), b: z.string() })).optional(),
  }).optional(),
  nextAction: nextActionSchema.optional(),
};

type Row = Record<string, unknown>;

type SkillsApplyBody = ApiEnvelope & {
  noOp?: boolean;
  pricing?: Record<string, unknown>;
  restartTriggered?: unknown;
  warnings?: unknown;
};

const UNCHANGED_RESTART = 'Nothing changed, so the agent does not restart.';

/** Wiro's own notes on an applied change, as it wrote them. */
function warningsOf(body: SkillsApplyBody): string[] {
  return (Array.isArray(body.warnings) ? body.warnings : [])
    .map(warning => asString(warning)?.trim())
    .filter((warning): warning is string => Boolean(warning));
}

/** How to give the new skills what they still need. A Wiro project comes first, since it takes no key. */
function stillNeededSteps(needed: Array<{ credentials: string[] }>): string {
  const keys = needed.flatMap(entry => entry.credentials);
  if (!keys.includes(WIRO_PROJECT_CREDENTIAL)) return 'Set them with set_agent_credentials.';
  const others = keys.some(key => key !== WIRO_PROJECT_CREDENTIAL) ? ' Set the others with set_agent_credentials.' : '';
  return `Connect the Wiro project with bind_agent_project, with no key to paste.${others}`;
}

/** A list of skills by title, with the names apply_agent_skills takes. */
function listLine(label: string, names: string[], titles: ReadonlyMap<string, string>): string | null {
  return names.length > 0 ? `**${label}:** ${names.map(name => skillLabel(name, titles)).join(', ')}` : null;
}

/** Each new skill with the credentials it still needs, by title: Video Creator (`util-video-creator`): Wiro AI Models (`wiro`). */
function neededText(
  needed: Array<{ skill: string; credentials: string[] }>,
  row: Row,
  titles: ReadonlyMap<string, string>,
  serviceTitles: ReadonlyMap<string, string>,
): string {
  return needed.map(entry => `${skillLabel(entry.skill, titles)}: ${entry.credentials.map(key => credentialLabel(row, key, serviceTitles)).join(', ')}`).join('; ');
}

/** The scheduled tasks the change paused: on and paused in the agent read after it, and not paused before it. */
function newlyPaused(before: Row, after: Row | null): CustomSkillEntry[] {
  if (!after) return [];
  const pausedBefore = new Set(customSkillEntries(before).filter(entry => entry.skillOff).map(entry => entry.key));
  return customSkillEntries(after).filter(entry => entry.kind === 'scheduled_task' && entry.enabled && entry.skillOff
    && !pausedBefore.has(entry.key));
}

/**
 * The agent read again after the change, and whether its live skills are what this change asked for; both
 * null when it cannot be read.
 */
async function readAfterChange(
  client: WiroClient,
  agentGuid: string,
  requested: Record<string, boolean>,
  signal: AbortSignal,
): Promise<{ holds: boolean | null; live: Row | null }> {
  let live: Row;
  try {
    live = await readUserAgent(client, agentGuid, signal);
  } catch {
    return { holds: null, live: null };
  }
  const enabled = new Set(enabledSkillNames(live));
  return { holds: Object.entries(requested).every(([name, on]) => enabled.has(name) === on), live };
}

/** The line that names the tasks a change paused, with the skills each waits for. */
async function pausedLine(client: WiroClient, paused: CustomSkillEntry[], signal: AbortSignal): Promise<string | null> {
  return paused.length > 0 ? `**Paused by this change:**${skillOffTasksNote(paused, await pausedSkillTitles(client, paused, signal), 'is paused')}` : null;
}

export function registerApplyAgentSkills(server: McpServer, client: WiroClient): void {
  server.registerTool(
    'apply_agent_skills',
    {
      title: 'Change an agent\'s skills',
      description: 'Turn Skills on or off for a deployed agent. Outside services are Connectors and connect with '
        + 'connect_agent_connector instead. Every plan includes every skill, so a '
        + 'skill change costs nothing: the plan keeps its price and the AI usage it includes, and no active plan is '
        + 'needed. The change is applied on the first call, so tell the user what turns on or off and get '
        + 'their yes first. The tool checks the names and turns on the skills they depend on '
        + '(add_dependencies); the result lists them, the credentials the new skills still need and the '
        + 'scheduled tasks the change paused. A running agent restarts once when a skill turns on or off. '
        + `A skill's work uses ${AGENT_AI_USAGE}, and model runs it starts are billed to the wallet of the `
        + 'workspace that owns the Wiro project connected to the agent. Newly enabled skills may still need '
        + 'credentials (set_agent_credentials, bind_agent_project for a Wiro project) and do '
        + 'not create scheduled tasks (manage_agent_custom_skill does). On a team agent only a team admin or the '
        + 'person who deployed the agent can change its skills; other members are refused and nothing changes. '
        + 'Every result gives an idempotency_key: if an answer does not arrive, repeat the same change with it, '
        + 'which never applies the change twice. To change the plan, use manage_agent_billing (change_plan). '
        + 'Find skill names with list_agent_skills and the agent\'s current skills with get_my_agent. The agents '
        + 'playbook (get_playbook) has the full setup walkthrough.',
      inputSchema: strictInput({
        agent_guid: z.string().min(1).describe('The deployed agent\'s guid, from list_my_agents.'),
        skills: z.record(z.string(), z.boolean())
          .describe('Skills to change, as name: true to turn on or name: false to turn off, for example {"util-video-creator": true}. Registry names only (list_agent_skills). Custom skills and scheduled tasks (cs-...) are managed with manage_agent_custom_skill; channels such as Telegram turn on through set_agent_credentials; connectors connect with connect_agent_connector.'),
        add_dependencies: z.boolean().default(true)
          .describe('Also turn on the skills that the enabled skills depend on (default true). Without them the change is refused.'),
        idempotency_key: z.string().min(8).max(128).optional()
          .describe('Only to repeat a change whose answer did not arrive: the idempotency_key that change returned or its error names. Repeating it never applies the change twice. Leave it out for a new change.'),
      }, 'A skill change applies on the first call and takes no confirm; manage_agent_billing with action change_plan changes the plan.'),
      outputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ agent_guid, skills, add_dependencies, idempotency_key }, extra) => {
      try {
        if (Object.keys(skills).length === 0) {
          return errorResult(new Error('Nothing to change: pass at least one skill.'));
        }
        const registry = await loadSkillRegistry(client, extra.signal);
        const titles = registryTitles(registry);
        const plan = planSkillChanges(skills, registry, add_dependencies);
        if (plan.errors.length > 0) {
          return errorResult(new Error(`The change was not sent:\n\n- ${plan.errors.join('\n- ')}`));
        }

        const row = await readUserAgent(client, agent_guid, extra.signal);
        const status = agentStatusOf(row);
        const digest = skillChangeDigest(agent_guid, plan.requested);
        const givenKey = idempotency_key ? parseSkillChangeKey(idempotency_key) : null;
        if (givenKey && givenKey.digest !== digest) {
          return errorResult(new Error('This idempotency_key belongs to a different skill change. Omit idempotency_key to make a new change, or repeat the exact change it was issued for.'));
        }

        const enabledNow = enabledSkillNames(row);
        const diff = diffSkills(plan.requested, enabledNow);
        const check = checkSkillSet(enabledNow, diff.changes, registry);
        if (check.deps.length > 0 || check.conflicts.length > 0) {
          const problems = [
            ...check.deps.map(dep => {
              const [skill, requires] = [skillLabel(dep.skill, titles), skillLabel(dep.requires, titles)];
              return diff.disable.includes(dep.requires)
                ? `${skill} needs ${requires}. Keep ${requires} on, or also turn off ${skill}.`
                : `${skill} needs ${requires}, which is off. Turn ${requires} on in the same change.`;
            }),
            ...check.conflicts.map(pair => `${skillLabel(pair.a, titles)} and ${skillLabel(pair.b, titles)} cannot be on together. Keep only one.`),
          ];
          return errorResult(new Error(`The change was not sent:\n\n- ${[...new Set(problems)].join('\n- ')}`));
        }
        const running = isAgentRunning(status);
        const changes = {
          enable: diff.enable,
          disable: diff.disable,
          addedDependencies: plan.addedDependencies.filter(name => diff.enable.includes(name)),
          alreadySet: diff.alreadySet.filter(name => !plan.addedDependencies.includes(name)),
        };
        const credentialsNeeded = credentialsNeededFor(diff.enable, registry, row);
        const serviceTitles = await credentialTitles(client, credentialsNeeded.flatMap(entry => entry.credentials), extra.signal);
        // A running agent restarts only for a skill that turns on or off.
        const skillsMove = Object.keys(diff.changes).length > 0;
        const base = {
          agentGuid: agent_guid,
          changes,
          credentialsNeeded,
          agentStatus: agentStatusLabel(status),
        };

        // An empty change does nothing. With a key issued for this same change it is still sent, so a repeat
        // gets the result of the earlier call with that key.
        if (!skillsMove && !idempotency_key) {
          return {
            content: [{ type: 'text' as const, text: `## No change needed\n\nThe skills are already as requested on agent \`${agent_guid}\`. Nothing changed.` }],
            structuredContent: {
              ...base,
              status: 'no_change' as const,
              note: FREE_NOTE,
              restart: UNCHANGED_RESTART,
            },
          };
        }

        // Every team member can read a team agent, but only a team admin or the person who deployed it can
        // change its skills. The transaction history check refuses the other members up front; the organization's
        // owner passes it and gets Wiro's own answer.
        if (skillsMove && await isPlainTeamMember(client, row, extra.signal)
          && await teamAgentBillingRefused(client, agent_guid, extra.signal)) {
          const message = 'Only a team admin or the person who deployed this agent can change its skills, and this '
            + 'connection acts as a team member without those rights. Nothing was changed. Ask a team admin or the '
            + 'person who deployed the agent to make the change.';
          return {
            content: [{ type: 'text' as const, text: `## Skill change not possible\n\n${message}` }],
            structuredContent: {
              ...base,
              status: 'refused' as const,
              note: FREE_NOTE,
              restart: UNCHANGED_RESTART,
              error: { code: 97, message },
            },
            isError: true,
          };
        }

        const key = idempotency_key?.trim() || newSkillChangeKey(digest);
        const sentEmpty = !skillsMove;
        let applied: SkillsApplyBody;
        try {
          applied = requireApiSuccess(
            await client.post<SkillsApplyBody>('/UserAgent/SkillsApply', {
              useragentguid: agent_guid,
              skills: diff.changes,
              idempotencyKey: key,
            }, extra.signal),
            'The skill change was refused.',
          );
        } catch (error) {
          if (extra.signal.aborted) throw error;
          if (!outcomeUnknown(error)) {
            const failure = describeSkillsApplyError(error, titles);
            // Code 110 is the whole outcome: the next step reads the agent, and the call is not repeated.
            const failedChange = failure.code === 110;
            const nextAction = failedChange
              ? { tool: 'get_my_agent', arguments: { agent_guid }, reason: 'Check the agent\'s skills. Do not repeat the change.' }
              : failure.code === 107
                ? { tool: 'apply_agent_skills', arguments: { agent_guid, skills, add_dependencies }, reason: 'Make the change again with a new key.' }
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
                note: failure.guidance || failure.message,
                restart: failedChange ? 'The agent does not restart for this change.' : UNCHANGED_RESTART,
                error: {
                  code: failure.code,
                  message: failure.message,
                  ...(failure.deps ? { deps: failure.deps } : {}),
                  ...(failure.conflicts ? { conflicts: failure.conflicts } : {}),
                },
                ...(nextAction ? { nextAction } : {}),
              },
              isError: true,
            };
          }

          const message = errorText(error);
          if (sentEmpty) {
            const note = 'The agent\'s skills already match the request, so the change is in place. Do not repeat it.';
            return {
              content: [{ type: 'text' as const, text: `## No change needed\n\n${note}` }],
              structuredContent: {
                ...base,
                status: 'no_change' as const,
                idempotencyKey: key,
                note: `${note} ${FREE_NOTE}`,
                restart: UNCHANGED_RESTART,
              },
            };
          }

          // The agent is read again to see whether the change is in place before anything is reported.
          const { holds, live } = await readAfterChange(client, agent_guid, plan.requested, extra.signal);
          if (holds === true) {
            const paused = newlyPaused(row, live);
            const note = `The agent's skills now match the request, so the change is in place. Do not repeat it. ${FREE_NOTE}`;
            return {
              content: [{ type: 'text' as const, text: [
                '## Skills updated',
                '',
                `**Agent:** \`${agent_guid}\``,
                listLine('Turned on', changes.enable, titles),
                listLine('Turned off', changes.disable, titles),
                note,
                `**Restart:** ${restartNote(status, 'skill change')}`,
                await pausedLine(client, paused, extra.signal),
              ].filter((line): line is string => line !== null).join('\n') }],
              structuredContent: {
                ...base,
                status: 'applied' as const,
                idempotencyKey: key,
                note,
                restart: restartNote(status, 'skill change'),
                ...(paused.length > 0 ? { pausedTasks: paused.map(entry => entry.key) } : {}),
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
              note,
              restart: unverified ? 'The agent restarts if the change was saved.' : UNCHANGED_RESTART,
              error: { code: null, message },
            },
            isError: true,
          };
        }

        // The live agent is checked against this change before it is reported as applied.
        const { holds, live } = await readAfterChange(client, agent_guid, plan.requested, extra.signal);
        if (holds === false) {
          const note = 'The agent\'s skills do not match this change, so it is not in place. Check get_my_agent; if they '
            + 'still do not match the request, call apply_agent_skills again without idempotency_key.';
          return {
            content: [{ type: 'text' as const, text: `## Skill change not applied\n\n${note}` }],
            structuredContent: {
              ...base,
              status: 'refused' as const,
              idempotencyKey: key,
              note,
              restart: UNCHANGED_RESTART,
              error: { code: null, message: note },
              nextAction: {
                tool: 'apply_agent_skills',
                arguments: { agent_guid, skills, add_dependencies },
                reason: 'Make the change again with a new key.',
              },
            },
            isError: true,
          };
        }

        // An empty request that comes back as a real change is the saved result of the earlier call with this
        // key, not a new change.
        const replayed = sentEmpty && !applied.noOp;
        // Wiro says whether this change restarts a running agent; an answer without it goes by the skills that move.
        const restarts = typeof applied.restartTriggered === 'boolean' ? applied.restartTriggered : skillsMove;
        const restart = applied.noOp || replayed || !skillsMove
          ? UNCHANGED_RESTART
          : running && !restarts
            ? 'The agent keeps running: Wiro did not restart it for this change. control_agent with action restart loads it now.'
            : restartNote(status, 'skill change');
        const note = replayed
          ? `This change was already applied by an earlier call with this idempotency_key. ${FREE_NOTE}`
          : FREE_NOTE;
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
        // Read from the agent after the change: the tasks it paused.
        const paused = applied.noOp || replayed ? [] : newlyPaused(row, live);
        const warnings = warningsOf(applied);
        const enabledSkills = applied.pricing && Array.isArray(applied.pricing.enabledSkills)
          ? applied.pricing.enabledSkills.map(String)
          : undefined;
        const lines = [
          applied.noOp ? '## No change needed' : replayed ? '## Already applied' : '## Skills updated',
          '',
          `**Agent:** \`${agent_guid}\``,
          listLine('Turned on', changes.enable, titles),
          listLine('Added because other skills need them', changes.addedDependencies, titles),
          listLine('Turned off', changes.disable, titles),
          applied.noOp || replayed ? listLine('Already as requested', changes.alreadySet, titles) : null,
          `**Cost:** ${note}${changes.enable.length > 0 && !applied.noOp && !replayed ? ` ${WORK_NOTE}` : ''}`,
          `**Restart:** ${restart}`,
          holds === null ? 'The agent could not be read afterwards to confirm the new skills; get_my_agent shows them.' : null,
          await pausedLine(client, paused, extra.signal),
          credentialsNeeded.length > 0 && !applied.noOp && !replayed
            ? `**Still needed:** credentials for ${neededText(credentialsNeeded, row, titles, serviceTitles)}. ${stillNeededSteps(credentialsNeeded)}`
            : null,
          warnings.length > 0 ? `**From Wiro:** ${warnings.join(' ')}` : null,
        ].filter((line): line is string => line !== null);
        return {
          content: [{ type: 'text' as const, text: lines.join('\n') }],
          structuredContent: {
            ...base,
            status: applied.noOp ? 'no_change' as const : 'applied' as const,
            idempotencyKey: key,
            note,
            ...(enabledSkills ? { enabledSkills } : {}),
            restart,
            ...(paused.length > 0 ? { pausedTasks: paused.map(entry => entry.key) } : {}),
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
