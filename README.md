# Spanning Cloud Backup MCP Server

[![CI](https://github.com/WYRE-AI/spanning-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/WYRE-AI/spanning-mcp/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

A [Model Context Protocol](https://modelcontextprotocol.io) server exposing the
[Spanning Cloud Backup](https://spanning.com/) API to Claude and other MCP
clients.

## What it does

Surface SaaS backup posture for your M365, Google Workspace, or Salesforce
tenants directly to AI assistants — list backed-up users, inspect covered
services, browse backup history, queue restores, and audit admin activity and
license usage.

- **Interactive backup status card (MCP Apps, SEP-1865)**: `spanning_get_user`
  renders as a read-only interactive card in MCP Apps hosts (Claude
  Desktop/web) showing the user's backup status, license state, last backup,
  and per-service coverage; neutral by default, brandable via
  `window.__BRAND__` injection or `MCP_BRAND_*` env vars
  (`MCP_BRAND_NAME`, `MCP_BRAND_LOGO_URL`, `MCP_BRAND_PRIMARY_COLOR`,
  `MCP_BRAND_ACCENT_COLOR`, `MCP_BRAND_BG`, `MCP_BRAND_TEXT`). Plain-JSON
  behavior is unchanged in other hosts. Rebuild the embedded card with
  `npm run build:ui` after editing `ui/`.

## Tools

| Tool | Purpose |
| --- | --- |
| `spanning_list_users` | List backed-up users in the org |
| `spanning_get_user` | Fetch a single user's detail |
| `spanning_list_services` | List services covered for a user |
| `spanning_list_backups` | List backup runs for a user + service |
| `spanning_queue_restore` | Queue a restore (DESTRUCTIVE — requires confirmation) |
| `spanning_get_restore_status` | Check restore progress |
| `spanning_list_audit_log` | Admin audit log (date-range elicitation) |
| `spanning_get_license_usage` | Seats used vs purchased |
| `spanning_status` | Server status / health |

## Credentials

Copy [`.env.example`](.env.example) and set the variables below. Leave `CONDUIT_S2S_SECRET` empty in the example. Never commit a real secret.

### Local (env mode)

```sh
export SPANNING_PLATFORM="m365"        # or "gws" or "salesforce"
export SPANNING_ADMIN_EMAIL="..."
export SPANNING_API_TOKEN="..."
```

The stdio transport reads those variables and does not use `CONDUIT_S2S_SECRET`.

### HTTP transport

`CONDUIT_S2S_SECRET` is required when `MCP_TRANSPORT=http`. If it is empty or a known placeholder (`changeme`, `change-me`, `secret`, `placeholder`, `example`, `replace-me`, `replace-with-a-real-secret`, `your-secret`, `your-s2s-secret`, `s2s-secret`), the process logs an error and exits non-zero. The secret value is never logged. Generate one with `openssl rand -hex 32`.

`MCP_ALLOW_INSECURE_DEV=1` is local development only. It starts HTTP without `CONDUIT_S2S_SECRET`, logs a warning, does not check `X-Gateway-S2S`, and listens on `127.0.0.1` only. A non-loopback `MCP_HTTP_HOST` (including `0.0.0.0`) is overridden to `127.0.0.1` and that override is logged. A known placeholder secret is still refused.

`MCP_HTTP_HOST` defaults to `127.0.0.1` when unset. A configured `CONDUIT_S2S_SECRET` honors `MCP_HTTP_HOST`. The container image sets `MCP_HTTP_HOST=0.0.0.0` and `AUTH_MODE=gateway`.

#### `X-Gateway-S2S`

With a real `CONDUIT_S2S_SECRET`, every `/mcp` request must include `X-Gateway-S2S`. The check is `verifyS2sHeader` in [`src/s2s-verify.ts`](src/s2s-verify.ts): the header value is `t=<unix seconds>,v1=<hex>`, where the hex is HMAC-SHA256 of the literal string `t=<unix seconds>` keyed with `CONDUIT_S2S_SECRET` (64 lowercase hex characters). The timestamp must be within 300 seconds of the server clock. A missing or invalid header is HTTP 401, before vendor credentials are read.

```bash
TS=$(date +%s)
SIG=$(printf 't=%s' "$TS" | openssl dgst -sha256 -hmac "$CONDUIT_S2S_SECRET" -hex | awk '{print $NF}')
curl -sS http://127.0.0.1:8080/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H "X-Gateway-S2S: t=${TS},v1=${SIG}" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

### Hosted (gateway mode)

`AUTH_MODE=gateway` (the Docker image and Compose default) requires all three headers on every `/mcp` request and does not fall back to `SPANNING_*` in the process environment:

- `X-Spanning-Platform` (required, one of `m365` | `gws` | `salesforce`)
- `X-Spanning-Admin-Email` (required)
- `X-Spanning-API-Token` (required, secret)

A request missing any of those headers is HTTP 401. Add them to the signed curl above. The gateway Compose service does not set `SPANNING_PLATFORM`, `SPANNING_ADMIN_EMAIL`, or `SPANNING_API_TOKEN`.

`/health` stays unauthenticated and does not read credentials.

### Single-tenant HTTP (`AUTH_MODE=env`)

`/mcp` still requires a valid `X-Gateway-S2S` header. Vendor credentials come from `SPANNING_PLATFORM`, `SPANNING_ADMIN_EMAIL`, and `SPANNING_API_TOKEN`. Pass those on that process. Do not add them to the gateway Compose service.

| Variable | Required | Description |
|----------|----------|-------------|
| `SPANNING_PLATFORM` | stdio and `AUTH_MODE=env` | `m365`, `gws`, or `salesforce` |
| `SPANNING_ADMIN_EMAIL` | stdio and `AUTH_MODE=env` | Spanning admin account email |
| `SPANNING_API_TOKEN` | stdio and `AUTH_MODE=env` | Spanning API token |
| `MCP_TRANSPORT` | No | `stdio` (default) or `http` |
| `AUTH_MODE` | No | `gateway` (Docker image and Compose) or `env`. Gateway mode requires the `X-Spanning-*` headers and never falls back to `SPANNING_*`. |
| `CONDUIT_S2S_SECRET` | Yes for HTTP | Service-to-service HMAC secret. HTTP logs an error and exits non-zero when this is empty or a known placeholder. Compose will not start without it. Never commit a real value. |
| `MCP_ALLOW_INSECURE_DEV` | No | Set to `1` only for local development to start HTTP without `CONDUIT_S2S_SECRET`. Logs a warning, skips `X-Gateway-S2S`, and binds `127.0.0.1` only. |
| `MCP_HTTP_HOST` | No | Bind address when `MCP_TRANSPORT=http`. Defaults to `127.0.0.1`. Honored when `CONDUIT_S2S_SECRET` is set. The container image sets `0.0.0.0`. |
| `MCP_HTTP_PORT` | No | HTTP port. Defaults to `8080`. |

## Run

```sh
npm install
npm run build
npm start                       # stdio

# HTTP refuses to start until CONDUIT_S2S_SECRET is a real secret
CONDUIT_S2S_SECRET="$(openssl rand -hex 32)" MCP_TRANSPORT=http npm start

# Local HTTP only, without a service-to-service secret (always binds 127.0.0.1)
MCP_TRANSPORT=http MCP_ALLOW_INSECURE_DEV=1 npm start
```

### Docker

The image listens on `0.0.0.0` inside the container and defaults to `AUTH_MODE=gateway`. Publish the port on loopback and pass the S2S secret. In gateway mode, Spanning credentials arrive on each request as headers.

```bash
docker build --secret id=npmrc,src=$HOME/.npmrc -t spanning-mcp .
docker run --rm \
  -e CONDUIT_S2S_SECRET \
  -p 127.0.0.1:8080:8080 \
  spanning-mcp
```

Compose refuses to start when `CONDUIT_S2S_SECRET` is unset, sets `AUTH_MODE=gateway`, publishes `127.0.0.1:8080:8080`, and does not inject static Spanning credentials:

```bash
CONDUIT_S2S_SECRET="$(openssl rand -hex 32)" docker compose up --build
```

The image build needs a GitHub Packages npmrc (`docker build --secret id=npmrc,src=$HOME/.npmrc`). Single-tenant HTTP still requires the S2S secret, then uses `SPANNING_*`:

```bash
docker run --rm \
  -e CONDUIT_S2S_SECRET \
  -e AUTH_MODE=env \
  -e SPANNING_PLATFORM=m365 \
  -e SPANNING_ADMIN_EMAIL=admin@example.com \
  -e SPANNING_API_TOKEN \
  -p 127.0.0.1:8080:8080 \
  spanning-mcp
```

## License

Apache 2.0 — see [LICENSE](LICENSE).
