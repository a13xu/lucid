import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { tx, type ToolMap } from "./shared.js";

// ---------------------------------------------------------------------------
// Dynamic toolsets — 47 always-visible tools cost ~5k tokens of tool schemas
// per conversation turn. Non-core domains are registered but DISABLED at boot;
// the single `lucid_toolsets` tool re-enables them on demand (the SDK emits
// notifications/tools/list_changed automatically on enable()/disable()).
// ---------------------------------------------------------------------------

/** Domains hidden at boot unless overridden via config/env. */
export const DEFAULT_DISABLED_DOMAINS = ["webdev", "book", "local"];

const ToolsetsSchema = z.object({
  enable: z.array(z.string()).optional()
    .describe("Domain names to enable (e.g. [\"webdev\"]). Omit to just list domains."),
  disable: z.array(z.string()).optional()
    .describe("Domain names to disable to reduce token overhead."),
});

/**
 * Resolve which domains start disabled.
 * Priority: LUCID_TOOLSETS_DISABLED env ("none" = all enabled) > config > default.
 */
export function resolveDisabledDomains(
  cfgDisabled: string[] | undefined,
  validDomains: string[],
): string[] {
  const env = process.env["LUCID_TOOLSETS_DISABLED"];
  const raw = env !== undefined
    ? (env.trim().toLowerCase() === "none" ? [] : env.split(",").map((s) => s.trim()).filter(Boolean))
    : cfgDisabled ?? DEFAULT_DISABLED_DOMAINS;
  return raw.filter((d) => validDomains.includes(d));
}

export function setupToolsets(
  server: McpServer,
  domains: Record<string, ToolMap>,
  disabledAtBoot: string[],
): void {
  const domainNames = Object.keys(domains);

  for (const d of disabledAtBoot) {
    for (const tool of Object.values(domains[d]!)) tool.disable();
  }

  const summary = (): string => {
    const lines: string[] = ["Toolset domains:"];
    for (const [name, tools] of Object.entries(domains)) {
      const all = Object.values(tools);
      const enabled = all.filter((t) => t.enabled).length;
      const state = enabled === 0 ? "disabled" : enabled === all.length ? "enabled" : "partial";
      lines.push(`  ${state === "disabled" ? "○" : "●"} ${name} — ${state} (${enabled}/${all.length} tools: ${Object.keys(tools).join(", ")})`);
    }
    lines.push("", "Use lucid_toolsets({enable:[\"<domain>\"]}) to activate a domain for this session.");
    return lines.join("\n");
  };

  server.registerTool("lucid_toolsets", {
    title: "Lucid Toolsets",
    description:
      "List, enable, or disable Lucid tool domains. Non-core domains " +
      `(${DEFAULT_DISABLED_DOMAINS.join(", ")}) start disabled to save tokens — enable one ` +
      "when its tools are needed (e.g. enable [\"webdev\"] before generate_component). " +
      "Changes emit tools/list_changed so the client refreshes its tool list.",
    inputSchema: ToolsetsSchema.shape,
  }, tx("lucid_toolsets", (args: z.infer<typeof ToolsetsSchema>) => {
    const unknown = [...(args.enable ?? []), ...(args.disable ?? [])]
      .filter((d) => !domainNames.includes(d));
    if (unknown.length > 0) {
      throw new Error(`Unknown domain(s): ${unknown.join(", ")}. Valid: ${domainNames.join(", ")}`);
    }
    for (const d of args.enable ?? []) {
      for (const tool of Object.values(domains[d]!)) tool.enable();
    }
    for (const d of args.disable ?? []) {
      for (const tool of Object.values(domains[d]!)) tool.disable();
    }
    return summary();
  }));
}
