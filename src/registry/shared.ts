import { z } from "zod";
import type Database from "better-sqlite3";
import type { RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Statements } from "../database.js";
import type { ResolvedConfig } from "../config.js";
import { guardRequest, guardOutput } from "../security/guard.js";

// ---------------------------------------------------------------------------
// Shared context passed to every register*() function
// ---------------------------------------------------------------------------

export interface RegistryCtx {
  db: Database.Database;
  stmts: Statements;
  cfg: ResolvedConfig;
  serverVersion: string;
  qdrantUrl: string | undefined;
  embeddingUrl: string | undefined;
}

/** Tool name → RegisteredTool handle, as returned by each domain module. */
export type ToolMap = Record<string, RegisteredTool>;

// ---------------------------------------------------------------------------
// Shared tool result wrapper: rate-limit + WAF + output secret scan + errors.
// Handler may return a string OR { text, structured }.
// ---------------------------------------------------------------------------

export type ToolReturn = string | { text: string; structured: Record<string, unknown> };

export function tx<I>(name: string, handler: (args: I) => ToolReturn | Promise<ToolReturn>) {
  return async (args: I) => {
    const guard = guardRequest(name, args as Record<string, unknown>);
    if (guard.blocked) {
      return {
        content: [{ type: "text" as const, text: guard.reason ?? "Request blocked by security guard" }],
        isError: true,
      };
    }
    try {
      const out = await handler(args);
      if (typeof out === "string") {
        return { content: [{ type: "text" as const, text: guardOutput(name, out) }] };
      }
      return {
        content: [{ type: "text" as const, text: guardOutput(name, out.text) }],
        structuredContent: out.structured,
      };
    } catch (err) {
      const msg = err instanceof z.ZodError
        ? `Validation error: ${err.errors.map((e) => e.message).join(", ")}`
        : err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
    }
  };
}
