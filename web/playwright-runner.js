// Playwright E2E test execution engine
// Wraps stored test code in a sandboxed .mjs subprocess that imports
// playwright, runs the steps, and returns JSON results via stdout.

import { spawn }              from "child_process";
import { writeFileSync, unlinkSync, mkdirSync } from "fs";
import { join }               from "path";
import { randomUUID }         from "crypto";
import { fileURLToPath }      from "url";
import { dirname }            from "path";

const __dirname  = dirname(fileURLToPath(import.meta.url));
// Temp files must live inside lucid/web/ so ESM can resolve playwright from node_modules
const TMP_DIR    = join(__dirname, "tmp");
mkdirSync(TMP_DIR, { recursive: true });

const TIMEOUT_MS = 60_000; // max 60 s per test

// ── Wrapper template ─────────────────────────────────────────────────────────
// The generated test code (injected at __CODE__) has access to:
//   page, context, browser, baseURL
//   step(name, pass, data?)  — record an assertion step
//   shot(name?)              — take + attach a JPEG screenshot to steps

function buildWrapper(baseURL, code) {
  return `
import { chromium } from 'playwright';

const baseURL = ${JSON.stringify(baseURL)};
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ baseURL });
const page    = await context.newPage();

const steps   = [];
const _t0     = Date.now();

function step(name, pass, data = {}) {
  steps.push({ name, pass, data, ts: Date.now() });
}

async function shot(name) {
  try {
    const buf = await page.screenshot({ type: 'jpeg', quality: 55 });
    steps.push({ name: name ?? 'screenshot', screenshot: 'data:image/jpeg;base64,' + buf.toString('base64'), ts: Date.now() });
  } catch {}
}

try {
  ${code}

  process.stdout.write(JSON.stringify({
    status: 'pass',
    steps,
    duration_ms: Date.now() - _t0,
  }));
} catch (_err) {
  try { await shot('error-state'); } catch {}
  process.stdout.write(JSON.stringify({
    status: 'fail',
    steps,
    error:  _err.message,
    duration_ms: Date.now() - _t0,
  }));
} finally {
  await browser.close();
}
`.trim();
}

// ── Main export ──────────────────────────────────────────────────────────────

export async function executeTest(testCode, { baseURL = "http://localhost:3069" } = {}) {
  const tmpFile = join(TMP_DIR, `pw-test-${randomUUID()}.mjs`);
  const src     = buildWrapper(baseURL, testCode);

  writeFileSync(tmpFile, src, "utf8");

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";

    const proc = spawn("node", [tmpFile], {
      cwd:  __dirname,          // so playwright resolves from lucid/web/node_modules
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });

    const killer = setTimeout(() => {
      proc.kill("SIGTERM");
      resolve({ status: "error", error: `Timeout after ${TIMEOUT_MS / 1000}s`, steps: [], duration_ms: TIMEOUT_MS });
    }, TIMEOUT_MS);

    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", (d) => { stderr += d.toString(); });

    proc.on("close", () => {
      clearTimeout(killer);
      try {
        unlinkSync(tmpFile);
      } catch {}

      if (!stdout.trim()) {
        resolve({ status: "error", error: stderr.slice(0, 500) || "No output", steps: [], duration_ms: 0 });
        return;
      }

      try {
        const result = JSON.parse(stdout);
        resolve(result);
      } catch {
        resolve({ status: "error", error: `Parse error: ${stdout.slice(0, 300)}`, steps: [], duration_ms: 0 });
      }
    });

    proc.on("error", (err) => {
      clearTimeout(killer);
      try { unlinkSync(tmpFile); } catch {}
      resolve({ status: "error", error: err.message, steps: [], duration_ms: 0 });
    });
  });
}
