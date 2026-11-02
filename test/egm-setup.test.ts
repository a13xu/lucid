import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  installEgm, isAtLeast, MIN_CLAUDE_CODE_VERSION, parseVersion, readRule, rewriteForInstall,
} from "../src/setup/egm.js";
import { installSkills } from "../src/tools/init.js";
import { toPosixPath } from "../src/setup/statusline.js";

const LUCID_ROOT = join(import.meta.dirname, "..");
const PATHS = { root: "C:/h/.claude/egm", skillsDir: "C:/h/.claude/skills", agentsDir: "C:/h/.claude/agents" };

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]);
}

describe("rewriteForInstall", () => {
  it("sends skill paths to the skills directory, not under the root", () => {
    expect(rewriteForInstall("`${CLAUDE_PLUGIN_ROOT}/skills/egm-bootstrap/SKILL.md`", PATHS))
      .toBe("`C:/h/.claude/skills/egm-bootstrap/SKILL.md`");
  });

  it("rewrites every root reference on a line", () => {
    expect(rewriteForInstall("${CLAUDE_PLUGIN_ROOT}/a ${CLAUDE_PLUGIN_ROOT}/b", PATHS))
      .toBe("C:/h/.claude/egm/a C:/h/.claude/egm/b");
  });

  it("drops the plugin namespace from agent types and commands", () => {
    expect(rewriteForInstall("`egm:egm-zoom-out` /egm:egm-review", PATHS)).toBe("`egm-zoom-out` /egm-review");
  });

  it("resolves the relative docs link, which would point at ~/.claude/docs once installed", () => {
    expect(rewriteForInstall("[Codex](../../docs/codex.md)", PATHS)).toBe("[Codex](C:/h/.claude/egm/docs/codex.md)");
  });

  it("does not treat a path as a regex replacement pattern", () => {
    const out = rewriteForInstall("${CLAUDE_PLUGIN_ROOT}/x", { ...PATHS, root: "C:/a$&b" });
    expect(out).toBe("C:/a$&b/x");
  });

  it("leaves text without plugin references unchanged", () => {
    expect(rewriteForInstall("Read `egm-style`.\n", PATHS)).toBe("Read `egm-style`.\n");
  });
});

describe("readRule", () => {
  it("uses the lower-case drive form, the only one EGM's guide says matches on Windows", () => {
    expect(readRule("C:\\Users\\x\\.claude\\egm")).toBe("Read(//c/Users/x/.claude/egm/**)");
  });

  it("uses a double leading slash for absolute POSIX paths", () => {
    expect(readRule("/home/x/.claude/egm")).toBe("Read(//home/x/.claude/egm/**)");
  });
});

describe("version check", () => {
  it("parses the Claude Code version output", () => {
    expect(parseVersion("2.1.316 (Claude Code)\n")).toEqual([2, 1, 316]);
    expect(parseVersion("")).toBeNull();
  });

  it("compares each part numerically at the boundary", () => {
    expect(isAtLeast([2, 1, 271], MIN_CLAUDE_CODE_VERSION)).toBe(true);
    expect(isAtLeast([2, 1, 270], MIN_CLAUDE_CODE_VERSION)).toBe(false);
    expect(isAtLeast([2, 2, 0], MIN_CLAUDE_CODE_VERSION)).toBe(true);
    expect(isAtLeast([1, 9, 999], MIN_CLAUDE_CODE_VERSION)).toBe(false);
    expect(isAtLeast([10, 0, 0], MIN_CLAUDE_CODE_VERSION)).toBe(true);
  });
});

