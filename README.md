<div align="center">

<img src="https://wiro.ai/images/logos/logo/logo.png" alt="Wiro" width="180" />

# Wiro MCP Server

**Official [MCP](https://modelcontextprotocol.io/) server for [Wiro AI](https://wiro.ai/)** — access all AI models on Wiro from Cursor, Claude, Windsurf, and any MCP-compatible AI assistant.

[![npm](https://img.shields.io/badge/npm-@wiro--ai/wiro--mcp-00c38c?style=for-the-badge&logo=npm&logoColor=white)](https://www.npmjs.com/package/@wiro-ai/wiro-mcp)
[![MCP](https://img.shields.io/badge/MCP-compatible-333?style=for-the-badge&logo=data:image/svg+xml;base64,&logoColor=white)](https://modelcontextprotocol.io/)
[![MIT](https://img.shields.io/badge/license-MIT-6f42c1?style=for-the-badge)](./LICENSE)

[Hosted MCP](https://wiro.ai/docs#/mcp) · [Models](https://wiro.ai/models) · [Dashboard](https://wiro.ai/panel) · [Docs](https://wiro.ai/docs)

<img src="https://wiro.ai/images/koala/accent-heavy-koala.png" alt="Wiro Koala mascot" width="60" />

</div>

## Quick Start

### 1. Get API Keys

Sign up at [wiro.ai](https://wiro.ai/) and create a project at [wiro.ai/panel/project/new](https://wiro.ai/panel/project/new) to get your API key and secret.

### 2. Add to Your AI Assistant

**Cursor** — open MCP settings (`Cmd+Shift+P` → "Open MCP settings") and add:

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

**Claude Desktop** — add to `claude_desktop_config.json`:

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

**Windsurf** — add to MCP settings:

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

### 3. Start Using

Ask your AI assistant:

- *"Generate a photorealistic image of a mountain lake at sunset"*
- *"What video generation models are available on Wiro?"*
- *"Show me the parameters for openai/sora-2"*
- *"Create a 5-second video with Kling V3 — a drone shot over mountains"*
- *"Check the status of my last task"*

## Authentication

Wiro supports two authentication types (chosen when creating a project):

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

## Available Tools

| Tool | Description |
|------|-------------|
| `search_models` | Search and browse all AI models on Wiro by keyword or category |
| `get_model_schema` | Get full parameter schema for any model |
| `run_model` | Run any model — wait for result or get task token |
| `get_task` | Check task status, outputs, and cost |
| `cancel_task` | Cancel a queued task |
| `kill_task` | Kill a running task |

## Hosted MCP Server

Wiro also provides a hosted MCP server at `https://mcp.wiro.ai/v1` that requires no local installation. See the [MCP Server documentation](https://wiro.ai/docs#/mcp) for setup instructions.

## Documentation

- [MCP Server (Hosted)](https://wiro.ai/docs#/mcp) — setup guides for Cursor, Claude Code, Claude Desktop, Windsurf
- [Self-Hosted MCP](https://wiro.ai/docs#/mcp-self-hosted) — run locally with npx, environment variables, library usage
- [Authentication](https://wiro.ai/docs#/authentication) — signature-based vs API Key Only
- [Run a Model](https://wiro.ai/docs#/run-a-model) — how the Run endpoint works
- [Tasks](https://wiro.ai/docs#/tasks) — task lifecycle, statuses, determining success
- [Concurrency Limits](https://wiro.ai/docs#/concurrency-limits) — concurrent task limits based on balance
- [Error Reference](https://wiro.ai/docs#/error-reference) — error codes and handling

## Using as a Library

This package exports its core components for use in custom MCP servers:

```typescript
import { createMcpServer, WiroClient } from '@wiro-ai/wiro-mcp';

const client = new WiroClient('your-api-key', 'your-api-secret');
const server = createMcpServer(client);
```

### Exports

| Export | Description |
|--------|-------------|
| `createMcpServer(client)` | Creates an McpServer with all 6 tools registered |
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

## Links

- [Wiro AI](https://wiro.ai/)
- [Dashboard](https://wiro.ai/panel)
- [Models](https://wiro.ai/models)
- [API Documentation](https://wiro.ai/docs)
- [Create Project](https://wiro.ai/panel/project/new)

## License

MIT — see [LICENSE](./LICENSE) for details.

---

<div align="center">

**Built with ❤️ by the Wiro team**

🌐 [wiro.ai](https://wiro.ai) · [GitHub @wiroai](https://github.com/wiroai)

</div>
