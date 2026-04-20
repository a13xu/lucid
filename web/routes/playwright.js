// Playwright E2E routes
//
//  GET  /api/e2e/tests                     — list all tests (with last run status)
//  GET  /api/e2e/tests/:id                 — test detail + run history
//  POST /api/e2e/generate/:taskId          — generate tests for a task via Claude
//  POST /api/e2e/tests                     — create test manually
//  PUT  /api/e2e/tests/:id                 — update test code/name
//  DELETE /api/e2e/tests/:id              — delete test
//  POST /api/e2e/tests/:id/run             — run a single test
//  POST /api/e2e/run-all                   — run all tests
//  POST /api/e2e/runs/:runId/create-bug    — create bug task from failed run
//  POST /api/e2e/trigger-by-file           — internal: run tests tagged with a file path

import { Router }          from "express";
import { db, stmts }      from "../db.js";
import { executeTest }    from "../playwright-runner.js";
import { broadcast }      from "../events.js";
import { claudePrint }    from "../claude-env.js";

const router = Router();

// ── helpers ───────────────────────────────────────────────────────────────────

function parseJSON(str, fallback) {
  try { return JSON.parse(str); } catch { return fallback; }
}

async function runAndSave(testId, triggeredBy = "manual") {
  const test = stmts.getPlaywrightTestById.get(testId);
  if (!test) throw new Error(`Test ${testId} not found`);

  const dataIn = { base_url: test.base_url, triggered_by: triggeredBy, ts: Date.now() };
  const runId  = stmts.insertPlaywrightRun.run(testId, JSON.stringify(dataIn), triggeredBy).lastInsertRowid;

  broadcast("e2e_run_start", { testId, runId, testName: test.name });

  const result = await executeTest(test.test_code, { baseURL: test.base_url });

  // Strip screenshots from steps for summary (keep them in data_out only)
  const stepsNoShots = (result.steps || []).map(s => ({ ...s, screenshot: undefined }));
  const dataOut = {
    steps: result.steps || [],
    pass_count:  (result.steps || []).filter(s => s.pass === true).length,
    fail_count:  (result.steps || []).filter(s => s.pass === false).length,
  };

  stmts.updatePlaywrightRun.run(
    result.status,
    JSON.stringify(dataOut),
    result.error ?? null,
    result.duration_ms ?? 0,
    runId
  );

  const run = stmts.getRunById.get(runId);
  broadcast("e2e_run_done", { testId, runId, status: result.status, testName: test.name });
  return run;
}

// ── List all tests ────────────────────────────────────────────────────────────

