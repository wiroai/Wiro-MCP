import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WiroClient } from '../client.js';
import { asString, errorResult, isAgentNotFound } from '../utils/api.js';
import { readUserAgent, WORKSPACE_HINT } from '../utils/agent-config.js';
import {
  agentProjectState,
  isOtherWorkspace,
  keySafeErrorText,
  PROJECT_LIST_LIMIT,
  projectLabel,
  readProjects,
  type AgentProjectState,
  type ListedProject,
  type ProjectView,
} from '../utils/wiro-project.js';
import { agentTitleSpan } from '../utils/user-agent.js';
import { strictInput } from './schemas.js';

const outputSchema = {
  projects: z.array(z.object({
    id: z.string(),
    name: z.string(),
    authMethod: z.string().optional(),
    connected: z.boolean().describe('This connection\'s own project.'),
    canBind: z.boolean().describe('Whether this connection can connect the project to an agent with bind_agent_project.'),
    ipRestricted: z.boolean().optional().describe('Whether the project accepts requests only from the addresses on its IP list.'),
    boundToAgent: z.boolean().optional().describe('With agent_guid: whether that agent uses this project.'),
  })),
  agent: z.object({
    guid: z.string(),
    title: z.string().optional(),
    project: z.enum(['none', 'listed', 'this_connection', 'outside_list'])
      .describe('none: the agent has no project. listed: it uses one of these. this_connection: it uses the project of this connection, which is not among these. outside_list: it uses a project key from outside this list, or one this connection cannot see.'),
    projectId: z.string().optional(),
  }).optional(),
  notes: z.array(z.string()).optional(),
};

function projectLine(project: ProjectView & { boundToAgent?: boolean }, otherWorkspace: boolean): string {
  const flags = [
    project.connected ? 'this connection\'s project' : null,
    project.boundToAgent ? 'this agent uses it' : null,
    otherWorkspace
      ? 'cannot be connected to this agent'
      : project.canBind ? 'can be connected' : 'this connection cannot connect it',
    project.ipRestricted ? 'accepts requests only from its IP list' : null,
  ].filter(Boolean).join('; ');
  return `- ${projectLabel(project)}: ${flags}`;
}

function agentLine(guid: string, title: string, { current, outsideList, holdsConnectionKey }: AgentProjectState): string {
  const state = current
    ? `uses ${projectLabel(current.view)}`
    : holdsConnectionKey
      ? `uses ${projectLabel({})}`
      : outsideList
        ? 'uses a project key from outside this list, or one this connection cannot see'
        : 'has no Wiro project connected';
  return `**Agent:** ${agentTitleSpan(title)} (\`${guid}\`) ${state}.`;
}

function agentProjectKind({ current, outsideList, holdsConnectionKey }: AgentProjectState) {
  if (current) return 'listed' as const;
  if (holdsConnectionKey) return 'this_connection' as const;
  return outsideList ? 'outside_list' as const : 'none' as const;
}

export function registerListProjects(server: McpServer, client: WiroClient): void {
  server.registerTool(
    'list_projects',
    {
      title: 'List Wiro projects',
      description: 'List the projects of the connected project\'s workspace, to pick one for bind_agent_project. '
        + 'Each shows its id and name, whether it is this connection\'s own project, and whether this connection can '
        + 'connect it to an agent: a project you created, or any project of a team you are an admin of. No keys are '
        + 'shown. With agent_guid the result also says which listed project that agent uses.',
      inputSchema: strictInput({
        agent_guid: z.string().min(1).max(100).optional()
          .describe('A deployed agent\'s guid, from list_my_agents, to see which listed project it uses.'),
      }),
      outputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ agent_guid }, extra) => {
      try {
        const guid = agent_guid?.trim();
        const notes: string[] = [];
        let row: Record<string, unknown> | null = null;
        if (guid) {
          try {
            row = await readUserAgent(client, guid, extra.signal);
          } catch (error) {
            if (extra.signal.aborted || isAgentNotFound(error)) throw error;
            notes.push(`The agent could not be read: ${keySafeErrorText(error)}`);
          }
        }

        let projects: ListedProject[];
        try {
          projects = await readProjects(client, extra.signal);
        } catch (error) {
          if (extra.signal.aborted) throw error;
          return errorResult(new Error(`The projects could not be read: ${keySafeErrorText(error)}`));
        }

        const state = row ? agentProjectState(row, projects, client) : null;
        const shown = projects.map(project => ({
          ...project.view,
          ...(state ? { boundToAgent: project.view.id === state.current?.view.id } : {}),
        }));
        const agent = row && guid && state
          ? {
            guid,
            ...(asString(row.title) ? { title: asString(row.title) } : {}),
            project: agentProjectKind(state),
            ...(state.current ? { projectId: state.current.view.id } : {}),
          }
          : undefined;

        const otherWorkspace = row !== null && isOtherWorkspace(row, projects);
        if (otherWorkspace) {
          notes.push(`This agent is in another workspace than this connection's project, so none of these can be connected to it. ${WORKSPACE_HINT}`);
        } else if (projects.some(project => project.view.canBind)) {
          notes.push('bind_agent_project with agent_guid and project_id connects one: it shows a summary first and changes nothing without confirm: true.');
        }
        if (projects.length >= PROJECT_LIST_LIMIT) notes.push(`This shows the ${PROJECT_LIST_LIMIT} newest projects of the workspace.`);

        const lines = [
          `## Projects in this workspace (${projects.length})`,
          '',
          ...(row && guid && state
            ? [agentLine(guid, asString(row.title) ?? '', state), '']
            : []),
          ...(shown.length > 0 ? shown.map(project => projectLine(project, otherWorkspace)) : ['No projects were found.']),
          ...(notes.length > 0 ? ['', ...notes.map(note => `- ${note}`)] : []),
        ];
        return {
          content: [{ type: 'text' as const, text: lines.join('\n') }],
          structuredContent: {
            projects: shown,
            ...(agent ? { agent } : {}),
            ...(notes.length > 0 ? { notes } : {}),
          },
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
