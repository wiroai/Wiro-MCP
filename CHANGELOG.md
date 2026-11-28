# Changelog

Notable changes to `@wiro-ai/wiro-mcp`. Releases before 2.0.0 are described on the
[GitHub Releases](https://github.com/wiroai/Wiro-MCP/releases) page.

## 2.3.0 (unreleased)

The exact price of each setting, for programs that ask for it. `get_model_schema` gives a model's price rows in the
result's `_meta`, under `ai.wiro/priceList`, when the call asks for them with `_meta: { "ai.wiro/priceList": true }`
in its params. Each row has `inputs`, `price` and `priceMethod`, plus `note`, `priceExtra`, `priceInput` and
`maxSeconds` where the row has them. The rows come in Wiro's order and at list price; your discount stays in
`discountPercent`.

A program that prices the chosen settings itself, such as the Wiro browser extension, can then price them the way
Wiro bills them. Veo 3.1 at 4K and 8 seconds is $4.80, where the `pricing` sentence says "$1.6 to $4.8 / per run".

The rows come only on that ask. Some clients show a result's `_meta` to the model, and a price list can run to 300
rows. No assistant's client sends the ask, so no model reads the rows. With the ask and without it, the text and the
structured output are the same as in 2.2.0. A model without a price list gets no `_meta`.

Clients that connected under 2.2.0 need no reconnect: `_meta` is not part of the tool's output schema.

### Added

- `get_model_schema`: the model's `dynamicprice` rows in the result's `_meta`, under `ai.wiro/priceList`, when the
  call's `_meta` asks for them. The key is exported as `PRICE_LIST_META_KEY`, and the row type as `PriceListRow`.

## 2.2.0 (unreleased)

How many files a file field takes. `get_model_schema` now gives each file field's limit: `maxFiles` in its
structured output and "At most 3 files. More is refused." in its text. When a choice in another field lets a run take
more, such as an effect that takes a second image, `maxFilesByOption` lists that choice as
`{ parameter, value, maxFiles }`, and the text says "a run takes 2 files when `effectType` is `product-360`". The raise
is for a run only: a workflow step takes `maxFiles` whatever the choice. A field with no limit gets neither.

The limit is the field's `maxinputlength`. The Wiro API serves the field under that name from the release that
renames it; the name was misspelled before. Until that release this version shows no limit, as 2.1.0 does.

MCP clients that connected before the upgrade should reconnect (in Claude Code, `/mcp` and reconnect). A client that
listed the tools under 2.1.0 refuses the new `maxFiles` until it lists them again.

### Added

- `get_model_schema`: `maxFiles` and `maxFilesByOption` on `fileinput`, `multifileinput`, `multifileinputdrop` and
  `combinefileinput` fields, and an "At most N files" line under each such field in the text.

### Changed

- `get_model_schema`'s output schema takes keys a later version adds: its objects (the result, the model, a parameter
  group, item and option) no longer set `additionalProperties: false`. A client that listed 2.2.0 or later keeps
  working when a later version adds a field.

## 2.1.0 (2026-11-28)

Prices read in plain words. Wiro renamed the price methods of a model's `dynamicprice` options in one change, and
this release reads the new ids: `search_models` and `get_model_schema` print "$0.14 to $0.24 / per output file",
"$0.025 / per second of output video" or "Set when the run ends" after a price, never a method's code. Models can now
be priced per second of input video, and `get_model_schema` says how many seconds of each input count.

This release goes out with the Wiro API release that renames the methods. Before that release the API serves the
old ids and this version shows those models as "No fixed price"; after it, 2.0.0 does. Every install that runs
`npx @wiro-ai/wiro-mcp@latest` takes it at its next start.

### Changed

| Old id | New id | Words after the price |
|--------|--------|-----------------------|
| `cpr` | `per-run` | per run |
| `cps` | `per-run-second` | per second of run time |
| `cpo` | `per-output-file` | per output file |
| `cpt` | `per-total-token` | per input and output token |
| `cp-pixel` | `per-output-megapixel` | per output megapixel |
| `cp-promptlength` | `per-input-character` | per prompt character |
| `cp-audiosecondslength` | `per-input-audio-second` | per second of input audio |
| (new) | `per-input-video-second` | per second of input video |
| `cp-outputVideoLength` | `per-output-video-second` | per second of output video |
| `cp-realtimeturn` | `per-realtime-turn` | per conversation turn |
| `cp-readoutput` | `reported-price` | set when the run ends |

- A price per second of input audio or video names the inputs it measures. When an option sets `maxSeconds`,
  `get_model_schema` says so: "Each input counts at most 60 seconds." once when the options share it, or beside each
  price when they differ.
