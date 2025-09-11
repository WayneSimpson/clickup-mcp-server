# ChatGPT Custom Connector (Search/Fetch) Integration

This guide explains how to use the ClickUp MCP server with ChatGPT Custom Connectors for Chat Search and Deep Research. The ChatGPT web app currently requires an HTTP SSE server exposing exactly two tools: `search` and `fetch`.

- Transport: Server-Sent Events (SSE)
- Tools: `search` and `fetch` only
- CORS: allow https://chatgpt.com (or use `ENABLE_CORS=true` with allowed origins)

The server already supports Claude and n8n via STDIO and SSE. These changes are additive—you can keep your existing workflows.

---

## Quick Start

1) Start the server with SSE enabled (HTTPS recommended in production):

```bash
# Required
export CLICKUP_API_KEY=your-clickup-api-key
export CLICKUP_TEAM_ID=your-clickup-team-id

# Recommended for ChatGPT usage
export ENABLE_SSE=true
export ENABLE_CORS=true
# Optionally restrict allowed origins (defaults include chatgpt.com)
# export ALLOWED_ORIGINS="https://chatgpt.com,https://your-domain"

# Optional: choose port (default 3231)
export PORT=3231

npx -y @taazkareem/clickup-mcp-server@latest
```

Endpoints when running locally (HTTP):
- SSE: `http://127.0.0.1:3231/sse` (GET)
- JSON-RPC messages: `http://127.0.0.1:3231/messages?sessionId=...` (POST)
- Health: `http://127.0.0.1:3231/health`

For HTTPS, set `ENABLE_HTTPS=true` and provide `SSL_KEY_PATH` and `SSL_CERT_PATH`. See `docs/security-features.md`.

---

## ChatGPT Connector Setup

In ChatGPT:
1) Settings → Connectors → Create → Custom
2) Server URL: set to your SSE endpoint, for example:
   - `https://your-hostname.example.com/sse`
3) Headers (examples):
   - `Authorization: Bearer YOUR_SECRET` (optional, if your reverse-proxy enforces it)
   - `x-api-key: YOUR_KEY` (optional)
4) Save. ChatGPT should connect and list two tools: `search` and `fetch`.

If you use a reverse-proxy or gateway in front of the server, ensure it preserves SSE (`text/event-stream`) and supports CORS.

---

## Tool Contracts

The server registers exactly two tools (plus others for non-ChatGPT clients). ChatGPT will only use `search` and `fetch`.

### search
- Input schema:
```json
{
  "type": "object",
  "properties": {
    "query": { "type": "string" },
    "limit": { "type": "integer", "minimum": 1, "maximum": 50, "default": 10 }
  },
  "required": ["query"]
}
```
- Output shape (both are provided for compatibility):
```json
{
  "ids": ["task_id_1", "task_id_2"],
  "objectIds": ["task_id_1", "task_id_2"],
  "results": [
    { "id": "task_id_1", "title": "Task title", "snippet": "...", "url": "https://app.clickup.com/t/task_id_1" }
  ]
}
```

### fetch
- Input schema:
```json
{ "type": "object", "properties": { "id": { "type": "string" } }, "required": ["id"] }
```
- Output shape:
```json
{
  "id": "task_id_1",
  "title": "Task title",
  "text": "Short summary or description...\nStatus: ...\nList: ...\nhttps://app.clickup.com/t/task_id_1",
  "url": "https://app.clickup.com/t/task_id_1",
  "metadata": { "status": "...", "list": "..." },
  "raw": { "...full ClickUp task JSON..." }
}
```

Notes:
- `url` is included for citation in ChatGPT UIs.
- `raw` contains the full ClickUp record for advanced use.

---

## CORS and Preflight

For browser use (ChatGPT web), the server:
- Responds to `OPTIONS` preflight with 204 and CORS headers.
- Allows headers: `Content-Type`, `Authorization`, `x-api-key`, `mcp-session-id`.
- When `ENABLE_CORS=true`, you can configure `ALLOWED_ORIGINS`. Defaults include `https://chatgpt.com`.

---

## Verification Steps

1) Open DevTools → Network while ChatGPT connects to your connector.
2) You should see:
   - `GET /sse` → 200, `Content-Type: text/event-stream`
   - An initial SSE event `endpoint` with `{ "url": "https://your-host/messages" }`
   - `POST /messages?sessionId=...` JSON-RPC requests
3) Trigger search/research. Expect `search` then `fetch` tool calls.

You can also test REST helpers locally (optional):
```bash
# Search (REST helper)
curl "http://127.0.0.1:3231/search?q=invoice&limit=5"

# Fetch (REST helper)
curl "http://127.0.0.1:3231/fetch?id=CLICKUP_TASK_ID"
```

---

## Tips & Troubleshooting

- Ensure your server is reachable via HTTPS with a valid cert.
- If you see “server doesn’t implement our specification” in ChatGPT:
  - Confirm only two tools named `search` and `fetch` are required by the use case (ChatGPT will list others but uses only these two in the web app).
  - Verify `GET /sse` returns an `endpoint` event and `POST /messages` works.
  - Check CORS: origin should be `https://chatgpt.com`, methods `GET,POST,OPTIONS`, headers include `Authorization`, `Content-Type`, `x-api-key` (if used).
- You can restrict tools to only `search,fetch` with:
  ```bash
  export ENABLED_TOOLS="search,fetch"
  ```
- For n8n:
  - Use SSE transport. Server URL is your base (e.g. `http://localhost:3231`).
  - The node can select any ClickUp tools you want.

---

## Keeping Claude and n8n Compatibility

- STDIO remains available when `ENABLE_SSE=false` (default) and `ENABLE_STDIO=true` (default).
- SSE endpoints are additive and do not break existing flows.

---

## Security Notes

- Prefer running behind a reverse proxy (e.g., Nginx/Cloudflare) that terminates TLS and enforces auth headers.
- Consider enabling optional security middleware (see `docs/security-features.md`).
