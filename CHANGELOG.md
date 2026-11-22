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
| `connect_agent_connector` | Connects a connector to an agent. A key connector takes its values and connects at once; values are never shown back. A sign-in returns a link the user opens in their own browser; a sign-in with the service's own OAuth takes the keys of the user's own app in the same call. A connector that offers both takes `mode`. A connector that runs with a Wiro project shows the project and the wallet that pays first. `accounts` saves the accounts the connection may act on where the connector's setup steps name an account key. `status` waits for a sign-in to finish. A call with values missing sends nothing and lists what to ask for. Replacing a working connection, or connecting a Wiro project, takes `confirm: true`. |
| `set_agent_connector_accounts` | Lists the account choices of a connected connector (ad accounts, pages, properties, channels, apps) with the accounts its connection reaches, and saves the ones the user picks. The agent then acts only on those. |
| `disconnect_agent_connector` | Shows what a disconnect removes and which scheduled tasks stop (a task keeps running while another connector it can use is connected), then removes the connection with `confirm: true` and asks the service to revoke a sign-in where it supports that. |

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
  changes that name the connector's slug. A connector an add needs connects with `key` or
  `signin` (`appkeys`, `token` and `page` are gone). Chat channels are never proposed, and
  a key a proposal asks for is saved with `connect_agent_connector`.

### Changes

- `get_my_agent` lists the agent's connectors with their state and the accounts chosen.
- `bind_agent_project` sets the Wiro project the agent's video and voice skills run models
  with; the agent's own model tools come from the `wiro` connector.
- The `deploy_agent` quote and result name the connectors a template suggests.
- `manage_agent_custom_skill` says which connectors a scheduled task needs to run, and that
  a custom skill is how the agent learns to use a connector's tools.
- The agents playbook, the server instructions, the `deploy_agent` prompt and the README
  describe connectors, how each kind connects, account choices and disconnecting.
