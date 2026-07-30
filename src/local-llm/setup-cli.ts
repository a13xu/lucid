/**
 * Interactive `lucid local <subcmd>` CLI.
 * Subcommands: init | status | test | disable | pull
 */

import { createInterface, type Interface } from "readline";
import { spawn } from "child_process";
import {
  loadLocalConfig, saveLocalConfig, disableLocalConfig, getConfigPath,
} from "./config.js";
import { autoDetectLocal, probeEndpoint, describeRuntime } from "./runtimes.js";
import { generate, ping } from "./client.js";
import type { DetectedRuntime, LocalLlmConfig, RuntimeKind } from "./types.js";

const RECOMMENDED_MODELS = [
  { name: "qwen2.5-coder:1.5b", size: "~1 GB",  note: "fast on CPU (~30 tok/s)  — recommended for brief synthesis" },
  { name: "qwen2.5-coder:3b",   size: "~3 GB",  note: "balanced (~15 tok/s on CPU)" },
  { name: "qwen2.5-coder:7b",   size: "~7 GB",  note: "best quality (~7 tok/s on CPU; 60+ on GPU)" },
];

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

export async function runLocalLlmCli(args: string[]): Promise<number> {
  const sub = args[0];
  if (sub === "init")    return await cmdInit(args.slice(1));
  if (sub === "status")  return await cmdStatus();
  if (sub === "test")    return await cmdTest();
  if (sub === "disable") return cmdDisable();
  if (sub === "pull")    return await cmdPull(args.slice(1));
  process.stderr.write(`Usage: lucid local <init|status|test|disable|pull <model>>\n`);
  return 64;
}

// ---------------------------------------------------------------------------
// init — guided 5-step setup
// ---------------------------------------------------------------------------

async function cmdInit(_args: string[]): Promise<number> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    process.stdout.write("\n🤖  Lucid Local LLM — interactive setup\n");
    process.stdout.write(`     Config will be saved to ${getConfigPath()}\n\n`);

    // ── Step 1: detect or accept remote endpoint ──────────────────────────
    process.stdout.write("Step 1/5  Detecting local runtimes…\n");
    const detected = await autoDetectLocal();

    let chosen: DetectedRuntime | null = null;
    if (detected.length > 0) {
      process.stdout.write(`  Found ${detected.length} runtime(s):\n`);
      detected.forEach((d, i) => {
        process.stdout.write(`    [${i + 1}] ${describeRuntime(d.kind)}  ${d.endpoint}  (${d.latency_ms}ms, ${d.models?.length ?? 0} models)\n`);
      });
      process.stdout.write(`    [r] Enter remote endpoint URL\n`);
      process.stdout.write(`    [s] Skip — show install instructions\n`);
      const ans = (await ask(rl, "  Choice [1]: ")).trim().toLowerCase() || "1";

      if (ans === "s") { showInstallInstructions(); return 0; }
      if (ans === "r") {
        chosen = await promptRemoteEndpoint(rl);
        if (!chosen) return 1;
      } else {
        const idx = Number(ans) - 1;
        if (Number.isFinite(idx) && idx >= 0 && idx < detected.length) {
          chosen = detected[idx]!;
        } else {
          process.stderr.write("  Invalid choice.\n"); return 64;
        }
      }
    } else {
      process.stdout.write("  No local runtime detected on common ports (11434, 1234, 8080, 8000).\n");
      process.stdout.write("    [r] Enter remote endpoint URL\n");
      process.stdout.write("    [s] Show install instructions and exit\n");
      const ans = (await ask(rl, "  Choice [r]: ")).trim().toLowerCase() || "r";
      if (ans === "s") { showInstallInstructions(); return 0; }
      chosen = await promptRemoteEndpoint(rl);
      if (!chosen) return 1;
    }

    // ── Step 2: choose model ──────────────────────────────────────────────
    process.stdout.write("\nStep 2/5  Choose model\n");
    if (chosen.models && chosen.models.length > 0) {
      process.stdout.write("  Already pulled on this runtime:\n");
      chosen.models.slice(0, 10).forEach((m, i) => process.stdout.write(`    [${i + 1}] ${m}\n`));
      process.stdout.write("    [n] None of these — show recommended downloads\n");
      const ans = (await ask(rl, "  Choice [n]: ")).trim().toLowerCase() || "n";
      if (ans !== "n") {
        const models = chosen.models;
        const idx = Number(ans) - 1;
        if (Number.isFinite(idx) && idx >= 0 && idx < models.length) {
          const model = models[idx]!;
          return await finalizeSetup(rl, chosen.kind, chosen.endpoint, model, false);
        }
      }
    }

    process.stdout.write("\n  Recommended (Python-specialized coders):\n");
    RECOMMENDED_MODELS.forEach((m, i) => {
      process.stdout.write(`    [${i + 1}] ${m.name.padEnd(24)} ${m.size.padEnd(7)} ${m.note}\n`);
    });
    process.stdout.write("    [c] Custom model name (already pulled or to pull)\n");
    const mAns = (await ask(rl, "  Choice [1]: ")).trim().toLowerCase() || "1";

    let modelName: string;
    if (mAns === "c") {
      modelName = (await ask(rl, "  Model name (e.g. qwen2.5-coder:7b): ")).trim();
      if (!modelName) { process.stderr.write("  Empty name.\n"); return 64; }
    } else {
      const idx = Number(mAns) - 1;
      if (!Number.isFinite(idx) || idx < 0 || idx >= RECOMMENDED_MODELS.length) {
        process.stderr.write("  Invalid choice.\n"); return 64;
      }
      modelName = RECOMMENDED_MODELS[idx]!.name;
    }

    return await finalizeSetup(rl, chosen.kind, chosen.endpoint, modelName, true);
  } finally {
    rl.close();
  }
}

