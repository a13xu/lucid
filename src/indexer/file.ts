import { readFileSync } from "fs";
import { extname } from "path";
import type { Statements } from "../database.js";
import { compress, sha256 } from "../store/content.js";

// ---------------------------------------------------------------------------
// Extract meaningful info from a single source file
// ---------------------------------------------------------------------------

export interface FileIndex {
  module: string;       // entity name (e.g. "src/tools/remember.ts")
  exports: string[];    // exported symbols
  description: string;  // from first comment/docstring
  todos: string[];      // TODO/FIXME comments
  language: string;
}

function extractTS(source: string): Pick<FileIndex, "exports" | "description" | "todos"> {
  const exports: string[] = [];
  const todos: string[] = [];

  // Exported symbols
  for (const m of source.matchAll(/export\s+(?:async\s+)?(?:function|class|const|type|interface|enum)\s+(\w+)/g)) {
    exports.push(m[1]!);
  }

  // First JSDoc / block comment as description
  const docMatch = source.match(/^\/\*\*([\s\S]*?)\*\//m) ?? source.match(/^\/\/(.*)/m);
  const description = docMatch
    ? docMatch[1]!.replace(/\s*\*\s*/g, " ").trim().slice(0, 200)
    : "";

  // TODOs
  for (const m of source.matchAll(/\/\/\s*(TODO|FIXME|HACK)[:\s]+(.+)/gi)) {
    todos.push(`${m[1]}: ${m[2]!.trim()}`);
  }

  return { exports, description, todos };
}

function extractPython(source: string): Pick<FileIndex, "exports" | "description" | "todos"> {
  const exports: string[] = [];
  const todos: string[] = [];

  // Public functions and classes
  for (const m of source.matchAll(/^(?:def|class|async def)\s+(\w+)/gm)) {
    if (!m[1]!.startsWith("_")) exports.push(m[1]!);
  }

  // Module docstring
  const docMatch = source.match(/^["']{3}([\s\S]*?)["']{3}/m);
  const description = docMatch ? docMatch[1]!.trim().slice(0, 200) : "";

  // TODOs
  for (const m of source.matchAll(/#\s*(TODO|FIXME|HACK)[:\s]+(.+)/gi)) {
    todos.push(`${m[1]}: ${m[2]!.trim()}`);
  }

  return { exports, description, todos };
}

function extractVue(source: string): Pick<FileIndex, "exports" | "description" | "todos"> {
  const exports: string[] = [];
  const todos: string[] = [];

  // Extract <script> or <script setup> block
  const scriptMatch = source.match(/<script[^>]*>([\s\S]*?)<\/script>/);
  const scriptContent = scriptMatch?.[1] ?? "";

  // defineExpose({ foo, bar }) — symbols available to parent components
  const exposeMatch = scriptContent.match(/defineExpose\(\s*\{([^}]+)\}/);
  if (exposeMatch) {
    for (const m of exposeMatch[1]!.matchAll(/\b([a-zA-Z_]\w*)\b/g)) {
      if (!["true", "false", "null", "undefined"].includes(m[1]!)) {
        exports.push(m[1]!);
      }
    }
  }

  // Regular named exports inside <script> (non-setup composables, types, etc.)
  for (const m of scriptContent.matchAll(/export\s+(?:async\s+)?(?:function|class|const|type|interface|enum)\s+(\w+)/g)) {
    exports.push(m[1]!);
  }

  // TODOs from entire SFC (template + script + style)
  for (const m of source.matchAll(/\/\/\s*(TODO|FIXME|HACK)[:\s]+(.+)/gi)) {
    todos.push(`${m[1]}: ${m[2]!.trim()}`);
  }

  // Description: first HTML comment, then first JSDoc in script
  const htmlComment = source.match(/<!--\s*([\s\S]*?)\s*-->/)?.[1] ?? "";
  const jsdoc = scriptContent.match(/^\/\*\*([\s\S]*?)\*\//m)?.[1] ?? "";
  const raw = htmlComment || jsdoc;
  const description = raw.replace(/\s*\*\s*/g, " ").trim().slice(0, 200);

  return { exports, description, todos };
}

function extractGeneric(source: string): Pick<FileIndex, "exports" | "description" | "todos"> {
  const todos: string[] = [];
  for (const m of source.matchAll(/(?:\/\/|#)\s*(TODO|FIXME|HACK)[:\s]+(.+)/gi)) {
    todos.push(`${m[1]}: ${m[2]!.trim()}`);
  }
  return { exports: [], description: "", todos };
}

/** Build a FileIndex from already-read source — no IO. */
export function buildFileIndex(filepath: string, source: string): FileIndex {
  const ext = extname(filepath).toLowerCase();
  const module = filepath.replace(/\\/g, "/");

  let extracted: Pick<FileIndex, "exports" | "description" | "todos">;
  let language: string;

  if ([".ts", ".tsx", ".js", ".jsx"].includes(ext)) {
    extracted = extractTS(source);
    language = ext.includes("ts") ? "typescript" : "javascript";
  } else if (ext === ".py") {
    extracted = extractPython(source);
    language = "python";
  } else if (ext === ".vue") {
    extracted = extractVue(source);
    language = "vue";
  } else {
    extracted = extractGeneric(source);
    language = "generic";
  }

  return { module, language, ...extracted };
}

export function indexFile(filepath: string): FileIndex | null {
  let source: string;
  try {
    source = readFileSync(filepath, { encoding: "utf-8" });
  } catch {
    return null;
  }
  return buildFileIndex(filepath, source);
}

// ---------------------------------------------------------------------------
// Write file index to DB
// ---------------------------------------------------------------------------

export interface UpsertResult {
  observations: string[];
  stored: boolean;   // false = skip (hash unchanged)
  savedBytes: number;
}

export function upsertFileIndex(
  index: FileIndex,
  source: string,
  stmts: Statements
): UpsertResult {
  const fileHash = sha256(source);

  // Change detection — skip everything se hash-ul e identic
  const existing = stmts.getFileByPath.get(index.module);
  if (existing?.content_hash === fileHash) {
    return { observations: [], stored: false, savedBytes: 0 };
  }

  // Comprimă și stochează conținutul binar
  const blob = compress(source);
  stmts.upsertFile.run(
    index.module,
    blob,
    fileHash,
    Buffer.byteLength(source, "utf-8"),
    blob.byteLength,
    index.language
  );

  // Index structural în entities (compact, pentru recall)
  const observations: string[] = [];
  if (index.description) observations.push(`description: ${index.description}`);
  if (index.exports.length > 0) observations.push(`exports: ${index.exports.join(", ")}`);
  if (index.todos.length > 0) observations.push(`TODOs: ${index.todos.join(" | ")}`);
  observations.push(`language: ${index.language}`);

  const entityRow = stmts.getEntityByName.get(index.module);
  if (entityRow) {
    stmts.updateEntity.run(JSON.stringify(observations), entityRow.id as number);
  } else {
    stmts.insertEntity.run(index.module, "pattern", JSON.stringify(observations));
  }

  const savedBytes = Buffer.byteLength(source, "utf-8") - blob.byteLength;
  return { observations, stored: true, savedBytes };
}
