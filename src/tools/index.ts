import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { WiroClient } from '../client.js';
import { registerSearchModels } from './search-models.js';
import { registerGetModelSchema } from './get-model-schema.js';
import { registerRunModel } from './run-model.js';
import { registerWaitForTask } from './wait-for-task.js';
import { registerGetTask } from './get-task.js';
import { registerListTasks } from './list-tasks.js';
import { registerGetTaskPrice } from './get-task-price.js';
import { registerCancelTask } from './cancel-task.js';
import { registerKillTask } from './kill-task.js';
import { registerSearchDocs } from './search-docs.js';
import { registerRecommendModel } from './recommend-model.js';
import { registerExplore } from './explore.js';
import { registerUploadFile } from './upload-file.js';
import { registerGetAccount } from './get-account.js';
import { registerListWorkflows } from './list-workflows.js';
import { registerGetWorkflow } from './get-workflow.js';
import { registerCreateWorkflow } from './create-workflow.js';
import { registerUpdateWorkflow } from './update-workflow.js';
import { registerCloneWorkflow } from './clone-workflow.js';
import { registerDeleteWorkflow } from './delete-workflow.js';
import { registerRunWorkflow } from './run-workflow.js';
import { registerWaitForWorkflowRun } from './wait-for-workflow-run.js';
import { registerResumeWorkflowRun } from './resume-workflow-run.js';
import { registerListWorkflowRuns } from './list-workflow-runs.js';
import { registerGetPlaybook } from './get-playbook.js';
import { registerSendAgentMessage } from './send-agent-message.js';
import { registerGetAgentMessage } from './get-agent-message.js';
import { registerGetAgentConversation } from './get-agent-conversation.js';
import { registerCancelAgentMessage } from './cancel-agent-message.js';
import { registerDeleteAgentSession } from './delete-agent-session.js';
import { registerListStudioResults } from './list-studio-results.js';
import { registerSaveWorkflowFromAgent } from './save-workflow-from-agent.js';
import { registerListAgentTemplates } from './list-agent-templates.js';
import { registerGetAgentTemplate } from './get-agent-template.js';
import { registerListAgentSkills } from './list-agent-skills.js';
import { registerDeployAgent } from './deploy-agent.js';
import { registerListMyAgents } from './list-my-agents.js';
import { registerGetMyAgent } from './get-my-agent.js';
import { registerControlAgent } from './control-agent.js';
import { registerUpdateAgent } from './update-agent.js';
import { registerManageAgentBilling } from './manage-agent-billing.js';
import { registerGetAgentActivity } from './get-agent-activity.js';
import { registerDeleteAgent } from './delete-agent.js';
import { registerApplyAgentSkills } from './apply-agent-skills.js';
import { registerSetAgentCredentials } from './set-agent-credentials.js';
import { registerConnectAgentOauth } from './connect-agent-oauth.js';
import { registerDisconnectAgentOauth } from './disconnect-agent-oauth.js';
import { registerManageAgentCustomSkill } from './manage-agent-custom-skill.js';

export const TOOLSETS = ['models', 'workflows', 'agents'] as const;
export type Toolset = typeof TOOLSETS[number];

/** What a tool wrapper is told about the tool it wraps. */
export interface ToolInfo {
  name: string;
  title?: string;
  annotations?: ToolAnnotations;
}

/** A tool's handler as the MCP server calls it: the arguments, then the request context. */
export type ToolHandler = (...args: never[]) => unknown;

/**
 * Lets a server that embeds these tools put its own checks around every call,
 * such as logging or an extra permission check. It gets each tool and its handler
 * and returns the handler to register.
 */
export type ToolWrapper = (tool: ToolInfo, handler: ToolHandler) => ToolHandler;

export interface RegisterToolsOptions {
  /** Which groups of tools to register. Defaults to all of them. */
  toolsets?: readonly Toolset[];
  /** Wraps every tool's handler before it is registered. */
  wrapTool?: ToolWrapper;
}

/** The server as the register functions see it, with every handler passed through `wrap`. */
function withToolWrapper(server: McpServer, wrap: ToolWrapper): McpServer {
  const registerTool = server.registerTool.bind(server) as unknown as (
    name: string,
    config: { title?: string; annotations?: ToolAnnotations },
    handler: ToolHandler,
  ) => unknown;
  return new Proxy(server, {
    get(target, property, receiver) {
      if (property !== 'registerTool') return Reflect.get(target, property, receiver);
      return (name: string, config: { title?: string; annotations?: ToolAnnotations }, handler: ToolHandler) =>
        registerTool(name, config, wrap({ name, title: config.title, annotations: config.annotations }, handler));
    },
  });
}

