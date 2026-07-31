import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

process.env["MEMORY_DB_PATH"] = join(mkdtempSync(join(tmpdir(), "lucid-recall-")), "t.db");

const { initDatabase, prepareStatements } = await import("../src/database.js");
const { recall, capEntity } = await import("../src/tools/recall.js");
const { handleSmartContext } = await import("../src/tools/smart-context.js");

let db: ReturnType<typeof initDatabase>;
let stmts: ReturnType<typeof prepareStatements>;

beforeAll(() => {
  db = initDatabase();
  stmts = prepareStatements(db);
  // A "project entity" with hundreds of long observations — the pattern that
  // blew past the MCP response cap via smart_context.
  const obs = Array.from({ length: 400 }, (_, i) =>
    `exports from src/module-${i}.ts: ${"handleSomething, ".repeat(40)}`);
  stmts.insertEntity.run("giant-project", "project", JSON.stringify(obs));
  for (let i = 0; i < 30; i++) {
    stmts.insertEntity.run(`giant-file-${i}`, "pattern",
      JSON.stringify([`description: ${"lorem ipsum ".repeat(200)}`]));
  }
});

afterAll(() => {
  const path = process.env["MEMORY_DB_PATH"]!;
  db.close();
  rmSync(join(path, ".."), { recursive: true, force: true });
});

describe("capEntity", () => {
  it("caps observation count and length, notes the remainder", () => {
    const capped = capEntity({
      id: 1, name: "x", type: "project",
      observations: Array.from({ length: 40 }, () => "y".repeat(2000)),
      created_at: 0, updated_at: 0, relations: [],
    });
    expect(capped.observations.length).toBe(16); // 15 + "+N more" marker
    expect(capped.observations[0]!.length).toBeLessThanOrEqual(501);
    expect(capped.observations.at(-1)).toContain("+25 more");
  });
});

describe("recall output budget", () => {
  it("stays under the char budget and returns valid JSON", () => {
    const out = recall(stmts, { query: "giant" });
    expect(out.length).toBeLessThanOrEqual(34_000);
    const parsed = JSON.parse(out) as unknown[];
    expect(parsed.length).toBeGreaterThan(0);
  });

  it("honors a custom maxChars", () => {
    const out = recall(stmts, { query: "giant" }, { maxChars: 3000 });
    expect(out.length).toBeLessThanOrEqual(5000); // one capped entity may exceed slightly
    expect(() => JSON.parse(out)).not.toThrow();
  });
});

describe("smart_context response size", () => {
  it("total output fits well under the MCP response cap", async () => {
    const out = await handleSmartContext(stmts, { query: "giant project exports", task_type: "moderate" });
    // moderate = 6000 tokens ≈ 24k chars + headers; must never approach 100k chars
    expect(out.length).toBeLessThanOrEqual(40_000);
    expect(out).toContain("## Knowledge Context");
    expect(out).toContain("## Code Context");
  });
});
