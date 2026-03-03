import { Router } from "express";
import { stmts } from "../db";
import type { PlanTaskRow, TestDefinitionRow, TestDefinitionWithLastRunRow } from "../db";

const router = Router();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function parseTask(row: PlanTaskRow) {
  let notes: Array<{ text: string; ts: number }> = [];
  try { notes = JSON.parse(row.notes); } catch { /* ignore */ }
  return { ...row, notes };
}

function parseTestDef(row: TestDefinitionRow | TestDefinitionWithLastRunRow) {
  let headers: Record<string, string> = {};
  let assertions: unknown[] = [];
  try { headers = JSON.parse(row.headers); } catch { /* ignore */ }
  try { assertions = JSON.parse(row.assertions); } catch { /* ignore */ }
  return { ...row, headers, assertions };
}

// GET /api/tasks/:id
router.get("/tasks/:id", (req, res) => {
  try {
    const id = Number(req.params.id);
    const task = stmts.getTaskById.get(id) as PlanTaskRow | undefined;
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    const tests = (stmts.getTestsWithLastRun.all(id) as TestDefinitionWithLastRunRow[]).map(parseTestDef);
    res.json({ ...parseTask(task), tests });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// PATCH /api/tasks/:id
router.patch("/tasks/:id", (req, res) => {
  try {
    const id = Number(req.params.id);
    const { status, note } = req.body as { status?: string; note?: string };

    if (!status) {
      res.status(400).json({ error: "status is required" });
      return;
    }

    const task = stmts.getTaskById.get(id) as PlanTaskRow | undefined;
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }

    let notes: Array<{ text: string; ts: number }> = [];
    try { notes = JSON.parse(task.notes); } catch { /* ignore */ }
    if (note) {
      notes.push({ text: note, ts: Math.floor(Date.now() / 1000) });
    }

    stmts.updateTaskStatus.run(status, JSON.stringify(notes), id);

    // Auto-complete plan if all tasks done
    if (status === "done") {
      const remaining = stmts.countRemainingTasks.get(task.plan_id) as { count: number };
      if (remaining && remaining.count === 0) {
        stmts.updatePlanStatus.run("completed", task.plan_id);
      }
    }

    const updated = stmts.getTaskById.get(id) as PlanTaskRow;
    res.json(parseTask(updated));
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

export default router;
