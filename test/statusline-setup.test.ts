import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  installStatusline, renderTemplate, toPosixPath, withStatusLine,
} from "../src/setup/statusline.js";

describe("toPosixPath", () => {
  it("converts separators and drops trailing slashes", () => {
    expect(toPosixPath("C:\\Users\\x\\.claude\\")).toBe("C:/Users/x/.claude");
  });
});

describe("renderTemplate", () => {
  it("replaces every occurrence of a placeholder", () => {
    expect(renderTemplate("__A__/x/__A__", { A: "root" })).toBe("root/x/root");
  });

  it("leaves unknown placeholders untouched", () => {
    expect(renderTemplate("__A__ __B__", { A: "1" })).toBe("1 __B__");
  });

  it("does not treat a Windows path as a regex replacement pattern", () => {
    // "$&" and friends in a replacement string would corrupt the output.
    expect(renderTemplate("__P__", { P: "C:/a$&b" })).toBe("C:/a$&b");
  });
});

describe("withStatusLine", () => {
  it("preserves unrelated settings", () => {
    const before = { permissions: { allow: ["Bash"] }, theme: "dark" };
    const { settings } = withStatusLine(before, "node x.mjs");
    expect(settings["permissions"]).toEqual({ allow: ["Bash"] });
    expect(settings["theme"]).toBe("dark");
    expect(settings["statusLine"]).toEqual({ type: "command", command: "node x.mjs" });
  });

  it("reports the previous command when replacing one", () => {
    const before = { statusLine: { type: "command", command: "node old.js" } };
    const { changed, previous } = withStatusLine(before, "node new.mjs");
    expect(changed).toBe(true);
    expect(previous).toBe("node old.js");
  });

  it("is a no-op when already registered", () => {
    const before = { statusLine: { type: "command", command: "node x.mjs" } };
    const { changed } = withStatusLine(before, "node x.mjs");
    expect(changed).toBe(false);
  });
});

describe("installStatusline", () => {
  function scratch() {
    const dir = mkdtempSync(join(tmpdir(), "lucid-setup-"));
    const claudeDir = join(dir, ".claude");
    // Minimal stand-in for a package layout: only the templates are read.
    const templates = join(dir, "root", "scripts", "statusline");
    mkdirSync(templates, { recursive: true });
    writeFileSync(join(templates, "lucid-statusline.mjs"), 'const LUCID_ROOT = "__LUCID_ROOT__";\n');
    writeFileSync(join(templates, "lucid-tasks.mjs"), 'const LUCID_ROOT = "__LUCID_ROOT__";\n');
    writeFileSync(join(templates, "tasks.md"), '!`node "__CLAUDE_DIR__/lucid-tasks.mjs"`\n');
    return { dir, claudeDir, lucidRoot: join(dir, "root") };
  }

  it("writes the scripts with the real root substituted", () => {
    const { dir, claudeDir, lucidRoot } = scratch();
    try {
      const r = installStatusline({ claudeDir, lucidRoot });
      const script = readFileSync(join(claudeDir, "lucid-statusline.mjs"), "utf-8");
      expect(script).toContain(toPosixPath(lucidRoot));
      expect(script).not.toContain("__LUCID_ROOT__");
      // Backslashes would be escape sequences inside the JS string literal.
      expect(script).not.toMatch(/\\/);
      expect(r.installed).toHaveLength(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("installs the slash command pointing at the installed script", () => {
    const { dir, claudeDir, lucidRoot } = scratch();
    try {
      installStatusline({ claudeDir, lucidRoot });
      const cmd = readFileSync(join(claudeDir, "commands", "tasks.md"), "utf-8");
      expect(cmd).toContain(`${toPosixPath(claudeDir)}/lucid-tasks.mjs`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps existing settings and backs the file up before rewriting", () => {
    const { dir, claudeDir, lucidRoot } = scratch();
    try {
      mkdirSync(claudeDir, { recursive: true });
      writeFileSync(
        join(claudeDir, "settings.json"),
        JSON.stringify({ theme: "dark", statusLine: { type: "command", command: "node old.js" } }),
      );

      const r = installStatusline({ claudeDir, lucidRoot });
      const after = JSON.parse(readFileSync(r.settingsPath, "utf-8"));

      expect(after.theme).toBe("dark");
      expect(after.statusLine.command).toContain("lucid-statusline.mjs");
      expect(r.previousCommand).toBe("node old.js");
      expect(r.backupPath).toBeTruthy();
      expect(JSON.parse(readFileSync(r.backupPath!, "utf-8")).statusLine.command).toBe("node old.js");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates settings.json when none exists", () => {
    const { dir, claudeDir, lucidRoot } = scratch();
    try {
      const r = installStatusline({ claudeDir, lucidRoot });
      expect(r.settingsChanged).toBe(true);
      expect(r.backupPath).toBeNull();
      expect(JSON.parse(readFileSync(r.settingsPath, "utf-8")).statusLine.type).toBe("command");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is idempotent — a second run leaves settings.json alone", () => {
    const { dir, claudeDir, lucidRoot } = scratch();
    try {
      installStatusline({ claudeDir, lucidRoot });
      const second = installStatusline({ claudeDir, lucidRoot });
      expect(second.settingsChanged).toBe(false);
      expect(second.backupPath).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports superseded pre-1.24 files without deleting them", () => {
    const { dir, claudeDir, lucidRoot } = scratch();
    try {
      mkdirSync(claudeDir, { recursive: true });
      writeFileSync(join(claudeDir, "lucid-statusline.js"), "// old");
      const r = installStatusline({ claudeDir, lucidRoot });
      expect(r.staleFiles.some((f) => f.endsWith("lucid-statusline.js"))).toBe(true);
      expect(readFileSync(join(claudeDir, "lucid-statusline.js"), "utf-8")).toBe("// old");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
