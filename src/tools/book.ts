/**
 * Book ingestion pipeline — PDF/EPUB → Markdown chunks → Lucid index → Claude
 * Code Skill router. Conversion shells out to user-installed tools
 * (pymupdf4llm for PDF, pandoc for EPUB); Lucid itself stays dependency-free.
 *
 * Three handlers:
 *   - handleIngestBook       : convert + chunk + index
 *   - handleGenerateBookSkill: emit ~/.claude/skills/book-<slug>/SKILL.md
 *   - handleListBooks        : list indexed books
 */

import { z } from "zod";
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync,
} from "fs";
import { join, resolve, extname, basename, dirname } from "path";
import { homedir } from "os";
import { execFileSync, spawnSync } from "child_process";
import type { Statements } from "../database.js";
import { indexFile, upsertFileIndex } from "../indexer/file.js";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const IngestBookSchema = z.object({
  path: z.string().min(1).describe("Path to the source book (.pdf, .epub, .docx, or .md)."),
  title: z.string().optional().describe("Display title. Defaults to the filename."),
  out_dir: z.string().optional().describe("Output directory for chunked markdown. Defaults to ./books/<slug>/"),
  chunker: z.enum(["heading", "page", "none"]).optional().default("heading")
    .describe("How to split: by H1/H2 headings (default), by source page, or single file."),
  index: z.boolean().optional().default(true).describe("Index chunks into Lucid immediately."),
});

export const GenerateBookSkillSchema = z.object({
  slug: z.string().min(1).describe("Book slug (the directory name produced by ingest_book)."),
  title: z.string().optional().describe("Display title shown in the skill description."),
  topics: z.string().optional().describe("Comma-separated topics that should trigger the skill."),
  scope: z.enum(["user", "project"]).optional().default("user")
    .describe("Where to install the skill: ~/.claude/skills/ (user) or .claude/skills/ (project)."),
});

