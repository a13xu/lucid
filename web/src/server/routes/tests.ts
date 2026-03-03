import { Router } from "express";
import { stmts } from "../db";
import type { TestDefinitionRow, TestDefinitionWithLastRunRow, TestRunRow } from "../db";
import { runTest, saveTestRun, runAllForTask } from "../test-runner";

const router = Router();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function parseTestDef(row: TestDefinitionRow | TestDefinitionWithLastRunRow) {
  let headers: Record<string, string> = {};
  let assertions: unknown[] = [];
  try { headers = JSON.parse(row.headers); } catch { /* ignore */ }
  try { assertions = JSON.parse(row.assertions); } catch { /* ignore */ }
  return { ...row, headers, assertions };
}

function parseTestRun(row: TestRunRow) {
  let response_headers: Record<string, string> = {};
  let assertions_result: unknown[] = [];
  try { response_headers = JSON.parse(row.response_headers); } catch { /* ignore */ }
  try { assertions_result = JSON.parse(row.assertions_result); } catch { /* ignore */ }
  return { ...row, response_headers, assertions_result };
}

// ---------------------------------------------------------------------------
// GET /api/tasks/:taskId/tests
// ---------------------------------------------------------------------------
router.get("/tasks/:taskId/tests", (req, res) => {
  try {
    const taskId = Number(req.params.taskId);
    const tests = (stmts.getTestsWithLastRun.all(taskId) as TestDefinitionWithLastRunRow[]).map(parseTestDef);
    res.json(tests);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// POST /api/tasks/:taskId/tests
router.post("/tasks/:taskId/tests", (req, res) => {
  try {
    const taskId = Number(req.params.taskId);
    const { name, method, url, headers, body, assertions } = req.body as {
      name?: string;
      method?: string;
      url?: string;
      headers?: Record<string, string>;
      body?: string | null;
      assertions?: unknown[];
    };

    if (!name || !url) {
      res.status(400).json({ error: "name and url are required" });
      return;
    }

    const result = stmts.insertTestDef.run(
      taskId,
      name,
      method ?? "GET",
      url,
      JSON.stringify(headers ?? {}),
      body ?? null,
      JSON.stringify(assertions ?? [])
    );
    const id = result.lastInsertRowid as number;
    const row = stmts.getTestById.get(id) as TestDefinitionRow;
    res.status(201).json(parseTestDef(row));
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// POST /api/tasks/:taskId/tests/run-all
router.post("/tasks/:taskId/tests/run-all", async (req, res) => {
  try {
    const taskId = Number(req.params.taskId);
    const results = await runAllForTask(taskId);
    res.json(results.map(parseTestRun));
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// PUT /api/tests/:id
router.put("/tests/:id", (req, res) => {
  try {
    const id = Number(req.params.id);
    const { name, method, url, headers, body, assertions } = req.body as {
      name?: string;
      method?: string;
      url?: string;
      headers?: Record<string, string>;
      body?: string | null;
      assertions?: unknown[];
    };

    if (!name || !url) {
      res.status(400).json({ error: "name and url are required" });
      return;
    }

    const existing = stmts.getTestById.get(id) as TestDefinitionRow | undefined;
    if (!existing) {
      res.status(404).json({ error: "Test definition not found" });
      return;
    }

    stmts.updateTestDef.run(
      name,
      method ?? "GET",
      url,
      JSON.stringify(headers ?? {}),
      body ?? null,
      JSON.stringify(assertions ?? []),
      id
    );
    const updated = stmts.getTestById.get(id) as TestDefinitionRow;
    res.json(parseTestDef(updated));
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// DELETE /api/tests/:id
router.delete("/tests/:id", (req, res) => {
  try {
    const id = Number(req.params.id);
    const existing = stmts.getTestById.get(id) as TestDefinitionRow | undefined;
    if (!existing) {
      res.status(404).json({ error: "Test definition not found" });
      return;
    }
    stmts.deleteTestDef.run(id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// POST /api/tests/:id/run
router.post("/tests/:id/run", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const def = stmts.getTestById.get(id) as TestDefinitionRow | undefined;
    if (!def) {
      res.status(404).json({ error: "Test definition not found" });
      return;
    }
    const result = await runTest(def);
    const row = saveTestRun(id, result);
    res.json(parseTestRun(row));
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /api/tests/:id/runs
router.get("/tests/:id/runs", (req, res) => {
  try {
    const id = Number(req.params.id);
    const runs = (stmts.getRunsByTestDefId.all(id) as TestRunRow[]).map(parseTestRun);
    res.json(runs);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

export default router;
