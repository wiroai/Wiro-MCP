import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WiroClient } from '../client.js';
import {
  asString,
  errorResult,
  errorText,
  isAgentNotFound,
  isOutcomeUnknown,
  isPlainObject,
  requireApiSuccess,
  toNumber,
  type ApiEnvelope,
} from '../utils/api.js';
import {
  agentStatusLabel,
  agentStatusOf,
  customSkillEntries,
  keyList,
  loadSkillRegistry,
  readUserAgent,
  restartNote,
  setupStillMissingNote,
  unusedCredential,
  workspaceHint,
  WORKSPACE_HINT,
  type UnusedCredential,
} from '../utils/agent-config.js';
import { DEFAULT_WAIT_SECONDS } from '../utils/poll.js';
import { jsonSpan, quotedSpan } from '../utils/quoted-text.js';
import {
  agentTitleSpan,
  nextStepForAgent,
  skillOffTasksNote,
  toAgentDetail,
  WIRO_PROJECT_CREDENTIAL,
  type AgentDetail,
  type NextAction,
} from '../utils/user-agent.js';
import {
  agentProjectState,
  isOtherWorkspace,
  keySafeErrorText,
  OUTSIDE_LIST_TEXT,
  projectLabel,
  readProjects,
  type ListedProject,
} from '../utils/wiro-project.js';
import { isPlainTeamMember, payingWalletText, readPayingWallet, teamAgentBillingRefused } from '../utils/workspace.js';
import { nextActionSchema, strictInput } from './schemas.js';

// What the route takes as a project's id.
const PROJECT_ID_PATTERN = /^[1-9][0-9]{0,17}$/;

const RECONNECT_NOTE = 'Connecting it again changes nothing. If the project\'s secret changed, restart the agent with control_agent so it loads the new one.';

const WALLET_WHEN_UNKNOWN = 'The wallet of the workspace that owns the project.';

const MEMBER_REFUSAL = 'Only a team admin or the person who deployed this agent can connect a project to it, and this '
  + 'connection acts as a team member without those rights. Nothing was changed. Ask a team admin or the person who '
  + 'deployed the agent to do it.';

const OTHER_WORKSPACE = `This agent is in another workspace than this connection's project, and nothing was changed. ${WORKSPACE_HINT}`;

const IP_LIST_WARNING = 'This project accepts requests only from the addresses on its IP list, and the agent\'s model calls '
  + 'are refused unless they come from one of them. To use it, allow all addresses for the project in the Wiro dashboard, '
  + 'or choose another project with list_projects.';

const restartStateSchema = z.enum(['scheduled', 'none', 'failed']);

type RestartState = z.infer<typeof restartStateSchema>;

const outputSchema = {
  agentGuid: z.string(),
  state: z.enum(['preview', 'unchanged', 'bound']),
  project: z.object({
    id: z.string().optional(),
    name: z.string().optional(),
    connected: z.boolean().describe('This connection\'s own project.'),
  }),
  replaces: z.object({
    id: z.string().optional(),
    name: z.string().optional(),
    outsideList: z.boolean().optional().describe('The agent holds a project outside this list or a key saved earlier.'),
  }).nullable(),
  applied: z.number().int().optional().describe('1 when the stored project changed, 0 when it was already this one.'),
  restart: restartStateSchema.optional()
    .describe('scheduled: a running agent restarts with the project. none: nothing changed, or the agent is not running and reads it at its next start. failed: the project is saved, but the running agent needs control_agent restart.'),
  wallet: z.string().optional().describe('Which wallet pays for the model runs the agent starts.'),
  warnings: z.array(z.string()),
  notes: z.array(z.string()),
  nextAction: nextActionSchema.optional(),
};

type BindBody = ApiEnvelope & { applied?: unknown; project?: unknown; restart?: unknown };

