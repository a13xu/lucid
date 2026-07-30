import { describe, it, expect, beforeAll } from "vitest";
import { extractSkeleton } from "../src/indexer/ast.js";
import { initTreeSitter, treeSitterActive, treeSitterSkeleton } from "../src/indexer/tree-sitter.js";
import { GRAMMAR_FILES, grammarPath } from "../src/indexer/grammars.js";

const TS_SAMPLE = `/** Widget helpers. */
import { readFileSync } from "fs";

// TODO: cache this
export async function loadWidget(
  id: string,
  opts: { retries?: number } = {}
): Promise<string> {
  return readFileSync(id, "utf-8");
}

export class WidgetStore<T> {
  private items: T[] = [];
}

export const DEFAULT_RETRIES = 3;
`;

const PY_SAMPLE = `"""Config parsing."""
import os

@lru_cache
def load_config(path: str, *, strict: bool = True) -> dict:
    return {}

def _private():
    pass
`;

describe("extractSkeleton regex fallback (tree-sitter not initialized)", () => {
  // NOTE: this file runs in the same process as the tree-sitter suite below,
  // but vitest runs files in isolated workers, so ordering within this file
  // matters: fallback tests come before initTreeSitter() is called.
  it("returns null from treeSitterSkeleton before init", () => {
    // may be non-null only if another test in this worker already init'd
    if (!treeSitterActive()) {
      expect(treeSitterSkeleton(TS_SAMPLE, "typescript")).toBeNull();
    }
  });

  it("regex fallback still extracts exports and imports", () => {
    const sk = extractSkeleton(TS_SAMPLE, "typescript");
    expect(sk.imports.length).toBe(1);
    expect(sk.exports.some((e) => e.includes("loadWidget"))).toBe(true);
    expect(sk.todos.some((t) => /TODO/.test(t))).toBe(true);
  });
});

// Grammar-dependent tests: run only when the user has installed grammars
// (`lucid setup grammars`) AND the optional runtime is importable.
const grammarsInstalled = Object.keys(GRAMMAR_FILES).every((l) => grammarPath(l) !== null);

describe.skipIf(!grammarsInstalled)("tree-sitter skeletons (grammars installed)", () => {
  beforeAll(async () => {
    await initTreeSitter();
  });

  it("activates after init", () => {
    expect(treeSitterActive()).toBe(true);
  });

  it("extracts full TS signatures without truncating at default-param braces", () => {
    const sk = extractSkeleton(TS_SAMPLE, "typescript");
    const fn = sk.exports.find((e) => e.includes("loadWidget"));
    // the regex version truncates at `opts: {` — tree-sitter must not
    expect(fn).toContain("Promise<string>");
    expect(fn).toContain("{ … }");
    expect(sk.exports.some((e) => e.includes("WidgetStore<T>"))).toBe(true);
    expect(sk.exports.some((e) => e.includes("DEFAULT_RETRIES"))).toBe(true);
    expect(sk.imports).toEqual([`import { readFileSync } from "fs";`]);
    expect(sk.summary).toContain("Widget helpers");
    expect(sk.todos.some((t) => t.includes("TODO: cache this"))).toBe(true);
  });

  it("extracts Python defs with decorators, skips private names", () => {
    const sk = extractSkeleton(PY_SAMPLE, "python");
    expect(sk.exports.some((e) => e.startsWith("def load_config"))).toBe(true);
    expect(sk.exports.some((e) => e.includes("_private"))).toBe(false);
    expect(sk.summary).toContain("Config parsing");
  });

  it("returns null for unsupported languages", () => {
    expect(treeSitterSkeleton("<template/>", "vue")).toBeNull();
  });

  it("survives syntactically broken input", () => {
    const sk = extractSkeleton("export function ((((", "typescript");
    expect(sk).toBeTruthy(); // no throw — either tree-sitter ERROR nodes or fallback
  });
});
