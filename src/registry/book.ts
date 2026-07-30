import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  handleIngestBook, IngestBookSchema,
  handleGenerateBookSkill, GenerateBookSkillSchema,
  handleListBooks, ListBooksSchema,
} from "../tools/book.js";
import { tx, type RegistryCtx, type ToolMap } from "./shared.js";

export function registerBookTools(server: McpServer, ctx: RegistryCtx): ToolMap {
  const { stmts } = ctx;

  return {
    ingest_book: server.registerTool("ingest_book", {
      title: "Ingest Book",
      description:
        "Convert a book (PDF, EPUB, DOCX, or Markdown) into chunked markdown files " +
        "under ./books/<slug>/ and index every chunk into Lucid. Requires user-installed " +
        "converter (pymupdf4llm for PDF, pandoc for EPUB/DOCX). Pair with generate_book_skill " +
        "to make the corpus auto-load as a Claude Code skill.",
      inputSchema: IngestBookSchema.shape,
    }, tx("ingest_book", (args) => handleIngestBook(stmts, args))),

    generate_book_skill: server.registerTool("generate_book_skill", {
      title: "Generate Book Skill",
      description:
        "Emit a thin SKILL.md router into ~/.claude/skills/book-<slug>/ (or .claude/skills/ " +
        "for project scope). The skill auto-loads (~100 tokens) when its trigger topics come up " +
        "and delegates retrieval to smart_context. Run after ingest_book.",
      inputSchema: GenerateBookSkillSchema.shape,
    }, tx("generate_book_skill", (args) => handleGenerateBookSkill(args))),

    list_books: server.registerTool("list_books", {
      title: "List Books",
      description: "List ingested books under ./books/ with chunk counts and ingestion dates.",
      inputSchema: ListBooksSchema.shape,
    }, tx("list_books", (args) => handleListBooks(args))),
  };
}
