# Changelog

Notable changes to `@wiro-ai/wiro-mcp`. Releases before 2.0.0 are described on the
[GitHub Releases](https://github.com/wiroai/Wiro-MCP/releases) page.

## 2.0.0 (unreleased)

An agent's outside services are now **Connectors**: one catalog of services an agent can
connect, such as ad accounts, stores, social accounts, mailboxes and data sources. A
connected connector gives the agent its tools, named `<connector>__<tool>`, and a custom
skill tells the agent when and how to use them. Connectors replace the integrations that
were skills, together with the credential and sign-in tools that set them up. Skills are
now only how an agent works (reporting, copywriting, video, voice calls), and credentials
only what it runs on: its chat channels, Twilio Voice, settings and the Wiro project.

This release needs the Wiro API release that serves agent connectors. Every install that
runs `npx @wiro-ai/wiro-mcp@latest` takes it at its next start.

### New tools

| Tool | What it does |
|------|-------------|
| `list_agent_connectors` | Lists the connector catalog with how each one connects: a key (values typed on its Connect card), a sign-in, or a Wiro project. With `name` it shows one connector in full: each value to ask for and where it comes from, its account choices, the tools the agent gets, and its setup and revoke steps. With `agent_guid` it adds each connector's state on that agent and lists the agent's connections. |
| `connect_agent_connector` | Connects a connector to an agent. A key connector takes its values and connects at once; values are never shown back. A sign-in returns a link the user opens in their own browser; a sign-in with the service's own OAuth takes the keys of the user's own app in the same call. A connector that offers both takes `mode`. The Wiro AI Models connector (`wiro`) runs with the agent's own Wiro project: connecting it binds the project it names (or this connection's) to the agent as `bind_agent_project` does, with the same checks, and first shows the project, the one it replaces (`replacesProject`), the wallet that pays and the scheduled tasks and custom skills the project turns on. `accounts` saves account ids the user already knows with the connect, such as TikTok Ads advertisers. A sign-in with account choices says to choose them once it finishes; a new sign-in keeps the ones the connection already holds and says so. `status` waits for a sign-in to finish. A call with values missing sends nothing and lists what to ask for. Replacing a working connection, or connecting a Wiro project, takes `confirm: true`. |
| `set_agent_connector_accounts` | Lists the account choices of a connected connector (ad accounts, pages, properties, channels, apps) with the accounts its connection reaches, and saves the ones the user picks. The agent then acts only on those. It works the same for a connector served by the service itself, such as the advertisers of a TikTok Ads sign-in, and a sign-in the service revoked is answered with the `connect_agent_connector` call that connects it again, with no confirm step first. |
| `disconnect_agent_connector` | Shows what a disconnect removes and which scheduled tasks stop (a task keeps running while another connector it can use is connected), then removes the connection with `confirm: true` and asks the service to revoke a sign-in where it supports that. |
| `answer_agent_approval` | Answers an approval card: a Connector action whose permission is Ask, which the agent did not run. `allow` runs this call once, `always` also lets the action run without asking from now on in the columns that ask for it (agent admins only; a Block stays blocked, and an action the connector has not listed yet is allowed only this once), and `decline` turns this call down. Without `confirm` it shows the card, its exact request and what the answer does; with `confirm: true` it answers, and an approval returns the new turn the agent goes on in, which `get_agent_message` reads. Wiro's refusals (`approval_expired`, `approval_done`, `approval_blocked`, 96, 97) come back with what to do. |
| `get_agent_connector_permissions` | Shows what an agent may do with a connector without asking: the three groups (Read-only, Create and send, Change and delete) and every action, each Allow, Ask or Block in Chat and in Autopilot, with its defaults and whether it has a setting of its own, what an action the connector has not listed yet does, and the approval cards a scheduled task, a channel chat or the agent's own work asked for that still wait. Agent admins only. |
| `set_agent_connector_permissions` | Sets a group or one action in Chat and Autopilot, or resets them. Without `confirm` it shows what changes for the agent, which actions it stops seeing, and whether a running agent restarts (any change other than Ask to Allow); a confirm with the summary's `summary_id` saves exactly that change. |

