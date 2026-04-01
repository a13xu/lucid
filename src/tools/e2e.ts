import { spawnSync } from "child_process";
import { z } from "zod";
import type Database from "better-sqlite3";
import type { Statements } from "../database.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const RunE2eTestSchema = z.object({
  task_id: z.coerce.number().int().positive(),
});

type RunE2eTestArgs = z.infer<typeof RunE2eTestSchema>;

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export function handleRunE2eTest(
  db: Database.Database,
  stmts: Statements,
  args: RunE2eTestArgs,
): string {
  const { task_id } = args;

  const task = stmts.getTaskById.get(task_id);
  if (!task) return `Error: Task #${task_id} not found.`;
  if (!task.is_e2e) return `Error: Task #${task_id} is not an E2E task.`;

  const criteria = task.test_criteria.trim();
  if (!criteria) return `Error: Task #${task_id} has empty test_criteria.`;

  const newRetryCount = task.retry_count + 1;

  // Execute test_criteria as a shell command
  const result = spawnSync(criteria, {
    shell: true,
    timeout: 60_000,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });

  const exitCode = result.status ?? 1;
  const stdout = (result.stdout ?? "").trim();
  const stderr = (result.stderr ?? "").trim();
  const timedOut = result.error?.message?.includes("ETIMEDOUT") ||
                   result.signal === "SIGTERM";

  const passed = exitCode === 0 && !timedOut;

  const e2eResult: string = passed ? "pass" : "fail";
  let e2eError: string | null = null;

  if (!passed) {
    const parts: string[] = [];
    if (timedOut) parts.push("Timed out after 60s");
    if (stderr) parts.push(stderr);
    if (!timedOut && !stderr && stdout) parts.push(stdout);
    if (result.error && !timedOut) parts.push(result.error.message);
    e2eError = parts.filter(Boolean).join("\n") || `Exit code: ${exitCode}`;
  }

  // Update e2e_result, e2e_error, retry_count in DB
  stmts.updateTaskE2eResult.run(e2eResult, e2eError, newRetryCount, task_id);

  // If passed, also mark the task as done
  if (passed) {
    const plan = stmts.getPlanById.get(task.plan_id);
    const maxRetries = plan?.max_retries ?? 3;
    let notes: Array<{ text: string; ts: number }> = [];
    try { notes = JSON.parse(task.notes); } catch { /* ignore */ }
    notes.push({ text: `E2E passed on attempt ${newRetryCount}`, ts: Math.floor(Date.now() / 1000) });
    stmts.updateTaskStatus.run("done", JSON.stringify(notes), task_id);

    const remaining = stmts.countRemainingTasks.get(task.plan_id);
    if (remaining && remaining.count === 0) {
      stmts.updatePlanStatus.run("completed", task.plan_id);
    }

    const lines = [
      `[E2E PASS] Task #${task_id} — ${task.title}`,
      `Attempt: ${newRetryCount}`,
    ];
    if (stdout) lines.push(`Output: ${stdout}`);
    lines.push(`Task status updated to done.`);
    if (remaining && remaining.count === 0) {
      lines.push(`Plan #${task.plan_id} completed.`);
    }
    return lines.join("\n");
  }

  // Failed — check retry budget
  const plan = stmts.getPlanById.get(task.plan_id);
  const maxRetries = plan?.max_retries ?? 3;
  const retriesLeft = maxRetries - newRetryCount;

  const lines = [
    `[E2E FAIL] Task #${task_id} — ${task.title}`,
    `Attempt: ${newRetryCount}/${maxRetries}`,
    `Error: ${e2eError ?? "unknown"}`,
  ];
  if (stdout) lines.push(`Stdout: ${stdout}`);

  if (retriesLeft > 0) {
    // Create a [FIX] remediation task for this iteration
    const errorSummary = (e2eError ?? "unknown error").slice(0, 100).replace(/\n/g, " ");
    const fixTitle = `[FIX] Iteration ${newRetryCount}: ${errorSummary}`;
    const fixDescription = `Fix the E2E failure from iteration ${newRetryCount}.\nError: ${e2eError ?? "unknown"}\nAfter fixing, mark this task done to trigger automatic E2E re-run.`;
    const maxSeqRow = stmts.getMaxSeqForPlan.get(task.plan_id);
    const nextSeq = (maxSeqRow?.max_seq ?? 0) + 1;
    const fixResult = stmts.insertFixTask.run(task.plan_id, nextSeq, fixTitle, fixDescription, task.test_criteria, task_id);
    const fixTaskId = fixResult.lastInsertRowid as number;
    lines.push(`Retries left: ${retriesLeft}.`);
    lines.push(`Created [FIX] task #${fixTaskId} "${fixTitle}".`);
    lines.push(`Fix the issue and mark task #${fixTaskId} done — this will automatically re-run the E2E test.`);
  } else {
    // Exhausted all retries — mark plan as e2e_failed
    stmts.updatePlanStatus.run("e2e_failed", task.plan_id);
    lines.push(`No retries left. Plan #${task.plan_id} marked as e2e_failed.`);
  }
  return lines.join("\n");
}
