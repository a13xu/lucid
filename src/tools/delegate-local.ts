import { z } from "zod";
import { loadLocalConfig } from "../local-llm/config.js";
import { generate, ping, LocalLlmError } from "../local-llm/client.js";
import { describeRuntime } from "../local-llm/runtimes.js";

// ---------------------------------------------------------------------------
// delegate_local — direct passthrough to the configured local LLM
// ---------------------------------------------------------------------------

export const DelegateLocalSchema = z.object({
  prompt:      z.string().min(1).describe("User prompt for the local model."),
  system:      z.string().optional().describe("Optional system prompt (Python coding role, conventions, …)."),
  max_tokens:  z.number().int().positive().max(8192).optional().describe("Cap on completion tokens. Default 2048."),
  temperature: z.number().min(0).max(2).optional().describe("Sampling temperature. Default 0.2 (deterministic)."),
  model:       z.string().optional().describe("Override the configured default model."),
});

export async function handleDelegateLocal(
  args: z.infer<typeof DelegateLocalSchema>,
): Promise<string> {
  const cfg = loadLocalConfig();
  if (!cfg) {
    return [
      `❌ Local LLM not configured.`,
      `   Run in your terminal:  lucid local init`,
      `   Then restart Claude Code so the new config is picked up.`,
    ].join("\n");
  }
  if (!cfg.enabled) {
    return `❌ Local LLM is disabled in ${cfg.endpoint} config. Run \`lucid local init\` to re-enable.`;
  }

  const effective = args.model ? { ...cfg, model: args.model } : cfg;

  try {
    const res = await generate(effective, {
      prompt:      args.prompt,
      system:      args.system,
      max_tokens:  args.max_tokens,
      temperature: args.temperature,
    });

    const tokens = res.prompt_tokens !== undefined && res.completion_tokens !== undefined
      ? `prompt=${res.prompt_tokens}, completion=${res.completion_tokens}`
      : "tokens=?";

    return [
      `🤖 ${effective.model} via ${describeRuntime(effective.runtime)} (${res.latency_ms}ms, ${tokens})`,
      ``,
      res.text.trim(),
    ].join("\n");
  } catch (e) {
    if (e instanceof LocalLlmError) {
      return `❌ ${e.message}`;
    }
    return `❌ Unexpected error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

// ---------------------------------------------------------------------------
// local_llm_status — informational
// ---------------------------------------------------------------------------

export const LocalLlmStatusSchema = z.object({});

export async function handleLocalLlmStatus(): Promise<string> {
  const cfg = loadLocalConfig();
  if (!cfg) {
    return [
      `Local LLM: not configured.`,
      ``,
      `To set it up, run in your terminal:  lucid local init`,
      `It walks you through runtime detection (Ollama / LM Studio / llama.cpp /`,
      `remote endpoint), model selection, and a reachability test.`,
    ].join("\n");
  }

  const reach = await ping(cfg);
  return [
    `Local LLM: ${cfg.enabled ? "enabled" : "disabled"}`,
    `  runtime:   ${describeRuntime(cfg.runtime)}`,
    `  endpoint:  ${cfg.endpoint}`,
    `  model:     ${cfg.model}`,
    `  reachable: ${reach.ok ? `✓ ${reach.latency_ms}ms` : `✗ ${reach.detail ?? "?"}`}`,
    `  saved at:  ${cfg.configured_at}`,
  ].join("\n");
}
