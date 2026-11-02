/**
 * `lucid setup egm` — install the vendored Elephant-Goldfish Model into
 * ~/.claude without the Claude Code plugin system.
 *
 * vendor/egm/ stays byte-identical to upstream. EGM is written for a plugin
 * host, which substitutes ${CLAUDE_PLUGIN_ROOT} and namespaces agent types, so
 * those two things are done here, on the installed copy. Canonical personas
 * live under ~/.claude/egm/ rather than ~/.claude/agents/: Claude Code would
 * load them as agents there, losing the read-only tool lists on the adapters.
 */

import { spawnSync } from "child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";

import { resolveLucidRoot, toPosixPath } from "./statusline.js";

/** First Claude Code version whose subagents honor `omitClaudeMd` (per EGM's docs/claude.md). */
export const MIN_CLAUDE_CODE_VERSION: [number, number, number] = [2, 1, 271];

const MODIFIED_NOTICE =
  "\n<!-- Modified from upstream EGM by `lucid setup egm`: plugin paths and agent names rewritten for a non-plugin install. -->\n";

export interface EgmPaths {
  /** Personas, standards, and guides. */
  root: string;
  skillsDir: string;
  agentsDir: string;
}

export interface EgmInstallResult extends EgmPaths {
  installed: string[];
  updated: string[];
  skipped: string[];
  /** Read rules for the installed files; EGM leaves approval to the user, so they are printed, not applied. */
  readRules: string[];
  pluginAlsoInstalled: boolean;
}

/** Rewrite plugin-only references. Text outside these three forms is left exactly as upstream wrote it. */
export function rewriteForInstall(text: string, paths: EgmPaths): string {
  return text
    // Before the bare root: skills are installed outside it, where Claude Code discovers them.
    .split("${CLAUDE_PLUGIN_ROOT}/skills").join(paths.skillsDir)
    .split("${CLAUDE_PLUGIN_ROOT}").join(paths.root)
    .split("egm:egm-").join("egm-")
    .split("](../../docs/").join(`](${paths.root}/docs/`);
}

/** Claude Code permission rule for a directory: `//c/Users/...` on Windows, `//home/...` elsewhere. */
export function readRule(dir: string): string {
  const posix = toPosixPath(dir);
  const drive = /^([A-Za-z]):\/(.*)$/.exec(posix);
  const absolute = drive ? `//${drive[1]!.toLowerCase()}/${drive[2]}` : `/${posix}`;
  return `Read(${absolute}/**)`;
}