/** Parses a comma-separated list such as "models,workflows"; unknown names are ignored. */
export function parseToolsets(value: string | undefined): Toolset[] | undefined {
  if (!value || !value.trim()) return undefined;
  const requested = value.split(',').map(name => name.trim().toLowerCase());
  const toolsets = TOOLSETS.filter(toolset => requested.includes(toolset));
  return toolsets.length > 0 ? toolsets : undefined;
}

export function registerTools(
  mcpServer: McpServer,
  client: WiroClient,
  options: RegisterToolsOptions = {},
): void {
  const server = options.wrapTool ? withToolWrapper(mcpServer, options.wrapTool) : mcpServer;
  const enabled = new Set<Toolset>(options.toolsets ?? TOOLSETS);

  // Always available: account context, guides and documentation.
  registerGetAccount(server, client);
  registerGetPlaybook(server);
  registerSearchDocs(server);

  if (enabled.has('models')) {
    registerSearchModels(server, client);
    registerGetModelSchema(server, client);
    registerRecommendModel(server, client);
    registerExplore(server, client);
    registerRunModel(server, client);
    registerWaitForTask(server, client);
    registerGetTask(server, client);
    registerListTasks(server, client);
    registerGetTaskPrice(server, client);
    registerCancelTask(server, client);
    registerKillTask(server, client);
    registerUploadFile(server, client);
  }

  if (enabled.has('workflows')) {
    if (!enabled.has('models')) {
      // Authoring a workflow needs the model catalog. Without run_model, the
      // schema points at workflow steps instead.
      registerSearchModels(server, client);
      registerGetModelSchema(server, client, { runModel: false });
      registerRecommendModel(server, client);
      registerUploadFile(server, client);
    }
    registerListWorkflows(server, client);
    registerGetWorkflow(server, client);
    registerCreateWorkflow(server, client);
    registerUpdateWorkflow(server, client);
    registerCloneWorkflow(server, client);
    registerDeleteWorkflow(server, client);
    registerRunWorkflow(server, client);
    registerWaitForWorkflowRun(server, client);
    registerResumeWorkflowRun(server, client);
    registerListWorkflowRuns(server, client);
  }

  // One conversation API serves Studio, the Workflow Agent and deployed agents,
  // so Studio and the Workflow Agent are reachable from either toolset. The Studio
  // guidance collects late results with list_studio_results, and a Workflow Agent
  // reply points at save_workflow_from_agent, so both come along.
  if (enabled.has('agents') || enabled.has('workflows')) {
    registerSendAgentMessage(server, client);
    registerGetAgentMessage(server, client);
    registerGetAgentConversation(server, client);
    registerCancelAgentMessage(server, client);
    registerDeleteAgentSession(server, client);
    registerListStudioResults(server, client);
    registerSaveWorkflowFromAgent(server, client);
  }

  if (enabled.has('agents')) {
    registerListAgentTemplates(server, client);
    registerGetAgentTemplate(server, client);
    registerListAgentSkills(server, client);
    registerDeployAgent(server, client);
    registerListMyAgents(server, client);
    registerGetMyAgent(server, client);
    registerControlAgent(server, client);
    registerUpdateAgent(server, client);
    registerManageAgentBilling(server, client);
    registerGetAgentActivity(server, client);
    registerDeleteAgent(server, client);
    registerApplyAgentSkills(server, client);
    registerSetAgentCredentials(server, client);
    registerConnectAgentOauth(server, client);
    registerDisconnectAgentOauth(server, client);
    registerManageAgentCustomSkill(server, client);
  }
}

export {
  registerSearchModels,
  registerGetModelSchema,
  registerRecommendModel,
  registerExplore,
  registerRunModel,
  registerWaitForTask,
  registerGetTask,
  registerListTasks,
  registerGetTaskPrice,
  registerCancelTask,
  registerKillTask,
  registerUploadFile,
  registerSearchDocs,
  registerGetAccount,
  registerListWorkflows,
  registerGetWorkflow,
  registerCreateWorkflow,
  registerUpdateWorkflow,
  registerCloneWorkflow,
  registerDeleteWorkflow,
  registerRunWorkflow,
  registerWaitForWorkflowRun,
  registerResumeWorkflowRun,
  registerListWorkflowRuns,
  registerGetPlaybook,
  registerSendAgentMessage,
  registerGetAgentMessage,
  registerGetAgentConversation,
  registerCancelAgentMessage,
  registerDeleteAgentSession,
  registerListStudioResults,
  registerSaveWorkflowFromAgent,
  registerListAgentTemplates,
  registerGetAgentTemplate,
  registerListAgentSkills,
  registerDeployAgent,
  registerListMyAgents,
  registerGetMyAgent,
  registerControlAgent,
  registerUpdateAgent,
  registerManageAgentBilling,
  registerGetAgentActivity,
  registerDeleteAgent,
  registerApplyAgentSkills,
  registerSetAgentCredentials,
  registerConnectAgentOauth,
  registerDisconnectAgentOauth,
  registerManageAgentCustomSkill,
};
