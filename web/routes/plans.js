import { Router } from "express";
import { db, stmts } from "../db.js";

const router = Router();

function parseTask(row) {
  let notes = [];
  try { notes = JSON.parse(row.notes); } catch { /* ignore */ }
  return { ...row, notes };
}

// GET /api/plans?status=active|completed|abandoned|all&page=1&limit=20
router.get("/plans", (_req, res) => {
  try {
    const { status } = _req.query;

    const rawPage  = _req.query.page  !== undefined ? parseInt(_req.query.page,  10) : 1;
    const rawLimit = _req.query.limit !== undefined ? parseInt(_req.query.limit, 10) : 20;

    if (isNaN(rawPage) || rawPage < 1) {
      res.status(400).json({ error: "page must be an integer >= 1" });
      return;
    }
    if (isNaN(rawLimit) || rawLimit < 1 || rawLimit > 100) {
      res.status(400).json({ error: "limit must be an integer between 1 and 100" });
      return;
    }

    const limit = rawLimit;
    const page  = rawPage;
    const offset = (page - 1) * limit;

    const paginated = _req.query.page !== undefined;

    let plans, total;
    if (status && status !== "all") {
      total = stmts.getPlansByStatusCount.get(status).count;
      plans = paginated
        ? stmts.getPlansByStatusPaginated.all(status, limit, offset)
        : stmts.getPlansByStatusWithStats.all(status);
    } else {
      total = stmts.getAllPlansCount.get().count;
      plans = paginated
        ? stmts.getAllPlansPaginated.all(limit, offset)
        : stmts.getAllPlansWithStats.all();
    }

    const normalized = plans.map(p => ({
      ...p,
      task_count: p.task_count ?? 0,
      tasks_done: p.tasks_done ?? 0,
    }));

    if (paginated) {
      res.json({ data: normalized, total, page, totalPages: Math.ceil(total / limit) });
    } else {
      res.json(normalized);
    }
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// POST /api/plans
router.post("/plans", (req, res) => {
  try {
    const { title, description, user_story, tasks } = req.body;

    if (!title || !description || !user_story) {
      res.status(400).json({ error: "title, description, user_story are required" });
      return;
    }
    if (!Array.isArray(tasks) || tasks.length === 0) {
      res.status(400).json({ error: "tasks array must be non-empty" });
      return;
    }

    const planId = db.transaction(() => {
      const result = stmts.insertPlan.run(title, description, user_story);
      const id = Number(result.lastInsertRowid);
      for (let i = 0; i < tasks.length; i++) {
        const t = tasks[i];
        stmts.insertPlanTask.run(id, i + 1, t.title, t.description, t.test_criteria ?? "");
      }
      return id;
    })();

    const plan = stmts.getPlanById.get(planId);
    const planTasks = stmts.getTasksByPlanId.all(planId).map(parseTask);
    res.status(201).json({ ...plan, tasks: planTasks, task_count: tasks.length, tasks_done: 0 });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /api/plans/:id
router.get("/plans/:id", (req, res) => {
  try {
    const id = Number(req.params.id);
    const plan = stmts.getPlanById.get(id);
    if (!plan) {
      res.status(404).json({ error: "Plan not found" });
      return;
    }

    const rawTasks = stmts.getTasksByPlanId.all(id);
    const testCounts = stmts.getTestCountsByPlanId.all(id);
    const countMap = new Map(testCounts.map(r => [r.task_id, r.count]));

    const tasks = rawTasks.map(t => ({
      ...parseTask(t),
      test_count: countMap.get(t.id) ?? 0,
    }));

    const task_count = tasks.length;
    const tasks_done = tasks.filter(t => t.status === "done").length;

    // Include E2E task summary for the status panel
    const e2eTask = stmts.getE2eTaskForPlan.get(id) ?? null;
    const e2e = e2eTask ? {
      task_id: e2eTask.id,
      status: e2eTask.e2e_result ?? (e2eTask.status === "done" ? "pass" : "pending"),
      retry_count: e2eTask.retry_count ?? 0,
      max_retries: plan.max_retries ?? 3,
      last_error: e2eTask.e2e_error ?? null,
      task_status: e2eTask.status,
    } : null;

    res.json({ ...plan, tasks, task_count, tasks_done, e2e });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /api/plans/:id/tasks?page=1&limit=10
router.get("/plans/:id/tasks", (req, res) => {
  try {
    const id = Number(req.params.id);
    const plan = stmts.getPlanById.get(id);
    if (!plan) { res.status(404).json({ error: "Plan not found" }); return; }

    const rawPage  = req.query.page  !== undefined ? parseInt(req.query.page,  10) : 1;
    const rawLimit = req.query.limit !== undefined ? parseInt(req.query.limit, 10) : 10;

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

    const { count: total } = stmts.getTasksByPlanIdCount.get(id);
    const rawTasks = stmts.getTasksByPlanIdPaginated.all(id, limit, offset);

    const testCounts = stmts.getTestCountsByPlanId.all(id);
    const countMap = new Map(testCounts.map(r => [r.task_id, r.count]));

    const data = rawTasks.map(t => ({
      ...parseTask(t),
      test_count: countMap.get(t.id) ?? 0,
    }));

    res.json({ data, page, limit, total, totalPages: Math.ceil(total / limit) });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// POST /api/plans/:id/e2e/rerun — reset E2E task so it gets picked up again
router.post("/plans/:id/e2e/rerun", (req, res) => {
  try {
    const id = Number(req.params.id);
    const plan = stmts.getPlanById.get(id);
    if (!plan) {
      res.status(404).json({ error: "Plan not found" });
      return;
    }
    const e2eTask = stmts.getE2eTaskForPlan.get(id);
    if (!e2eTask) {
      res.status(404).json({ error: "No E2E task found for this plan" });
      return;
    }
    stmts.resetE2eTask.run(e2eTask.id);
    // Also reactivate the plan if it was e2e_failed
    if (plan.status === "e2e_failed") {
      stmts.updatePlanStatus.run("active", id);
    }
    res.json({ success: true, task_id: e2eTask.id });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// PATCH /api/plans/:id
router.patch("/plans/:id", (req, res) => {
  try {
    const id = Number(req.params.id);
    const { status } = req.body;
    if (!status) {
      res.status(400).json({ error: "status is required" });
      return;
    }
    const plan = stmts.getPlanById.get(id);
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
    const plan = stmts.getPlanById.get(id);
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
