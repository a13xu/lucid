/**
 * `lucid setup statusline` — install the Claude Code statusline, the /tasks
 * slash command, and register the statusline in ~/.claude/settings.json.
 *
 * The scripts are shipped as templates under scripts/statusline/ with a
 * __LUCID_ROOT__ placeholder. They are not standalone copies of the project
 * logic: they import build/project.js from this installation, so scoping can
 * never drift from the server's own definition.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

export interface StatuslineInstallResult {
  lucidRoot: string;
  claudeDir: string;
  installed: string[];
  settingsPath: string;
  settingsChanged: boolean;
  previousCommand: string | null;
  backupPath: string | null;
  staleFiles: string[];
}

/**
 * Paths are substituted into JavaScript string literals and JSON. Backslashes
 * would be read as escape sequences in both, so every embedded path uses
 * forward slashes — Node accepts them on Windows.
 */
export function toPosixPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "");
}

export function renderTemplate(source: string, vars: Record<string, string>): string {
  let out = source;
  for (const [key, value] of Object.entries(vars)) {
    out = out.split(`__${key}__`).join(value);
  }
  return out;
}

/**
 * Merge the statusLine entry into an existing settings object without touching
 * anything else the user has configured.
 */
export function withStatusLine(
  settings: Record<string, unknown>,
  command: string,
): { settings: Record<string, unknown>; changed: boolean; previous: string | null } {
  const existing = settings["statusLine"] as { type?: string; command?: string } | undefined;
  const previous = existing && typeof existing.command === "string" ? existing.command : null;

  if (previous === command && existing?.type === "command") {
    return { settings, changed: false, previous };
  }

  return {
    settings: { ...settings, statusLine: { type: "command", command } },
    changed: true,
    previous,
  };
}

/** Package root, derived from this module's location inside build/setup/. */
function resolveLucidRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

function readJsonOr(path: string, fallback: Record<string, unknown>): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
  } catch {
    return fallback;
  }
}

export function installStatusline(opts: { claudeDir?: string; lucidRoot?: string } = {}): StatuslineInstallResult {
  const lucidRoot = toPosixPath(opts.lucidRoot ?? resolveLucidRoot());
  const claudeDir = toPosixPath(opts.claudeDir ?? join(homedir(), ".claude"));
  const templateDir = join(lucidRoot, "scripts", "statusline");

  mkdirSync(claudeDir, { recursive: true });
  mkdirSync(join(claudeDir, "commands"), { recursive: true });

  const vars = { LUCID_ROOT: lucidRoot, CLAUDE_DIR: claudeDir };
  const installed: string[] = [];

  for (const name of ["lucid-statusline.mjs", "lucid-tasks.mjs"]) {
    const target = join(claudeDir, name);
    writeFileSync(target, renderTemplate(readFileSync(join(templateDir, name), "utf-8"), vars), "utf-8");
    installed.push(target);
  }

  const commandTarget = join(claudeDir, "commands", "tasks.md");
  writeFileSync(commandTarget, renderTemplate(readFileSync(join(templateDir, "tasks.md"), "utf-8"), vars), "utf-8");
  installed.push(commandTarget);

  // Register the statusline, preserving every other setting.
  const settingsPath = join(claudeDir, "settings.json");
  const command = `node "${claudeDir}/lucid-statusline.mjs"`;
  const current = readJsonOr(settingsPath, {});
  const { settings, changed, previous } = withStatusLine(current, command);

  let backupPath: string | null = null;
  if (changed) {
    // Back up before rewriting: settings.json holds the user's permissions and
    // env, and a bad write here breaks far more than the status bar.
    if (existsSync(settingsPath)) {
      backupPath = `${settingsPath}.bak-${Math.floor(Date.now() / 1000)}`;
      copyFileSync(settingsPath, backupPath);
    }
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
  }

  // Pre-1.24 installs left CJS copies behind; they are no longer referenced.
  const staleFiles = ["lucid-statusline.js", "lucid-tasks.js", "lucid-project.js"]
    .map((f) => join(claudeDir, f))
    .filter((f) => existsSync(f));

  return {
    lucidRoot, claudeDir, installed, settingsPath,
    settingsChanged: changed, previousCommand: previous, backupPath, staleFiles,
  };
}

export function runStatuslineSetup(): number {
  let r: StatuslineInstallResult;
  try {
    r = installStatusline();
  } catch (err) {
    process.stderr.write(`[lucid] statusline setup failed: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  const out = process.stderr;
  out.write(`[lucid] statusline installed from ${r.lucidRoot}\n`);
  for (const f of r.installed) out.write(`  ✓ ${f}\n`);

  if (r.settingsChanged) {
    out.write(`  ✓ statusLine registered in ${r.settingsPath}\n`);
    if (r.previousCommand) out.write(`    previous command: ${r.previousCommand}\n`);
    if (r.backupPath) out.write(`    backup: ${r.backupPath}\n`);
  } else {
    out.write(`  = statusLine already registered — settings.json untouched\n`);
  }

  if (r.staleFiles.length > 0) {
    out.write(`\n  Superseded files from an older install are no longer used:\n`);
    for (const f of r.staleFiles) out.write(`    ${f}\n`);
    out.write(`  Delete them when convenient — they are left in place, not removed automatically.\n`);
  }

  out.write(`\n  Restart Claude Code (or run /statusline) to pick it up.\n`);
  return 0;
}