/** What a bind would do, read afresh for every call, so a confirm acts only on what is true now. */
interface BindPlan {
  row: Record<string, unknown>;
  plainMember: boolean;
  /** The project asked for. Null when no project_id was passed and this connection's project is not in the list. */
  target: ListedProject | null;
  current: ListedProject | null;
  outsideList: boolean;
  /** The agent holds this connection's own key, listed or not. */
  holdsConnectionKey: boolean;
  /** The agent already holds the project asked for. */
  alreadyBound: boolean;
  /** How many projects this connection could connect instead: not the target, and not the one the agent already uses. */
  others: number;
  unused: UnusedCredential | null;
}

async function readBindPlan(client: WiroClient, agentGuid: string, projectId: string | undefined, signal: AbortSignal): Promise<BindPlan> {
  let row: Record<string, unknown>;
  try {
    row = await readUserAgent(client, agentGuid, signal);
  } catch (error) {
    if (signal.aborted || isAgentNotFound(error)) throw error;
    throw new Error(`The agent could not be read, and nothing was changed: ${keySafeErrorText(error)}`);
  }

  // Only a warning hangs on this read, so a failed one just leaves it out.
  let unused: UnusedCredential | null = null;
  try {
    unused = unusedCredential(row, WIRO_PROJECT_CREDENTIAL, await loadSkillRegistry(client, signal));
  } catch (error) {
    if (signal.aborted) throw error;
  }

  // Every team member can read a team agent, but only a team admin or the
  // person who deployed it can change it. As in apply_agent_skills, the credit
  // history check refuses the other members up front; the organization's owner
  // passes it and gets Wiro's answer on confirm.
  const plainMember = await isPlainTeamMember(client, row, signal);
  if (plainMember && await teamAgentBillingRefused(client, agentGuid, signal)) throw new Error(MEMBER_REFUSAL);

  let projects: ListedProject[];
  try {
    projects = await readProjects(client, signal);
  } catch (error) {
    if (signal.aborted) throw error;
    throw new Error(`The projects could not be read, and nothing was changed: ${keySafeErrorText(error)}`);
  }
  if (isOtherWorkspace(row, projects)) throw new Error(OTHER_WORKSPACE);

  const target = projectId !== undefined
    ? projects.find(project => project.view.id === projectId) ?? null
    : projects.find(project => project.view.connected) ?? null;
  if (projectId !== undefined && !target) {
    throw new Error(`No project with the id ${projectId} is in this connection's workspace, and nothing was changed. list_projects shows the projects you can choose.`);
  }
  if (target && !target.view.canBind) {
    throw new Error('You can bind a project you created, or any project of a team you are an admin of. Nothing was changed. list_projects shows which ones.');
  }

  const { current, outsideList, holdsConnectionKey } = agentProjectState(row, projects, client);
  return {
    row,
    plainMember,
    target,
    current,
    outsideList,
    holdsConnectionKey,
    alreadyBound: target ? target === current : holdsConnectionKey,
    others: projects.filter(project => project.view.canBind && project !== target && project !== current).length,
    unused,
  };
}

/** What to say before and after connecting: nothing uses the project yet, or its IP list stands in the way. */
function warningsOf(plan: BindPlan): string[] {
  const warnings: string[] = [];
  if (plan.unused) {
    const skills = plan.unused.skills;
    warnings.push(`No active skill of this agent uses a Wiro project yet, so connecting one changes nothing until one does.${skills.length > 0 ? ` Turn on ${skills.join(' or ')} with apply_agent_skills to use it.` : ''}`);
  }
  if (plan.target?.view.ipRestricted) warnings.push(IP_LIST_WARNING);
  return warnings;
}

function hasProject(plan: BindPlan): boolean {
  return plan.current !== null || plan.outsideList || plan.holdsConnectionKey;
}

/**
 * What turns on with the project. Saving one sets every custom skill and
 * scheduled task that requires it to on: with a first project that is all of
 * them, and with a new project it is the ones that are off now. A task whose
 * skills are all off is named with the skill it still waits for. Null when
 * nothing does, as when the agent already holds this project.
 */
