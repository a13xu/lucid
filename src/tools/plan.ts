import Database from "better-sqlite3";
import { z } from "zod";
import type { PlanRow, Statements } from "../database.js";
import { getProjectScope, isSameProject } from "../project.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** A plan larger than this is a roadmap, not a plan — split it. */
const MAX_TASKS_PER_PLAN = 20;

/** An active plan untouched this long is treated as abandoned by plan_cleanup. */
const DEFAULT_STALE_HOURS = 72;

const SECONDS_PER_HOUR = 3600;

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
  })).min(1).max(MAX_TASKS_PER_PLAN),
});

export const PlanListSchema = z.object({
  status: z.enum(["active", "completed", "abandoned", "all"]).optional().default("active"),
  scope:  z.enum(["project", "all"]).optional().default("project")
    .describe("'project' (default) = plans for the current working directory only; 'all' = every project"),
});

export const PlanGetSchema = z.object({
  plan_id: z.coerce.number().int().positive(),
});

export const PlanUpdateTaskSchema = z.object({
  task_id: z.coerce.number().int().positive(),
  status:  z.enum(["pending", "in_progress", "done", "blocked"]),
  note:    z.string().optional(),
});

export const PlanArchiveSchema = z.object({
  plan_id: z.coerce.number().int().positive(),
  status:  z.enum(["completed", "abandoned", "active"]).optional().default("completed")
    .describe("'completed' = finished, 'abandoned' = dropped, 'active' = reopen an archived plan"),
  reason:  z.string().optional().describe("Recorded as a note on the plan's unfinished tasks"),
});

export const PlanDeleteSchema = z.object({
  plan_id: z.coerce.number().int().positive(),
  confirm: z.literal(true)
    .describe("Must be true. Deletion is permanent and removes every task of the plan."),
});

