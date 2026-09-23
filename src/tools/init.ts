import { z } from "zod";
import { resolve, join, basename } from "path";
import { homedir } from "os";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import type { Statements } from "../database.js";
import { indexProject, type IndexResult } from "../indexer/project.js";
import {
  saveAdminConfig,
  loadAdminConfig,
  isAdminConfigured,
  sendTestAlert,
} from "../security/alerts.js";
import { isConfigured as isLocalLlmConfigured, loadLocalConfig } from "../local-llm/config.js";
import { describeRuntime } from "../local-llm/runtimes.js";

export const InitProjectSchema = z.object({
  directory: z.string().optional(),

  // ── Admin alert configuration (asked once at project init) ──────────────
  /** Display name of the security admin */
  adminName: z.string().optional(),
  /** Email address to send security alerts to */
  adminEmail: z.string().email().optional(),
  /** SMTP server hostname (e.g. smtp.gmail.com) */
  smtpHost: z.string().optional(),
  /** SMTP port: 587 (STARTTLS, default) or 465 (direct TLS) */
  smtpPort: z.number().int().min(1).max(65535).optional(),
  /** SMTP login username (often same as adminEmail) */
  smtpUser: z.string().optional(),
  /** "From" display name + address (e.g. "Lucid Security <alerts@co.com>") */
  smtpFrom: z.string().optional(),
  /** Generic HTTP webhook URL (receives JSON POST, HMAC-signed if LUCID_WEBHOOK_SECRET is set) */
  webhookUrl: z.string().url().optional(),
  /** Slack incoming webhook URL */
  slackWebhookUrl: z.string().url().optional(),
  /** Which severities trigger an alert: default ["critical","high"] */
  alertOn: z.array(z.enum(["critical", "high", "medium", "low"])).optional(),
  /** Human-readable project name shown in alerts */
  projectName: z.string().optional(),
});

export type InitProjectInput = z.infer<typeof InitProjectSchema>;

// ---------------------------------------------------------------------------
// Instalează PostToolUse hook în .claude/settings.json
// ---------------------------------------------------------------------------

// Hook format (Claude Code latest): matcher is a regex string, hooks is an array
// { "matcher": "Write|Edit|NotebookEdit", "hooks": [{ "type": "command", "command": "..." }] }
interface HookEntry {
  matcher?: string;
  hooks?: Array<{ type: string; command: string }>;
  // old format (for detection only)
  command?: string;
}

// Old installs carried an `|| echo 'Lucid: call sync_file…'` fallback; the echo was
// dead weight (PostToolUse stdout on exit 0 never reaches the model), but its text
// still identifies those installs, so both markers count as "already installed".
const LUCID_MARKER = "lucid-sync-hook";
const LUCID_LEGACY_MARKER = "Lucid: call sync_file";
const LUCID_UPDATE_MARKER = "lucid-update-check";
const LUCID_GUARD_MARKER = "lucid-guard-pre-edit";
const LUCID_SESSION_TICK_MARKER = "lucid-session-tick";
const LUCID_SESSION_COMPACT_MARKER = "lucid-session-compact";

const LUCID_HOOK: HookEntry = {
  matcher: "Write|Edit|NotebookEdit",
  hooks: [
    {
      type: "command",
      command: `lucid-sync # ${LUCID_MARKER}`,
    },
  ],
};

// PreToolUse hook: snapshot file + block destructive truncates BEFORE write.
// Reads Claude Code's PreToolUse JSON from stdin; exit 2 hard-blocks the tool.
// Marker token included so we can idempotently detect prior installs.
// No MultiEdit here: the tool was folded into Edit and no longer exists in
// current Claude Code, so the alternative only added a dead branch to the regex.
const LUCID_PRE_EDIT_HOOK: HookEntry = {
  matcher: "Write|Edit|NotebookEdit",
  hooks: [
    {
      type: "command",
      command: `lucid guard pre-edit # ${LUCID_GUARD_MARKER}`,
    },
  ],
};

// UserPromptSubmit hook: track session length → emit /compact and /clear hints.
// stdout from this hook is injected into Claude's context for the upcoming turn.
const LUCID_SESSION_TICK_HOOK = {
  hooks: [
    {
      type: "command",
      command: `lucid session tick # ${LUCID_SESSION_TICK_MARKER}`,
    },
  ],
};