function turnsOnNote(plan: BindPlan, when: 'once' | 'now that'): string | null {
  if (plan.alreadyBound) return null;
  const replacing = hasProject(plan);
  const entries = customSkillEntries(plan.row).filter(entry => entry.requiresCredentials.includes(WIRO_PROJECT_CREDENTIAL)
    && (!replacing || !entry.enabled));
  if (entries.length === 0) return null;
  const sentence = `${keyList(entries.map(entry => quotedSpan(entry.key)))} ${entries.length > 1 ? 'turn' : 'turns'} on ${when} the project is connected.${skillOffTasksNote(entries)}`;
  return entries.some(entry => entry.kind === 'scheduled_task')
    ? `${sentence} Every run of a scheduled task uses credits; turn off any you do not want with manage_agent_custom_skill.`
    : sentence;
}

function replacedProject(plan: BindPlan): { id?: string; name?: string; outsideList?: boolean } | null {
  if (plan.alreadyBound || !hasProject(plan)) return null;
  if (plan.current) return { id: plan.current.view.id, name: plan.current.view.name };
  // Nothing is known of this connection's own project when the list leaves it out.
  return plan.outsideList ? { outsideList: true } : {};
}

function replacedLine(replaces: ReturnType<typeof replacedProject>): string[] {
  if (!replaces) return [];
  return [`**Replaces:** ${replaces.outsideList ? OUTSIDE_LIST_TEXT : projectLabel(replaces)}`];
}

function nextLine(nextAction: NextAction | undefined): string[] {
  return nextAction
    ? ['', `**Next:** \`${nextAction.tool}\` with ${jsonSpan(nextAction.arguments)}. ${nextAction.reason}`]
    : [];
}

function bulletLines(warnings: string[], notes: string[]): string[] {
  const all = [...warnings.map(warning => `Warning: ${warning}`), ...notes];
  return all.length > 0 ? ['', ...all.map(line => `- ${line}`)] : [];
}

function agentLine(agentGuid: string, row: Record<string, unknown>): string {
  return `**Agent:** ${agentTitleSpan(asString(row.title) ?? '')} (\`${agentGuid}\`), ${agentStatusLabel(agentStatusOf(row))}`;
}

function targetView(plan: BindPlan): { id?: string; name?: string; connected: boolean } {
  return plan.target
    ? { id: plan.target.view.id, name: plan.target.view.name, connected: plan.target.view.connected }
    : { connected: true };
}

async function walletText(client: WiroClient, signal: AbortSignal): Promise<string> {
  const { workspace } = await readPayingWallet(client, signal);
  return payingWalletText(workspace, WALLET_WHEN_UNKNOWN);
}

/** The answer when the agent already has the project: from the summary, or from the route when it changed nothing. */
function unchangedResult(agentGuid: string, plan: BindPlan, project: { id?: string; name?: string; connected: boolean }, restart?: RestartState) {
  const warnings = warningsOf(plan);
  const notes = [RECONNECT_NOTE];
  const lines = [
    '## Already connected',
    '',
    agentLine(agentGuid, plan.row),
    `**Project:** ${projectLabel(project)}`,
    '',
    'This project is already connected to the agent, and nothing changed.',
    ...bulletLines(warnings, notes),
  ];
  return {
    content: [{ type: 'text' as const, text: lines.join('\n') }],
    structuredContent: {
      agentGuid,
      state: 'unchanged' as const,
      project,
      replaces: null,
      ...(restart !== undefined ? { applied: 0, restart } : {}),
      warnings,
      notes,
    },
  };
}

