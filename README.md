# codex-search-mcp

A local stdio [MCP](https://modelcontextprotocol.io) server that exposes Codex web search to any MCP client — no client-specific UI, extension APIs, or vendor SDKs.

Two tools:

| Tool | What it does |
| --- | --- |
| `codex_search` | One web search. Returns the answer text plus structured results (`ref_id`, `url`, `title`, `snippet`, `domain`). Retrieval only — it does not run an agent turn. |
| `codex_research` | Multi-step research. Start with `search_query`, then pass the returned `sessionId` back as `session_id` for `open`, `click`, and `find` follow-ups. |

## Requirements

- Node.js 22.18+ (24 recommended) — the server runs `.ts` files directly via native type stripping, there is no build step.
- A Codex login, or a token in the environment (see [Authentication](#authentication)).

## Install

```bash
git clone https://github.com/KorenKrita/codex-search-mcp.git
cd codex-search-mcp
npm install
```

## Run

```bash
node src/server.ts          # stdio transport, speaks MCP on stdin/stdout
```

## Client configuration

Point any MCP client at the server. Most clients take a command/args pair:

```json
{
  "mcpServers": {
    "codex-search": {
      "command": "node",
      "args": ["/absolute/path/to/codex-search-mcp/src/server.ts"]
    }
  }
}
```

Some clients (Amp, Hermes, and others) use the same shape under a different key — `amp.mcpServers`, `mcp_servers`, `servers` — with extra fields such as `enabled`, `timeout`, or a per-server `env` block.

If the machine reaches the network through a proxy, set it in the server's environment, for example:

```json
{
  "env": {
    "HTTP_PROXY": "http://127.0.0.1:7890",
    "HTTPS_PROXY": "http://127.0.0.1:7890",
    "NODE_USE_ENV_PROXY": "1"
  }
}
```

## Authentication

Credentials are resolved in this order, and are never logged or printed:

1. `CODEX_ACCESS_TOKEN` (and optional `CODEX_ACCOUNT_ID`) from the environment.
2. `~/.codex/auth.json`, written by `codex login`.

If neither is available the tools fail with a message telling you to run `codex login` or set `CODEX_ACCESS_TOKEN`.

## Development

```bash
npm test        # node --test, covers response normalization and research input validation
```

`src/server.ts` exports `createServer()` plus a `testables` object (`normalizeResponse`, `formatText`, `validateResearchInput`) so the pure helpers can be tested without spawning the server.

## Notes

- `codex_research` never shares implicit state between callers: a call with `search_query` and no `session_id` mints its own session, and follow-up calls must pass that `session_id`.
- Requests time out after 15s and retry twice on `502`/`503`/`504` only; `401`/`403`/`429` fail fast with a distinct message.
- The server targets the Codex backend search endpoint and sends a `codex-cli` user agent, so token validity and endpoint availability are the upstream service's to decide.