export const PlanCleanupSchema = z.object({
  stale_hours: z.coerce.number().int().positive().optional().default(DEFAULT_STALE_HOURS)
    .describe("An active plan untouched for longer than this is considered abandoned"),
  scope:   z.enum(["project", "all"]).optional().default("project"),
  dry_run: z.coerce.boolean().optional().default(false)
    .describe("Report what would be archived without changing anything"),
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type PlanCreateArgs     = z.infer<typeof PlanCreateSchema>;
type PlanListArgs       = z.infer<typeof PlanListSchema>;
type PlanGetArgs        = z.infer<typeof PlanGetSchema>;
type PlanUpdateTaskArgs = z.infer<typeof PlanUpdateTaskSchema>;
type PlanArchiveArgs    = z.infer<typeof PlanArchiveSchema>;
type PlanDeleteArgs     = z.infer<typeof PlanDeleteSchema>;
type PlanCleanupArgs    = z.infer<typeof PlanCleanupSchema>;

interface TaskNote { text: string; ts: number }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STATUS_ICONS: Record<string, string> = {
  pending:     "⬜",
  in_progress: "🔄",
  done:        "✅",
  blocked:     "🚫",
};

function progressBar(done: number, total: number): string {
  if (total === 0) return "░".repeat(10);
  const filled = Math.round((done / total) * 10);
  return "█".repeat(filled) + "░".repeat(10 - filled);
}

function parseNotes(raw: string): TaskNote[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed as TaskNote[] : [];
  } catch {
    return [];
  }
}

function appendNote(stmts: Statements, taskId: number, status: string, text: string): void {
  const task = stmts.getTaskById.get(taskId);
  if (!task) return;
  const notes = parseNotes(task.notes);
  notes.push({ text, ts: Math.floor(Date.now() / 1000) });
  stmts.updateTaskStatus.run(status, JSON.stringify(notes), taskId);
}

/** Plans visible from the current working directory, newest first. */
function plansInScope(stmts: Statements, scope: "project" | "all"): PlanRow[] {
  const all = stmts.getAllPlans.all();
  if (scope === "all") return all;
  const { id } = getProjectScope();
  // Legacy rows (project === '') are kept visible on purpose: they were written
  // before scoping existed and would otherwise silently disappear from every
  // project at once. plan_list marks them so they can be archived or adopted.
  return all.filter((p) => isSameProject(p.project, id) || p.project === "");
}

function planLabel(plan: PlanRow, currentProjectId: string): string {
  if (plan.project === "") return " [unscoped — legacy]";
  return isSameProject(plan.project, currentProjectId)
    ? ""
    : ` [${plan.project_name || plan.project}]`;
}

/**
 * Tasks still standing between a plan and auto-completion. Single definition on
 * purpose: three call sites derive the plan id differently (task.plan_id, an
 * argument, a loop variable) and duplicating the filter invites exactly the
 * mismatch that would make a plan look finished when it is not.
 */
function openTasks(stmts: Statements, planId: number) {
  return stmts.getTasksByPlanId.all(planId).filter((t) => t.status !== "done");
}

function ageInHours(ts: number): number {
  return (Math.floor(Date.now() / 1000) - ts) / SECONDS_PER_HOUR;
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
  const project = getProjectScope();

  // Real rowids, captured inside the transaction — plan_update_task needs the
  // actual ids, and any derived/guessed numbering would simply not exist.
  const { planId, taskIds } = db.transaction(() => {
    const planId = stmts.insertPlan.run(
      title, description, user_story, project.id, project.name,
    ).lastInsertRowid as number;

    const taskIds: number[] = [];
    for (let i = 0; i < tasks.length; i++) {
      const t = tasks[i]!;
      const info = stmts.insertPlanTask.run(planId, i + 1, t.title, t.description, t.test_criteria);
      taskIds.push(info.lastInsertRowid as number);
    }
    return { planId, taskIds };
  })();

  const lines: string[] = [
    `[PLAN #${planId} active] ${title}`,
    `Project: ${project.name} (${project.id})`,
    `User Story: ${user_story}`,
    ``,
  ];
  for (let i = 0; i < tasks.length; i++) {
    lines.push(`[TASK ${i + 1} #${taskIds[i]} pending] ${tasks[i]!.title}`);
  }
  lines.push(``, `Progress: 0/${tasks.length} done`);

  // Surfacing this at creation time is what stops plans from piling up: the
  // statusline only ever shows one, so older active plans go unnoticed.
  const otherActive = plansInScope(stmts, "project")
    .filter((p) => p.status === "active" && p.id !== planId);
  if (otherActive.length > 0) {
    lines.push(``, `⚠ ${otherActive.length} other active plan(s) in this project:`);
    for (const p of otherActive) {
      lines.push(`   #${p.id} "${p.title}" — idle ${Math.round(ageInHours(p.updated_at))}h`);
    }
    lines.push(`   Close them with plan_archive, or plan_cleanup to sweep stale ones.`);
  }

  return lines.join("\n");
}

export function handlePlanList(
  stmts: Statements,
  args: PlanListArgs,
): string {
  const { status, scope } = args;
  const project = getProjectScope();
  const inScope = plansInScope(stmts, scope);
  const filtered = status === "all" ? inScope : inScope.filter((p) => p.status === status);

  const header = scope === "project"
    ? `Project: ${project.name} (${project.id})`
    : `All projects`;

  if (filtered.length === 0) {
    const hidden = scope === "project"
      ? stmts.getAllPlans.all().filter((p) => !isSameProject(p.project, project.id) && p.project !== "").length
      : 0;
    const hint = hidden > 0
      ? ` ${hidden} plan(s) belong to other projects — use scope:"all" to see them.`
      : "";
    return `${header}\nNo ${status === "all" ? "" : status + " "}plans found.${hint}`;
  }

  const lines: string[] = [header, ""];
  for (const plan of filtered) {
    const tasks = stmts.getTasksByPlanId.all(plan.id);
    const doneCount = tasks.filter((t) => t.status === "done").length;
    lines.push(
      `[#${plan.id} ${plan.status}] ${plan.title}${planLabel(plan, project.id)} — ` +
      `${doneCount}/${tasks.length} tasks done`,
    );
  }
  return lines.join("\n");
}

export function handlePlanGet(
  stmts: Statements,
  args: PlanGetArgs,
): string {
  const plan = stmts.getPlanById.get(args.plan_id);
  if (!plan) return `Error: Plan #${args.plan_id} not found.`;

  const project = getProjectScope();
  const tasks = stmts.getTasksByPlanId.all(plan.id);
  const doneCount = tasks.filter((t) => t.status === "done").length;
  const total = tasks.length;

  const lines: string[] = [
    `[PLAN #${plan.id} | ${plan.status}] ${plan.title}${planLabel(plan, project.id)}`,
    `Project: ${plan.project_name || "(unscoped)"} ${plan.project ? `(${plan.project})` : ""}`.trimEnd(),
    `User Story: ${plan.user_story}`,
    `Progress: ${doneCount}/${total} done ${progressBar(doneCount, total)}`,
    ``,
  ];

  for (const task of tasks) {
    const icon = STATUS_ICONS[task.status] ?? "❓";
    lines.push(`[${task.seq}] #${task.id} ${icon} ${task.status}  — ${task.title}`);
    lines.push(`    Desc: ${task.description}`);
    lines.push(`    Test: ${task.test_criteria}`);
    for (const n of parseNotes(task.notes)) {
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

  const notes = parseNotes(task.notes);
  if (note) notes.push({ text: note, ts: Math.floor(Date.now() / 1000) });
  stmts.updateTaskStatus.run(status, JSON.stringify(notes), task_id);

  const lines: string[] = [`✅ Task #${task_id} → ${status}`];

  const remaining = stmts.countRemainingTasks.get(task.plan_id);
  if (remaining && remaining.count === 0) {
    stmts.updatePlanStatus.run("completed", task.plan_id);
    const plan = stmts.getPlanById.get(task.plan_id);
    const taskCount = stmts.getTasksByPlanId.all(task.plan_id).length;
    lines.push(`🎉 Plan #${task.plan_id} completat! Toate ${taskCount} task-uri done.`);
    if (plan) lines.push(`   "${plan.title}"`);
  } else if (remaining) {
    // Naming exactly what is left is what makes a stuck plan diagnosable: the
    // plan only auto-completes at zero, and 'blocked' counts as remaining.
    const open = openTasks(stmts, task.plan_id);
    lines.push(`Plan #${task.plan_id}: ${remaining.count} task(s) left before auto-complete:`);
    for (const t of open) {
      lines.push(`   #${t.id} ${STATUS_ICONS[t.status] ?? "❓"} ${t.status} — ${t.title}`);
    }
  }

  return lines.join("\n");
}

export function handlePlanArchive(
  stmts: Statements,
  args: PlanArchiveArgs,
): string {
  const { plan_id, status, reason } = args;

  const plan = stmts.getPlanById.get(plan_id);
  if (!plan) return `Error: Plan #${plan_id} not found.`;
  if (plan.status === status) {
    return `Plan #${plan_id} is already ${status} — nothing to do.`;
  }

  const open = openTasks(stmts, plan_id);
  stmts.updatePlanStatus.run(status, plan_id);

  // Task rows are never rewritten here — their status is the history of what
  // actually happened. Only an explanatory note is appended.
  if (reason) {
    for (const t of open) {
      appendNote(stmts, t.id, t.status, `plan ${status}: ${reason}`);
    }
  }

  const verb = status === "active" ? "reopened" : status;
  const lines = [`📦 Plan #${plan_id} → ${verb} — "${plan.title}"`];
  if (open.length > 0 && status !== "active") {
    lines.push(`   ${open.length} unfinished task(s) kept as-is: ` +
      open.map((t) => `#${t.id} (${t.status})`).join(", "));
  }
  return lines.join("\n");
}

export function handlePlanDelete(
  stmts: Statements,
  args: PlanDeleteArgs,
): string {
  const plan = stmts.getPlanById.get(args.plan_id);
  if (!plan) return `Error: Plan #${args.plan_id} not found.`;

  const taskCount = stmts.getTasksByPlanId.all(args.plan_id).length;
  stmts.deletePlanById.run(args.plan_id);

  return `🗑 Plan #${args.plan_id} deleted permanently — "${plan.title}" ` +
    `(${taskCount} task(s) removed via cascade).`;
}

export function handlePlanCleanup(
  stmts: Statements,
  args: PlanCleanupArgs,
): string {
  const { stale_hours, scope, dry_run } = args;
  const project = getProjectScope();

  const stale = plansInScope(stmts, scope)
    .filter((p) => p.status === "active" && ageInHours(p.updated_at) >= stale_hours);

  const header = scope === "project" ? `Project: ${project.name}` : "All projects";

  if (stale.length === 0) {
    return `${header}\nNo active plan idle for ${stale_hours}h or more. Nothing to clean up.`;
  }

  const lines: string[] = [
    `${header}`,
    dry_run
      ? `Dry run — ${stale.length} plan(s) would be archived as 'abandoned':`
      : `Archived ${stale.length} stale plan(s) as 'abandoned':`,
  ];

  for (const p of stale) {
    const open = openTasks(stmts, p.id);
    const idle = Math.round(ageInHours(p.updated_at));
    lines.push(`   #${p.id} "${p.title}" — idle ${idle}h, ${open.length} task(s) not done`);
    if (!dry_run) {
      stmts.updatePlanStatus.run("abandoned", p.id);
      for (const t of open) {
        appendNote(stmts, t.id, t.status, `auto-archived by plan_cleanup after ${idle}h idle`);
      }
    }
  }

  if (dry_run) lines.push(`Re-run with dry_run:false to apply.`);
  return lines.join("\n");
}
