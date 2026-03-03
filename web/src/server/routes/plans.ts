import { Router } from "express";
import { db, stmts } from "../db";
import type { PlanRow, PlanWithStatsRow, PlanTaskRow } from "../db";

const router = Router();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function parseTask(row: PlanTaskRow) {
  let notes: Array<{ text: string; ts: number }> = [];
  try { notes = JSON.parse(row.notes); } catch { /* ignore */ }
  return { ...row, notes };
}

// GET /api/plans?status=active|completed|abandoned|all
router.get("/plans", (_req, res) => {
  try {
    const { status } = _req.query as { status?: string };
    let plans: unknown[];
    if (status && status !== "all") {
      plans = stmts.getPlansByStatusWithStats.all(status) as PlanWithStatsRow[];
    } else {
      plans = stmts.getAllPlansWithStats.all() as PlanWithStatsRow[];
    }
    // Ensure numeric nulls become 0 for SQLite LEFT JOIN aggregation
    const normalized = (plans as PlanWithStatsRow[]).map(p => ({
      ...p,
      task_count: p.task_count ?? 0,
      tasks_done: p.tasks_done ?? 0,
    }));
    res.json(normalized);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// POST /api/plans
router.post("/plans", (req, res) => {
  try {
    const { title, description, user_story, tasks } = req.body as {
      title?: string;
      description?: string;
      user_story?: string;
      tasks?: Array<{ title: string; description: string; test_criteria: string }>;
    };

    if (!title || !description || !user_story) {
      res.status(400).json({ error: "title, description, user_story are required" });
      return;
    }
    if (!Array.isArray(tasks) || tasks.length === 0) {
      res.status(400).json({ error: "tasks array must be non-empty" });
      return;
    }

    const planId = db.transaction((): number => {
      const result = stmts.insertPlan.run(title, description, user_story);
      const id = result.lastInsertRowid as number;
      for (let i = 0; i < tasks.length; i++) {
        const t = tasks[i]!;
        stmts.insertPlanTask.run(id, i + 1, t.title, t.description, t.test_criteria ?? "");
      }
      return id;
    })();

    const plan = stmts.getPlanById.get(planId) as PlanRow;
    const planTasks = (stmts.getTasksByPlanId.all(planId) as PlanTaskRow[]).map(parseTask);
    res.status(201).json({ ...plan, tasks: planTasks, task_count: tasks.length, tasks_done: 0 });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /api/plans/:id
router.get("/plans/:id", (req, res) => {
  try {
    const id = Number(req.params.id);
    const plan = stmts.getPlanById.get(id) as PlanRow | undefined;
    if (!plan) {
      res.status(404).json({ error: "Plan not found" });
      return;
    }

    const rawTasks = stmts.getTasksByPlanId.all(id) as PlanTaskRow[];
    const testCounts = stmts.getTestCountsByPlanId.all(id) as Array<{ task_id: number; count: number }>;
    const countMap = new Map(testCounts.map(r => [r.task_id, r.count]));

    const tasks = rawTasks.map(t => ({
      ...parseTask(t),
      test_count: countMap.get(t.id) ?? 0,
    }));

    const task_count = tasks.length;
    const tasks_done = tasks.filter(t => t.status === "done").length;

    res.json({ ...plan, tasks, task_count, tasks_done });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// PATCH /api/plans/:id
router.patch("/plans/:id", (req, res) => {
  try {
    const id = Number(req.params.id);
    const { status } = req.body as { status?: string };
    if (!status) {
      res.status(400).json({ error: "status is required" });
      return;
    }
    const plan = stmts.getPlanById.get(id) as PlanRow | undefined;
    if (!plan) {
      res.status(404).json({ error: "Plan not found" });
      return;
    }
    stmts.updatePlanStatus.run(status, id);
    res.json({ ...plan, status });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// DELETE /api/plans/:id
router.delete("/plans/:id", (req, res) => {
  try {
    const id = Number(req.params.id);
    const plan = stmts.getPlanById.get(id) as PlanRow | undefined;
    if (!plan) {
      res.status(404).json({ error: "Plan not found" });
      return;
    }
    stmts.deletePlan.run(id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

export default router;
