import { z } from "zod";
import { resolve, join } from "path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import type { Statements } from "../database.js";
import { indexProject, type IndexResult } from "../indexer/project.js";

export const InitProjectSchema = z.object({
  directory: z.string().optional(),
});

export type InitProjectInput = z.infer<typeof InitProjectSchema>;

// ---------------------------------------------------------------------------
// Instalează PostToolUse hook în .claude/settings.json
// ---------------------------------------------------------------------------

function installHook(dir: string): { installed: boolean; reason: string } {
  const claudeDir = join(dir, ".claude");
  const settingsPath = join(claudeDir, "settings.json");

  const HOOK_CMD =
    'node -e "const p=process.argv[1]; if(p) require(\'child_process\').execSync(\'node \'+require(\'path\').resolve(\'node_modules/.bin/lucid\'||\'\')+\' --noop\', {stdio:\'ignore\'})" "$TOOL_INPUT_PATH" 2>/dev/null || true';

  // Hook mai simplu și portabil: apelează sync_file prin claude mcp
  const HOOK = {
    matcher: "Write|Edit|NotebookEdit",
    command: "echo '{\"tool\":\"sync_file\",\"path\":\"'\"$TOOL_INPUT_PATH\"'\"}' | true",
  };

  // Citim sau cream settings.json
  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
    } catch {
      return { installed: false, reason: "Could not parse .claude/settings.json" };
    }
  }

  // Verifică dacă hook-ul e deja instalat
  const hooks = settings["hooks"] as Record<string, unknown[]> | undefined ?? {};
  const postToolUse = (hooks["PostToolUse"] as Array<{ matcher?: string }> | undefined) ?? [];

  const alreadyInstalled = postToolUse.some(
    (h) => h.matcher?.includes("Write") && String(h).includes("lucid")
  );

  if (alreadyInstalled) {
    return { installed: false, reason: "already installed" };
  }

  // Adaugă hook-ul — notifică Claude să cheme sync_file
  const lucidHook = {
    matcher: "Write|Edit|NotebookEdit",
    command: "echo '🔄 Lucid: call sync_file(path) to keep knowledge graph up to date'",
  };

  hooks["PostToolUse"] = [...postToolUse, lucidHook];
  settings["hooks"] = hooks;

  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");

  return { installed: true, reason: "hook added to .claude/settings.json" };
}

// ---------------------------------------------------------------------------
// Adaugă instrucțiune în CLAUDE.md
// ---------------------------------------------------------------------------

const LUCID_SYNC_INSTRUCTION = `
<!-- LUCID_SYNC -->
## 🔄 Lucid — Auto-sync after file changes

After EVERY Write, Edit, or NotebookEdit tool call, you MUST immediately call:
\`\`\`
sync_file(path="<path of the file you just wrote/edited>")
\`\`\`

This keeps the Lucid knowledge graph up to date with the latest code.
If multiple files changed (refactor, git pull), call sync_project() instead.
<!-- /LUCID_SYNC -->
`;

function injectClaudeMdInstruction(dir: string): boolean {
  const claudeMdPath = join(dir, "CLAUDE.md");
  if (!existsSync(claudeMdPath)) return false;

  const content = readFileSync(claudeMdPath, "utf-8");
  if (content.includes("LUCID_SYNC")) return false; // already injected

  writeFileSync(claudeMdPath, content.trimEnd() + "\n" + LUCID_SYNC_INSTRUCTION, "utf-8");
  return true;
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export function handleInitProject(stmts: Statements, input: InitProjectInput): string {
  const dir = resolve(input.directory ?? process.cwd());
  const results: IndexResult[] = indexProject(dir, stmts);

  const lines: string[] = [`✅ Project indexed: ${dir}`, ``];

  if (results.length === 0) {
    lines.push("No indexable files found.");
    lines.push("Expected: CLAUDE.md, package.json, README.md, src/");
  } else {
    lines.push(`Indexed ${results.length} source(s):`);
    for (const r of results) {
      lines.push(`  • [${r.type}] "${r.entity}" — ${r.observations} observation(s) from ${r.source}`);
    }
  }

  // Instalează hook PostToolUse
  lines.push(``);
  const hookResult = installHook(dir);
  if (hookResult.installed) {
    lines.push(`🔗 Claude Code hook installed (.claude/settings.json)`);
    lines.push(`   After every Write/Edit, you will see a reminder to call sync_file().`);
  } else {
    lines.push(`🔗 Hook: ${hookResult.reason}`);
  }

  // Injectează instrucțiune în CLAUDE.md
  const injected = injectClaudeMdInstruction(dir);
  if (injected) {
    lines.push(`📋 CLAUDE.md updated with sync_file() instruction`);
  }

  lines.push(``);
  lines.push(`From now on, call sync_file(path) after every file you write or edit.`);
  lines.push(`Use recall() to query accumulated project knowledge.`);

  return lines.join("\n");
}