### Breaking changes

- `connect_agent_oauth` and `disconnect_agent_oauth` are removed, with their exports
  `registerConnectAgentOauth` and `registerDisconnectAgentOauth`. The connector tools take
  their place: `registerListAgentConnectors`, `registerConnectAgentConnector`,
  `registerSetAgentConnectorAccounts` and `registerDisconnectAgentConnector`.
- `set_agent_credentials` saves only chat channels, Twilio Voice, settings and the Wiro
  project key. A connector's key is refused with the tool that connects it. Its describe
  result has no `connectionModes` or `ownAppRedirectUri`, a credential's `kind` is
  `fields` or `channel`, fields carry no `modes`, and there is no `authmethod` field or
  key-file field any more.
- `list_agent_skills` lists Skills: its `category` input is gone, and a credential's setup
  carries no `oauth`, `connectionModes`, `wiroConnectAvailable` or `onlyInModes`. A
  connector's name points to `list_agent_connectors`.
- `get_agent_template`: a credential requirement carries no `oauth`, `connectionModes` or
  `onlyInModes`. The template's suggested connectors come as `suggestedConnectors`.
- `get_my_agent` and `deploy_agent`: credential states and `missingCredentials` items carry
  no `oauth`, and the next step for a missing credential is never a sign-in.
- `apply_agent_skills` takes Skills only; an outside service's name is refused with the
  connector tools to use.
- Setup proposals in an agent's chat: an add or remove names a Skill (`util-*`), and its
  `with` list holds Skills only. Connectors are proposed with connect and disconnect
  changes that name the connector's slug. A connector connects with `key`, `signin` or
  `project` (the Wiro project of the Wiro AI Models connector, `wiro`; `appkeys`, `token`
  and `page` are gone), as an add's `needs` and a connect change's own `mode` say. Chat
  channels are never proposed, and a key a proposal asks for is saved with
  `connect_agent_connector`.
- Agents are billed in dollars. An agent's `credits` (in `list_my_agents`, `get_my_agent`,
  `control_agent`, `manage_agent_billing` and `deploy_agent`) is replaced by `usage`, its AI
  usage in USD: what the plan includes this period, used and left, what each renewal
  includes, the Wiro balance that pays after it, and whether the agent is paused and why.
  `spend` adds what the agent cost this calendar month. A plan's price carries
  `includedUsageUsd` instead of `monthlyCredits`, in `pricing` and in the `deploy_agent` and
  `manage_agent_billing` quotes, whose results carry `includedUsageUsd` and
  `includedUsageNowUsd` instead of `monthlyCredits` and `creditsNow`. Model rates are
  `inputUsdPer1M`, `outputUsdPer1M` and `cachedInputUsdPer1M`, and a message's cost is
  `aiUsageUsd` instead of `creditsUsed`.
- Extra credit packs are retired. `get_my_agent` lists no `extraCreditPacks`, and
  `manage_agent_billing` with `buy_credits` quotes and charges nothing: it says the agent
  uses the Wiro balance after its plan's included usage, and that funds are added on
  wiro.ai. Its `pack` and `request_id` are ignored, and no answer carries a `requestId`.
- `get_agent_activity` (usage) reads the dollar ledger: `summary` holds this month's AI
  usage within the plan and from the balance, model runs and funds added, and each of
  `transactions` its kind, title, model, tokens and costs by kind, `amountUsd` (absent on a
  plan payment from before Wiro kept what was paid), `direction` and `paidFrom`. `balance`,
  `extraPacks` and `byModel` are gone, `entries` reads one kind of row, and a log event's
  cost is `costUsd`.

### Changes