// PreCompact hook: reset per-session counters when /compact runs so the next
// hint cycle starts from a clean baseline.
const LUCID_PRE_COMPACT_HOOK = {
  hooks: [
    {
      type: "command",
      command: `lucid session compact # ${LUCID_SESSION_COMPACT_MARKER}`,
    },
  ],
};

// SessionStart hook: checks npm registry and notifies if update is available.
// Uses only Node.js built-in https module — no external dependencies required.
const LUCID_UPDATE_HOOK = {
  hooks: [
    {
      type: "command",
      command:
        `node -e "const h=require('https');` +
        `h.get('https://registry.npmjs.org/@a13xu/lucid/latest',` +
        `function(r){var d='';r.on('data',function(c){d+=c});` +
        `r.on('end',function(){` +
        `try{var v=JSON.parse(d).version;` +
        `var s=require('child_process').execSync(` +
        `'npm list -g @a13xu/lucid --depth=0 2>/dev/null',{encoding:'utf8'});` +
        `var m=s.match(/lucid@([\\d.]+)/);` +
        `if(m&&m[1]&&v!==m[1])` +
        `console.log('[Lucid] Update available: v'+m[1]+' → v'+v+'. Call update_lucid().')}` +
        `catch(e){}})}).on('error',function(){})" 2>/dev/null || true`,
    },
  ],
};

function installHooks(dir: string): { installed: boolean; reason: string } {
  const claudeDir = join(dir, ".claude");
  const settingsPath = join(claudeDir, "settings.json");

  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
    } catch {
      return { installed: false, reason: "Could not parse .claude/settings.json" };
    }
  }

  const hooks = (settings["hooks"] ?? {}) as Record<string, HookEntry[]>;
  let changed = false;

  // ── PostToolUse: lucid-sync indexes each edited file ─────────────────────
  const postToolUse: HookEntry[] = hooks["PostToolUse"] ?? [];
  const syncAlreadyInstalled = postToolUse.some((h) => {
    const cmd = h.command ?? h.hooks?.[0]?.command ?? "";
    return cmd.includes(LUCID_MARKER) || cmd.includes(LUCID_LEGACY_MARKER);
  });
  if (!syncAlreadyInstalled) {
    hooks["PostToolUse"] = [...postToolUse, LUCID_HOOK];
    changed = true;
  }

  // ── PreToolUse: backup + truncate guard ──────────────────────────────────
  const preToolUse: HookEntry[] = hooks["PreToolUse"] ?? [];
  const guardAlreadyInstalled = preToolUse.some((h) => {
    const cmd = h.command ?? h.hooks?.[0]?.command ?? "";
    return cmd.includes(LUCID_GUARD_MARKER);
  });
  if (!guardAlreadyInstalled) {
    hooks["PreToolUse"] = [...preToolUse, LUCID_PRE_EDIT_HOOK];
    changed = true;
  }

  // ── UserPromptSubmit: session-cost hints (/compact, /clear) ──────────────
  const userPromptSubmit: HookEntry[] = hooks["UserPromptSubmit"] ?? [];
  const sessionTickInstalled = userPromptSubmit.some((h) => {
    const cmd = h.command ?? h.hooks?.[0]?.command ?? "";
    return cmd.includes(LUCID_SESSION_TICK_MARKER);
  });
  if (!sessionTickInstalled) {
    hooks["UserPromptSubmit"] = [...userPromptSubmit, LUCID_SESSION_TICK_HOOK];
    changed = true;
  }

  // ── PreCompact: reset counters when /compact fires ────────────────────────
  const preCompact: HookEntry[] = hooks["PreCompact"] ?? [];
  const preCompactInstalled = preCompact.some((h) => {
    const cmd = h.command ?? h.hooks?.[0]?.command ?? "";
    return cmd.includes(LUCID_SESSION_COMPACT_MARKER);
  });
  if (!preCompactInstalled) {
    hooks["PreCompact"] = [...preCompact, LUCID_PRE_COMPACT_HOOK];
    changed = true;
  }

  // ── SessionStart: version check ───────────────────────────────────────────
  const sessionStart: HookEntry[] = hooks["SessionStart"] ?? [];
  const updateAlreadyInstalled = sessionStart.some((h) => {
    const cmd = h.command ?? h.hooks?.[0]?.command ?? "";
    return cmd.includes(LUCID_UPDATE_MARKER);
  });
  if (!updateAlreadyInstalled) {
    hooks["SessionStart"] = [...sessionStart, LUCID_UPDATE_HOOK];
    changed = true;
  }

  if (!changed) {
    return { installed: false, reason: "already installed" };
  }

  settings["hooks"] = hooks;
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");

  return { installed: true, reason: "hooks added to .claude/settings.json" };
}

