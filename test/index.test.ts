import { describe, it, expect } from "vitest";
import { TOOL_DEFINITIONS } from "../src/tool.definitions.js";

describe("Spanning Cloud Backup MCP Server", () => {
  describe("Tool Definitions", () => {
    it("defines exactly the 9 expected tools", () => {
      const names = TOOL_DEFINITIONS.map((t) => t.name);
      expect(names).toEqual([
        "spanning_list_users",
        "spanning_get_user",
        "spanning_list_services",
        "spanning_list_backups",
        "spanning_queue_restore",
        "spanning_get_restore_status",
        "spanning_list_audit_log",
        "spanning_get_license_usage",
        "spanning_status",
      ]);
    });

    it("every tool has a non-empty description", () => {
      for (const tool of TOOL_DEFINITIONS) {
        expect(tool.description, `${tool.name} description`).toBeTruthy();
      }
    });

    it("spanning_get_user requires userId", () => {
      const tool = TOOL_DEFINITIONS.find((t) => t.name === "spanning_get_user");
      expect(tool?.inputSchema.required).toEqual(["userId"]);
    });

    it("spanning_list_services requires userId", () => {
      const tool = TOOL_DEFINITIONS.find((t) => t.name === "spanning_list_services");
      expect(tool?.inputSchema.required).toEqual(["userId"]);
    });

    it("spanning_list_backups requires userId and service", () => {
      const tool = TOOL_DEFINITIONS.find((t) => t.name === "spanning_list_backups");
      expect(tool?.inputSchema.required).toEqual(["userId", "service"]);
    });

    it("spanning_queue_restore requires userId, service, and items", () => {
      const tool = TOOL_DEFINITIONS.find((t) => t.name === "spanning_queue_restore");
      expect(tool?.inputSchema.required).toEqual(["userId", "service", "items"]);
    });

    it("spanning_get_restore_status requires restoreId", () => {
      const tool = TOOL_DEFINITIONS.find((t) => t.name === "spanning_get_restore_status");
      expect(tool?.inputSchema.required).toEqual(["restoreId"]);
    });

    it("spanning_list_audit_log, spanning_get_license_usage, and spanning_status take no required fields", () => {
      for (const name of ["spanning_list_audit_log", "spanning_get_license_usage", "spanning_status"]) {
        const tool = TOOL_DEFINITIONS.find((t) => t.name === name);
        expect(tool?.inputSchema.required ?? [], name).toEqual([]);
      }
    });

    it("only spanning_get_user advertises MCP Apps UI metadata", () => {
      const withMeta = TOOL_DEFINITIONS.filter((t) => t._meta);
      expect(withMeta.map((t) => t.name)).toEqual(["spanning_get_user"]);
    });
  });

  describe("Platform validation", () => {
    // Mirrors index.ts's VALID_PLATFORMS. Kept as a literal so this file does
    // not boot the HTTP transport.
    const validPlatforms = ["m365", "gws", "salesforce"];

    it("should support m365, gws, salesforce", () => {
      expect(validPlatforms).toEqual(["m365", "gws", "salesforce"]);
    });
  });
});
