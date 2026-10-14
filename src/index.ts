#!/usr/bin/env node
/**
 * Spanning Cloud Backup MCP Server
 *
 * This MCP server provides tools for interacting with the Spanning Cloud
 * Backup API (M365 / Google Workspace / Salesforce). It accepts credentials
 * via environment variables (env mode) or per-request HTTP headers (gateway
 * mode).
 *
 * Supports both stdio (default) and HTTP (StreamableHTTP) transports.
 *
 * HTTP transport refuses to start unless CONDUIT_S2S_SECRET is a real secret.
 * Known placeholders are rejected. MCP_ALLOW_INSECURE_DEV=1 is a local-only
 * escape hatch: it logs a warning and binds 127.0.0.1 only. A configured
 * secret honors MCP_HTTP_HOST. The default bind address is 127.0.0.1.
 * Gateway mode requires X-Spanning-* credential headers and does not fall
 * back to SPANNING_* in the environment. /health stays unauthenticated.
 * stdio does not use S2S auth.
 */

import { createServer, IncomingMessage, ServerResponse, Server as HttpServer } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { setServerRef } from "./utils/server-ref.js";
import { TOOL_DEFINITIONS } from "./tool.definitions.js";
import { registerResourceHandlers } from "./resources.js";
import { verifyS2sHeader, S2S_HEADER } from "./s2s-verify.js";
import {
  handleSpanningTool,
  type SpanningCredentials,
  type SpanningPlatform,
  type CredentialError,
} from "./tool-handler.js";

/**
 * Public example values. A copied placeholder must not verify as a real
 * secret, and it is refused even when MCP_ALLOW_INSECURE_DEV=1.
 */
const KNOWN_PLACEHOLDER_SECRETS = new Set([
  "replace-with-a-real-secret",
  "your-s2s-secret",
  "your-secret",
  "changeme",
  "change-me",
  "placeholder",
  "secret",
  "example",
  "replace-me",
  "s2s-secret",
]);

const LOOPBACK_HOST = "127.0.0.1";

const MISSING_S2S_SECRET_ERROR =
  "Refusing to start HTTP transport: CONDUIT_S2S_SECRET is empty. " +
  "Set CONDUIT_S2S_SECRET to the gateway-provisioned secret (openssl rand -hex 32), " +
  "or set MCP_ALLOW_INSECURE_DEV=1 for local development only.";

const PLACEHOLDER_S2S_SECRET_ERROR =
  "Refusing to start HTTP transport: CONDUIT_S2S_SECRET is a known placeholder. " +
  "Generate a secret with `openssl rand -hex 32` and set CONDUIT_S2S_SECRET to that value.";

const INSECURE_DEV_WARNING =
  "SECURITY WARNING: CONDUIT_S2S_SECRET is unset and MCP_ALLOW_INSECURE_DEV=1. " +
  "HTTP /mcp is starting with service-to-service authentication DISABLED, bound to 127.0.0.1 only. " +
  "Local development only; do not expose this port.";

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[(.+)\]$/, "$1");
  if (normalized === "localhost" || normalized === "::1") return true;
  const bare = normalized.startsWith("::ffff:") ? normalized.slice("::ffff:".length) : normalized;
  const parts = bare.split(".");
  if (parts.length !== 4) return false;
  if (parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return false;
  return parts[0] === "127";
}