// ---------------------------------------------------------------------------
// Adaugă instrucțiune în CLAUDE.md
// ---------------------------------------------------------------------------

// Read by current Claude models on every session, which follow instructions
// literally: plain language, the reason next to each rule, and nothing a hook
// already does deterministically (the old "you MUST call sync_file" line cost a
// tool call per edit that lucid-sync was already making).
const LUCID_BLOCK_START = "<!-- LUCID_SYNC -->";
const LUCID_BLOCK_END = "<!-- /LUCID_SYNC -->";

const LUCID_SYNC_INSTRUCTION = `
${LUCID_BLOCK_START}
## Lucid

**Index sync.** Edits made with Write/Edit/NotebookEdit are synced into Lucid's index
automatically by the \`lucid-sync\` PostToolUse hook. Changes made any other way —
\`git pull\`, codegen, edits through Bash — are not; call \`sync_project()\` after those.

**Backup and truncate guard.** A PreToolUse hook (\`lucid guard pre-edit\`) snapshots each
file before Write/Edit/NotebookEdit (last 10 versions kept) and blocks destructive
truncates: an empty or whitespace-only overwrite, a shrink of more than 70%, or two
truncate attempts within 60 s. \`restore_file(path, version=1, dry_run=true)\` previews
a restore; \`backup_file(path)\` snapshots by hand before a risky refactor. If a block is
wrong — you really do mean to empty the file — set \`LUCID_TRUNCATE_OVERRIDE=1\` for that
one invocation, or run \`lucid guard clear\` to release a cascade lock. Leave the hook
installed: it is the only thing between an autonomous loop and a wiped file.

**Session-cost hints.** A UserPromptSubmit hook (\`lucid session tick\`) notes when the
prompt cache has likely expired after an idle gap (and, if enabled, suggests \`/compact\`
or \`/clear\` as a session grows). Only the user can run those commands, so pass a hint on
when it is relevant and let them decide.
${LUCID_BLOCK_END}
`;

