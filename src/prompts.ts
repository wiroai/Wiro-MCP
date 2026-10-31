import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { TOOLSETS, type Toolset } from './tools/index.js';

// Ready-made plans for the jobs that take several tools in a fixed order. Each
// one sends the assistant to the matching playbook first, because the plan
// here is only the outline. A prompt is offered only when every tool it names
// is loaded, so it never points at a tool the client cannot call.

function given(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function userMessage(text: string) {
  return {
    messages: [{
      role: 'user' as const,
      content: { type: 'text' as const, text },
    }],
  };
}

function buildWorkflowText(goal: string | undefined): string {
  return [
    `I want a Wiro workflow for this goal: ${goal ?? '(not given yet, ask me first)'}`,
    '',
    'Before anything else, call `get_playbook` with the topics "workflows", "workflow-graph" and "workflow-agent" and follow them.',
    '',
    'Plan:',
    '1. Call `get_account` to see which workspace and wallet this key uses.',
    '2. Split the goal into steps. For each step, find a model with `search_models` (a category, or one to three key words) and read it with `get_model_schema`. For steps that only pick, join or split data, read the utilities with `get_model_schema` (workflow-utilities/output-filter, workflow-utilities/merge-text or workflow-utilities/split-text).',
    '3. Build the workflow in one of two ways:',
    '   - Write the graph yourself and save it with `create_workflow`. Saving is free.',
    '   - Or ask the Workflow Agent with `send_agent_message` (agent "workflow-agent") and save its proposal with `save_workflow_from_agent`. Tell me first that it needs at least $10 in the wallet and that its turns are billed.',
    '4. Show me the inputs and the outputs of the saved workflow, and the models it uses with their prices.',
    '5. Estimate the cost of one run from the model prices and ask me before running it. Test first with `run_workflow` stopped after an early step, check the result with `wait_for_workflow_run`, then continue with `resume_workflow_run`.',
    '6. Show me every output file and text.',
    '',
    'Confirm every charge with me before it happens. Follow each `nextAction` to keep waiting, and never start the same run twice.',
  ].join('\n');
}

function deployAgentText(goal: string | undefined): string {
  return [
    `I want a Wiro agent for this goal: ${goal ?? '(not given yet, ask me first)'}`,
    '',
    'Before anything else, call `get_playbook` with the topic "agents" and follow it.',
    '',
    'Plan:',
    '1. Look for a template with `list_agent_templates` and read the best matches with `get_agent_template`. If none fits, suggest a custom build from `list_agent_skills`.',
    '2. Show me the options: tier, monthly price, monthly credits, the credentials and accounts it needs, and its chat channels. Let me choose.',
    '3. Call `get_account` to check the balance and which wallet will pay.',
    '4. Call `deploy_agent` without confirm to get the quote. Show me the amount, the wallet, and that the plan renews every 30 days until it is cancelled. Only after I say yes, repeat the call as the quote\'s `nextAction` shows: `confirm: true` with `confirm_charge_usd` set to the quoted amount. If the price changed in between, nothing is charged: show me the new quote.',
    '5. Wait with `get_my_agent` until the agent is running (status 4). It starts even while credentials are missing.',
    '6. Set it up: ask me for each required credential and save it with `set_agent_credentials`. For sign-in accounts, call `connect_agent_oauth` and tell me what it needs: a sign-in link, my own app keys first, or a token. If it gives a link, wait for me, then check the status.',
    '7. Tell me what works now and what still needs setup. Offer a short test message with `send_agent_message`; each message uses the agent\'s credits.',
    '',
    'Confirm every charge with me before it happens. Never repeat secret values back to me. If a deploy fails or times out, check `list_my_agents` before trying again.',
  ].join('\n');
}

function createWithStudioText(request: string | undefined): string {
  return [
    `Create this with Wiro Studio: ${request ?? '(not given yet, ask me first)'}`,
    '',
    'Before anything else, call `get_playbook` with the topic "studio" and follow it.',
    '',
    'Plan:',
    '1. Call `get_account`. Tell me in one line that a Studio turn needs at least $10 in the wallet to start (a minimum, not a spending cap) and is billed after the turn for its chat and each model run it starts. If my request is large or open-ended, such as many videos, agree on the scope with me first.',
    '2. Call `send_agent_message` with agent "studio", my request and a new session name.',
    '3. If the reply is not ready, follow its `nextAction` with `get_agent_message` until the turn completes. Never send the request again.',
    '4. Show me every file from the turn\'s model runs, inline when you can, with its link and the cost. If Studio says it is working in the background, or a result is missing, collect the rest with `list_studio_results`.',
    '5. Offer changes in the same session.',
    '',
    'Confirm any further spending with me before it happens.',
  ].join('\n');
}

function talkToMyAgentText(agentName: string | undefined, message: string | undefined): string {
  return [
    'Send a message to one of my Wiro agents.',
    `Agent: ${agentName ?? '(not given: list my agents and ask me which one)'}`,
    `Message: ${message ?? '(not given: ask me what to send)'}`,
    '',
    'Before anything else, call `get_playbook` with the topic "agents" and follow it.',
    '',
    'Plan:',
    '1. Call `list_my_agents` and find the agent by name. If there is no clear match, show me the list and ask.',
    '2. Call `get_my_agent`. The agent must be running (status 4) and have credits left. If it is stopped, ask me before starting it with `control_agent`, then wait until it runs. If it has no credits, tell me and stop there.',
    '3. Call `send_agent_message` with agent set to the agent\'s guid and the message. Use its main session ("default") unless I name another one.',
    '4. If the reply is not ready, follow its `nextAction` with `get_agent_message`. If the agent moves the work to the background, read the result later with `get_agent_conversation`.',
    '5. Show me the reply and any files.',
    '',
    'Each message uses the agent\'s credits. Confirm with me before any action that costs money, such as buying credits or renewing the plan.',
  ].join('\n');
}

export function registerPrompts(server: McpServer, toolsets: readonly Toolset[] = TOOLSETS): void {
  const enabled = new Set<Toolset>(toolsets);
  const agents = enabled.has('agents');
  const workflows = enabled.has('workflows');

  if (workflows) {
    server.registerPrompt(
      'build_workflow',
      {
        title: 'Build a Wiro workflow',
        description: 'Plan, save and test a multi-step Wiro workflow for a goal, confirming costs before any run.',
        argsSchema: {
          goal: z.string().describe('What the workflow should do, e.g. "turn a product photo into a 5 second ad video".'),
        },
      },
      ({ goal }) => userMessage(buildWorkflowText(given(goal))),
    );
  }

  if (agents) {
    server.registerPrompt(
      'deploy_agent',
      {
        title: 'Deploy a Wiro agent',
        description: 'Choose a template or skills, quote and deploy a Wiro agent, then set it up and test it.',
        argsSchema: {
          goal: z.string().describe('What the agent should do, e.g. "post our blog articles to LinkedIn every Monday".'),
        },
      },
      ({ goal }) => userMessage(deployAgentText(given(goal))),
    );
  }

  // Studio is reached through the conversation tools, which both toolsets load.
  if (agents || workflows) {
    server.registerPrompt(
      'create_with_studio',
      {
        title: 'Create with Wiro Studio',
        description: 'Ask Wiro Studio to create images, video or audio, after explaining what a turn can cost.',
        argsSchema: {
          request: z.string().describe('What to create, e.g. "three square product shots of a ceramic mug on a wooden table".'),
        },
      },
      ({ request }) => userMessage(createWithStudioText(given(request))),
    );
  }

  if (agents) {
    server.registerPrompt(
      'talk_to_my_agent',
      {
        title: 'Talk to my Wiro agent',
        description: 'Find one of your deployed Wiro agents, make sure it is running, send it a message and show the reply.',
        argsSchema: {
          agent_name: z.string().optional().describe('The agent\'s name, as shown in your agent list. Leave empty to choose from the list.'),
          message: z.string().optional().describe('The message to send. Leave empty to be asked.'),
        },
      },
      ({ agent_name, message }) => userMessage(talkToMyAgentText(given(agent_name), given(message))),
    );
  }
}
