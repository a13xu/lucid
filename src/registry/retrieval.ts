import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  handleGetContext, GetContextSchema,
  handleGetRecent, GetRecentSchema,
} from "../tools/context.js";
import { handleSmartContext, SmartContextSchema } from "../tools/smart-context.js";
import { handleSuggestModel, SuggestModelSchema } from "../tools/model-advisor.js";
import { handleCompressText, CompressTextSchema } from "../tools/compress.js";
import { tx, type RegistryCtx, type ToolMap, type ToolReturn } from "./shared.js";

const suggestModelOutputShape = {
  model: z.enum(["haiku", "sonnet"]),
  model_id: z.string(),
  reasoning: z.string(),
  context_budget: z.number().int(),
} as const;

const compressTextOutputShape = {
  compressed: z.string(),
  original_length: z.number().int(),
  compressed_length: z.number().int(),
  ratio_kept: z.number(),
  method: z.string(),
  tokens_saved: z.number().int(),
} as const;

export function registerRetrievalTools(server: McpServer, ctx: RegistryCtx): ToolMap {
  const { stmts } = ctx;

  const suggestModelRich = (args: z.infer<typeof SuggestModelSchema>): ToolReturn => {
    const text = handleSuggestModel(args);
    return { text, structured: JSON.parse(text) as Record<string, unknown> };
  };

  const compressTextRich = async (args: z.infer<typeof CompressTextSchema>): Promise<ToolReturn> => {
    const text = await handleCompressText(args);
    return { text, structured: JSON.parse(text) as Record<string, unknown> };
  };

  return {
    get_context: server.registerTool("get_context", {
      title: "Get Context",
      description:
        "Retrieve the minimal relevant context for a task or query. TF-IDF (or Qdrant) ranking " +
        "+ recency boost + skeleton pruning to stay within token budget.",
      inputSchema: GetContextSchema.shape,
    }, tx("get_context", async (args) => handleGetContext(stmts, args))),

    get_recent: server.registerTool("get_recent", {
      title: "Get Recent",
      description:
        "Return files modified recently with line-level diffs. Useful after a git pull or session resume.",
      inputSchema: GetRecentSchema.shape,
    }, tx("get_recent", (args) => handleGetRecent(stmts, args))),

    smart_context: server.registerTool("smart_context", {
      title: "Smart Context",
      description:
        "Combined: knowledge graph (recall) + code files (get_context) in one call. " +
        "task_type adjusts token budget: simple=2000, moderate=6000, complex=12000.",
      inputSchema: SmartContextSchema.shape,
    }, tx("smart_context", async (args) => handleSmartContext(stmts, args))),

    suggest_model: server.registerTool("suggest_model", {
      title: "Suggest Model",
      description:
        "Classify task complexity → recommend Claude model. Returns { model, model_id, reasoning, context_budget }. " +
        "Call at the start of any workflow.",
      inputSchema: SuggestModelSchema.shape,
      outputSchema: suggestModelOutputShape,
    }, tx("suggest_model", (args) => suggestModelRich(args))),

    compress_text: server.registerTool("compress_text", {
      title: "Compress Text",
      description:
        "Compress text using LLMLingua-2 semantic compression. Model downloads ~700MB on first use " +
        "(cached in ~/.lucid/models/). Returns compressed text with stats.",
      inputSchema: CompressTextSchema.shape,
      outputSchema: compressTextOutputShape,
    }, tx("compress_text", async (args) => compressTextRich(args))),
  };
}
