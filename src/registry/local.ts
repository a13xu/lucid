import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  handleDelegateLocal, DelegateLocalSchema,
  handleLocalLlmStatus, LocalLlmStatusSchema,
} from "../tools/delegate-local.js";
import { tx, type RegistryCtx, type ToolMap } from "./shared.js";

export function registerLocalTools(server: McpServer, _ctx: RegistryCtx): ToolMap {
  return {
    delegate_local: server.registerTool("delegate_local", {
      title: "Delegate to Local LLM",
      description:
        "Send a prompt to the user-configured local LLM (Ollama / LM Studio / llama.cpp / remote " +
        "endpoint). Returns the raw completion. Configure once via `lucid local init`. Best for " +
        "small specialized tasks (docstrings, type hints, simple refactors, regex). Claude should " +
        "review the output before applying it via Edit/Write.",
      inputSchema: DelegateLocalSchema.shape,
    }, tx("delegate_local", async (args) => handleDelegateLocal(args))),

    local_llm_status: server.registerTool("local_llm_status", {
      title: "Local LLM Status",
      description:
        "Inspect the local-LLM configuration: runtime, endpoint, model, reachability. " +
        "Returns setup instructions if not yet configured.",
      inputSchema: LocalLlmStatusSchema.shape,
    }, tx("local_llm_status", async () => handleLocalLlmStatus())),
  };
}
