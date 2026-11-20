# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **The HTTP transport no longer exits on a malformed request (WYREAI-741).** The request
  target was parsed against the client-supplied `Host` header, and a value that does not parse
  (or a target such as `//`) threw inside the request listener before authentication. The
  target is now parsed against a fixed base, so `Host` is no longer consulted, and a target
  that still cannot be parsed gets a `400` JSON response while the server keeps running.

### Added
- **Interactive backup status card via MCP Apps (SEP-1865).** `spanning_get_user` results now render as a read-only interactive card in MCP Apps hosts (Claude Desktop/web, and other hosts advertising the `io.modelcontextprotocol/ui` extension) showing the user's backup status, license state, last backup time, platform, and per-service backup coverage. Non-App hosts are unaffected: the tool's JSON payload is unchanged apart from a new `_card` field.
  - The card is **brand-neutral by default** (system fonts, neutral palette, no baked-in identity — this is a published server) and brandable without rebuilding: `MCP_BRAND_NAME`, `MCP_BRAND_LOGO_URL`, `MCP_BRAND_PRIMARY_COLOR`, `MCP_BRAND_ACCENT_COLOR`, `MCP_BRAND_BG`, and `MCP_BRAND_TEXT` env vars are injected as `window.__BRAND__` at serve time (a gateway can inject the same object per-org). A test pins the default bundle to zero brand identity and zero external font fetches.
  - `spanning_get_user` advertises the UI via `_meta` (`ui/resourceUri`, plus the nested `ui.resourceUri` form) pointing at a new `ui://spanning/backup-status-card.html` resource served as `text/html;profile=mcp-app` under a new `resources` capability. The card HTML is a self-contained vite single-file bundle embedded at build time (`src/generated/backup-status-card-html.ts`, committed), so it serves identically from stdio and HTTP transports.
  - The card is read-only by policy (backup posture is surfaced; restores stay behind the elicitation-confirmed `spanning_queue_restore` tool) and the payload builder is best-effort: a failed per-service lookup degrades the card (or drops it) without affecting the tool result. Contract tests in `test/mcp-apps.test.ts` pin the `_meta` advertisement, the `ui://` resource wire shape, brand injection, and the card normalization.
  - New `npm run build:ui` regenerates the embedded HTML after editing `ui/` (requires the new `vite`, `vite-plugin-singlefile`, and `@modelcontextprotocol/ext-apps` devDependencies); plain `npm run build` and CI are unaffected.
- Initial scaffold of the Spanning Cloud Backup MCP server.
- Stdio + HTTP (StreamableHTTP) transports.
- Gateway-mode credential handling via `X-Spanning-Platform` / `X-Spanning-Admin-Email` / `X-Spanning-API-Token` headers.
- 9 tools covering users, services, backups, restores, audit log, license usage, and server status.
- Destructive-action confirmation elicitation for `spanning_queue_restore`.
- Date-range elicitation for `spanning_list_audit_log`.
- Multi-stage `Dockerfile` with GitHub Packages auth via build secret.
- Semantic-release based CI release pipeline (`.github/workflows/release.yml`).
- MCPB packaging script and Smithery registry config.
