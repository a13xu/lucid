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

// GET /api/tasks?page=1&limit=20[&status=pending|in_progress|done|blocked]
router.get("/tasks", (req, res) => {
  try {
    const rawPage  = req.query.page  !== undefined ? parseInt(req.query.page,  10) : 1;
    const rawLimit = req.query.limit !== undefined ? parseInt(req.query.limit, 10) : 20;

    if (isNaN(rawPage) || rawPage < 1) {
      res.status(400).json({ error: "page must be an integer >= 1" });
      return;
    }
    if (isNaN(rawLimit) || rawLimit < 1 || rawLimit > 100) {
      res.status(400).json({ error: "limit must be an integer between 1 and 100" });
      return;
    }

    const page  = rawPage;
    const limit = rawLimit;
    const offset = (page - 1) * limit;

    const { count: total } = stmts.getAllTasksCount.get();
    const data = stmts.getAllTasksPaginated.all(limit, offset).map(parseTask);

    res.json({
      data,
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

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