describe("installEgm", () => {
  let claudeDir: string;

  beforeEach(() => { claudeDir = mkdtempSync(join(tmpdir(), "lucid-egm-")); });
  afterEach(() => { rmSync(claudeDir, { recursive: true, force: true }); });

  const install = () => installEgm({ claudeDir, lucidRoot: LUCID_ROOT });
  const adapter = (name: string) => readFileSync(join(claudeDir, "agents", `egm-${name}.md`), "utf-8");

  it("leaves no plugin-only reference in any installed file", () => {
    install();
    for (const file of walk(claudeDir)) {
      const text = readFileSync(file, "utf-8");
      expect(text.includes("${CLAUDE_PLUGIN_ROOT}"), file).toBe(false);
      expect(text.includes("egm:egm-"), file).toBe(false);
    }
  });

  it("keeps every skill's frontmatter first, or Claude Code would not parse it", () => {
    install();
    const skills = readdirSync(join(claudeDir, "skills"));
    expect(skills.sort()).toEqual([
      "egm-bootstrap", "egm-brainstorm", "egm-draft", "egm-drift-report",
      "egm-resolve", "egm-review", "egm-review-loop",
    ]);
    for (const skill of skills) {
      const text = readFileSync(join(claudeDir, "skills", skill, "SKILL.md"), "utf-8");
      expect(text.startsWith("---"), skill).toBe(true);
      expect(text).toContain("disable-model-invocation: true");
    }
  });

  it("installs the skill references the skills read", () => {
    install();
    expect(existsSync(join(claudeDir, "skills", "egm-draft", "references", "design_doc.md"))).toBe(true);
    expect(existsSync(join(claudeDir, "skills", "egm-bootstrap", "references", "worker-return.schema.json"))).toBe(true);
  });

  it("keeps reviewers read-only and isolated from CLAUDE.md", () => {
    install();
    for (const name of ["design_critic", "zoom_out", "comprehension", "style", "structural", "codebase_details", "implementation_readiness"]) {
      const text = adapter(name);
      expect(text, name).toContain("tools: [Read, Grep, Glob]");
      expect(text, name).toContain("omitClaudeMd: true");
    }
  });

  it("points each adapter at a persona that exists", () => {
    install();
    const root = toPosixPath(claudeDir);
    for (const file of readdirSync(join(claudeDir, "agents"))) {
      const text = readFileSync(join(claudeDir, "agents", file), "utf-8");
      const persona = new RegExp(`Read \`(${root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/egm/agents/[^\`]+)\``).exec(text);
      expect(persona, file).not.toBeNull();
      expect(existsSync(persona![1]!), file).toBe(true);
    }
  });

  it("does not put canonical personas where Claude Code would load them as agents", () => {
    install();
    expect(readdirSync(join(claudeDir, "agents")).every((f) => f.startsWith("egm-"))).toBe(true);
    expect(readdirSync(join(claudeDir, "agents")).length).toBe(9);
    expect(existsSync(join(claudeDir, "egm", "agents", "design_critic.md"))).toBe(true);
  });

  it("marks modified files and leaves unmodified ones as upstream wrote them", () => {
    install();
    expect(readFileSync(join(claudeDir, "skills", "egm-review", "SKILL.md"), "utf-8")).toContain("Modified from upstream EGM");
    const persona = join("agents", "design_critic.md");
    expect(readFileSync(join(claudeDir, "egm", persona), "utf-8"))
      .toBe(readFileSync(join(LUCID_ROOT, "vendor", "egm", persona), "utf-8"));
  });

  it("ships the license and tells the model it is not a plugin install", () => {
    install();
    expect(existsSync(join(claudeDir, "egm", "LICENSE"))).toBe(true);
    const guide = readFileSync(join(claudeDir, "egm", "docs", "claude.md"), "utf-8");
    expect(guide.startsWith("> **Installed by Lucid.**")).toBe(true);
    expect(guide).toContain(`The EGM root is \`${toPosixPath(claudeDir)}/egm\``);
  });

  it("changes nothing on a second run", () => {
    const first = install();
    expect(first.installed.length).toBeGreaterThan(0);
    const second = install();
    expect(second.installed).toEqual([]);
    expect(second.updated).toEqual([]);
    expect(second.skipped.length).toBe(first.installed.length);
    expect(walk(claudeDir).some((f) => f.endsWith(".bak"))).toBe(false);
  });

  it("treats a CRLF-only difference as unchanged", () => {
    install();
    const file = join(claudeDir, "skills", "egm-review", "SKILL.md");
    writeFileSync(file, readFileSync(file, "utf-8").replace(/\r?\n/g, "\r\n"));
    expect(install().updated).toEqual([]);
  });

  it("keeps local edits as .bak when refreshing", () => {
    install();
    const file = join(claudeDir, "skills", "egm-review", "SKILL.md");
    const shipped = readFileSync(file, "utf-8");
    writeFileSync(file, "my edit\n");
    expect(install().updated.length).toBe(1);
    expect(readFileSync(file, "utf-8")).toBe(shipped);
    expect(readFileSync(file + ".bak", "utf-8")).toBe("my edit\n");
  });

  it("does not touch the user's own agents and skills", () => {
    mkdirSync(join(claudeDir, "agents"), { recursive: true });
    mkdirSync(join(claudeDir, "skills", "mine"), { recursive: true });
    writeFileSync(join(claudeDir, "agents", "style.md"), "mine\n");
    writeFileSync(join(claudeDir, "skills", "mine", "SKILL.md"), "mine\n");
    install();
    expect(readFileSync(join(claudeDir, "agents", "style.md"), "utf-8")).toBe("mine\n");
    expect(readFileSync(join(claudeDir, "skills", "mine", "SKILL.md"), "utf-8")).toBe("mine\n");
  });

  it("detects a parallel plugin install", () => {
    expect(install().pluginAlsoInstalled).toBe(false);
    mkdirSync(join(claudeDir, "plugins", "cache", "egm"), { recursive: true });
    expect(install().pluginAlsoInstalled).toBe(true);
  });

  it("fails clearly when the vendored copy is missing", () => {
    expect(() => installEgm({ claudeDir, lucidRoot: join(claudeDir, "nowhere") })).toThrow(/vendored EGM not found/);
  });
});

describe("init_project", () => {
  it("does not install EGM, which stays opt-in through lucid setup egm", () => {
    const dir = mkdtempSync(join(tmpdir(), "lucid-egm-init-"));
    try {
      const { installed } = installSkills(dir);
      expect(installed.length).toBeGreaterThan(0);
      expect(installed.some((s) => s.startsWith("egm-"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
