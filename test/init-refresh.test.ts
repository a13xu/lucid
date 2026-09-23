import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { injectClaudeMdInstruction, installSkills } from "../src/tools/init.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "lucid-init-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const claudeMd = () => readFileSync(join(dir, "CLAUDE.md"), "utf-8");
const count = (s: string, sub: string) => s.split(sub).length - 1;

describe("injectClaudeMdInstruction", () => {
  it("does nothing without a CLAUDE.md", () => {
    expect(injectClaudeMdInstruction(dir)).toBeNull();
    expect(existsSync(join(dir, "CLAUDE.md"))).toBe(false);
  });

  it("appends the block once and is idempotent", () => {
    writeFileSync(join(dir, "CLAUDE.md"), "# Project\n");
    expect(injectClaudeMdInstruction(dir)).toBe("injected");
    expect(injectClaudeMdInstruction(dir)).toBeNull();
    const text = claudeMd();
    expect(text.startsWith("# Project\n")).toBe(true);
    expect(count(text, "<!-- LUCID_SYNC -->")).toBe(1);
    expect(count(text, "<!-- /LUCID_SYNC -->")).toBe(1);
  });

  it("refreshes an outdated block and keeps the text around it", () => {
    writeFileSync(
      join(dir, "CLAUDE.md"),
      "# Before\n\n<!-- LUCID_SYNC -->\nyou MUST call sync_file\n<!-- /LUCID_SYNC -->\n\n# After\n",
    );
    expect(injectClaudeMdInstruction(dir)).toBe("updated");
    const text = claudeMd();
    expect(text).not.toContain("you MUST call sync_file");
    expect(text.startsWith("# Before\n\n<!-- LUCID_SYNC -->")).toBe(true);
    expect(text.endsWith("<!-- /LUCID_SYNC -->\n\n# After\n")).toBe(true);
    expect(injectClaudeMdInstruction(dir)).toBeNull();
  });

  it("treats a CRLF copy of the current block as current", () => {
    writeFileSync(join(dir, "CLAUDE.md"), "# P\n");
    injectClaudeMdInstruction(dir);
    writeFileSync(join(dir, "CLAUDE.md"), claudeMd().replace(/\n/g, "\r\n"));
    expect(injectClaudeMdInstruction(dir)).toBeNull();
  });

  it("leaves an unterminated block alone", () => {
    const original = "# P\n<!-- LUCID_SYNC -->\nhand edited\n";
    writeFileSync(join(dir, "CLAUDE.md"), original);
    expect(injectClaudeMdInstruction(dir)).toBeNull();
    expect(claudeMd()).toBe(original);
  });
});

describe("installSkills", () => {
  it("installs, skips unchanged copies, and refreshes changed ones with a backup", () => {
    const first = installSkills(dir);
    expect(first.installed.length).toBeGreaterThan(0);
    expect(first.updated).toEqual([]);

    const second = installSkills(dir);
    expect(second.installed).toEqual([]);
    expect(second.updated).toEqual([]);
    const byName = (a: string, b: string) => a.localeCompare(b);
    expect([...second.skipped].sort(byName)).toEqual([...first.installed].sort(byName));

    const name = first.installed[0];
    const skillFile = join(dir, ".claude", "skills", name, "SKILL.md");
    const shipped = readFileSync(skillFile, "utf-8");
    writeFileSync(skillFile, "stale copy\n");

    const third = installSkills(dir);
    expect(third.updated).toEqual([name]);
    expect(readFileSync(skillFile, "utf-8")).toBe(shipped);
    expect(readFileSync(skillFile + ".bak", "utf-8")).toBe("stale copy\n");
    expect(readdirSync(join(dir, ".claude", "skills")).length).toBe(first.installed.length);
  });

  it("does not rewrite a copy that differs only in line endings", () => {
    const { installed } = installSkills(dir);
    const skillFile = join(dir, ".claude", "skills", installed[0], "SKILL.md");
    writeFileSync(skillFile, readFileSync(skillFile, "utf-8").replace(/\n/g, "\r\n"));
    expect(installSkills(dir).updated).toEqual([]);
    expect(existsSync(skillFile + ".bak")).toBe(false);
  });
});