/** The guide's plugin instructions do not apply here, and the model follows it literally, so say so first. */
function installNote(paths: EgmPaths, readRules: string[]): string {
  return [
    "> **Installed by Lucid.** This copy came from `lucid setup egm`, not from a Claude Code plugin, which changes how this guide applies:",
    ">",
    `> - The EGM root is \`${paths.root}\`. Resolve \`agents/\`, \`resources/\`, and \`docs/\` against it. Skills are in \`${paths.skillsDir}/egm-*\`.`,
    "> - Invoke skills as `/egm-review`, and request reviewer types by bare name, such as `egm-zoom-out`.",
    "> - Ignore the plugin install, enable, cache-path, and Cowork instructions below; they describe a different install.",
    `> - Reviewers read these files with normal permissions. The rules that cover them are ${readRules.map((r) => `\`${r}\``).join(" and ")}.`,
    "",
    "",
  ].join("\n");
}

function normalizeEol(s: string): string {
  return s.replace(/\r\n/g, "\n");
}

/** Relative paths of the text files under `dir`. Icons and non-Claude adapters are not needed at runtime. */
function listTextFiles(dir: string, prefix = ""): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...listTextFiles(join(dir, entry.name), rel));
    else if (/\.(md|json)$/.test(entry.name)) files.push(rel);
  }
  return files;
}

/** Write one installed file. A differing copy is kept as .bak so local edits stay recoverable. */
function writeInstalled(dest: string, content: string, result: EgmInstallResult): void {
  if (existsSync(dest)) {
    const current = readFileSync(dest, "utf-8");
    if (normalizeEol(current) === normalizeEol(content)) {
      result.skipped.push(dest);
      return;
    }
    writeFileSync(dest + ".bak", current, "utf-8");
    writeFileSync(dest, content, "utf-8");
    result.updated.push(dest);
    return;
  }
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, content, "utf-8");
  result.installed.push(dest);
}

export function installEgm(opts: { claudeDir?: string; lucidRoot?: string } = {}): EgmInstallResult {
  const lucidRoot = toPosixPath(opts.lucidRoot ?? resolveLucidRoot());
  const claudeDir = toPosixPath(opts.claudeDir ?? join(homedir(), ".claude"));
  const source = join(lucidRoot, "vendor", "egm");
  if (!existsSync(join(source, "LICENSE"))) {
    throw new Error(`vendored EGM not found at ${source}`);
  }

  const paths: EgmPaths = {
    root: `${claudeDir}/egm`,
    skillsDir: `${claudeDir}/skills`,
    agentsDir: `${claudeDir}/agents`,
  };
  const readRules = [readRule(paths.root), readRule(`${paths.skillsDir}/egm-*`)];
  const result: EgmInstallResult = {
    ...paths, readRules, installed: [], updated: [], skipped: [],
    pluginAlsoInstalled: existsSync(join(claudeDir, "plugins", "cache", "egm")),
  };

  const install = (srcFile: string, dest: string, prepend = ""): void => {
    const original = readFileSync(srcFile, "utf-8");
    const rewritten = rewriteForInstall(original, paths);
    // Apache-2.0 section 4(b): modified files must say so.
    const marked = rewritten === original ? rewritten : rewritten + MODIFIED_NOTICE;
    writeInstalled(dest, prepend + marked, result);
  };

  for (const dir of ["agents", "resources", "docs"]) {
    for (const rel of listTextFiles(join(source, dir))) {
      const prepend = dir === "docs" && rel === "claude.md" ? installNote(paths, readRules) : "";
      install(join(source, dir, rel), `${paths.root}/${dir}/${rel}`, prepend);
    }
  }
  install(join(source, "LICENSE"), `${paths.root}/LICENSE`);

  const skillsSource = join(source, "skills");
  for (const rel of listTextFiles(skillsSource)) {
    install(join(skillsSource, rel), `${paths.skillsDir}/${rel}`);
  }

  // Prefixed because adapter names like style.md would collide with the user's own agents.
  const adapters = join(source, ".claude-plugin", "agents");
  for (const rel of listTextFiles(adapters)) {
    install(join(adapters, rel), `${paths.agentsDir}/egm-${rel}`);
  }

  return result;
}

export function parseVersion(output: string): [number, number, number] | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(output);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function isAtLeast(version: [number, number, number], minimum: [number, number, number]): boolean {
  for (let i = 0; i < 3; i++) {
    if (version[i]! !== minimum[i]!) return version[i]! > minimum[i]!;
  }
  return true;
}

function detectClaudeCodeVersion(): [number, number, number] | null {
  // shell: true because the Windows install is a .cmd shim; the command is a constant.
  const res = spawnSync("claude --version", { shell: true, encoding: "utf-8", timeout: 15_000 });
  return res.status === 0 ? parseVersion(res.stdout ?? "") : null;
}

export function runEgmSetup(): number {
  let r: EgmInstallResult;
  try {
    r = installEgm();
  } catch (err) {
    process.stderr.write(`[lucid] EGM setup failed: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  const out = process.stderr;
  out.write(`[lucid] EGM installed: ${r.installed.length} new, ${r.updated.length} updated, ${r.skipped.length} unchanged\n`);
  out.write(`  personas and standards: ${r.root}\n  skills: ${r.skillsDir}/egm-*\n  reviewers: ${r.agentsDir}/egm-*.md\n`);
  if (r.updated.length > 0) {
    out.write(`  Previous copies of updated files were kept as <file>.bak.\n`);
  }

  const version = detectClaudeCodeVersion();
  const minimum = MIN_CLAUDE_CODE_VERSION.join(".");
  if (version === null) {
    out.write(`\n  ⚠ Could not detect the Claude Code version. Reviewers are only isolated from CLAUDE.md on ${minimum} or later.\n`);
  } else if (!isAtLeast(version, MIN_CLAUDE_CODE_VERSION)) {
    out.write(`\n  ⚠ Claude Code ${version.join(".")} ignores omitClaudeMd, so reviewers would see CLAUDE.md. Upgrade to ${minimum} or later.\n`);
  }

  if (r.pluginAlsoInstalled) {
    out.write(`\n  ⚠ The egm plugin is also installed. Disable it with: claude plugin disable egm@egm\n`);
  }

  out.write(`\n  Reviewers read these files outside your project. To avoid a prompt per read, add to /permissions:\n`);
  for (const rule of r.readRules) out.write(`    ${rule}\n`);
  out.write(`\n  Restart Claude Code, then start with /egm-brainstorm, /egm-draft, or /egm-review <file>.\n`);
  return 0;
}
