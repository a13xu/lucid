// Worker control routes + AI task generation
//   GET  /api/worker/status          — current worker state
//   POST /api/worker/start           — start the poll loop
//   POST /api/worker/stop            — stop and kill current process
//   POST /api/worker/reset-stuck     — reset in_progress tasks → pending (all active plans)
//   POST /api/tasks/:id/reset        — reset a single task → pending
//   POST /api/generate/tasks         — call Claude to generate tasks from a user story

import { Router }              from "express";
import { worker }              from "../worker.js";
import { db }                  from "../db.js";
import { claudePrint }         from "../claude-env.js";

const router = Router();

const resetStuckStmt = db.prepare(`
  UPDATE plan_tasks SET status = 'pending', updated_at = unixepoch()
  WHERE status = 'in_progress'
    AND plan_id IN (SELECT id FROM plans WHERE status = 'active')
`);

const resetOneTaskStmt = db.prepare(`
  UPDATE plan_tasks SET status = 'pending', updated_at = unixepoch()
  WHERE id = ?
`);

// ── Worker control ────────────────────────────────────────────────────────────

router.get("/worker/status", (_req, res) => {
  res.json(worker.status());
});

router.post("/worker/start", (_req, res) => {
  worker.start();
  res.json(worker.status());
});

router.post("/worker/stop", (_req, res) => {
  worker.stop();
  res.json(worker.status());
});

// Toggle auto-approve (skip all permissions automatically)
router.post("/worker/auto-approve", (req, res) => {
  const { enabled } = req.body ?? {};
  worker.autoApprove = !!enabled;
  res.json(worker.status());
});

// User approved a permission request → re-run task with --dangerously-skip-permissions
router.post("/worker/approve/:taskId", (req, res) => {
  const taskId = Number(req.params.taskId);
  if (!taskId) return res.status(400).json({ error: "taskId required" });
  worker.approveTask(taskId);
  res.json({ ok: true, taskId });
});

// User denied a permission request → mark task blocked
router.post("/worker/deny/:taskId", (req, res) => {
  const taskId = Number(req.params.taskId);
  if (!taskId) return res.status(400).json({ error: "taskId required" });
  worker.denyTask(taskId);
  res.json({ ok: true, taskId });
});

// Reset all stuck in_progress tasks → pending so the worker picks them up
router.post("/worker/reset-stuck", (_req, res) => {
  try {
    const info = resetStuckStmt.run();
    res.json({ reset: info.changes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Reset a single task → pending
router.post("/tasks/:id/reset", (req, res) => {
  try {
    const info = resetOneTaskStmt.run(Number(req.params.id));
    res.json({ reset: info.changes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── AI task generation ────────────────────────────────────────────────────────

router.post("/generate/tasks", async (req, res) => {
  const { user_story, title } = req.body ?? {};
  if (!user_story || !user_story.trim()) {
    return res.status(400).json({ error: "user_story is required" });
  }

  const prompt = `You are an experienced software architect and project manager.

Given the following user story, generate a list of concrete implementation tasks that a developer should complete.

${title ? `Project: ${title}\n` : ""}User Story: ${user_story.trim()}

Rules:
- Generate between 3 and 8 tasks
- Each task must be concrete and actionable
- Tasks should be in logical implementation order
- Return ONLY a valid JSON array, nothing else — no markdown, no explanation

JSON format (array of objects):
[
  {
    "title": "Short task title (max 60 chars)",
    "description": "What exactly needs to be done (2-3 sentences)",
    "test_criteria": "How to verify this task is complete"
  }
]

JSON array:`;

  try {
    const stdout = await claudePrint(prompt, { timeoutMs: 120_000, model: "claude-haiku-4-5-20251001" });

    // Extract JSON array — handles markdown code fences too
    const match = stdout.match(/\[[\s\S]*\]/);
    if (!match) throw new Error("No JSON array found in Claude response");

    const tasks = JSON.parse(match[0]);
    if (!Array.isArray(tasks) || tasks.length === 0) throw new Error("Claude returned empty or non-array");

    const normalised = tasks.map((t, i) => ({
      title:         String(t.title        ?? `Task ${i + 1}`).slice(0, 120),
      description:   String(t.description  ?? "").slice(0, 1000),
      test_criteria: String(t.test_criteria ?? "").slice(0, 500),
    }));

    res.json({ tasks: normalised });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