- `get_workflow` explains Wiro's estimate lines for a step priced per second of input video, and for a Start video
  input that feeds one.
- A row with a method this version does not know, an old id included, reads "No fixed price" and never shows the id.

## 2.0.0 (2026-11-25)

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
| `answer_agent_approval` | Answers an approval card: a Connector action whose permission is Ask, which the agent did not run. `allow` runs this call once, `always` also lets the action run without asking from now on in the columns that ask for it (agent admins only; a Block stays blocked, and an action the connector has not listed yet is allowed only this once), and `decline` turns this call down. Without `confirm` it shows the card, its exact request and what the answer does; with `confirm: true` it answers, and an approval returns the new turn the agent goes on in, which `get_agent_message` reads. Wiro's refusals (`approval_expired`, `approval_done`, `approval_blocked`, `approval_in_channel`, 96, 97) come back with what to do. |
| `get_agent_connector_permissions` | Shows what an agent may do with a connector without asking: the three groups (Read-only, Create and send, Change and delete) and every action, each Allow, Ask or Block in Chat and in Autopilot, with its defaults and whether it has a setting of its own, what an action the connector has not listed yet does, and the approval cards a scheduled task, a channel chat or the agent's own work asked for that still wait. Agent admins only. |
| `set_agent_connector_permissions` | Sets a group or one action in Chat and Autopilot, or resets them. Without `confirm` it shows what changes for the agent and which actions it stops seeing; a confirm with the summary's `summary_id` saves exactly that change. When an action the connector has not listed yet loses its own setting and Wiro may have a default of its own for it, the summary names both values it can read (`to`, `or`). |

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
- `get_agent_activity` (usage) reads the dollar ledger: `summary` holds this calendar
  month's AI usage the plan covered and from the balance, model runs and funds added, and
  the AI usage the plan includes each period, renewal to renewal (`includedUsd`, never shown
  beside the month's figures: a month that holds a renewal covers more than one period
  includes), and each of `transactions` its kind, title, model, tokens and costs by kind,
  `amountUsd` (absent on a plan payment from before Wiro kept what was paid), `direction`
  and `paidFrom`. `balance`, `extraPacks` and `byModel` are gone, `entries` reads one kind
  of row, and a log event's cost is `costUsd`.

### Changes

- Most changes reach a running agent live, from its next message, with no restart: a
  connector connected, disconnected or given new values, its accounts and permissions, a
  Skill turned on or off (except `util-voice-receptionist`, `util-twilio-channel`,
  `util-web-channel` and `util-newsletter-compose`), every custom skill and scheduled task
  change, `cs-approval-policy` included, and a new title. A setting that changes (time
  zone, session sharing, models, commands, setup from chat turned on or off), credentials
  and a new Wiro project still restart it. The `restart` answer of
  `connect_agent_connector`, `disconnect_agent_connector`, `set_agent_connector_accounts`
  and `set_agent_connector_permissions` can read `live`; `manage_agent_custom_skill`,
  `apply_agent_skills` and `update_agent` carry `live: true` for such a change, and the
  `setupResult` of a reply Wiro applied carries `live`. Before a change, the tools and the
  agents playbook say that a running agent gets most changes without a restart, and the
  answer says which happened.
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
- A reply that is only yes, always or no, sent while an approval card waits, is answered by
  Wiro, not the agent, and starts no turn: the first yes sent from here gets Wiro's listing of
  the exact request, only a later yes (or "yes N") allows it once, and always from here allows
  it once. `send_agent_message` returns `approvalReply`: the cards Wiro answered with the turn
  an approval started (read with `get_agent_message`; its live token is never passed on), or
  the cards it listed with their numbers. A reply read later carries `approvalAnswers` and
  `listedApprovals`.
- A card asked in a Telegram, Slack or Discord chat is answered there, by a reply in that
  chat; `answer_agent_approval` cannot answer it. Such a card carries `answeredIn` and no
  answer step, the listings say where it is answered, and `answer_agent_approval` passes on
  Wiro's `approval_in_channel` refusal.
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
  balance says what counts. `get_my_agent` shows what the agent's wallet can pay a plan with
  (`usage.planBalanceUsd`).
- An agent's AI usage after what its plan includes, and the $0.50 a new turn needs then,
  count the same money as a plan payment: coupon credit limited to certain models never pays
  an agent's AI usage. `usage.balanceUsd` in `get_my_agent` and `list_my_agents` is what that
  AI usage can draw on, so it can read less than `get_account` shows. The agents and billing
  playbooks and the README say so.