function normalizeEol(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

/**
 * Appends the Lucid block to the project's CLAUDE.md, or refreshes it in place
 * when an older version is present, so wording fixes reach projects that ran
 * init_project before them. Text outside the markers is never touched.
 */
export function injectClaudeMdInstruction(dir: string): "injected" | "updated" | null {
  const claudeMdPath = join(dir, "CLAUDE.md");
  if (!existsSync(claudeMdPath)) return null;

  const content = readFileSync(claudeMdPath, "utf-8");
  const start = content.indexOf(LUCID_BLOCK_START);
  if (start === -1) {
    writeFileSync(claudeMdPath, content.trimEnd() + "\n" + LUCID_SYNC_INSTRUCTION, "utf-8");
    return "injected";
  }

  const endMarker = content.indexOf(LUCID_BLOCK_END, start);
  if (endMarker === -1) return null; // unterminated block — leave a hand-edited file alone

  const end = endMarker + LUCID_BLOCK_END.length;
  const block = LUCID_SYNC_INSTRUCTION.trim();
  // Compare modulo CRLF: an editor that rewrote line endings hasn't changed the text.
  if (normalizeEol(content.slice(start, end)) === block) return null; // already current

  writeFileSync(claudeMdPath, content.slice(0, start) + block + content.slice(end), "utf-8");
  return "updated";
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export async function handleInitProject(stmts: Statements, input: InitProjectInput): Promise<string> {
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

  // ── Hook PostToolUse ──────────────────────────────────────────────────────
  lines.push(``);
  const hookResult = installHooks(dir);
  if (hookResult.installed) {
    lines.push(`🔗 Claude Code hooks installed (.claude/settings.json)`);
    lines.push(`   PreToolUse:       backup + truncate guard before every Write/Edit/NotebookEdit`);
    lines.push(`   PostToolUse:      lucid-sync indexes each file after Write/Edit/NotebookEdit`);
    lines.push(`   UserPromptSubmit: session-cost hints (cache-cold after idle; /compact, /clear opt-in)`);
    lines.push(`   PreCompact:       reset session counters when /compact fires`);
    lines.push(`   SessionStart:     auto-check for Lucid updates on session start`);
  } else {
    lines.push(`🔗 Hooks: ${hookResult.reason}`);
  }

  // ── Skills ────────────────────────────────────────────────────────────────
  const skillsResult = installSkills(dir);
  if (skillsResult.installed.length > 0) {
    lines.push(`📚 Skills installed in .claude/skills/:`);
    for (const s of skillsResult.installed) {
      lines.push(`   • /${s}`);
    }
    lines.push(`   Invoke with /<skill-name> in Claude Code.`);
  }
  if (skillsResult.updated.length > 0) {
    lines.push(`📚 Skills updated (previous copy kept as SKILL.md.bak): ${skillsResult.updated.map((s) => "/" + s).join(", ")}`);
  }
  if (skillsResult.installed.length === 0 && skillsResult.updated.length === 0 && skillsResult.skipped.length > 0) {
    lines.push(`📚 Skills: already installed (${skillsResult.skipped.length} skill(s))`);
  }

  // ── Global skills (~/.claude/skills/) ────────────────────────────────────
  const globalSkillsResult = installGlobalSkills();
  if (globalSkillsResult.installed.length > 0) {
    lines.push(`🌐 Global skills installed in ~/.claude/skills/:`);
    for (const s of globalSkillsResult.installed) {
      lines.push(`   • /${s} (available in all projects)`);
    }
  }
  if (globalSkillsResult.updated.length > 0) {
    lines.push(`🌐 Global skills updated (previous copy kept as SKILL.md.bak): ${globalSkillsResult.updated.map((s) => "/" + s).join(", ")}`);
  }
  if (globalSkillsResult.installed.length === 0 && globalSkillsResult.updated.length === 0 && globalSkillsResult.skipped.length > 0) {
    lines.push(`🌐 Global skills: already installed (${globalSkillsResult.skipped.length} skill(s))`);
  }

  // ── CLAUDE.md injection ───────────────────────────────────────────────────
  const injected = injectClaudeMdInstruction(dir);
  if (injected === "injected") {
    lines.push(`📋 CLAUDE.md: Lucid section added`);
  } else if (injected === "updated") {
    lines.push(`📋 CLAUDE.md: Lucid section refreshed to the current version`);
  }

  // ── Security admin configuration ──────────────────────────────────────────
  lines.push(``);
  lines.push(`🔒 Security Alerts`);

  // Save any admin params provided in this call
  const adminFields = {
    adminName:       input.adminName,
    adminEmail:      input.adminEmail,
    smtpHost:        input.smtpHost,
    smtpPort:        input.smtpPort,
    smtpUser:        input.smtpUser,
    smtpFrom:        input.smtpFrom,
    webhookUrl:      input.webhookUrl,
    slackWebhookUrl: input.slackWebhookUrl,
    alertOn:         input.alertOn,
    projectName:     input.projectName ?? results.find((r) => r.type === "project")?.entity,
  };

  const hasNewAdmin = Object.values(adminFields).some((v) => v !== undefined);
  if (hasNewAdmin) {
    // Strip undefined values before saving
    const clean = Object.fromEntries(
      Object.entries(adminFields).filter(([, v]) => v !== undefined)
    );
    saveAdminConfig(dir, clean);
    lines.push(`   Saved admin config → .claude/lucid-admin.json`);

    // Test alert channels
    const testResults = await sendTestAlert(dir);
    lines.push(`   Test alert results:`);
    for (const r of testResults) lines.push(`     ${r}`);
  } else {
    // Check existing config
    const existing = loadAdminConfig(dir);
    if (isAdminConfigured()) {
      lines.push(`   Admin: ${existing.adminName ?? existing.adminEmail ?? "configured"}`);
      lines.push(`   Channels: ${buildChannelSummary(existing)}`);
      lines.push(`   Alerting on: ${(existing.alertOn ?? ["critical", "high"]).join(", ")}`);
    } else {
      // Not configured — prompt user
      lines.push(``);
      lines.push(`   ⚠️  No security admin configured. Security alerts will only appear in logs.`);
      lines.push(``);
      lines.push(`   To enable alerts, re-run init_project() with admin parameters:`);
      lines.push(``);
      lines.push(`   Minimal (webhook only):`);
      lines.push(`     init_project(`);
      lines.push(`       adminName="Your Name",`);
      lines.push(`       adminEmail="admin@yourcompany.com",`);
      lines.push(`       webhookUrl="https://hooks.yourservice.com/...",`);
      lines.push(`     )`);
      lines.push(``);
      lines.push(`   With Slack:`);
      lines.push(`     init_project(`);
      lines.push(`       adminName="Your Name",`);
      lines.push(`       adminEmail="admin@yourcompany.com",`);
      lines.push(`       slackWebhookUrl="https://hooks.slack.com/services/...",`);
      lines.push(`     )`);
      lines.push(``);
      lines.push(`   With Email (SMTP):`);
      lines.push(`     init_project(`);
      lines.push(`       adminName="Your Name",`);
      lines.push(`       adminEmail="admin@yourcompany.com",`);
      lines.push(`       smtpHost="smtp.gmail.com",`);
      lines.push(`       smtpPort=587,`);
      lines.push(`       smtpUser="alerts@yourcompany.com",`);
      lines.push(`     )`);
      lines.push(`     # Then set in your environment:`);
      lines.push(`     export LUCID_SMTP_PASS="your-app-password"`);
      lines.push(``);
      lines.push(`   SMTP password must be in LUCID_SMTP_PASS env var (never as a parameter).`);
      lines.push(`   Webhook HMAC signing: set LUCID_WEBHOOK_SECRET env var.`);
    }
  }

  // ── Local LLM nudge ───────────────────────────────────────────────────────
  lines.push(``);
  lines.push(`🤖 Local LLM (delegate_local)`);
  if (isLocalLlmConfigured()) {
    const cfg = loadLocalConfig()!;
    lines.push(`   Configured: ${cfg.model} via ${describeRuntime(cfg.runtime)} @ ${cfg.endpoint}`);
  } else {
    lines.push(`   Not configured. To enable delegation of small specialized tasks to a local`);
    lines.push(`   coder LLM (Ollama / LM Studio / llama.cpp / remote endpoint), run in your terminal:`);
    lines.push(``);
    lines.push(`     lucid local init`);
    lines.push(``);
    lines.push(`   It walks you through runtime detection, model selection, and a reachability test.`);
    lines.push(`   Config is saved globally to ~/.lucid/local.json (one setup → all projects).`);
  }

  lines.push(``);
  lines.push(`From now on, call sync_file(path) after every file you write or edit.`);
  lines.push(`Use recall() to query accumulated project knowledge.`);

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Instalează Lucid skills în .claude/skills/ al proiectului
// ---------------------------------------------------------------------------

const PACKAGE_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "../..");

interface SkillInstallResult {
  installed: string[];
  updated: string[];
  skipped: string[];
}

export function installSkills(projectDir: string): SkillInstallResult {
  const skillsSource = join(PACKAGE_ROOT, "skills");
  const result: SkillInstallResult = { installed: [], updated: [], skipped: [] };

  if (!existsSync(skillsSource)) return result;

  const skillDirs = readdirSync(skillsSource, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  for (const skillName of skillDirs) {
    const srcSkillMd = join(skillsSource, skillName, "SKILL.md");
    if (!existsSync(srcSkillMd)) continue;

    const destDir = join(projectDir, ".claude", "skills", skillName);
    const destFile = join(destDir, "SKILL.md");

    const shipped = readFileSync(srcSkillMd, "utf-8");

    // An installed copy that differs from the shipped one is refreshed, or skill
    // fixes would never reach anyone who installed an earlier version. The old
    // copy is kept as SKILL.md.bak so local edits are recoverable.
    if (existsSync(destFile)) {
      const current = readFileSync(destFile, "utf-8");
      if (normalizeEol(current) === normalizeEol(shipped)) {
        result.skipped.push(skillName);
        continue;
      }
      writeFileSync(destFile + ".bak", current, "utf-8");
      writeFileSync(destFile, shipped, "utf-8");
      result.updated.push(skillName);
      continue;
    }

    mkdirSync(destDir, { recursive: true });
    writeFileSync(destFile, shipped, "utf-8");
    result.installed.push(skillName);
  }

  return result;
}

function installGlobalSkills(): SkillInstallResult {
  return installSkills(homedir());
}

function buildChannelSummary(cfg: import("../security/alerts.js").AdminConfig): string {
  const channels: string[] = [];
  if (cfg.adminEmail && cfg.smtpHost) channels.push(`email(${cfg.adminEmail})`);
  if (cfg.webhookUrl) channels.push(`webhook`);
  if (cfg.slackWebhookUrl) channels.push(`slack`);
  return channels.length > 0 ? channels.join(", ") : "none";
}
