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

const LUCID_MARKER = "Lucid: call sync_file";
const LUCID_UPDATE_MARKER = "lucid-update-check";

const LUCID_HOOK: HookEntry = {
  matcher: "Write|Edit|NotebookEdit",
  hooks: [
    {
      type: "command",
      command: `lucid-sync 2>/dev/null || echo '🔄 ${LUCID_MARKER}(path) — install lucid globally: npm i -g @a13xu/lucid'`,
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

  // ── PostToolUse: sync_file reminder ──────────────────────────────────────
  const postToolUse: HookEntry[] = hooks["PostToolUse"] ?? [];
  const syncAlreadyInstalled = postToolUse.some((h) => {
    const cmd = h.command ?? h.hooks?.[0]?.command ?? "";
    return cmd.includes(LUCID_MARKER);
  });
  if (!syncAlreadyInstalled) {
    hooks["PostToolUse"] = [...postToolUse, LUCID_HOOK];
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
    lines.push(`   PostToolUse: reminder to call sync_file() after every Write/Edit`);
    lines.push(`   SessionStart: auto-check for Lucid updates on session start`);
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
  } else if (skillsResult.skipped.length > 0) {
    lines.push(`📚 Skills: already installed (${skillsResult.skipped.length} skill(s))`);
  }

  // ── Global skills (~/.claude/skills/) ────────────────────────────────────
  const globalSkillsResult = installGlobalSkills();
  if (globalSkillsResult.installed.length > 0) {
    lines.push(`🌐 Global skills installed in ~/.claude/skills/:`);
    for (const s of globalSkillsResult.installed) {
      lines.push(`   • /${s} (available in all projects)`);
    }
  } else if (globalSkillsResult.skipped.length > 0) {
    lines.push(`🌐 Global skills: already installed (${globalSkillsResult.skipped.length} skill(s))`);
  }

  // ── CLAUDE.md injection ───────────────────────────────────────────────────
  const injected = injectClaudeMdInstruction(dir);
  if (injected) {
    lines.push(`📋 CLAUDE.md updated with sync_file() instruction`);
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
  skipped: string[];
}

function installSkills(projectDir: string): SkillInstallResult {
  const skillsSource = join(PACKAGE_ROOT, "skills");
  const result: SkillInstallResult = { installed: [], skipped: [] };

  if (!existsSync(skillsSource)) return result;

  const skillDirs = readdirSync(skillsSource, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  for (const skillName of skillDirs) {
    const srcSkillMd = join(skillsSource, skillName, "SKILL.md");
    if (!existsSync(srcSkillMd)) continue;

    const destDir = join(projectDir, ".claude", "skills", skillName);
    const destFile = join(destDir, "SKILL.md");

    if (existsSync(destFile)) {
      result.skipped.push(skillName);
      continue;
    }

    mkdirSync(destDir, { recursive: true });
    writeFileSync(destFile, readFileSync(srcSkillMd, "utf-8"), "utf-8");
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