- `get_my_agent` lists the agent's connectors with their state and the accounts chosen.
- `get_agent_activity` (logs) names who connected or disconnected a connector, or set its
  accounts (`CONNECTOR_CONNECTED`, `CONNECTOR_DISCONNECTED`, `CONNECTOR_ACCOUNTS_SET`), as
  it names who changed the agent. `CONNECTOR_REAUTH`, a connector that has to be connected
  again, is Wiro's own row and names no one.
- A tool call that neither ran nor failed reads so: a Connector action that waits for a
  person's approval is `held`, a call refused while a person has Take Control of the
  agent's screen is `paused`, and a Connector action refused because its permission is
  Block is `blocked`. `get_agent_activity` (logs) keeps such a row's `status`, which stands
  in place of `ok` and `error`, and its line says "held for approval", "paused during Take
  Control" or "blocked by a Connector permission", where it read as a call that ran or
  failed. A message's `toolsUsed` carries the same three statuses.
- `get_agent_activity` (logs) keeps Wiro's mark on a turn's cost that is an estimate. When
  Wiro measures an agent's model calls itself, a `token_usage` row's cost is the turn's calls
  priced at the agent's rates, and what was billed is in the agent's `ai-usage` ledger rows,
  which add calls up across turns. Such an event carries `costEstimate: true` beside
  `costUsd`, its line reads "cost $0.07 (estimate)", and a note below the rows says where
  the billed amount is. The mark was dropped, so an assistant read the estimate as what was
  billed. An event's line now names its cost, which only the structured result held.
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
- `list_agent_connectors` shows `wiroApp` on a connector that also signs in with Wiro's own
  app, which only the agent's Connectors tab in the Wiro web app uses; a sign-in through this
  server always takes the user's own app's keys.
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
  with nothing charged. A `manage_agent_billing` quote whose charge the balance cannot pay
  yet (a renewal, a new plan, or a move to a larger wallet plan) says so before the confirm
  step: what that balance can pay a plan with, and the amount to add.
- A cancelled wallet plan ends at its period end, as a card plan does: the cancel quote of
  `manage_agent_billing` and a move to a larger plan on a cancelled plan name that end,
  where they said about a day after it. A wallet short at renewal keeps the plan active
  while Wiro tries again for up to a day after the period end, and the playbooks say so,
  where they said the plan ends instead of renewing.
- An active plan's renewal or end is named as Wiro shows it, never a moment gone by: the
  plan line of `get_my_agent` and `list_my_agents`, a move set for the renewal, the
  `manage_agent_billing` quotes (`startsAt` included), `control_agent`'s stop and
  `delete_agent`'s card plan. They named the period end, which is gone by while Wiro tries a
  wallet plan's renewal again. The subscription carries that moment as `renewsOrEndsAt`; an
  answer without it names the period end, as before.
- A move to a larger plan while the plan's renewal is due is refused at the
  `manage_agent_billing` quote with Wiro's own sentence, which its pricing answer carries
  as `planChange.refusal`: no price, no confirm step, and nothing is sent. The quote read
  "$0.00 now" with a confirm step that Wiro then refused, and that refusal read as an
  outcome that may have taken effect. A Wiro that still quotes the charge refuses it at
  the confirm in the same words, which now read as a refusal before any charge.
- While Wiro says a plan's renewal is due (`usage.renewalDue`), the plan line of
  `get_my_agent` and `list_my_agents` reads "renewal due now (once the balance can pay it,
  it renews within 15 minutes)", and a move set for the renewal starts "from the renewal
  due now". It read "renews after" the time of the answer. An answer without the flag reads
  as before.
- With nothing included (no live plan), the usage line reads AI usage instead of Included AI
  usage, as on the agent's page, and says "nothing included (no active plan)", where it read
  "$0.00 of $0.00 included" (`list_my_agents`: "no AI usage included"). `usage.period` is
  described as what it is: a month tag, the month the current plan period started in, not
  the period itself.
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
- A task's status reads in words, such as `Completed`, `Failed` or `Running: producing
  output`, in place of its status code (`task_postprocess_end`, `task_output`), in
  `get_task`, `wait_for_task`, `run_model`, `list_tasks`, `get_task_price`, their progress
  messages and a workflow step's details in `wait_for_workflow_run`. An assistant passed the
  code on to the person, who could not read it. The structured result keeps the code as
  `task.status` and has the words beside it as `task.statusText` (a workflow step's details
  as `taskStatusText`), since some clients show the model the structured result before the
  text. The task tools' descriptions say to tell a person the words, never the code.
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