async function finalizeSetup(
  rl: Interface, kind: RuntimeKind, endpoint: string, model: string, mayPull: boolean,
): Promise<number> {
  // ── Step 3: optional pull ─────────────────────────────────────────────
  if (mayPull && kind === "ollama") {
    const pullAns = (await ask(rl, `\nStep 3/5  Pull "${model}" via ollama now? [Y/n]: `)).trim().toLowerCase();
    if (pullAns === "" || pullAns === "y" || pullAns === "yes") {
      const code = await streamPull(model);
      if (code !== 0) {
        process.stderr.write(`  ⚠️  ollama pull exited with code ${code}. You can rerun: ollama pull ${model}\n`);
      }
    }
  } else {
    process.stdout.write("\nStep 3/5  Skipping model pull (handled by runtime).\n");
  }

  // ── Step 4: test ──────────────────────────────────────────────────────
  process.stdout.write("\nStep 4/5  Testing endpoint…\n");
  const probeCfg: LocalLlmConfig = {
    enabled: true, runtime: kind, endpoint, model,
    timeout_ms: 30_000,
    configured_at: new Date().toISOString(),
  };
  const reach = await ping(probeCfg);
  if (!reach.ok) {
    process.stderr.write(`  ❌ Endpoint not reachable: ${reach.detail ?? "?"}\n`);
    const cont = (await ask(rl, "  Save config anyway? [y/N]: ")).trim().toLowerCase();
    if (cont !== "y" && cont !== "yes") return 1;
  } else {
    process.stdout.write(`  ✓ Endpoint reachable (${reach.latency_ms}ms). Running 1-token generate…\n`);
    try {
      const out = await generate(probeCfg, { prompt: "Say OK.", max_tokens: 8, temperature: 0 });
      const preview = out.text.replace(/\s+/g, " ").trim().slice(0, 60);
      process.stdout.write(`  ✓ Model responded in ${out.latency_ms}ms: "${preview}"\n`);
    } catch (e) {
      process.stderr.write(`  ⚠️  Generation failed: ${(e as Error).message}\n`);
      const cont = (await ask(rl, "  Save config anyway? [y/N]: ")).trim().toLowerCase();
      if (cont !== "y" && cont !== "yes") return 1;
    }
  }

  // ── Step 5: save ──────────────────────────────────────────────────────
  saveLocalConfig(probeCfg);
  process.stdout.write(`\nStep 5/5  ✅ Saved → ${getConfigPath()}\n`);
  process.stdout.write(`\nRestart Claude Code to activate. delegate_local() will then be available.\n\n`);
  return 0;
}

async function promptRemoteEndpoint(rl: Interface): Promise<DetectedRuntime | null> {
  const url = (await ask(rl, "  Endpoint URL (e.g. http://gpu.lan:11434): ")).trim();
  if (!url) return null;
  const apiKey = (await ask(rl, "  Bearer token (optional, press Enter to skip): ")).trim();
  process.stdout.write(`  Probing ${url}…\n`);
  const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined;
  const det = await probeEndpoint(url, headers);
  if (!det) {
    process.stderr.write(`  ❌ No Ollama or OpenAI-compatible endpoint found at ${url}\n`);
    return null;
  }
  process.stdout.write(`  ✓ ${describeRuntime(det.kind)} detected (${det.latency_ms}ms, ${det.models?.length ?? 0} models)\n`);
  // Stash the api key on the returned struct via a side channel (set on cfg later).
  if (apiKey) (det as DetectedRuntime & { api_key?: string }).api_key = apiKey;
  return det;
}

