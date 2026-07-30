import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerPrompts(server: McpServer): void {
  server.registerPrompt("validate-changes", {
    title: "Validate recent changes",
    description: "Run the Logic Guardian 5-pass validation across files modified in the last N hours.",
    argsSchema: { hours: z.string().optional() },
  }, ({ hours }) => {
    const h = hours ? Number(hours) : 24;
    return {
      messages: [{
        role: "user",
        content: {
          type: "text",
          text:
            `Run Logic Guardian validation on every file modified in the last ${h} hours.\n\n` +
            `Steps:\n` +
            `1. Call \`get_recent\` with hours=${h} to list changed files.\n` +
            `2. For EACH file, call \`validate_file(path)\` and \`check_code_quality(path)\`.\n` +
            `3. Apply the 5-pass checklist from \`get_checklist\`.\n` +
            `4. Report: per-file findings + a single summary table (file × pass × issue count).\n` +
            `5. Stop and ask before fixing anything — report only.`,
        },
      }],
    };
  });

  server.registerPrompt("audit-file", {
    title: "Audit a single file",
    description: "Run the full Lucid audit pipeline (validate + drift + coding rules + security) on one file.",
    argsSchema: { path: z.string() },
  }, ({ path }) => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text:
          `Audit \`${path}\` with the full Lucid pipeline:\n\n` +
          `1. \`validate_file(path="${path}")\` — Logic Guardian drift detection.\n` +
          `2. \`check_code_quality(path="${path}")\` — 25 Golden Rules.\n` +
          `3. Read the file content, then \`security_scan(code, language, context)\` if it's web code.\n` +
          `4. Apply the 5-pass checklist (\`get_checklist\`).\n` +
          `5. Report findings grouped by severity (high/medium/low). Do not fix yet.`,
      },
    }],
  }));

  server.registerPrompt("plan-feature", {
    title: "Plan a new feature",
    description: "Scaffold a Lucid plan from a feature description with tasks and test criteria.",
    argsSchema: { feature: z.string() },
  }, ({ feature }) => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text:
          `Create a Lucid plan for this feature:\n\n"${feature}"\n\n` +
          `Steps:\n` +
          `1. Call \`smart_context(query="${feature}", task_type="moderate")\` to gather relevant files.\n` +
          `2. Draft a user story: "As a [user], I want [goal], so that [benefit]."\n` +
          `3. Break into 3–8 tasks. EACH task needs explicit \`test_criteria\` (how to verify done).\n` +
          `4. Call \`plan_create({title, description, user_story, tasks})\`.\n` +
          `5. Show the plan ID and the task list.`,
      },
    }],
  }));

  server.registerPrompt("security-review", {
    title: "Security review of recent changes",
    description: "Scan recently changed web code for XSS, injection, secrets, SSRF, and OWASP Top 10 patterns.",
    argsSchema: { hours: z.string().optional() },
  }, ({ hours }) => {
    const h = hours ? Number(hours) : 24;
    return {
      messages: [{
        role: "user",
        content: {
          type: "text",
          text:
            `Security review of files changed in the last ${h} hours.\n\n` +
            `1. Call \`get_recent\` with hours=${h}.\n` +
            `2. Filter to JS/TS/HTML/Vue files only.\n` +
            `3. For each, read content and call \`security_scan(code, language, context)\` ` +
            `with context inferred from the path (frontend/backend/api).\n` +
            `4. Report findings as a table: file × vuln class × severity × line.\n` +
            `5. Recommend fixes only after the report is complete.`,
        },
      }],
    };
  });
}