async function previewResult(client: WiroClient, agentGuid: string, plan: BindPlan, signal: AbortSignal) {
  const project = targetView(plan);
  if (plan.alreadyBound) return unchangedResult(agentGuid, plan, project);

  const wallet = await walletText(client, signal);
  const replaces = replacedProject(plan);
  const warnings = warningsOf(plan);
  const notes = [
    restartNote(agentStatusOf(plan.row), 'project'),
    ...(plan.others > 0
      ? [`${plan.others} other ${plan.others === 1 ? 'project' : 'projects'} can be chosen; list_projects shows ${plan.others === 1 ? 'it' : 'them'}.`]
      : []),
    ...[turnsOnNote(plan, 'once')].filter((note): note is string => note !== null),
  ];
  const nextAction = {
    tool: 'bind_agent_project',
    arguments: {
      agent_guid: agentGuid,
      // The yes covers exactly the project shown here.
      ...(plan.target ? { project_id: plan.target.view.id } : {}),
      confirm: true,
    },
    reason: 'Ask the user to confirm this first.',
  };
  const lines = [
    '## Connect a Wiro project to this agent?',
    '',
    agentLine(agentGuid, plan.row),
    `**Project:** ${projectLabel(project)}${plan.target?.view.connected ? ', the project of this connection' : ''}`,
    ...replacedLine(replaces),
    `**Model runs the agent starts are paid by:** ${wallet}`,
    ...bulletLines(warnings, notes),
    '',
    'Nothing has changed yet.',
    ...nextLine(nextAction),
  ];
  return {
    content: [{ type: 'text' as const, text: lines.join('\n') }],
    structuredContent: {
      agentGuid,
      state: 'preview' as const,
      project,
      replaces,
      wallet,
      warnings,
      notes,
      nextAction,
    },
  };
}

function restartSentence(restart: RestartState | undefined, hadProject: boolean): string {
  switch (restart) {
    case 'scheduled':
      return 'The agent restarts with the project, which takes about a minute.';
    case 'none':
      return 'The agent is not running and uses the project when it next starts.';
    case 'failed':
      return `The project is saved, but the running agent ${hadProject ? 'keeps the old one' : 'runs without it'} until it restarts.`;
    default:
      return 'get_my_agent shows whether the agent restarted.';
  }
}

function toRestartState(value: unknown): RestartState | undefined {
  return value === 'scheduled' || value === 'none' || value === 'failed' ? value : undefined;
}

/** A refusal as this tool's user reads it. A key cannot switch workspaces, and list_projects is what lists here. */
function refusalText(error: unknown): string {
  const message = errorText(error);
  // The rest of this answer varies, so it is shown as Wiro sent it.
  if (message.startsWith('This project\'s API key no longer works:')) return message;
  if (workspaceHint(message)) return OTHER_WORKSPACE;
  return message.replaceAll('Project/List', 'list_projects');
}