function headerValue(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Secret for X-Gateway-S2S on /mcp. Read at HTTP startup, not module load.
 * Empty is fail-closed unless MCP_ALLOW_INSECURE_DEV=1. A known placeholder
 * always refuses to start. The secret value is never written to logs.
 */
function resolveHttpS2sSecret(): { secret: string; insecureDev: boolean } {
  const raw = (process.env.CONDUIT_S2S_SECRET ?? "").trim();
  if (raw && KNOWN_PLACEHOLDER_SECRETS.has(raw.toLowerCase())) {
    console.error(PLACEHOLDER_S2S_SECRET_ERROR);
    process.exit(1);
  }
  if (raw) return { secret: raw, insecureDev: false };

  if (process.env.MCP_ALLOW_INSECURE_DEV === "1") {
    console.error(INSECURE_DEV_WARNING);
    return { secret: "", insecureDev: true };
  }

  console.error(MISSING_S2S_SECRET_ERROR);
  process.exit(1);
}

/**
 * No secret (the insecure-dev bypass) always binds 127.0.0.1, including when
 * MCP_HTTP_HOST is a wider address. A configured secret honors MCP_HTTP_HOST.
 * Unset MCP_HTTP_HOST defaults to 127.0.0.1 in either case.
 */
function resolveBindHost(hasSecret: boolean): string {
  const configured = (process.env.MCP_HTTP_HOST ?? "").trim();
  if (hasSecret) {
    return configured === "" ? LOOPBACK_HOST : configured;
  }
  if (configured !== "" && !isLoopbackHost(configured)) {
    console.error(
      `WARNING: MCP_HTTP_HOST=${configured} is not a loopback address. ` +
        "MCP_ALLOW_INSECURE_DEV=1 without CONDUIT_S2S_SECRET cannot listen there. " +
        `Binding ${LOOPBACK_HOST} only.`,
    );
  }
  return LOOPBACK_HOST;
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

const VALID_PLATFORMS: readonly SpanningPlatform[] = ["m365", "gws", "salesforce"];

function isValidPlatform(value: string | undefined): value is SpanningPlatform {
  return !!value && (VALID_PLATFORMS as readonly string[]).includes(value);
}

function getCredentials(): SpanningCredentials | CredentialError | null {
  const platform = process.env.SPANNING_PLATFORM;
  const adminEmail = process.env.SPANNING_ADMIN_EMAIL;
  const apiToken = process.env.SPANNING_API_TOKEN;

  if (!platform && !adminEmail && !apiToken) return null;

  const missing: string[] = [];
  if (!platform) missing.push("SPANNING_PLATFORM");
  if (!adminEmail) missing.push("SPANNING_ADMIN_EMAIL");
  if (!apiToken) missing.push("SPANNING_API_TOKEN");
  if (missing.length > 0) {
    return {
      status: 401,
      body: { error: "Missing credentials", required: missing },
    };
  }
  if (!isValidPlatform(platform)) {
    return {
      status: 400,
      body: {
        error: "Invalid platform",
        message: `SPANNING_PLATFORM must be one of: ${VALID_PLATFORMS.join(", ")}`,
        validValues: VALID_PLATFORMS,
      },
    };
  }
  return { platform, adminEmail: adminEmail!, apiToken: apiToken! };
}

// ---------------------------------------------------------------------------
// Server factory — fresh server per request (stateless HTTP mode)
// ---------------------------------------------------------------------------

function createMcpServer(credentialOverrides?: SpanningCredentials): Server {
  const server = new Server(
    {
      name: "spanning-mcp",
      version: "0.0.0",
    },
    {
      capabilities: {
        tools: {},
        resources: {},
      },
    }
  );

  setServerRef(server);
  registerResourceHandlers(server);

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: TOOL_DEFINITIONS };
  });

  // -------------------------------------------------------------------------
  // Tool call handler — logic lives in tool-handler.ts (testable in
  // isolation; this module boots a real transport at import time via main()
  // below, so it can't be imported directly by a test).
  // -------------------------------------------------------------------------

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const credsOrErr = credentialOverrides ?? getCredentials();
    return handleSpanningTool(name, args, credsOrErr);
  });

  return server;
}

// ---------------------------------------------------------------------------
// Transport: stdio (default)
// ---------------------------------------------------------------------------

async function startStdioTransport(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Spanning Cloud Backup MCP server running on stdio");
}

// ---------------------------------------------------------------------------
// Transport: HTTP (StreamableHTTPServerTransport)
// ---------------------------------------------------------------------------

