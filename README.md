<div align="center">

<img src="https://raw.githubusercontent.com/wiroai/Wiro-MCP/main/.github/assets/wiro-logo.png" alt="Wiro AI" width="240">

# Wiro MCP Server

Official MCP server for Wiro AI: run image, video, audio and LLM models, build and run workflows, and deploy and talk to AI agents from Cursor, Claude Code, Claude Desktop, Windsurf and any other MCP client.

[![npm](https://img.shields.io/npm/v/@wiro-ai/wiro-mcp?style=for-the-badge&color=111111)](https://www.npmjs.com/package/@wiro-ai/wiro-mcp) [![Node.js 20+](https://img.shields.io/badge/Node.js-20%2B-111111?style=for-the-badge&color=111111)](#quick-start) [![MCP server](https://img.shields.io/badge/MCP-server-111111?style=for-the-badge&color=111111)](https://modelcontextprotocol.io/) [![License: MIT](https://img.shields.io/badge/license-MIT-111111?style=for-the-badge&color=111111)](./LICENSE)

[Website](https://wiro.ai) · [Models](https://wiro.ai/models) · [Docs](https://wiro.ai/docs/wiro-mcp-server) · [Dashboard](https://wiro.ai/panel)

<img src="https://wiro.ai/images/koala/accent-heavy-koala.png" alt="Wiro AI koala mascot" width="60" />

</div>

`@wiro-ai/wiro-mcp` is a TypeScript [Model Context Protocol](https://modelcontextprotocol.io/) server that runs locally over stdio with `npx`. Its tools are grouped in three sets:

- **Models**: search the Wiro AI model catalog, read a model's parameters and price, run it and wait for the result, upload input files and browse past tasks.
- **Workflows**: build multi-step workflows that chain models, run them, resume failed runs, browse the public gallery, and design workflows together with the Workflow Agent.
- **Agents**: talk to Studio, the creative agent that runs models for you, and deploy, configure, run and message your own agents built from templates or from scratch.

Playbooks explain each job step by step, so the assistant knows the order of calls, what costs money and what needs your approval. The hosted server at `https://mcp.wiro.ai/v1` serves the same tools with nothing to install.

## Quick Start

Local `npx` and library usage require Node.js 20 or later. The hosted MCP
endpoint does not require a local Node.js installation.

### 1. Get API Keys

Sign up at [wiro.ai](https://wiro.ai/) and create a project at [wiro.ai/panel/project/new](https://wiro.ai/panel/project/new) to get your API key and secret.

### 2. Add to Your AI Assistant

**Cursor**: open MCP settings (`Cmd+Shift+P` → "Open MCP settings") and add:

```json
{
  "mcpServers": {
    "wiro": {
      "command": "npx",
      "args": ["-y", "@wiro-ai/wiro-mcp"],
      "env": {
        "WIRO_API_KEY": "your-api-key",
        "WIRO_API_SECRET": "your-api-secret"
      }
    }
  }
}
```

**Claude Code:**

```bash
claude mcp add wiro -- npx -y @wiro-ai/wiro-mcp
```

Then set environment variables `WIRO_API_KEY` and `WIRO_API_SECRET`.

**Claude Desktop**: add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "wiro": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@wiro-ai/wiro-mcp"],
      "env": {
        "WIRO_API_KEY": "your-api-key",
        "WIRO_API_SECRET": "your-api-secret"
      }
    }
  }
}
```

**Windsurf**: add to MCP settings:

```json
{
  "mcpServers": {
    "wiro": {
      "command": "npx",
      "args": ["-y", "@wiro-ai/wiro-mcp"],
      "env": {
        "WIRO_API_KEY": "your-api-key",
        "WIRO_API_SECRET": "your-api-secret"
      }
    }
  }
}
```

**OpenClaw**: configure a remote server under `mcp.servers`:

```json
{
  "mcp": {
    "servers": {
      "wiro": {
        "url": "https://mcp.wiro.ai/v1",
        "transport": "streamable-http",
        "connectionTimeoutMs": 10000,
        "headers": {
          "Authorization": "Bearer ${WIRO_MCP_AUTH}"
        }
      }
    }
  }
}
```

Set `WIRO_MCP_AUTH` in OpenClaw's environment to your API key, or to
`API_KEY:API_SECRET` for a project with signature-based auth. Then verify with
`openclaw mcp doctor wiro --probe`. On older OpenClaw releases without that
probe command, use `openclaw mcp show wiro`, restart OpenClaw, and run
`/tools verbose`.

**Hermes**: add to `~/.hermes/config.yaml`:

```yaml
mcp_servers:
  wiro:
    url: "https://mcp.wiro.ai/v1"
    headers:
      Authorization: "Bearer ${WIRO_MCP_AUTH}"
    timeout: 60
    connect_timeout: 10
```

Store `WIRO_MCP_AUTH` (your API key, or `API_KEY:API_SECRET`) in `~/.hermes/.env`, then run `/reload-mcp` and `/tools`.

### 3. Start Using

Ask your AI assistant:

**Models**

- *"Generate a photorealistic image of a mountain lake at sunset"*
- *"What video generation models are available on Wiro?"*
- *"Show me the parameters for google/veo3-1"*
- *"Create a 5-second video with Kling V3: a drone shot over mountains"*
- *"Check the status of my last task"*
- *"Show my latest productions and open the newest result"*

**Workflows**

- *"Build a workflow that turns a product photo into a short ad video, then run it on this photo"*
- *"Find a public workflow for podcast covers and run it with my show's name"*
- *"Ask the Workflow Agent to add an upscale step to my product ad workflow and save it"*
- *"Why did my last workflow run fail? Resume it if it can be resumed"*

**Agents**

- *"Ask Studio for three logo ideas for a coffee shop"*
- *"Which agent templates can manage Instagram? What does each plan cost?"*
- *"Deploy the Instagram manager agent on the Starter plan and tell me what it still needs"*
- *"Tell my support agent to summarise today's tickets"*

## Authentication

Wiro AI supports two authentication types, chosen when you create a project:

### Signature-Based (Recommended)

More secure. Requires both API key and API secret.

```
WIRO_API_KEY=your-api-key
WIRO_API_SECRET=your-api-secret
```

### API Key Only

Simpler. Only requires the API key. Omit `WIRO_API_SECRET` from your config.

```
WIRO_API_KEY=your-api-key
```

The hosted server takes the same credentials as a bearer token:
`Authorization: Bearer API_KEY:API_SECRET` for a signature-based project, or
`Authorization: Bearer API_KEY` for an API Key Only project.

## Available Tools

### Models

| Tool | Description |
|------|-------------|
| `search_models` | Search and browse AI models by keyword, category, or owner |
| `get_model_schema` | Get full parameter schema and pricing for any model, or the parameters and output ports of a workflow utility |
| `recommend_model` | Find models for a goal from two or three key words, best matches first |
| `explore` | Browse curated models grouped by category, no parameters needed |
| `run_model` | Run any model, waiting up to 45s by default before it returns a recoverable task token |
| `wait_for_task` | Continue waiting for an existing task without submitting or billing a duplicate run |
| `get_task` | Check task status immediately or wait up to 45s with `wait_seconds` |
| `list_tasks` | Browse authenticated task history across conversations, then continue with `get_task` |
| `get_task_price` | Get the cost of a completed task |
| `cancel_task` | Cancel a queued task |
| `kill_task` | Stop a queued or running task |
| `upload_file` | Upload a file from a public http(s) URL (up to about 100 MB) for use as model input |

For long generations, `run_model` returns the existing task ID and token when its
wait budget expires. The assistant must continue with `wait_for_task`; retrying
`run_model` creates a separate billable task.

### Workflows

A workflow chains models and built-in utility steps into one graph with its own
inputs and outputs. Every model step is charged like a normal model run when it
finishes. Wiro fills a model input you leave out with the model's default, so the
save result lists what it filled, and a graph can be at most 40 KB of JSON.

| Tool | Description |
|------|-------------|
| `list_workflows` | List the workflows in your workspace, or search the public gallery by text, tag or model |
| `get_workflow` | Read a workflow's inputs, outputs and step graph |
| `create_workflow` | Save a new workflow from a step graph. Wiro checks it against the live model catalog and returns every problem it finds at once |
| `update_workflow` | Edit a workflow's title, description, tags or graph without overwriting newer changes; a new graph is saved only after you confirm a summary of the change |
| `clone_workflow` | Copy a public workflow into your workspace |
| `delete_workflow` | Delete a workflow, after your confirmation |
| `run_workflow` | Run a workflow and wait for its outputs; can stop after a chosen step to test the first steps |
| `wait_for_workflow_run` | Keep waiting on a run, read its outputs, or see why a step failed |
| `resume_workflow_run` | Continue a failed or stopped run without paying again for finished steps |
| `list_workflow_runs` | Browse past and current runs, including runs started on wiro.ai |
| `save_workflow_from_agent` | Save a workflow the Workflow Agent proposed, as a new workflow, or onto an existing one after you confirm a summary of the change |

The **Workflow Agent** designs workflows with you in plain language: talk to it
with `send_agent_message` and `agent: "workflow-agent"`, attach an existing
workflow to edit, then save its proposal with `save_workflow_from_agent`.
Conversations started through this server belong to the connected project and
are separate from your Workflow Agent chats on wiro.ai.

### Agents

Talk to any Wiro agent with one set of tools. `agent` is `"studio"`, `"workflow-agent"`
or the id of one of your own agents.

| Tool | Description |
|------|-------------|
| `send_agent_message` | Send a message and wait for the reply, with any media, workflows or model runs it produced |
| `get_agent_message` | Keep waiting on a reply, or read one again |
| `get_agent_conversation` | List conversations, or read one conversation's history |
| `cancel_agent_message` | Stop a reply that is still being written |
| `delete_agent_session` | Delete a conversation and the agent's memory of it, after your confirmation |
| `list_studio_results` | List the images, videos and other results Studio generated for you |

**Studio** is Wiro's creative agent: it picks and runs models for you and charges
your wallet after each reply. Your own agents run on a monthly plan with credits.

| Tool | Description |
|------|-------------|
| `list_agent_templates` | Browse ready-made agent templates and their monthly prices |
| `get_agent_template` | Read a template's skills, plans, and the accounts and keys it needs |
| `list_agent_skills` | Browse the skills an agent can have, and what each one needs to work |
| `deploy_agent` | Deploy an agent from a template or build one from skills; shows the price and asks before charging |
| `list_my_agents` | List your agents with their status, plan and credits |
| `get_my_agent` | Read one agent's setup, plan and credits; can wait until it is running |
| `control_agent` | Start, stop or restart an agent |
| `update_agent` | Change an agent's name, description, time zone, models and chat commands |
| `apply_agent_skills` | Turn skills on or off; shows the price change and asks before charging |
| `set_agent_credentials` | Save the keys, tokens and settings an agent's skills and channels need, such as a Telegram bot token or a Gmail app password |
| `connect_agent_oauth` | Connect sign-in accounts such as HubSpot or X; you approve the connection in your browser. Some services need your own app keys or a token first |
| `disconnect_agent_oauth` | Disconnect a connected account, after your confirmation |
| `manage_agent_custom_skill` | Add, edit, schedule, restore or remove an agent's own instructions and scheduled tasks |
| `manage_agent_billing` | Subscribe, upgrade to Pro, cancel, renew or buy extra credits from your wallet, after your confirmation |
| `get_agent_activity` | Read an agent's credit usage and activity logs |
| `delete_agent` | Delete an agent, after your confirmation |

### Account and guides

| Tool | Description |
|------|-------------|
| `get_account` | Show which workspace the connected project belongs to and its wallet balance |
| `get_playbook` | Step-by-step guides: getting started, models, workflows, workflow graphs, the Workflow Agent, Studio, agents and billing |
| `search_docs` | Search the Wiro documentation for guides and API references |

The server also offers prompts for common jobs (`build_workflow`, `deploy_agent`,
`create_with_studio`, `talk_to_my_agent`). In clients that support MCP prompts
they appear as ready-made commands.

### Choosing tool groups

All groups are on by default. Some clients work best with fewer tools; set
`WIRO_TOOLSETS` to a comma-separated list of `models`, `workflows` and `agents`
to load only those. `get_account`, `get_playbook` and `search_docs` are always
available, and `workflows` also brings the model search tools it needs. The
conversation tools for Studio and the Workflow Agent, with
`save_workflow_from_agent`, come with either `workflows` or `agents`, and each
prompt appears only when its tools are loaded. If a job needs a tool from a
group that is not loaded, the server instructions tell the assistant to say so.

```json
"env": {
  "WIRO_API_KEY": "your-api-key",
  "WIRO_TOOLSETS": "models,workflows"
}
```

### Paid and irreversible actions

Running a model or workflow, sending a message to Studio or the Workflow Agent,
and messages to your own agents (which use the agent's credits) cost money. Agent
plans, plan changes, credit packs and skill changes are charged to your wallet,
so those tools first return the price (an estimate for prorated changes such as
an upgrade to Pro) and only act when called again with `confirm: true` and the
quote's reference (`confirm_charge_usd` with the approved amount, or the quote's
`idempotency_key` for skill changes) after you agree. If the price changed in
between, nothing is charged and you get a new quote. Deleting a workflow, an
agent, a conversation or an account connection also waits for `confirm: true`,
and so does replacing a workflow's steps with `update_workflow` or
`save_workflow_from_agent`: you see a summary of the change first. No tool adds
funds or takes a card payment: funds are added in the Wiro dashboard, and an
agent plan paid by card is upgraded or topped up there. The connected project
decides the workspace: a personal project uses your personal wallet, a team
project uses the team wallet.

### LLM-friendly responses

All tools publish typed MCP input and output schemas. Successful calls return
`structuredContent` for reliable chaining, concise text `content` for clients
that only render text, and MCP resource links for generated media.
Model parameters remain catalog-driven: `json` and `json-array` fields are sent
as structured values in the same `run_model.params` object as all other inputs.
Use `get_model_schema` as the source of truth for continuation fields. A model
can continue a conversation only when its schema lists `session_id`: send the
same `session_id` on every turn, the first one included. Each next turn also
sends `previousTaskToken`, the last turn's task token, with exactly one new
`prompt` or non-empty `messages` value for a stateful next turn, or with
`toolOutputs` for a tool-result continuation.

LLM task outputs preserve the public Task Detail segment names and casing:
`thinking`, `answer`, `function_call`, and `custom_tool_call`, including
`call_id`, `finishreason`, and optional normalized token `usage`.
Only validated fields are projected into structured MCP output. When segments
are present, `response` is derived from ordered `answer` segments instead of
raw debug transport; tasks without a typed projection retain their normal
`debugoutput` response.

Completed tool calls return a continuation template in the existing
`nextAction`. Execute each call, replace the output placeholders, and pass the
same ordinary `run_model.params` object back:

```json
{
  "tool": "run_model",
  "arguments": {
    "model": "owner/model",
    "params": {
      "previousTaskToken": "task-token",
      "toolOutputs": [
        {
          "call_id": "call_01",
          "output": "<tool result>"
        }
      ],
      "session_id": "launch-taglines"
    }
  }
}
```

Function calls carry JSON-string `arguments`; custom tool calls carry free-form
`input`. Tool results are request values in `toolOutputs`, not response
segments.

Completed media responses also include an assistant-audience delivery
instruction. Some MCP clients expose a `resource_link` as tool metadata instead
of previewing it inside the tool card, so the assistant is explicitly told to
render images and preserve clickable media links in its user-facing response.
The standard resource link and full-resolution URL remain available to every
client; no base64 media payload is required. Only files on Wiro's own hosts are
returned this way. Other links in an agent's reply stay plain links in the text,
without the delivery instruction.

Task responses use the stable states `submitted`, `running`, `completed`,
`failed`, and `cancelled`. When more work is required, the response includes an
executable `nextAction`:

```json
{
  "state": "running",
  "task": {
    "id": "123",
    "token": "task-token",
    "status": "task_start"
  },
  "outputs": [],
  "nextAction": {
    "tool": "wait_for_task",
    "arguments": { "tasktoken": "task-token" },
    "reason": "Continue this exact task. Do not call run_model again."
  }
}
```

Generation chain:
`search_models → get_model_schema → run_model → wait_for_task`

Cross-conversation history:
`list_tasks → get_task`

Workflow chain:
`search_models → get_model_schema → create_workflow → run_workflow → wait_for_workflow_run`

Workflow Agent chain:
`send_agent_message (agent "workflow-agent") → get_agent_message → save_workflow_from_agent → run_workflow`

Agent chain:
`list_agent_templates → get_agent_template → deploy_agent → set_agent_credentials / connect_agent_oauth → control_agent → send_agent_message`

## Hosted MCP Server

Wiro AI also hosts the same tools at `https://mcp.wiro.ai/v1` over streamable HTTP, so nothing has to be installed locally. Send your credentials in the `Authorization` header as shown under [Authentication](#authentication). The [MCP Server documentation](https://wiro.ai/docs/wiro-mcp-server) has setup instructions for each client.

### Install as a plugin

[wiroai/Wiro-Plugin](https://github.com/wiroai/Wiro-Plugin) packages the hosted server as a plugin for Cursor, Claude Code, Gemini CLI and Devin. Its README has the install command for each of them.

## Documentation

- [MCP Server (Hosted)](https://wiro.ai/docs/wiro-mcp-server): setup guides for Cursor, Claude Code, Claude Desktop, Windsurf, Gemini CLI, Devin, OpenClaw, and Hermes
- [Self-Hosted MCP](https://wiro.ai/docs/mcp-self-hosted): run locally with npx, environment variables, library usage
- [Node.js Library](https://wiro.ai/docs/nodejs-library): use `WiroClient` from this package in your own Node.js or TypeScript code
- [Authentication](https://wiro.ai/docs/authentication): signature-based vs API Key Only
- [Run a Model](https://wiro.ai/docs/run-a-model): how the Run endpoint works
- [Tasks](https://wiro.ai/docs/tasks): task lifecycle, statuses, determining success
- [Concurrency Limits](https://wiro.ai/docs/concurrency-limits): concurrent task limits based on balance
- [Error Reference](https://wiro.ai/docs/error-reference): error codes and handling
- [Agents Overview](https://wiro.ai/docs/agent-overview): templates, plans, credits and the agent lifecycle
- [Agent Builder](https://wiro.ai/docs/agent-builder): build an agent from skills instead of a template
- [Agent Skills](https://wiro.ai/docs/agent-skills) and [Agent Credentials](https://wiro.ai/docs/agent-credentials): what each skill needs and how accounts are connected
- [Agent Messaging](https://wiro.ai/docs/agent-messaging): conversations, sessions and replies

## Using as a Library

This package exports its core components for use in custom MCP servers:

```typescript
import { WiroClient } from '@wiro-ai/wiro-mcp/client';
import { createMcpServer } from '@wiro-ai/wiro-mcp/server';

const client = new WiroClient('your-api-key', 'your-api-secret');
const server = createMcpServer(client);
```

If a project uses signature-based auth and no API secret was given, tool errors say that the secret is missing. When your server takes credentials in its own way, tell users where the secret goes:

```typescript
const client = new WiroClient(apiKey, apiSecret, undefined, {
  missingSecretHint: 'This project uses signature-based auth. Enter API_KEY:API_SECRET as the API key.',
});
```

### Exports

| Export | Description |
|--------|-------------|
| `createMcpServer(client, options?)` | Creates an McpServer with the tools, prompts and server instructions registered. `options.toolsets` picks tool groups and the prompts that use them; `options.instructions` replaces the instructions; `options.wrapTool(tool, handler)` returns the handler to register for each tool, for your own logging or permission checks |
| `WiroClient` | API client with both auth types; `post(path, body)` calls any Wiro API endpoint with the same credentials |
| `registerTools(server, client, options?)` | Register tools on an existing McpServer |
| `parseToolsets(value)` | Parse a `WIRO_TOOLSETS`-style list such as `"models,agents"` |

```typescript
// Import specific components
import { WiroClient } from '@wiro-ai/wiro-mcp/client';
import { registerTools } from '@wiro-ai/wiro-mcp/tools';

// Only the model and workflow tools
const server = createMcpServer(client, { toolsets: ['models', 'workflows'] });
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `WIRO_API_KEY` | Yes | Your Wiro project API key |
| `WIRO_API_SECRET` | No | Your Wiro project API secret (for signature auth) |
| `WIRO_API_BASE_URL` | No | Override API base URL (default: `https://api.wiro.ai/v1`) |
| `WIRO_TOOLSETS` | No | Comma-separated tool groups to load: `models`, `workflows`, `agents` (default: all) |

## More from Wiro AI

| Repository | What it is |
| --- | --- |
| [Wiro-Plugin](https://github.com/wiroai/Wiro-Plugin) | Wiro AI plugin for Cursor, Claude Code, Gemini CLI and Devin |
| [Swift-QuickStart](https://github.com/wiroai/Swift-QuickStart) | WiroKit, the Wiro AI SDK for iOS |
| [Kotlin-QuickStart](https://github.com/wiroai/Kotlin-QuickStart) | WiroKit, the Wiro AI SDK for Android |
| [Dart-QuickStart](https://github.com/wiroai/Dart-QuickStart) | Wiro AI SDK for Dart and Flutter, [`wiro` on pub.dev](https://pub.dev/packages/wiro) |
| [ReactNative-QuickStart](https://github.com/wiroai/ReactNative-QuickStart) | Wiro AI SDK for React Native and Expo, [`@wiro-ai/wiro-react-native` on npm](https://www.npmjs.com/package/@wiro-ai/wiro-react-native) |
| [Swift-Realtime](https://github.com/wiroai/Swift-Realtime) | Realtime voice AI example for iOS |
| [Kotlin-Realtime](https://github.com/wiroai/Kotlin-Realtime) | Realtime voice AI example for Android |
| [Dart-Realtime](https://github.com/wiroai/Dart-Realtime) | Realtime voice AI example for Flutter |
| [ReactNative-Realtime](https://github.com/wiroai/ReactNative-Realtime) | Realtime voice AI example for React Native |
| [n8n-nodes-wiroai](https://github.com/wiroai/n8n-nodes-wiroai) | Wiro AI nodes for n8n, [`@wiro-ai/n8n-nodes-wiroai` on npm](https://www.npmjs.com/package/@wiro-ai/n8n-nodes-wiroai) |
| [Wiro-Docs](https://github.com/wiroai/Wiro-Docs) | Source of the Wiro AI API docs |

[Website](https://wiro.ai) · [Models](https://wiro.ai/models) · [Docs](https://wiro.ai/docs) · [X](https://x.com/wiroai)

## License

MIT, see [LICENSE](./LICENSE).