- Connector actions can wait for approval. By default Create and send and Change and delete
  ask in chat and run in scheduled tasks. `send_agent_message`,
  `get_agent_message` and `get_agent_conversation` list a message's approval cards under
  `approvals`: `cardid`, `messageguid`, the connector, the action, where it came from, the
  request (`arguments`, or `preview` when it is too long, or `hidden` for a connector whose
  data terms keep requests out of storage), `status`, `alwaysChanges` and `expiresAt`, and
  `actionListed: false` when the connector has not listed the action yet, so Always allow
  can only allow that call once. A pending card carries the `answer_agent_approval` step that
  shows it, and it comes first in the next step. The turn Wiro starts after an approval
  reads as its line, such as "Allowed: Create a post in WordPress", with kind
  `approval_resume` and `approvalResume`, never as the prompt Wiro wrote for the agent.
- A scheduled task that comes with the agent's template keeps the template's text, which is
  the text the agent runs. `manage_agent_custom_skill` refuses a different text with Wiro's
  sentence and what can still change; the template's own text sent back changes nothing, and
  its schedule and switch change as before. `get_my_agent` and `manage_agent_custom_skill`
  mark such a task `editable: false`. `deploy_agent` refuses a text only for a task the
  template wrote a text for.
- Every agent plan payment counts the same money, the automatic renewal included: the
  balance's deposits, store revenue and coupon credit that is not limited to certain models.
  The `deploy_agent` quote shows the paying balance in its parts
  (`quote.wallet.couponCreditUsd` joins `storeRevenueUsd`), and a refusal for a short
  balance says what counts.
- `get_my_agent` lists the agent's connectors with their state and the accounts chosen.
- `get_agent_activity` (logs) names who connected or disconnected a connector, or set its
  accounts (`CONNECTOR_CONNECTED`, `CONNECTOR_DISCONNECTED`, `CONNECTOR_ACCOUNTS_SET`), as
  it names who changed the agent. `CONNECTOR_REAUTH`, a connector that has to be connected
  again, is Wiro's own row and names no one.
- `bind_agent_project` sets the Wiro project the agent's video and voice skills run models
  with. The agent's own model tools come from the Wiro AI Models connector (`wiro`), which
  always runs with that same project; connecting it binds its project the same way, and
  while it is connected a bind moves its tools to the new project and its wallet. It gives
  only Wiro's model, task and file upload tools, plus read-only docs search and playbooks,
  and its calls count as the agent's own: the agent's spend limits and Model Access rules
  apply, and account, agent and billing calls are refused.
- `send_agent_message` and `get_agent_message`: a proposed connect change carries how its
  connector connects (`mode`). A sign-in or a Wiro project is never connected by a reply, so
  its next step is `connect_agent_connector`, whatever the card's age; a key card's is what
  its connector needs. A connector that reads connected already gets no step. Both return the
  connectors Wiro's answer to a reply leaves to connect (`setupNext`), also on a later read,
  and the next step connects a sign-in or a Wiro project among them without waiting for a
  restart. A later read of Wiro's listing of a proposed change marks it as a listing
  (`listedSetupChanges`), as `send_agent_message` does, and `get_agent_conversation`
  carries both fields.
- A message refused because the agent's setup is not finished names its missing settings
  only: connectors do not hold an agent's start. `control_agent` reads Start's new wording of
  that refusal as before.
- The `deploy_agent` quote and result name the connectors a template suggests, or a custom
  build's skills work with. `list_agent_skills` names the Connectors each Skill works with
  (`suggestedConnectors`), by their catalog titles; none connects by itself.
  `apply_agent_skills` names the ones the skills it turned on work with that the agent has
  not connected (`connectorsToConnect`), as an add card's `needs` does.
- `manage_agent_custom_skill` says which connectors a scheduled task needs to run, and that
  a custom skill is how the agent learns to use a connector's tools.
- The agents playbook, the server instructions, the `deploy_agent` prompt and the README
  describe connectors, how each kind connects, account choices and disconnecting. They name
  the agent's model tools' connector by its catalog title, Wiro AI Models (`wiro`), and say
  that a sign-in with the user's own app needs the redirect URI from its setup steps added to
  that app before its keys go in `values`. `list_agent_skills` gives `video_generation` as its
  capability example: `image_generation` is no longer a capability.
