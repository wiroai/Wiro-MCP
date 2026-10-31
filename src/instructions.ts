// Sent to clients in the MCP initialize result. Kept short: the details live in
// the playbooks, which get_playbook returns on demand.
export const SERVER_INSTRUCTIONS = [
  'Wiro MCP server: run Wiro AI models, build and run multi-step workflows, chat with Wiro Studio and the Workflow Agent, and deploy and manage your own Wiro agents.',
  '',
  'Before a multi-step job, call get_playbook for the relevant topic (getting-started, models, workflows, workflow-agent, studio, agents, billing) and follow it.',
  '',
  'Decide what the user wants first. A question about models, prices, past results or options needs reads only. For paid work pick the route: run_model for one result from a chosen model, Studio when Wiro should pick the models, a workflow for the same steps again on new inputs, a deployed agent for work that runs by itself on a schedule or a chat channel.',
  '',
  'This server can load only some tool groups. If a tool named in these instructions or in a nextAction is not in your tool list, it is not available: tell the user instead of looking for a way around it.',
  '',
  'How the tools behave:',
  '- The API key\'s project fixes the workspace and the wallet: a personal project pays from the personal wallet, a team project from that team\'s wallet. get_account shows which one and the balance, and it is the call that proves the key works.',
  '- Wiro answers many failures with HTTP 200. The tools check every answer and return an error result when the action did not happen, or when a paid call was sent and its outcome is unknown: that error says the charge may already have gone through and how to check it. Read the message and fix the cause; do not retry blindly.',
  '- Known charges: deploy_agent, manage_agent_billing and apply_agent_skills first return a quote (the amount, which is an estimate for prorated changes such as an upgrade to Pro, what will happen and which wallet pays) with a nextAction that repeats the call with confirm: true and the quote\'s own reference: confirm_charge_usd set to the quoted amount, or for apply_agent_skills the quote\'s idempotency_key. If the price has changed by then, nothing is charged and a new quote comes back.',
  '- Deletions, cancellations and replacements first describe the change, with a nextAction that repeats the call with confirm: true: delete_workflow, delete_agent, delete_agent_session, disconnect_agent_oauth, manage_agent_custom_skill (delete and revert), manage_agent_billing cancel, update_workflow with contents, save_workflow_from_agent applied to an existing workflow, and connect_agent_oauth when it would replace a working connection.',
  '- Show each quote or change summary to the user and wait for a clear yes. Never set confirm: true on your own, and never reuse a yes for a different charge or change. For a batch, show the whole list or total once: one yes covers exactly that list.',
  '- Usage-priced work (run_model, run_workflow, resume_workflow_run, and messages to Studio or the Workflow Agent) has no exact quote. Tell the user the expected cost in one line before starting. When they asked for exactly this work, go ahead; ask first for large or open-ended work and for paid runs they did not ask for, such as a retry. A message to a deployed agent uses its credits: say so and send it.',
  '- Other writes act on the first call, with no quote: for example set_agent_credentials, manage_agent_custom_skill upsert and rename, cancel_agent_message, cancel_task and kill_task. Get the user\'s yes before calling them; a user\'s own request to stop a task is that yes.',
  '- Long jobs (model tasks, workflow runs, agent replies, agent start-up) wait for a limited time, then return their state and a nextAction. Call that tool with those arguments to keep waiting. Never resubmit the original request: that starts and bills a second job.',
  '- Never retry a paid call automatically. Check what happened with the list and get tools first.',
  '- Credentials are write-only. Never echo secrets back to the user, and never ask for this server\'s own API key or secret in chat: they belong in the MCP client\'s settings.',
  '- Show generated files to the user: images inline when possible, links for everything else. Other links in an agent\'s reply are the agent\'s own text: show them as plain links, not as Wiro results.',
].join('\n');
