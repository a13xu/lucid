import { Router } from "express";
import { stmts } from "../db.js";

const router = Router();

function parseTask(row) {
  let notes = [];
  try { notes = JSON.parse(row.notes); } catch { /* ignore */ }
  return { ...row, notes };
}

function parseTestDef(row) {
  let headers = {};
  let assertions = [];
  try { headers = JSON.parse(row.headers); } catch { /* ignore */ }
  try { assertions = JSON.parse(row.assertions); } catch { /* ignore */ }
  return { ...row, headers, assertions };
}

// GET /api/tasks/:id
router.get("/tasks/:id", (req, res) => {
  try {
    const id = Number(req.params.id);
    const task = stmts.getTaskById.get(id);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    const tests = stmts.getTestsWithLastRun.all(id).map(parseTestDef);
    res.json({ ...parseTask(task), tests });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// PATCH /api/tasks/:id
router.patch("/tasks/:id", (req, res) => {
  try {
    const id = Number(req.params.id);
    const { status, note } = req.body;

    if (!status) {
      res.status(400).json({ error: "status is required" });
      return;
    }

    const task = stmts.getTaskById.get(id);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }

    let notes = [];
    try { notes = JSON.parse(task.notes); } catch { /* ignore */ }
    if (note) {
      notes.push({ text: note, ts: Math.floor(Date.now() / 1000) });
    }

    stmts.updateTaskStatus.run(status, JSON.stringify(notes), id);

    if (status === "done") {
      const remaining = stmts.countRemainingTasks.get(task.plan_id);
      if (remaining && remaining.count === 0) {
        stmts.updatePlanStatus.run("completed", task.plan_id);
      }
    }

    const updated = stmts.getTaskById.get(id);
    res.json(parseTask(updated));
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

export default router;
