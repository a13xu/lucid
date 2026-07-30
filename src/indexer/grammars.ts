// Grammar WASM management for tree-sitter skeleton extraction.
//
// Grammar files are NOT bundled with the npm package (each is ~1-3MB).
// `lucid setup grammars` downloads them once into ~/.lucid/grammars/;
// until then extractSkeleton silently uses the regex fallback.

import { existsSync, mkdirSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { allowHost, safeFetch } from "../security/ssrf.js";

export const GRAMMAR_DIR = join(homedir(), ".lucid", "grammars");

// tree-sitter-wasms ships prebuilt ABI-14 grammars, loadable by
// web-tree-sitter >= 0.22. Version pinned so downloads are reproducible.
const CDN_BASE = "https://cdn.jsdelivr.net/npm/tree-sitter-wasms@0.1.12/out/";

/** language name (as stored in file_contents.language) → grammar file */
export const GRAMMAR_FILES: Record<string, string> = {
  typescript: "tree-sitter-typescript.wasm",
  javascript: "tree-sitter-javascript.wasm",
  python: "tree-sitter-python.wasm",
};

export function grammarPath(language: string): string | null {
  const file = GRAMMAR_FILES[language];
  if (!file) return null;
  const path = join(GRAMMAR_DIR, file);
  return existsSync(path) ? path : null;
}

/** `lucid setup grammars` — download grammar WASMs into ~/.lucid/grammars/. */
export async function setupGrammars(): Promise<number> {
  mkdirSync(GRAMMAR_DIR, { recursive: true });
  allowHost(CDN_BASE);

  let failures = 0;
  for (const [lang, file] of Object.entries(GRAMMAR_FILES)) {
    const dest = join(GRAMMAR_DIR, file);
    if (existsSync(dest)) {
      process.stdout.write(`✓ ${lang} — already installed (${file})\n`);
      continue;
    }
    try {
      const res = await safeFetch(CDN_BASE + file, {}, 30_000);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      // WASM magic number — refuse to store an HTML error page as a grammar
      if (buf.length < 8 || buf.readUInt32LE(0) !== 0x6d736100) {
        throw new Error("response is not a WASM binary");
      }
      writeFileSync(dest, buf);
      process.stdout.write(`⬇ ${lang} — downloaded ${file} (${Math.round(buf.length / 1024)}KB)\n`);
    } catch (err) {
      failures++;
      process.stderr.write(`✗ ${lang} — ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  // Verify the runtime is importable (it's an optionalDependency — install may have skipped it)
  try {
    await import("web-tree-sitter");
    process.stdout.write("✓ web-tree-sitter runtime available\n");
  } catch {
    failures++;
    process.stderr.write("✗ web-tree-sitter not installed — run: npm install web-tree-sitter\n");
  }

  process.stdout.write(failures === 0
    ? "Done. Restart the Lucid MCP server to activate tree-sitter skeletons.\n"
    : `Done with ${failures} failure(s) — regex fallback stays active for missing grammars.\n`);
  return failures === 0 ? 0 : 1;
}