async function bindAndReport(client: WiroClient, agentGuid: string, projectId: string | undefined, plan: BindPlan, signal: AbortSignal) {
  let body: BindBody;
  try {
    body = requireApiSuccess(
      await client.post<BindBody>('/UserAgent/CredentialProjectBind', {
        useragentguid: agentGuid,
        ...(projectId !== undefined ? { projectid: projectId } : {}),
      }, signal),
      'The project could not be bound. Try again.',
    );
  } catch (error) {
    if (signal.aborted) throw error;
    if (isOutcomeUnknown(error)) {
      throw new Error(`${keySafeErrorText(error)}\n\nThe outcome is not known: the project may or may not be connected. list_projects with agent_guid shows the project the agent uses now, and repeating this call is safe.`);
    }
    throw new Error(refusalText(error));
  }

  // The route's answer is the authority on what was connected.
  const answered = isPlainObject(body.project) ? body.project : {};
  const shown = targetView(plan);
  const id = asString(answered.id) ?? shown.id;
  const name = asString(answered.name) ?? shown.name;
  const project = { ...(id ? { id } : {}), ...(name ? { name } : {}), connected: shown.connected };
  const restart = toRestartState(body.restart);
  if (toNumber(body.applied) === 0) return unchangedResult(agentGuid, plan, project, restart ?? 'none');

  const notes = [restartSentence(restart, hasProject(plan))];
  // The bind is done whatever this read says.
  let after: Record<string, unknown> | null = null;
  let detail: AgentDetail | null = null;
  try {
    after = await readUserAgent(client, agentGuid, signal);
    detail = toAgentDetail(after);
  } catch (error) {
    if (signal.aborted) throw error;
    notes.push('The agent could not be read afterwards; get_my_agent shows its state.');
  }
  const setup = setupStillMissingNote(detail?.setupRequired ? detail.missingCredentials : []);
  if (setup) notes.push(setup);
  const turnsOn = turnsOnNote(plan, 'now that');
  if (turnsOn) notes.push(turnsOn);

  const followUp = {
    tool: 'get_my_agent',
    arguments: { agent_guid: agentGuid, wait_seconds: DEFAULT_WAIT_SECONDS },
    reason: 'See the agent settle with the project.',
  };
  let nextAction: NextAction | undefined;
  if (restart === 'failed') {
    nextAction = {
      tool: 'control_agent',
      arguments: { agent_guid: agentGuid, action: 'restart', wait_seconds: DEFAULT_WAIT_SECONDS },
      reason: 'The project is saved; a restart makes the running agent load it.',
    };
  } else if (restart === 'none' && detail) {
    nextAction = nextStepForAgent(detail, DEFAULT_WAIT_SECONDS, plan.plainMember);
  } else {
    nextAction = followUp;
  }

  const wallet = await walletText(client, signal);
  const replaces = replacedProject(plan);
  const warnings = warningsOf(plan);
  const lines = [
    '## Project connected',
    '',
    agentLine(agentGuid, after ?? plan.row),
    `**Project:** ${projectLabel(project)}`,
    ...replacedLine(replaces),
    `**Model runs the agent starts are paid by:** ${wallet}`,
    ...bulletLines(warnings, notes),
    ...nextLine(nextAction),
  ];
  return {
    content: [{ type: 'text' as const, text: lines.join('\n') }],
    structuredContent: {
      agentGuid,
      state: 'bound' as const,
      project,
      replaces,
      applied: 1,
      ...(restart ? { restart } : {}),
      wallet,
      warnings,
      notes,
      ...(nextAction ? { nextAction } : {}),
    },
  };
}

export function registerBindAgentProject(server: McpServer, client: WiroClient): void {
  server.registerTool(
    'bind_agent_project',
    {
      title: 'Connect an agent to a Wiro project',
      description: 'Connect a deployed agent to a Wiro project, so it can run Wiro models, with no key in this chat. '
        + 'Without project_id it takes the project of this connection; project_id takes one from list_projects. Call it '
        + 'without confirm first: it shows the project, what it replaces, whether a running agent restarts and which wallet '
        + 'pays for the agent\'s model runs, and changes nothing. After the user agrees, repeat the call as its nextAction '
        + 'shows, with confirm: true. Connecting the same project again changes nothing and does not restart the agent; '
        + 'if the project\'s secret changed, restart the agent with control_agent. On a team agent this needs a team admin '
        + 'or the person who deployed it.',
      inputSchema: strictInput({
        agent_guid: z.string().min(1).max(100).describe('The deployed agent\'s guid, from list_my_agents.'),
        project_id: z.string()
          .regex(PROJECT_ID_PATTERN, 'project_id must be the id of a project from list_projects, such as "12345". Nothing was changed.')
          .optional()
          .describe('The id of a project, as a string, from list_projects. Leave it out for the project of this connection.'),
        confirm: z.boolean().default(false)
          .describe('false (default) only shows what would change. true connects the project.'),
      }),
      outputSchema,
      annotations: {
        readOnlyHint: false,
        // It can replace a project, and it restarts a running agent.
        destructiveHint: true,
        // A repeat changes nothing.
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ agent_guid, project_id, confirm }, extra) => {
      try {
        const agentGuid = agent_guid.trim();
        const plan = await readBindPlan(client, agentGuid, project_id, extra.signal);
        return confirm
          ? await bindAndReport(client, agentGuid, project_id, plan, extra.signal)
          : await previewResult(client, agentGuid, plan, extra.signal);
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