// ---------------------------------------------------------------------------
// status / test / disable / pull
// ---------------------------------------------------------------------------

async function cmdStatus(): Promise<number> {
  const cfg = loadLocalConfig();
  if (!cfg) {
    process.stdout.write("Local LLM: not configured. Run `lucid local init`.\n");
    return 0;
  }
  process.stdout.write([
    `Local LLM: ${cfg.enabled ? "enabled" : "disabled"}`,
    `  runtime:  ${describeRuntime(cfg.runtime)}`,
    `  endpoint: ${cfg.endpoint}`,
    `  model:    ${cfg.model}`,
    `  api_key:  ${cfg.api_key ? "(set)" : "(none)"}`,
    `  config:   ${getConfigPath()}`,
    `  saved at: ${cfg.configured_at}`,
  ].join("\n") + "\n");

  const reach = await ping(cfg);
  process.stdout.write(`  reachable: ${reach.ok ? `✓ ${reach.latency_ms}ms` : `✗ ${reach.detail ?? "?"}`}\n`);
  return 0;
}

async function cmdTest(): Promise<number> {
  const cfg = loadLocalConfig();
  if (!cfg) { process.stderr.write("Not configured. Run `lucid local init` first.\n"); return 1; }
  process.stdout.write(`Testing ${cfg.model} on ${cfg.endpoint}…\n`);
  try {
    const out = await generate(cfg, {
      prompt: "Write a one-line Python function that returns the square of its argument.",
      max_tokens: 64, temperature: 0.1,
    });
    process.stdout.write(`✓ ${out.latency_ms}ms (prompt=${out.prompt_tokens ?? "?"}, completion=${out.completion_tokens ?? "?"})\n`);
    process.stdout.write(`---\n${out.text.trim()}\n---\n`);
    return 0;
  } catch (e) {
    process.stderr.write(`✗ ${(e as Error).message}\n`);
    return 1;
  }
}

function cmdDisable(): number {
  const ok = disableLocalConfig();
  process.stdout.write(ok ? "Local LLM disabled.\n" : "Nothing to disable (not configured).\n");
  return 0;
}

async function cmdPull(args: string[]): Promise<number> {
  const cfg = loadLocalConfig();
  const model = args[0] ?? cfg?.model;
  if (!model) { process.stderr.write("Usage: lucid local pull <model>\n"); return 64; }
  if (cfg && cfg.runtime !== "ollama") {
    process.stderr.write(`pull is only supported for Ollama runtimes. For ${describeRuntime(cfg.runtime)}, fetch the model via its own UI.\n`);
    return 64;
  }
  return await streamPull(model);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ask(rl: Interface, prompt: string): Promise<string> {
  return new Promise((resolveAns) => rl.question(prompt, resolveAns));
}

async function streamPull(model: string): Promise<number> {
  return new Promise((resolveCode) => {
    const proc = spawn("ollama", ["pull", model], { stdio: "inherit" });
    proc.on("error", (e) => {
      process.stderr.write(`  ⚠️  Could not run ollama: ${e.message}\n`);
      process.stderr.write(`     Install Ollama first (see \`lucid local init\` step 1 instructions).\n`);
      resolveCode(127);
    });
    proc.on("exit", (code) => resolveCode(code ?? 0));
  });
}

function showInstallInstructions(): void {
  process.stdout.write([
    "",
    "──────────────────────────────────────────────────────────────",
    "Install a local LLM runtime, then re-run `lucid local init`.",
    "",
    "  Ollama  (recommended, simplest):",
    "    Windows:  winget install Ollama.Ollama",
    "    macOS:    brew install ollama  (or download from ollama.com/download)",
    "    Linux:    curl -fsSL https://ollama.com/install.sh | sh",
    "",
    "  LM Studio (GUI, OpenAI-compatible server):",
    "    Download: https://lmstudio.ai/",
    "    Start the local server in the GUI before re-running setup.",
    "",
    "  llama.cpp server (advanced):",
    "    https://github.com/ggerganov/llama.cpp  →  ./server -m model.gguf",
    "",
    "  Remote endpoint:",
    "    Any of the above hosted on another machine — re-run init and",
    "    pick `[r] Enter remote endpoint URL`. Bearer auth supported.",
    "──────────────────────────────────────────────────────────────",
    "",
  ].join("\n"));
}