export async function startHttpTransport(): Promise<HttpServer> {
  const port = parseInt(process.env.MCP_HTTP_PORT || "8080", 10);
  const { secret: s2sSecret } = resolveHttpS2sSecret();
  const host = resolveBindHost(s2sSecret.length > 0);
  const authMode = process.env.AUTH_MODE || "env";
  const isGatewayMode = authMode === "gateway";

  const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    // Health endpoint - no auth required
    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          transport: "http",
          authMode: isGatewayMode ? "gateway" : "env",
          timestamp: new Date().toISOString(),
        })
      );
      return;
    }

    if (url.pathname === "/mcp") {
      // Empty s2sSecret is only reachable when MCP_ALLOW_INSECURE_DEV=1;
      // startup refuses otherwise. A configured secret is always enforced.
      if (s2sSecret && !verifyS2sHeader(headerValue(req.headers[S2S_HEADER]), s2sSecret)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: "Missing or invalid X-Gateway-S2S header: this endpoint only accepts requests signed by the gateway.",
          })
        );
        return;
      }

      if (req.method !== "POST") {
        res.writeHead(405, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32000, message: "Method not allowed" },
            id: null,
          })
        );
        return;
      }

      // In gateway mode, credentials must arrive on every request via headers.
      // Reject explicitly if any are missing. Falling through would resolve
      // SPANNING_* from the process environment, which is not request-scoped.
      let gatewayCredentials: SpanningCredentials | undefined;
      if (isGatewayMode) {
        const platform = headerValue(req.headers["x-spanning-platform"]);
        const adminEmail = headerValue(req.headers["x-spanning-admin-email"]);
        const apiToken = headerValue(req.headers["x-spanning-api-token"]);

        const missing: string[] = [];
        if (!platform) missing.push("X-Spanning-Platform");
        if (!adminEmail) missing.push("X-Spanning-Admin-Email");
        if (!apiToken) missing.push("X-Spanning-API-Token");
        if (missing.length > 0) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: "Missing credentials",
              message: "Gateway mode requires Spanning credential headers.",
              required: missing,
            })
          );
          return;
        }
        if (!isValidPlatform(platform)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: "Invalid platform",
              message: `X-Spanning-Platform must be one of: ${VALID_PLATFORMS.join(", ")}`,
              validValues: VALID_PLATFORMS,
            })
          );
          return;
        }

        gatewayCredentials = {
          platform,
          adminEmail: adminEmail!,
          apiToken: apiToken!,
        };
      }

      // Stateless: fresh server + transport per request
      const server = createMcpServer(gatewayCredentials);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });

      res.on("close", () => {
        transport.close();
        server.close();
      });

      server
        .connect(transport as unknown as Transport)
        .then(() => {
          transport.handleRequest(req, res);
        })
        .catch((err) => {
          console.error("MCP transport error:", err);
          if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                jsonrpc: "2.0",
                error: { code: -32603, message: "Internal error" },
                id: null,
              })
            );
          }
        });

      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found", endpoints: ["/mcp", "/health"] }));
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    httpServer.once("error", onError);
    httpServer.listen(port, host, () => {
      httpServer.removeListener("error", onError);
      console.error(`Spanning Cloud Backup MCP server listening on http://${host}:${port}/mcp`);
      console.error(`Health check available at http://${host}:${port}/health`);
      console.error(
        `Authentication mode: ${isGatewayMode ? "gateway (header-based)" : "env (environment variables)"}`
      );
      resolve();
    });
  });

  return httpServer;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const transportType = process.env.MCP_TRANSPORT || "stdio";

  if (transportType === "http") {
    const httpServer = await startHttpTransport();
    const shutdown = async () => {
      console.error("Shutting down Spanning Cloud Backup MCP server...");
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      });
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  } else {
    const shutdown = async () => {
      console.error("Shutting down Spanning Cloud Backup MCP server...");
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    await startStdioTransport();
  }
}

// Vitest imports this module to call startHttpTransport. Skip the CLI
// entrypoint there. `node dist/index.js` still starts stdio or HTTP.
if (process.env.VITEST !== "true") {
  main().catch((error) => {
    console.error("Fatal startup error:", error);
    process.exit(1);
  });
}
