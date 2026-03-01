// Structural skeleton extraction — regex-based AST-like parsing
// Returns only signatures, imports, and TODO comments (no function bodies)
// Used by get_context when a file exceeds the per-file token budget

export interface Skeleton {
  imports: string[];
  exports: string[];   // function/class/type signatures
  todos: string[];
  summary: string;     // first docstring / block comment
}

// ---------------------------------------------------------------------------
// TypeScript / JavaScript
// ---------------------------------------------------------------------------

function skeletonTS(source: string): Skeleton {
  const lines = source.split("\n");
  const imports: string[] = [];
  const exports: string[] = [];
  const todos: string[] = [];
  let summary = "";

  // Grab first JSDoc comment as summary
  const jsdoc = source.match(/^\/\*\*([\s\S]*?)\*\//m);
  if (jsdoc) {
    summary = jsdoc[1].replace(/\s*\*\s*/g, " ").trim().slice(0, 150);
  }

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const trimmed = line.trim();

    // Imports
    if (/^import\s/.test(trimmed)) {
      // Multi-line import: collect until ';'
      let full = line;
      while (!full.includes(";") && i + 1 < lines.length) {
        i++;
        full += " " + lines[i]!.trim();
      }
      imports.push(full.replace(/\s+/g, " ").trim());
      i++;
      continue;
    }

    // Exported declarations
    if (/^export\s/.test(trimmed)) {
      // Grab JSDoc above if present
      let sig = line;

      // If it's a function/class/interface, find the signature (up to first '{' or ';')
      if (/^export\s+(async\s+)?function|^export\s+(abstract\s+)?class|^export\s+interface/.test(trimmed)) {
        let j = i;
        let full = "";
        while (j < lines.length) {
          full += lines[j]! + "\n";
          if (lines[j]!.includes("{") || lines[j]!.includes(";")) break;
          j++;
        }
        // Show only up to opening brace
        sig = full.split("{")[0]!.replace(/\n/g, " ").replace(/\s+/g, " ").trim() + " { … }";
      } else if (/^export\s+(type|interface)\s/.test(trimmed)) {
        // Multi-line type — take first line
        sig = trimmed.split("{")[0]!.trim() + (trimmed.includes("{") ? " { … }" : "");
      } else {
        // const/enum/default — take line
        sig = trimmed.slice(0, 120);
      }

      exports.push(sig);
      i++;
      continue;
    }

    // TODOs
    if (/\/\/\s*(TODO|FIXME|HACK)/i.test(trimmed)) {
      todos.push(trimmed.slice(0, 100));
    }

    i++;
  }

  return { imports, exports, todos, summary };
}

// ---------------------------------------------------------------------------
// Python
// ---------------------------------------------------------------------------

function skeletonPython(source: string): Skeleton {
  const lines = source.split("\n");
  const imports: string[] = [];
  const exports: string[] = [];
  const todos: string[] = [];
  let summary = "";

  // Module docstring
  const docMatch = source.match(/^['"]{3}([\s\S]*?)['"]{3}/m);
  if (docMatch) summary = docMatch[1].trim().slice(0, 150);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();

    if (trimmed.startsWith("import ") || trimmed.startsWith("from ")) {
      imports.push(trimmed.slice(0, 100));
      continue;
    }

    // Public function/class/async def at top level (no indent)
    if (/^(def|class|async def)\s+(\w)/.test(trimmed) && !trimmed.startsWith("_")) {
      // Collect signature (may span multiple lines until ':')
      let sig = line;
      let j = i + 1;
      while (!sig.includes(":") && j < lines.length) {
        sig += " " + lines[j]!.trim();
        j++;
      }
      sig = sig.split(":")[0]!.replace(/\s+/g, " ").trim() + ":";
      exports.push(sig.slice(0, 120));
      continue;
    }

    if (/^\s*#\s*(TODO|FIXME|HACK)/i.test(line)) {
      todos.push(trimmed.slice(0, 100));
    }
  }

  return { imports, exports, todos, summary };
}

// ---------------------------------------------------------------------------
// Vue SFC
// ---------------------------------------------------------------------------

function skeletonVue(source: string): Skeleton {
  // Extract <script> or <script setup> block and run TS skeleton on it
  const scriptMatch = source.match(/<script[^>]*>([\s\S]*?)<\/script>/);
  const sk = scriptMatch ? skeletonTS(scriptMatch[1]!) : { imports: [], exports: [], todos: [], summary: "" };

  // Prepend Vue macro signatures (defineProps, defineEmits, defineExpose)
  const scriptContent = scriptMatch?.[1] ?? "";
  for (const macro of ["defineProps", "defineEmits", "defineExpose"]) {
    const m = scriptContent.match(new RegExp(`${macro}[\\s\\S]*?(?=\\n\\n|\\n[^\\s]|$)`, "m"));
    if (m) sk.exports.unshift(m[0]!.split("\n")[0]!.slice(0, 120));
  }

  // HTML comment as summary fallback
  if (!sk.summary) {
    const htmlComment = source.match(/<!--\s*([\s\S]*?)\s*-->/)?.[1];
    if (htmlComment) sk.summary = htmlComment.replace(/\n/g, " ").trim().slice(0, 150);
  }

  // Also note top-level template structure (first tag inside <template>)
  const templateMatch = source.match(/<template[^>]*>\s*<(\w[\w-]*)/);
  if (templateMatch) sk.exports.unshift(`<template> root: <${templateMatch[1]}>`);

  return sk;
}

// ---------------------------------------------------------------------------
// Generic (markdown, yaml, json, etc.)
// ---------------------------------------------------------------------------

function skeletonGeneric(source: string): Skeleton {
  const lines = source.split("\n").slice(0, 30);
  const todos: string[] = [];

  for (const line of source.split("\n")) {
    if (/(?:\/\/|#)\s*(TODO|FIXME|HACK)/i.test(line)) {
      todos.push(line.trim().slice(0, 100));
    }
  }

  return {
    imports: [],
    exports: [],
    todos,
    summary: lines.join("\n").slice(0, 300),
  };
}

// ---------------------------------------------------------------------------
// Public
// ---------------------------------------------------------------------------

export function extractSkeleton(source: string, language: string): Skeleton {
  switch (language) {
    case "typescript":
    case "javascript":
      return skeletonTS(source);
    case "python":
      return skeletonPython(source);
    case "vue":
      return skeletonVue(source);
    default:
      return skeletonGeneric(source);
  }
}

/** Render skeleton as compact text for context assembly. */
export function renderSkeleton(sk: Skeleton, filepath: string): string {
  const parts: string[] = [`// ${filepath} [skeleton]`];

  if (sk.summary) parts.push(`// ${sk.summary}`);
  if (sk.imports.length > 0) parts.push(sk.imports.slice(0, 8).join("\n"));
  if (sk.exports.length > 0) {
    parts.push("// — exports —");
    parts.push(sk.exports.join("\n"));
  }
  if (sk.todos.length > 0) {
    parts.push("// — TODOs —");
    parts.push(sk.todos.join("\n"));
  }

  return parts.join("\n\n");
}
