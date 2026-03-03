import Database from "better-sqlite3";
import { z } from "zod";
import type { Statements } from "../database.js";

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

export const PlanCreateSchema = z.object({
  title:       z.string().min(1),
  description: z.string().min(1),
  user_story:  z.string().min(1).describe("As a [user], I want [goal], so that [benefit]"),
  tasks: z.array(z.object({
    title:         z.string().min(1),
    description:   z.string().min(1),
    test_criteria: z.string().min(1),
  })).min(1).max(20),
});

export const PlanListSchema = z.object({
  status: z.enum(["active", "completed", "abandoned", "all"]).optional().default("active"),
});

export const PlanGetSchema = z.object({
  plan_id: z.number().int().positive(),
});

export const PlanUpdateTaskSchema = z.object({
  task_id: z.number().int().positive(),
  status:  z.enum(["pending", "in_progress", "done", "blocked"]),
  note:    z.string().optional(),
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type PlanCreateArgs    = z.infer<typeof PlanCreateSchema>;
type PlanListArgs      = z.infer<typeof PlanListSchema>;
type PlanGetArgs       = z.infer<typeof PlanGetSchema>;
type PlanUpdateTaskArgs = z.infer<typeof PlanUpdateTaskSchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STATUS_ICONS: Record<string, string> = {
  pending:     "⬜",
  in_progress: "🔄",
  done:        "✅",
  blocked:     "🚫",
};

const PLAN_STATUS_ICONS: Record<string, string> = {
  active:    "active",
  completed: "completed",
  abandoned: "abandoned",
};

function progressBar(done: number, total: number): string {
  if (total === 0) return "░".repeat(10);
  const filled = Math.round((done / total) * 10);
  return "█".repeat(filled) + "░".repeat(10 - filled);
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export function handlePlanCreate(
  db: Database.Database,
  stmts: Statements,
  args: PlanCreateArgs,
): string {
  const { title, description, user_story, tasks } = args;

  const planId = db.transaction(() => {
    const result = stmts.insertPlan.run(title, description, user_story);
    const id = result.lastInsertRowid as number;
    for (let i = 0; i < tasks.length; i++) {
      const t = tasks[i]!;
      stmts.insertPlanTask.run(id, i + 1, t.title, t.description, t.test_criteria);
    }
    return id;
  })();

  const lines: string[] = [
    `[PLAN #${planId} active] ${title}`,
    `User Story: ${user_story}`,
    ``,
  ];
  for (let i = 0; i < tasks.length; i++) {
    lines.push(`[TASK ${i + 1} #${planId * 100 + i + 1} pending] ${tasks[i]!.title}`);
  }
  lines.push(``, `Progress: 0/${tasks.length} done`);

  return lines.join("\n");
}

export function handlePlanList(
  stmts: Statements,
  args: PlanListArgs,
): string {
  const { status } = args;
  const all = stmts.getAllPlans.all();
  const filtered = status === "all" ? all : all.filter(p => p.status === status);

  if (filtered.length === 0) {
    return `No ${status === "all" ? "" : status + " "}plans found.`;
  }

  const lines: string[] = [];
  for (const plan of filtered) {
    const tasks = stmts.getTasksByPlanId.all(plan.id);
    const doneCount = tasks.filter(t => t.status === "done").length;
    const label = PLAN_STATUS_ICONS[plan.status] ?? plan.status;
    lines.push(`[#${plan.id} ${label}] ${plan.title} — ${doneCount}/${tasks.length} tasks done`);
  }
  return lines.join("\n");
}

export function handlePlanGet(
  stmts: Statements,
  args: PlanGetArgs,
): string {
  const plan = stmts.getPlanById.get(args.plan_id);
  if (!plan) return `Error: Plan #${args.plan_id} not found.`;

  const tasks = stmts.getTasksByPlanId.all(plan.id);
  const doneCount = tasks.filter(t => t.status === "done").length;
  const total = tasks.length;
  const bar = progressBar(doneCount, total);
  const label = PLAN_STATUS_ICONS[plan.status] ?? plan.status;

  const lines: string[] = [
    `[PLAN #${plan.id} | ${label}] ${plan.title}`,
    `User Story: ${plan.user_story}`,
    `Progress: ${doneCount}/${total} done ${bar}`,
    ``,
  ];

  for (const task of tasks) {
    const icon = STATUS_ICONS[task.status] ?? "❓";
    lines.push(`[${task.seq}] ${icon} ${task.status}  — ${task.title}`);
    lines.push(`    Desc: ${task.description}`);
    lines.push(`    Test: ${task.test_criteria}`);

    let parsedNotes: Array<{ text: string; ts: number }> = [];
    try { parsedNotes = JSON.parse(task.notes); } catch { /* ignore */ }
    for (const n of parsedNotes) {
      const date = new Date(n.ts * 1000).toISOString().slice(0, 10);
      lines.push(`    Note: ${date} — ${n.text}`);
    }
    lines.push(``);
  }

  return lines.join("\n").trimEnd();
}

export function handlePlanUpdateTask(
  stmts: Statements,
  args: PlanUpdateTaskArgs,
): string {
  const { task_id, status, note } = args;

  const task = stmts.getTaskById.get(task_id);
  if (!task) return `Error: Task #${task_id} not found.`;

  let notes: Array<{ text: string; ts: number }> = [];
  try { notes = JSON.parse(task.notes); } catch { /* ignore */ }
  if (note) {
    notes.push({ text: note, ts: Math.floor(Date.now() / 1000) });
  }
  const notesJson = JSON.stringify(notes);

  stmts.updateTaskStatus.run(status, notesJson, task_id);

  const lines: string[] = [`✅ Task #${task_id} → ${status}`];

  if (status === "done") {
    const remaining = stmts.countRemainingTasks.get(task.plan_id);
    if (remaining && remaining.count === 0) {
      stmts.updatePlanStatus.run("completed", task.plan_id);
      const plan = stmts.getPlanById.get(task.plan_id);
      const taskCount = stmts.getTasksByPlanId.all(task.plan_id).length;
      lines.push(`🎉 Plan #${task.plan_id} completat! Toate ${taskCount} task-uri done.`);
      if (plan) lines.push(`   "${plan.title}"`);
    }
  }

  return lines.join("\n");
}