export const ListBooksSchema = z.object({
  dir: z.string().optional().describe("Root directory to scan. Defaults to ./books/"),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "book";
}

function which(cmd: string): boolean {
  const probe = process.platform === "win32" ? "where" : "which";
  const r = spawnSync(probe, [cmd], { stdio: "ignore" });
  return r.status === 0;
}

interface Chunk {
  index: number;
  title: string;
  content: string;
}

// ---------------------------------------------------------------------------
// Converters — shell out to user tools; never bundle binaries
// ---------------------------------------------------------------------------

function convertPdfToMarkdown(src: string): string {
  // Preferred: pymupdf4llm (fastest for native-text PDFs, no GPU, no ML)
  if (which("python") || which("python3")) {
    const py = which("python3") ? "python3" : "python";
    const script =
      `import sys\n` +
      `try:\n` +
      `  import pymupdf4llm\n` +
      `  sys.stdout.write(pymupdf4llm.to_markdown(sys.argv[1]))\n` +
      `except ImportError:\n` +
      `  sys.stderr.write("pymupdf4llm not installed\\n")\n` +
      `  sys.exit(2)\n`;
    const r = spawnSync(py, ["-c", script, src], { encoding: "utf-8", maxBuffer: 200 * 1024 * 1024 });
    if (r.status === 0 && r.stdout) return r.stdout;
  }
  // Fallback: marker_single (datalab-to/marker)
  if (which("marker_single")) {
    const tmpDir = join(homedir(), ".lucid", "tmp-marker", `${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    const r = spawnSync("marker_single", [src, "--output_format", "markdown", "--output_dir", tmpDir],
      { encoding: "utf-8" });
    if (r.status === 0) {
      const produced = readdirSync(tmpDir, { recursive: true })
        .filter((p): p is string => typeof p === "string" && p.endsWith(".md"));
      if (produced.length > 0) return readFileSync(join(tmpDir, produced[0]!), "utf-8");
    }
  }
  throw new Error(
    `Cannot convert PDF — install one of:\n` +
    `  pip install pymupdf4llm   # fast, native PDFs (recommended)\n` +
    `  pip install marker-pdf    # best quality, supports scans`
  );
}

function convertEpubToMarkdown(src: string): string {
  if (which("pandoc")) {
    const r = spawnSync("pandoc", ["-f", "epub", "-t", "gfm", src], { encoding: "utf-8", maxBuffer: 200 * 1024 * 1024 });
    if (r.status === 0 && r.stdout) return r.stdout;
  }
  throw new Error(`Cannot convert EPUB — install pandoc: https://pandoc.org/installing.html`);
}

function convertDocxToMarkdown(src: string): string {
  if (which("pandoc")) {
    const r = spawnSync("pandoc", ["-f", "docx", "-t", "gfm", src], { encoding: "utf-8", maxBuffer: 200 * 1024 * 1024 });
    if (r.status === 0 && r.stdout) return r.stdout;
  }
  throw new Error(`Cannot convert DOCX — install pandoc.`);
}

function loadSource(path: string): string {
  const ext = extname(path).toLowerCase();
  if (!existsSync(path)) throw new Error(`Source not found: ${path}`);
  if (ext === ".md" || ext === ".markdown" || ext === ".txt") return readFileSync(path, "utf-8");
  if (ext === ".pdf") return convertPdfToMarkdown(path);
  if (ext === ".epub") return convertEpubToMarkdown(path);
  if (ext === ".docx") return convertDocxToMarkdown(path);
  throw new Error(`Unsupported source format: ${ext}. Use .pdf, .epub, .docx, .md, or .txt.`);
}

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

function chunkByHeading(md: string): Chunk[] {
  // Split on H1 (#) primarily; if a single chunk grows beyond 80KB, fall back to H2.
  const HARD_LIMIT = 80 * 1024;
  const lines = md.split(/\r?\n/);
  const out: Chunk[] = [];
  let cur: { title: string; buf: string[] } | null = null;

  const push = (): void => {
    if (cur && cur.buf.length > 0) {
      out.push({ index: out.length + 1, title: cur.title, content: cur.buf.join("\n").trim() });
    }
  };

  for (const line of lines) {
    const h1 = /^# +(.+)$/.exec(line);
    if (h1) {
      push();
      cur = { title: h1[1]!.trim(), buf: [line] };
      continue;
    }
    if (!cur) cur = { title: "Preface", buf: [] };
    cur.buf.push(line);

    // Soft split on H2 if the current chunk is getting too big
    const h2 = /^## +(.+)$/.exec(line);
    if (h2 && cur.buf.join("\n").length > HARD_LIMIT) {
      // Drop the trailing line, push, restart with the H2 as new chunk title.
      cur.buf.pop();
      push();
      cur = { title: h2[1]!.trim(), buf: [line] };
    }
  }
  push();

  // If no headings were found at all → fall back to a single chunk
  if (out.length === 0) out.push({ index: 1, title: "Body", content: md.trim() });
  return out;
}

function chunkByPage(md: string): Chunk[] {
  // pymupdf4llm separates pages with -----\n; treat each as a chunk
  const parts = md.split(/\n-{3,}\n/);
  return parts
    .map((p, i) => ({ index: i + 1, title: `Page ${i + 1}`, content: p.trim() }))
    .filter((c) => c.content.length > 0);
}

function chunkAll(md: string, mode: "heading" | "page" | "none"): Chunk[] {
  if (mode === "none") return [{ index: 1, title: "Full", content: md.trim() }];
  if (mode === "page") return chunkByPage(md);
  return chunkByHeading(md);
}

// ---------------------------------------------------------------------------
// handleIngestBook
// ---------------------------------------------------------------------------

export function handleIngestBook(
  stmts: Statements,
  args: z.infer<typeof IngestBookSchema>,
): string {
  const src = resolve(args.path);
  const title = args.title ?? basename(src, extname(src));
  const slug = slugify(title);
  const outDir = resolve(args.out_dir ?? join(process.cwd(), "books", slug));

  mkdirSync(outDir, { recursive: true });

  const raw = loadSource(src);
  const chunks = chunkAll(raw, args.chunker ?? "heading");

  // Write a manifest so generate_book_skill knows what was produced
  const manifest = {
    slug, title,
    source: src,
    chunker: args.chunker ?? "heading",
    chunks: chunks.map((c) => ({ index: c.index, title: c.title, file: chunkFilename(c) })),
    created_at: new Date().toISOString(),
  };

  // Write chunks
  for (const c of chunks) {
    const file = join(outDir, chunkFilename(c));
    const header = `---\nbook: ${title}\nslug: ${slug}\nchunk: ${c.index}\ntitle: ${c.title.replace(/"/g, '\\"')}\n---\n\n`;
    writeFileSync(file, header + c.content, "utf-8");
  }
  writeFileSync(join(outDir, "_manifest.json"), JSON.stringify(manifest, null, 2), "utf-8");

  // Index into Lucid via existing pipeline (sync_file is .ts/.py only — call indexer directly)
  let indexed = 0;
  if (args.index !== false) {
    for (const c of chunks) {
      const file = join(outDir, chunkFilename(c));
      const idx = indexFile(file);
      if (!idx) continue;
      const r = upsertFileIndex(idx, readFileSync(file, "utf-8"), stmts);
      if (r.stored) indexed++;
    }
  }

  return [
    `📚 Ingested: "${title}" → ${outDir}`,
    `   chunks: ${chunks.length} (${args.chunker ?? "heading"})`,
    args.index !== false ? `   indexed: ${indexed} new chunk(s) into Lucid` : `   indexing skipped`,
    ``,
    `Next: generate the auto-loaded skill router with:`,
    `  lucid book skill ${slug} --topics "<comma,separated,topics>"`,
  ].join("\n");
}

function chunkFilename(c: Chunk): string {
  const safe = slugify(c.title);
  return `${String(c.index).padStart(3, "0")}-${safe}.md`;
}

// ---------------------------------------------------------------------------
// handleGenerateBookSkill
// ---------------------------------------------------------------------------

export function handleGenerateBookSkill(
  args: z.infer<typeof GenerateBookSkillSchema>,
): string {
  const slug = args.slug;
  const booksRoot = join(process.cwd(), "books", slug);
  const manifestPath = join(booksRoot, "_manifest.json");

  let title = args.title ?? slug;
  let chunkCount = 0;
  let chunkTitles: string[] = [];
  if (existsSync(manifestPath)) {
    try {
      const m = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
        title: string; chunks: Array<{ title: string }>;
      };
      title = args.title ?? m.title;
      chunkCount = m.chunks.length;
      chunkTitles = m.chunks.map((c) => c.title).slice(0, 12);
    } catch { /* ignore — manifest optional */ }
  }

  const topics = (args.topics ?? "").split(",").map((t) => t.trim()).filter(Boolean);
  const skillRoot = args.scope === "project"
    ? join(process.cwd(), ".claude", "skills", `book-${slug}`)
    : join(homedir(), ".claude", "skills", `book-${slug}`);

  mkdirSync(skillRoot, { recursive: true });

  const description = topics.length > 0
    ? `Use when the user asks about ${topics.join(", ")} — or any concept from "${title}". Retrieves passages via Lucid smart_context.`
    : `Use for questions whose answers should cite "${title}". Retrieves passages via Lucid smart_context.`;

  const tocPreview = chunkTitles.length > 0
    ? chunkTitles.map((t, i) => `   ${String(i + 1).padStart(2, "0")}. ${t}`).join("\n")
    : "   (run `lucid book ingest` first to populate the table of contents)";

  const body =
`---
name: book-${slug}
description: ${description}
---

# ${title} — Lucid skill router

This skill does NOT contain the book text. It delegates retrieval to Lucid's
indexed corpus so passages are pulled on demand instead of being loaded into
every prompt.

## When invoked

1. Identify the user's question or the topic at hand.
2. Call \`mcp__lucid__smart_context\` with:
   - \`query\`: the user's question, or the topic phrased as a search
   - \`task_type\`: "moderate" for explanations, "complex" for multi-chapter synthesis
3. The retrieved chunks come from \`books/${slug}/\` (${chunkCount} indexed chunk${chunkCount === 1 ? "" : "s"}).
4. Quote chapter / chunk titles when you cite, so the source stays verifiable.
5. After answering, call \`mcp__lucid__reward\` if the passages were on-point
   so future queries on this topic rank them higher (decay half-life ~14 days).

## Table of contents (first ${Math.min(chunkTitles.length, 12)} chunks)

${tocPreview}

## Notes

- If \`smart_context\` returns nothing, the corpus may not be indexed. Run
  \`lucid book ingest <source>\` then \`sync_project\` to rebuild.
- This skill is a thin router (~100 tokens at scan time). Adding more books
  here does not bloat Claude Code's startup.
`;

  const skillFile = join(skillRoot, "SKILL.md");
  writeFileSync(skillFile, body, "utf-8");

  return [
    `🧠 Skill generated: ${skillFile}`,
    `   description trigger: ${description}`,
    `   scope: ${args.scope ?? "user"}`,
    chunkCount > 0 ? `   linked to ${chunkCount} chunk(s) in books/${slug}/` : `   ⚠️  no chunks indexed yet`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// handleListBooks
// ---------------------------------------------------------------------------

export function handleListBooks(args: z.infer<typeof ListBooksSchema>): string {
  const root = resolve(args.dir ?? join(process.cwd(), "books"));
  if (!existsSync(root)) return `No books directory at ${root}. Run \`lucid book ingest\` first.`;

  const entries = readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  if (entries.length === 0) return `No books indexed under ${root}.`;

  const lines: string[] = [`📚 Books in ${root}:`];
  for (const name of entries) {
    const manifestPath = join(root, name, "_manifest.json");
    if (existsSync(manifestPath)) {
      try {
        const m = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
          title: string; chunks: unknown[]; created_at: string;
        };
        lines.push(`  • ${name} — "${m.title}" (${m.chunks.length} chunks, ingested ${m.created_at.slice(0, 10)})`);
      } catch {
        lines.push(`  • ${name} — (manifest unreadable)`);
      }
    } else {
      const mdCount = readdirSync(join(root, name)).filter((f) => f.endsWith(".md")).length;
      lines.push(`  • ${name} — ${mdCount} .md file(s), no manifest`);
    }
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI entry — `lucid book <subcmd>`
// ---------------------------------------------------------------------------

export async function runBookCli(args: string[], stmts: Statements): Promise<number> {
  const sub = args[0];

  if (!sub || sub === "--help" || sub === "-h" || sub === "help") {
    process.stdout.write(BOOK_HELP);
    return 0;
  }

  if (sub === "ingest") {
    const rest = args.slice(1);
    if (rest.includes("--help") || rest.includes("-h") || rest.length === 0) {
      process.stdout.write(INGEST_HELP);
      return rest.length === 0 ? 64 : 0;
    }
    const path = rest.find((a) => !a.startsWith("--"));
    if (!path) { process.stderr.write("Missing source path.\n"); return 64; }
    const opts = {
      path,
      title: getFlag(rest, "--title"),
      out_dir: getFlag(rest, "--out"),
      chunker: (getFlag(rest, "--chunker") as "heading" | "page" | "none" | undefined) ?? "heading",
      index: !rest.includes("--no-index"),
    };
    process.stdout.write(handleIngestBook(stmts, IngestBookSchema.parse(opts)) + "\n");
    return 0;
  }

  if (sub === "skill") {
    const rest = args.slice(1);
    if (rest.includes("--help") || rest.includes("-h") || rest.length === 0) {
      process.stdout.write(SKILL_HELP);
      return rest.length === 0 ? 64 : 0;
    }
    const slug = rest.find((a) => !a.startsWith("--"));
    if (!slug) { process.stderr.write("Missing book slug.\n"); return 64; }
    const opts = {
      slug,
      title: getFlag(rest, "--title"),
      topics: getFlag(rest, "--topics"),
      scope: (getFlag(rest, "--scope") as "user" | "project" | undefined) ?? "user",
    };
    process.stdout.write(handleGenerateBookSkill(GenerateBookSkillSchema.parse(opts)) + "\n");
    return 0;
  }

  if (sub === "list") {
    const rest = args.slice(1);
    if (rest.includes("--help") || rest.includes("-h")) {
      process.stdout.write(LIST_HELP);
      return 0;
    }
    process.stdout.write(handleListBooks({ dir: getFlag(rest, "--dir") }) + "\n");
    return 0;
  }

  process.stderr.write(`Unknown subcommand: ${sub}\n\n${BOOK_HELP}`);
  return 64;
}

function getFlag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

const BOOK_HELP =
`lucid book — convert books to indexed markdown + auto-load as Claude Code skills

USAGE
  lucid book <command> [options]

COMMANDS
  ingest <path>     Convert a PDF/EPUB/DOCX/MD into chunked markdown and index it.
  skill  <slug>     Emit a SKILL.md router into ~/.claude/skills/ for a book.
  list              List ingested books and their chunk counts.

Run \`lucid book <command> --help\` for command-specific options.

EXAMPLES
  lucid book ingest ./clean-code.pdf --title "Clean Code"
  lucid book skill clean-code --topics "naming,refactor,functions,code review"
  lucid book list

DEPENDENCIES (install only what you need)
  PDF   pip install pymupdf4llm        # native-text PDFs, fastest
        pip install marker-pdf         # OCR-quality, supports scans
  EPUB  pandoc                         # https://pandoc.org/installing.html
  DOCX  pandoc
`;

const INGEST_HELP =
`lucid book ingest <path> [options]

Convert a book into chunked markdown and index it in Lucid.

OPTIONS
  --title TEXT       Display title. Defaults to filename without extension.
  --out  DIR         Output directory. Defaults to ./books/<slug>/
  --chunker MODE     heading (default) | page | none
  --no-index         Skip indexing into Lucid (just produce markdown).

OUTPUT
  ./books/<slug>/001-<title>.md, 002-<title>.md, ..., _manifest.json
`;

const SKILL_HELP =
`lucid book skill <slug> [options]

Generate a SKILL.md router that auto-loads when relevant topics come up.
The skill itself is a thin router (~100 tokens) — retrieval happens via Lucid.

OPTIONS
  --title  TEXT      Override display title (defaults to manifest).
  --topics LIST      Comma-separated trigger topics (e.g. "naming,functions").
  --scope  SCOPE     user (default, ~/.claude/skills) | project (.claude/skills)
`;

const LIST_HELP =
`lucid book list [options]

OPTIONS
  --dir DIR         Books root. Defaults to ./books/
`;
