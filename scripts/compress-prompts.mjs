#!/usr/bin/env node
// Build-time prompt compression for Lucid.
//
// Reads CHECKLIST and CODING_RULES from the compiled build/, runs them through
// LLMLingua-2 (semantic token-importance pruning), and writes the compressed
// versions to ~/.lucid/compressed-prompts/. The runtime guardian modules pick
// these up automatically on next start.
//
// Usage:   npm run build && npm run compress-prompts
// Disable: rm -rf ~/.lucid/compressed-prompts/   (originals are restored)
//
// First run downloads ~700MB (LLMLingua-2 ONNX model) into ~/.lucid/models/.

import { mkdirSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";
import { fileURLToPath, pathToFileURL } from "url";

const SCRIPT_DIR = fileURLToPath(new URL(".", import.meta.url));
const ROOT       = resolve(SCRIPT_DIR, "..");
const BUILD_DIR  = join(ROOT, "build");

// Conservative ratio: keep 65% of tokens. Higher than default 0.5 because
// these are checklists with structural markers we can't afford to lose.
const TARGET_RATIO = 0.65;

// Force compression regardless of input length (default min_length=300 would
// process both, but be explicit).
const MIN_LENGTH = 100;

const OUT_DIR = join(homedir(), ".lucid", "compressed-prompts");

function approxTokens(text) {
  // Rough heuristic matching Lucid's own estimator (~4 chars per token for English).
  return Math.ceil(text.length / 4);
}

async function dynImport(relPath) {
  const url = pathToFileURL(join(BUILD_DIR, relPath)).href;
  return import(url);
}

const DRY_RUN = process.argv.includes("--dry-run");

async function main() {
  console.log("Lucid prompt compression" + (DRY_RUN ? " (DRY RUN)" : ""));
  console.log(`  build dir: ${BUILD_DIR}`);
  console.log(`  output:    ${OUT_DIR}`);
  console.log(`  ratio:     ${TARGET_RATIO} (keep ~${Math.round(TARGET_RATIO * 100)}% of tokens)`);
  console.log("");

  let semantic, checklistMod, codingRulesMod;
  try {
    [semantic, checklistMod, codingRulesMod] = await Promise.all([
      dynImport("compression/semantic.js"),
      dynImport("guardian/checklist.js"),
      dynImport("guardian/coding-rules.js"),
    ]);
  } catch (err) {
    console.error("Failed to load compiled modules. Did you run `npm run build` first?");
    console.error(err.message);
    process.exit(1);
  }

  const { compressTextSemantic, isSemanticCompressionAvailable } = semantic;

  // Dry run: verify wiring (modules load, originals are exported) without
  // touching the 700MB model.
  if (DRY_RUN) {
    const checklist = checklistMod.ORIGINAL_CHECKLIST;
    const codingRules = codingRulesMod.ORIGINAL_CODING_RULES;
    if (!checklist || !codingRules) {
      console.error("FAIL: ORIGINAL_CHECKLIST or ORIGINAL_CODING_RULES not exported");
      process.exit(1);
    }
    console.log(`  checklist:    ${checklist.length} chars (~${approxTokens(checklist)} tokens)`);
    console.log(`  coding-rules: ${codingRules.length} chars (~${approxTokens(codingRules)} tokens)`);
    console.log("");
    console.log("Dry run OK. Re-run without --dry-run to compress (~700MB model download on first use).");
    return;
  }

  console.log("Checking LLMLingua-2 availability (downloads ~700MB on first run)...");
  const available = await isSemanticCompressionAvailable();
  if (!available) {
    console.error("LLMLingua-2 model is not available. Aborting.");
    process.exit(1);
  }

  mkdirSync(OUT_DIR, { recursive: true });

  // IMPORTANT: read the *originals*, not whatever loadCompressed() returned.
  // We re-export them as ORIGINAL_* so the script always compresses the source
  // text, even if a previous run already wrote a compressed version.
  const targets = [
    {
      name: "checklist",
      original: checklistMod.ORIGINAL_CHECKLIST ?? checklistMod.CHECKLIST,
      outFile: "checklist.txt",
    },
    {
      name: "coding-rules",
      original: codingRulesMod.ORIGINAL_CODING_RULES ?? codingRulesMod.CODING_RULES,
      outFile: "coding-rules.txt",
    },
  ];

  let totalSavedTokens = 0;
  for (const t of targets) {
    if (!t.original) {
      console.error(`  ${t.name}: SKIP — could not find original text export`);
      continue;
    }
    const before = t.original.length;
    const beforeTokens = approxTokens(t.original);

    process.stdout.write(`  ${t.name}: compressing ${before} chars (~${beforeTokens} tokens)... `);
    const result = await compressTextSemantic(t.original, TARGET_RATIO, MIN_LENGTH);
    const afterTokens = approxTokens(result.compressed);
    const savedTokens = beforeTokens - afterTokens;
    totalSavedTokens += savedTokens;

    writeFileSync(join(OUT_DIR, t.outFile), result.compressed, "utf-8");

    const pct = Math.round((1 - result.compressed.length / before) * 100);
    console.log(`done. ${result.compressed.length} chars (~${afterTokens} tokens), -${pct}% (saved ~${savedTokens} tokens) [${result.method}]`);
  }

  console.log("");
  console.log(`Total saved per get_checklist + coding_rules call pair: ~${totalSavedTokens} tokens`);
  console.log(`Compressed prompts written to: ${OUT_DIR}`);
  console.log("Restart the Lucid server (or Claude Code) to pick them up.");
  console.log("To revert: rm -rf " + OUT_DIR);
}

main().catch((err) => {
  console.error("\nCompression failed:");
  console.error(err.stack ?? err.message ?? err);
  process.exit(1);
});
