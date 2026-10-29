<div align="center">

<img src="https://raw.githubusercontent.com/wiroai/Wiro-MCP/main/.github/assets/wiro-logo.png" alt="Wiro AI" width="240">

# Wiro MCP Server

Official MCP server for Wiro AI: search, price and run image, video, audio and LLM models from Cursor, Claude Code, Claude Desktop, Windsurf and any other MCP client.

[![npm](https://img.shields.io/npm/v/@wiro-ai/wiro-mcp?style=for-the-badge&color=111111)](https://www.npmjs.com/package/@wiro-ai/wiro-mcp) [![Node.js 20+](https://img.shields.io/badge/Node.js-20%2B-111111?style=for-the-badge&color=111111)](#quick-start) [![MCP server](https://img.shields.io/badge/MCP-server-111111?style=for-the-badge&color=111111)](https://modelcontextprotocol.io/) [![License: MIT](https://img.shields.io/badge/license-MIT-111111?style=for-the-badge&color=111111)](./LICENSE)

[Website](https://wiro.ai) · [Models](https://wiro.ai/models) · [Docs](https://wiro.ai/docs/wiro-mcp-server) · [Dashboard](https://wiro.ai/panel)

<img src="https://wiro.ai/images/koala/accent-heavy-koala.png" alt="Wiro AI koala mascot" width="60" />

</div>

`@wiro-ai/wiro-mcp` is a TypeScript [Model Context Protocol](https://modelcontextprotocol.io/) server that runs locally over stdio with `npx`. Its 13 tools let an AI assistant search the Wiro AI model catalog, read a model's parameters and price, run it and wait for the result, upload input files, browse past tasks and search the Wiro AI docs. The hosted server at `https://mcp.wiro.ai/v1` serves the same tools with nothing to install.

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

- *"Generate a photorealistic image of a mountain lake at sunset"*
- *"What video generation models are available on Wiro?"*
- *"Show me the parameters for google/veo3-1"*
- *"Create a 5-second video with Kling V3: a drone shot over mountains"*
- *"Check the status of my last task"*
- *"Show my latest productions and open the newest result"*

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

| Tool | Description |
|------|-------------|
| `search_models` | Search and browse AI models by keyword, category, or owner |
| `get_model_schema` | Get full parameter schema and pricing for any model |
| `recommend_model` | Describe what you want to build, get model recommendations by relevance |
| `explore` | Browse curated models grouped by category, no parameters needed |
| `run_model` | Run any model, waiting up to 45s by default before it returns a recoverable task token |
| `wait_for_task` | Continue waiting for an existing task without submitting or billing a duplicate run |
| `get_task` | Check task status immediately or wait up to 45s with `wait_seconds` |
| `list_tasks` | Browse authenticated task history across conversations, then continue with `get_task` |
| `get_task_price` | Get the cost of a completed task |
| `cancel_task` | Cancel a queued task |
| `kill_task` | Kill a running task |
| `upload_file` | Upload a file from a public http(s) URL (up to 200 MB) for use as model input |
| `search_docs` | Search the Wiro documentation for guides and API references |

For long generations, `run_model` returns the existing task ID and token when its
wait budget expires. The assistant must continue with `wait_for_task`; retrying
`run_model` creates a separate billable task.

### LLM-friendly responses

All tools publish typed MCP input and output schemas. Successful calls return
`structuredContent` for reliable chaining, concise text `content` for clients
that only render text, and MCP resource links for generated media.
Model parameters remain catalog-driven: `json` and `json-array` fields are sent
as structured values in the same `run_model.params` object as all other inputs.
Use `get_model_schema` as the source of truth for continuation fields.
`previousTaskToken` is the single continuation reference. Send it with exactly
one new `prompt` or non-empty `messages` value for a stateful next turn, or with
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
      ]
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
client; no base64 media payload is required.

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
| `createMcpServer(client)` | Creates an McpServer with all 13 tools registered |
| `WiroClient` | API client with both auth types |
| `registerTools(server, client)` | Register tools on an existing McpServer |

```typescript
// Import specific components
import { WiroClient } from '@wiro-ai/wiro-mcp/client';
import { registerTools } from '@wiro-ai/wiro-mcp/tools';
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `WIRO_API_KEY` | Yes | Your Wiro project API key |
| `WIRO_API_SECRET` | No | Your Wiro project API secret (for signature auth) |
| `WIRO_API_BASE_URL` | No | Override API base URL (default: `https://api.wiro.ai/v1`) |

## More from Wiro AI

| Repository | What it is |
| --- | --- |
| [Wiro-Plugin](https://github.com/wiroai/Wiro-Plugin) | Wiro AI plugin for Cursor, Claude Code, Gemini CLI and Devin |
| [Swift-QuickStart](https://github.com/wiroai/Swift-QuickStart) | WiroKit, the Wiro AI SDK for iOS |
| [Kotlin-QuickStart](https://github.com/wiroai/Kotlin-QuickStart) | WiroKit, the Wiro AI SDK for Android |
| [Dart-QuickStart](https://github.com/wiroai/Dart-QuickStart) | Wiro AI SDK for Dart and Flutter (`wiro` on pub.dev) |
| [ReactNative-QuickStart](https://github.com/wiroai/ReactNative-QuickStart) | Wiro AI SDK for React Native and Expo (`@wiro-ai/wiro-react-native`) |
| [Swift-Realtime](https://github.com/wiroai/Swift-Realtime) | Realtime voice AI example for iOS |
| [Kotlin-Realtime](https://github.com/wiroai/Kotlin-Realtime) | Realtime voice AI example for Android |
| [Dart-Realtime](https://github.com/wiroai/Dart-Realtime) | Realtime voice AI example for Flutter |
| [ReactNative-Realtime](https://github.com/wiroai/ReactNative-Realtime) | Realtime voice AI example for React Native |
| [n8n-nodes-wiroai](https://github.com/wiroai/n8n-nodes-wiroai) | Wiro AI nodes for n8n |
| [Wiro-Docs](https://github.com/wiroai/Wiro-Docs) | Source of the Wiro AI API docs |

[Website](https://wiro.ai) · [Models](https://wiro.ai/models) · [Docs](https://wiro.ai/docs) · [X](https://x.com/wiroai)

## License

MIT, see [LICENSE](./LICENSE).
