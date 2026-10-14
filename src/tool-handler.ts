/**
 * Tool-call handling for the Spanning Cloud Backup MCP server.
 *
 * Extracted from index.ts so tool behavior can be unit-tested without the
 * HTTP transport. This module has no side effects — importing it just gives
 * you handleSpanningTool.
 */

import { SpanningClient } from "@wyre-technology/node-spanning";
import { elicitConfirmation, elicitSelection, elicitText } from "./utils/elicitation.js";
import { buildBackupStatusCard } from "./card.builder.js";

export type SpanningPlatform = "m365" | "gws" | "salesforce";

export interface SpanningCredentials {
  platform: SpanningPlatform;
  adminEmail: string;
  apiToken: string;
}

export interface CredentialError {
  status: number;
  body: Record<string, unknown>;
}

export interface ToolResult {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

function createClient(creds: SpanningCredentials): SpanningClient {
  return new SpanningClient({
    platform: creds.platform,
    adminEmail: creds.adminEmail,
    apiToken: creds.apiToken,
  });
}

// ---------------------------------------------------------------------------
// spanning_list_audit_log helpers
// ---------------------------------------------------------------------------

const DATE_FILTER_PAGE_CAP = 2000;

interface DateRangeMs {
  sinceMs?: number;
  untilMs?: number;
}

function normalizeTs(raw: number): number {
  return raw < 1e12 ? raw * 1000 : raw;
}

export function filterByDate<T extends { createdAt?: number | string; timestamp?: number | string }>(
  items: T[],
  range: DateRangeMs
): T[] {
  const sinceMs = range.sinceMs ?? -Infinity;
  const untilMs = range.untilMs ?? Infinity;
  const out: T[] = [];
  for (const item of items) {
    const raw = item.createdAt ?? item.timestamp;
    if (raw != null) {
      const numeric = typeof raw === "string" ? Date.parse(raw) : normalizeTs(raw);
      if (!Number.isNaN(numeric) && (numeric < sinceMs || numeric > untilMs)) continue;
    }
    out.push(item);
    if (out.length >= DATE_FILTER_PAGE_CAP) break;
  }
  return out;
}

export async function resolveDateRange(
  args: { since?: string; until?: string }
): Promise<DateRangeMs> {
  if (args.since || args.until) {
    return {
      sinceMs: args.since ? new Date(args.since).getTime() : undefined,
      untilMs: args.until ? new Date(args.until).getTime() : undefined,
    };
  }

  const choice = await elicitSelection(
    "No date range provided. This query can return many results. Choose a window:",
    "range",
    [
      { value: "24h", label: "Last 24 hours" },
      { value: "7d", label: "Last 7 days" },
      { value: "30d", label: "Last 30 days" },
      { value: "custom", label: "Enter custom ISO 8601 dates" },
      { value: "all", label: "No filter (return everything)" },
    ]
  );

  const nowMs = Date.now();
  const PRESET_WINDOWS_MS: Record<string, number> = {
    "24h": 24 * 60 * 60 * 1000,
    "7d": 7 * 24 * 60 * 60 * 1000,
    "30d": 30 * 24 * 60 * 60 * 1000,
  };
  if (!choice || choice === "all") return {};
  if (choice in PRESET_WINDOWS_MS) {
    return { sinceMs: nowMs - PRESET_WINDOWS_MS[choice] };
  }
  if (choice === "custom") {
    const since = await elicitText(
      "Enter the start datetime in ISO 8601 format (e.g. 2025-04-01T00:00:00Z).",
      "since",
      "Start datetime"
    );
    const until = await elicitText(
      "Enter the end datetime in ISO 8601 format (leave blank for now).",
      "until",
      "End datetime"
    );
    return {
      sinceMs: since ? new Date(since).getTime() : undefined,
      untilMs: until ? new Date(until).getTime() : undefined,
    };
  }
  return {};
}

function isNotImplemented(error: unknown): boolean {
  if (!error) return false;
  const name = (error as { name?: string }).name ?? "";
  const message = error instanceof Error ? error.message : String(error);
  return (
    name === "NotImplementedError" ||
    /not[\s_-]?implemented/i.test(message)
  );
}

// ---------------------------------------------------------------------------
// Tool call handler
// ---------------------------------------------------------------------------

export async function handleSpanningTool(
  name: string,
  args: Record<string, unknown> | undefined,
  credsOrErr: SpanningCredentials | CredentialError | null
): Promise<ToolResult> {
  if (!credsOrErr) {
    return {
      content: [
        {
          type: "text",
          text:
            "Error: No Spanning credentials provided. Please set SPANNING_PLATFORM, SPANNING_ADMIN_EMAIL, and SPANNING_API_TOKEN environment variables, or pass them as gateway headers.",
        },
      ],
      isError: true,
    };
  }

  if ("status" in credsOrErr) {
    return {
      content: [{ type: "text", text: `Error: ${JSON.stringify(credsOrErr.body)}` }],
      isError: true,
    };
  }

  const creds = credsOrErr;

  // spanning_status doesn't require an API call
  if (name === "spanning_status") {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              status: "ok",
              server: "spanning-mcp",
              version: "0.0.0",
              platform: creds.platform,
              adminEmail: creds.adminEmail,
              timestamp: new Date().toISOString(),
            },
            null,
            2
          ),
        },
      ],
    };
  }

  const client = createClient(creds);

  try {
    switch (name) {
      case "spanning_list_users": {
        const params = (args ?? {}) as { limit?: number };
        const result = await client.users.list({ limit: params.limit ?? 100 });
        return { content: [{ type: "text", text: JSON.stringify(result ?? [], null, 2) }] };
      }

      case "spanning_get_user": {
        const { userId } = args as { userId: string };
        const user = await client.users.get(userId);
        const payload: Record<string, unknown> = { ...(user ?? {}) };
        // MCP Apps: attach the normalized card payload the ui:// backup
        // status card renders from. Best-effort — a null card just means no
        // UI surface; the model-visible payload is otherwise unchanged.
        const card = await buildBackupStatusCard(payload, creds.platform, client);
        if (card) payload._card = card;
        return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
      }

      case "spanning_list_services": {
        const { userId } = args as { userId: string };
        const services = await client.services.list(userId);
        return { content: [{ type: "text", text: JSON.stringify(services ?? [], null, 2) }] };
      }

      case "spanning_list_backups": {
        const { userId, service } = args as { userId: string; service: string };
        const backups = await client.backups.list(userId, service);
        return { content: [{ type: "text", text: JSON.stringify(backups ?? [], null, 2) }] };
      }

      case "spanning_queue_restore": {
        const { userId, service, items } = args as {
          userId: string;
          service: string;
          items: string[];
        };
        const confirmed = await elicitConfirmation(
          `About to QUEUE A RESTORE for user ${userId} (service: ${service}, ${items.length} item(s)).\n\n` +
            "This writes data back into the target M365 / Google Workspace / Salesforce tenant. " +
            "The destination account must have appropriate Microsoft Graph / Google API / Salesforce " +
            "permissions for the restore to land successfully.\n\nProceed?"
        );
        if (confirmed !== true) {
          return {
            content: [
              {
                type: "text",
                text:
                  confirmed === null
                    ? "Restore cancelled: client does not support confirmation prompts. Pass an explicit confirm flag from a different client to proceed."
                    : "Restore cancelled by user.",
              },
            ],
            isError: true,
          };
        }
        const restore = await client.restores.queue(userId, service, { items });
        return { content: [{ type: "text", text: JSON.stringify(restore ?? {}, null, 2) }] };
      }

      case "spanning_get_restore_status": {
        const { restoreId } = args as { restoreId: string };
        const status = await client.restores.get(restoreId);
        return { content: [{ type: "text", text: JSON.stringify(status ?? {}, null, 2) }] };
      }

      case "spanning_list_audit_log": {
        const params = (args ?? {}) as { since?: string; until?: string };
        const range = await resolveDateRange(params);
        // SDK uses from/to (matches Spanning's documented field names),
        // not since/until.
        const audit = await client.audit.list({
          from: range.sinceMs ? new Date(range.sinceMs).toISOString() : undefined,
          to: range.untilMs ? new Date(range.untilMs).toISOString() : undefined,
        });
        const list: Array<{ createdAt?: number | string; timestamp?: number | string }> =
          Array.isArray((audit as { items?: unknown }).items)
            ? ((audit as { items: Array<{ createdAt?: number | string; timestamp?: number | string }> }).items)
            : (Array.isArray(audit)
                ? (audit as Array<{ createdAt?: number | string; timestamp?: number | string }>)
                : []);
        const filtered = filterByDate(list, range);
        return { content: [{ type: "text", text: JSON.stringify(filtered, null, 2) }] };
      }

      case "spanning_get_license_usage": {
        const license = await client.license.get();
        return { content: [{ type: "text", text: JSON.stringify(license ?? {}, null, 2) }] };
      }

      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isNotImplemented(error)) {
      return {
        content: [
          {
            type: "text",
            text: `Not implemented for platform '${creds.platform}': ${message}`,
          },
        ],
        isError: true,
      };
    }
    return {
      content: [{ type: "text", text: `Error: ${message}` }],
      isError: true,
    };
  }
}