router.get("/e2e/tests", (_req, res) => {
  try {
    const tests = stmts.getAllPlaywrightTests.all();
    res.json(tests);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Test detail + history ─────────────────────────────────────────────────────

router.get("/e2e/tests/:id", (req, res) => {
  try {
    const test = stmts.getPlaywrightTestById.get(Number(req.params.id));
    if (!test) return res.status(404).json({ error: "Not found" });
    const runs = stmts.getRunsByTestId.all(test.id);
    res.json({ ...test, tags: parseJSON(test.tags, []), runs });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Generate tests for a task via Claude ─────────────────────────────────────

router.post("/e2e/generate/:taskId", async (req, res) => {
  const taskId = Number(req.params.taskId);
  const task   = stmts.getTaskById.get(taskId);
  if (!task) return res.status(404).json({ error: "Task not found" });

  const plan = db.prepare("SELECT * FROM plans WHERE id = ?").get(task.plan_id);

  const prompt = `You are a senior QA engineer writing Playwright E2E tests.

Application: Lucid Web UI running at http://localhost:3069 (Express + vanilla JS SPA, hash router)
Pages: / (Orchestrator), /plans (list), /plans/:id (detail + tasks), /plans/:id/tasks/:id/tests (HTTP test runner)

Task being tested:
  Plan: ${plan?.title ?? ""}
  Task #${task.seq}: ${task.title}
  Description: ${task.description || "none"}
  Test Criteria: ${task.test_criteria || "none"}

Write 1-3 Playwright test snippets. Each test is a SELF-CONTAINED JavaScript code block (NOT a function definition) that uses these pre-injected variables:
  - page       — Playwright Page object (async methods)
  - baseURL    — 'http://localhost:3069'
  - step(name, pass, data?)  — record an assertion (pass=true/false)
  - shot(name?)              — take a screenshot

Rules:
- Each test block ends successfully or throws an Error
- Use page.goto(), page.click(), page.fill(), page.waitForSelector(), page.textContent() etc.
- Use step() to record every assertion you make
- Do NOT use test(), describe(), expect() — those are Jest/Playwright Test API, not available here
- Keep code concise, focus on the test_criteria above

Return ONLY a JSON array of test objects, no markdown:
[
  {
    "name": "Short test name",
    "description": "What this test verifies",
    "tags": ["plans", "navigation"],
    "code": "await page.goto(baseURL + '/#/plans');\\nconst title = await page.textContent('.page-title');\\nstep('Plans page loaded', title.includes('Plans'), { title });"
  }
]

JSON array:`;

  try {
    const stdout = await claudePrint(prompt, { timeoutMs: 90_000 });

    const match  = stdout.match(/\[[\s\S]*\]/);
    if (!match) throw new Error("No JSON array in response");
    const defs   = JSON.parse(match[0]);
    if (!Array.isArray(defs) || !defs.length) throw new Error("Empty array");

    const created = [];
    for (const d of defs) {
      const tags = JSON.stringify(Array.isArray(d.tags) ? d.tags : []);
      const id   = stmts.insertPlaywrightTest.run(
        taskId,
        String(d.name || "Generated test"),
        String(d.description || ""),
        String(d.code || ""),
        "http://localhost:3069",
        tags,
      ).lastInsertRowid;
      created.push(stmts.getPlaywrightTestById.get(id));
    }
    res.json({ tests: created });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Create test manually ──────────────────────────────────────────────────────

router.post("/e2e/tests", (req, res) => {
  const { task_id, name, description, test_code, base_url, tags } = req.body ?? {};
  if (!name || !test_code) return res.status(400).json({ error: "name and test_code required" });
  try {
    const id = stmts.insertPlaywrightTest.run(
      task_id ?? null,
      name, description ?? "",
      test_code,
      base_url ?? "http://localhost:3069",
      JSON.stringify(Array.isArray(tags) ? tags : []),
    ).lastInsertRowid;
    res.json(stmts.getPlaywrightTestById.get(id));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Update test ───────────────────────────────────────────────────────────────

router.put("/e2e/tests/:id", (req, res) => {
  const { name, description, test_code, base_url, tags } = req.body ?? {};
  const test = stmts.getPlaywrightTestById.get(Number(req.params.id));
  if (!test) return res.status(404).json({ error: "Not found" });
  try {
    stmts.updatePlaywrightTest.run(
      name ?? test.name,
      description ?? test.description,
      test_code ?? test.test_code,
      base_url ?? test.base_url,
      JSON.stringify(Array.isArray(tags) ? tags : parseJSON(test.tags, [])),
      test.id,
    );
    res.json(stmts.getPlaywrightTestById.get(test.id));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Delete test ───────────────────────────────────────────────────────────────

router.delete("/e2e/tests/:id", (req, res) => {
  try {
    stmts.deletePlaywrightTest.run(Number(req.params.id));
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Run single test ───────────────────────────────────────────────────────────

router.post("/e2e/tests/:id/run", async (req, res) => {
  try {
    const run = await runAndSave(Number(req.params.id), "manual");
    res.json(run);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Run all tests ─────────────────────────────────────────────────────────────

router.post("/e2e/run-all", async (req, res) => {
  const { triggered_by = "manual" } = req.body ?? {};
  try {
    const tests = stmts.getAllPlaywrightTests.all();
    res.json({ queued: tests.length });
    // Run sequentially in background (avoid parallel browser instances)
    (async () => {
      for (const t of tests) {
        try { await runAndSave(t.id, triggered_by); } catch {}
      }
    })();
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Auto-trigger tests by file path ──────────────────────────────────────────
// Called internally by auto-tools after sync_file

router.post("/e2e/trigger-by-file", async (req, res) => {
  const { file_path } = req.body ?? {};
  if (!file_path) return res.status(400).json({ error: "file_path required" });

  // Extract keywords from the file path segments
  const keywords = file_path
    .replace(/\\/g, "/")
    .split("/")
    .pop()                            // filename only
    .replace(/\.[^.]+$/, "")         // strip extension
    .replace(/[-_]/g, " ")
    .toLowerCase()
    .split(/\s+/)
    .filter(k => k.length > 2);

  const triggered = [];
  for (const kw of keywords) {
    const tests = stmts.getTestsByTag.all(`%${kw}%`);
    for (const t of tests) {
      if (!triggered.includes(t.id)) {
        triggered.push(t.id);
      }
    }
  }

  res.json({ triggered: triggered.length });

  // Run matched tests in background
  (async () => {
    for (const id of triggered) {
      try { await runAndSave(id, "sync"); } catch {}
    }
  })();
});

// ── Create bug task from failed run ──────────────────────────────────────────

router.post("/e2e/runs/:runId/create-bug", (req, res) => {
  const run  = stmts.getRunById.get(Number(req.params.runId));
  if (!run)  return res.status(404).json({ error: "Run not found" });

  const test = stmts.getPlaywrightTestById.get(run.test_id);
  if (!test) return res.status(404).json({ error: "Test not found" });

  const { plan_id } = req.body ?? {};
  if (!plan_id) return res.status(400).json({ error: "plan_id required" });

  const plan = stmts.getPlanById.get(Number(plan_id));
  if (!plan) return res.status(404).json({ error: "Plan not found" });

  const dataOut = parseJSON(run.data_out, {});
  const failedSteps = (dataOut.steps || []).filter(s => s.pass === false);

  const bugTitle = `BUG: ${test.name} — E2E test failed`;
  const bugDesc  = [
    `Playwright test "${test.name}" failed (run #${run.id}).`,
    run.error_msg ? `Error: ${run.error_msg}` : "",
    failedSteps.length
      ? `Failed assertions:\n${failedSteps.map(s => `  - ${s.name}`).join("\n")}`
      : "",
    `Duration: ${run.duration_ms}ms`,
    `Triggered by: ${run.triggered_by}`,
  ].filter(Boolean).join("\n");

  const bugCriteria = `All assertions in test "${test.name}" must pass`;

  try {
    // Find next seq in plan
    const tasks = stmts.getTasksByPlanId.all(Number(plan_id));
    const seq   = (tasks.at(-1)?.seq ?? 0) + 1;

    const taskId = stmts.insertPlanTask.run(
      Number(plan_id), seq, bugTitle, bugDesc, bugCriteria
    ).lastInsertRowid;

    res.json({ task_id: taskId, plan_id: Number(plan_id) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
