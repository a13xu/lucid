// Optional tree-sitter (WASM) skeleton extraction.
//
// web-tree-sitter is an optionalDependency and grammar WASMs are downloaded
// separately (`lucid setup grammars`), so this module NEVER hard-fails:
// initTreeSitter() is fire-and-forget at boot; until it completes (or when
// runtime/grammars are missing) treeSitterSkeleton() returns null and
// extractSkeleton falls back to the regex implementation in ast.ts.
//
// Parser init is async (WASM compile) but parsing itself is sync, which lets
// the synchronous get_context pipeline stay unchanged.

import { grammarPath } from "./grammars.js";
import type { Skeleton } from "./ast.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type TSNode = any;

const parsers = new Map<string, any>();
let initPromise: Promise<void> | null = null;

export function treeSitterActive(): boolean {
  return parsers.size > 0;
}

/** Idempotent, never throws. Call once at server boot (fire-and-forget). */
export function initTreeSitter(): Promise<void> {
  initPromise ??= doInit().catch(() => { /* regex fallback stays active */ });
  return initPromise;
}

async function doInit(): Promise<void> {
  const wanted = ["typescript", "javascript", "python"]
    .map((lang) => ({ lang, path: grammarPath(lang) }))
    .filter((g): g is { lang: string; path: string } => g.path !== null);
  if (wanted.length === 0) return;

  let mod: any;
  try { mod = await import("web-tree-sitter"); } catch { return; }
  // 0.24 exports a default Parser class (its static Language only exists
  // AFTER init()); 0.25+ exports named { Parser, Language }. Support both.
  const ParserCls = mod.Parser ?? mod.default ?? mod;
  await ParserCls.init();
  const LanguageCls = mod.Language ?? ParserCls.Language;

  for (const { lang, path } of wanted) {
    try {
      const language = await LanguageCls.load(path);
      const parser = new ParserCls();
      parser.setLanguage(language);
      parsers.set(lang, parser);
    } catch { /* grammar ABI mismatch or corrupt file — skip this language */ }
  }

  if (parsers.size > 0) {
    process.stderr.write(`[lucid] tree-sitter skeletons active: ${[...parsers.keys()].join(", ")}\n`);
  }
}

/** Sync parse. Returns null when tree-sitter isn't ready for this language. */
export function treeSitterSkeleton(source: string, language: string): Skeleton | null {
  const parser = parsers.get(language) ?? (language === "javascript" ? parsers.get("typescript") : undefined);
  if (!parser) return null;

  let tree: any;
  try { tree = parser.parse(source); } catch { return null; }
  if (!tree) return null;

  try {
    return language === "python"
      ? pythonSkeleton(tree.rootNode, source)
      : tsSkeleton(tree.rootNode, source);
  } catch {
    return null;
  } finally {
    tree.delete?.();
  }
}

// ---------------------------------------------------------------------------
// Signature helpers
// ---------------------------------------------------------------------------

const collapse = (s: string): string => s.replace(/\s+/g, " ").trim();

/** Text of `outer` up to the start of `decl`'s body — a body-less signature. */
function sigUpToBody(outer: TSNode, decl: TSNode, source: string): string {
  const body = decl?.childForFieldName?.("body") ?? null;
  const end = body ? body.startIndex : Math.min(outer.endIndex, outer.startIndex + 200);
  const sig = collapse(source.slice(outer.startIndex, end));
  return body ? `${sig} { … }` : sig.slice(0, 120);
}

// ---------------------------------------------------------------------------
// TypeScript / JavaScript
// ---------------------------------------------------------------------------

const TS_DECL_TYPES = new Set([
  "function_declaration", "generator_function_declaration", "class_declaration",
  "abstract_class_declaration", "interface_declaration", "enum_declaration",
]);

function tsSkeleton(root: TSNode, source: string): Skeleton {
  const imports: string[] = [];
  const exports: string[] = [];
  const todos: string[] = [];
  let summary = "";

  for (const node of root.namedChildren as TSNode[]) {
    switch (node.type) {
      case "import_statement":
        imports.push(collapse(node.text));
        break;
      case "export_statement": {
        const decl = node.childForFieldName?.("declaration")
          ?? (node.namedChildren as TSNode[]).find((c: TSNode) => TS_DECL_TYPES.has(c.type) || c.type === "lexical_declaration" || c.type === "type_alias_declaration");
        if (decl && (TS_DECL_TYPES.has(decl.type))) {
          exports.push(sigUpToBody(node, decl, source));
        } else {
          // export const / export type / export { … } / export default expr
          exports.push(collapse(node.text).slice(0, 120));
        }
        break;
      }
      case "comment": {
        const text: string = node.text;
        if (/(TODO|FIXME|HACK)/i.test(text)) todos.push(collapse(text).slice(0, 100));
        if (!summary && text.startsWith("/**")) {
          summary = collapse(text.replace(/^\/\*\*|\*\/$/g, "").replace(/\s*\*\s*/g, " ")).slice(0, 150);
        }
        break;
      }
    }
    // TODOs anywhere in the tree would need a full walk; top-level + inside
    // exported bodies covers the regex version's line scan closely enough for
    // top-level comments. Deep TODO scan:
    if (node.type !== "comment" && /(TODO|FIXME|HACK)/i.test(node.text)) {
      for (const line of (node.text as string).split("\n")) {
        if (/(?:\/\/|\/\*)\s*(TODO|FIXME|HACK)/i.test(line)) todos.push(line.trim().slice(0, 100));
      }
    }
  }

  return { imports, exports, todos: [...new Set(todos)], summary };
}

// ---------------------------------------------------------------------------
// Python
// ---------------------------------------------------------------------------

function pythonSkeleton(root: TSNode, source: string): Skeleton {
  const imports: string[] = [];
  const exports: string[] = [];
  const todos: string[] = [];
  let summary = "";

  const firstChild = (root.namedChildren as TSNode[])[0];
  if (firstChild?.type === "expression_statement" && firstChild.namedChildren?.[0]?.type === "string") {
    summary = collapse(firstChild.namedChildren[0].text.replace(/^['"]{3}|['"]{3}$/g, "")).slice(0, 150);
  }

  for (const node of root.namedChildren as TSNode[]) {
    let def: TSNode = node;
    if (node.type === "decorated_definition") {
      def = node.childForFieldName?.("definition") ?? node.namedChildren[node.namedChildren.length - 1];
    }
    switch (def?.type) {
      case "import_statement":
      case "import_from_statement":
        imports.push(collapse(def.text).slice(0, 100));
        break;
      case "function_definition":
      case "class_definition": {
        const name: string = def.childForFieldName?.("name")?.text ?? "";
        if (name.startsWith("_")) break;
        const body = def.childForFieldName?.("body");
        const end = body ? body.startIndex : Math.min(def.endIndex, def.startIndex + 200);
        let sig = collapse(source.slice(def.startIndex, end));
        if (!sig.endsWith(":")) sig = sig.replace(/:?\s*$/, ":");
        exports.push(sig.slice(0, 120));
        break;
      }
      case "comment":
        if (/(TODO|FIXME|HACK)/i.test(def.text)) todos.push(collapse(def.text).slice(0, 100));
        break;
    }
    if (def?.type !== "comment" && /#\s*(TODO|FIXME|HACK)/i.test(node.text)) {
      for (const line of (node.text as string).split("\n")) {
        if (/#\s*(TODO|FIXME|HACK)/i.test(line)) todos.push(line.trim().slice(0, 100));
      }
    }
  }

  return { imports, exports, todos: [...new Set(todos)], summary };
}