- Plans are read from Wiro's plan list (`includedUsageUsd`, else the plan's price) and said
  as "Pro $30 a month, includes $30 of AI usage" in the catalog, the deploy quote and
  `get_my_agent`.
- Agent plans are paid only from the Wiro balance: `subscribe`, `renew`, `change_plan` and
  `deploy_agent` quote "paid from your Wiro balance" (the team's for a team agent), and no
  card checkout, billing portal or dashboard card payment is offered. A card plan from
  before that is paid by card through its period, then moves to the balance and renews from
  it (one whose period ends within 7 days after Wiro's email announcing the move renews
  once more by card first): its plan changes are quoted from the balance. `cancel` ends a
  card plan with its period instead, with nothing charged or refunded, and `renew` undoes
  that before then or brings back a card plan that has ended, paid from the balance;
  `delete_agent` waits until a card plan has ended. A charge the balance cannot cover is
  refused with code 97 and `neededusd`, and the answer says how much to add on wiro.ai,
  with nothing charged.
- A message or a start refused because the agent's included usage is used up and the
  balance is short (code 97 with `agentusage`) keeps Wiro's answer and says where funds are
  added; `neededusd` marks a plan payment refusal instead, and no pack is offered.
- An answer from a Wiro API before agents were billed in dollars has no `usage`: the agent's
  usage is then worked out from its credit fields, which count hundredths of a dollar.
- The agents, billing and controls playbooks, the server instructions, the prompts and the
  README say AI usage in dollars, the balance after the plan, and how spend limits and
  Model Access rules count an agent's usage. Every agent plan charge, the automatic renewal
  included, counts toward the limits of the whole wallet, the member who paid for it and the
  `agent` surface, and a plan payment made with an API key, as every payment through this
  server is, also toward that key's limits, which can refuse it with code 93.
- The model runs Studio starts are your own tasks: `list_tasks` lists them, and `get_task`,
  `wait_for_task`, `cancel_task` and `kill_task` work on them by their id.
  `list_studio_results` still lists them with their prompts, and only it reads Studio's older
  runs, which Studio ran on its own account. `list_tasks` also says that a deployed agent
  calling it through its Wiro AI Models connector sees only its own tasks.
- Controls know nine surfaces: `studio`, `workflow-agent` and `workflow` join the six.
  Messages to Studio and the Workflow Agent, the models Studio runs for a person and workflow
  runs with their steps count on them, whichever way they come in, so a limit or a rule on
  `web`, `api` or `mcp` does not cover that work. `get_controls` shows their spending, and
  spend limits, Model Access rules and `check_model_access` can name them.
  `check_model_access` checks a Studio or Workflow Agent message, and a workflow run, with
  this connection's key unless a project or a member is named. Studio's and the Workflow
  Agent's work is checked on the turn's project: the key the message came with, or the
  workspace's Studio project for a message sent on wiro.ai.
- The `wiro-mcp-server` command names itself to Wiro with `x-wiro-client: wiro-mcp/<version>`,
  so the runs of a local install, the Docker image included, count on the `mcp` surface (Spend
  Limits, Model Access, Task/List) instead of `api`. A `WiroClient` that other code builds
  sends no such header. The header is the caller's own word: a limit or a rule that must hold
  for whoever holds the key belongs on the key (scope `project`).
- An agent runs only with an active plan. One without reads as paused with `pausedReason`
  `plan` in `get_my_agent` and `list_my_agents`, whatever the balance holds, and a message or
  a start Wiro refuses for it (code 97 with `agentusage`) points to `manage_agent_billing`
  with `renew` or `subscribe` instead of adding funds.
- `get_account` lists an agent's AI usage its plan covered (`USAGE (AGENT PLAN)`) with
  `inPlan: true`, no `direction` and no sign, as the Transactions page shows it "(in plan)":
  it moved no money, so it is no charge. A row names its agent from `useragentguid` and the
  way in that made it (`surface`).
