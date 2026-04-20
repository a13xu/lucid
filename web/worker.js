// Claude CLI long-running worker
// Polls the DB for pending tasks in active plans and executes them.
// Detects permission requests in Claude's output and surfaces them
// to the web UI — user can Approve (re-run with --dangerously-skip-permissions)
// or Deny (mark task blocked).

import { db, stmts }    from "./db.js";
import { broadcast }    from "./events.js";
import { claudeStream } from "./claude-env.js";

const POLL_IDLE_MS   = 5000;
const POLL_BUSY_MS   = 2000;
const CLAUDE_TIMEOUT = 300_000; // 5 minutes — real tasks take time

// ── Permission pattern detection ─────────────────────────────────────────────

const PERMISSION_PATTERNS = [
  /I need your permission/i,
  /please approve/i,
  /permission to (edit|create|write|delete|run|execute|modify|update)/i,
  /would you like me to/i,
  /do you want me to/i,
  /can I (edit|create|write|delete|run|execute|modify|update)/i,
  /approval (to|before)/i,
];

function detectPermissionRequest(text) {
  return PERMISSION_PATTERNS.some(p => p.test(text));
}

// ── DB helpers ────────────────────────────────────────────────────────────────

const getNextPendingTask = db.prepare(`
  SELECT pt.*, p.title AS plan_title, p.description AS plan_desc, p.user_story
  FROM plan_tasks pt
  JOIN plans p ON p.id = pt.plan_id
  WHERE pt.status = 'pending' AND p.status = 'active'
  ORDER BY pt.plan_id ASC, pt.seq ASC
  LIMIT 1
`);

function setTaskStatus(taskId, status, noteText) {
  const row = stmts.getTaskById.get(taskId);
  if (!row) return;
  const notes = JSON.parse(row.notes || "[]");
  if (noteText) notes.push({ text: noteText, ts: Math.floor(Date.now() / 1000) });
  stmts.updateTaskStatus.run(status, JSON.stringify(notes), taskId);
}

// ── ClaudeWorker ──────────────────────────────────────────────────────────────

class ClaudeWorker {
  constructor() {
    this.running          = false;
    this.busy             = false;
    this.currentTaskId    = null;
    this._timer           = null;
    // taskId → true means next execution uses --dangerously-skip-permissions
    this._skipPermsFor    = new Set();
    // global auto-approve toggle (set via API)
    this.autoApprove      = false;
  }

  // ── public API ──────────────────────────────────────────────────────────────

  start() {
    if (this.running) return;
    this.running = true;
    this._scheduleNext(100);
    broadcast("worker", this.status());
    console.error("[worker] started");
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    this.busy = false; this.currentTaskId = null;
    broadcast("worker", this.status());
    console.error("[worker] stopped");
  }

  // Called from route when user clicks "Approve" on a permission request
  approveTask(taskId) {
    this._skipPermsFor.add(taskId);
    // Reset the task to pending so the worker picks it up again
    setTaskStatus(taskId, "pending", "✅ Permission approved by user — retrying");
    broadcast("worker_approval", { taskId, decision: "approved", ts: Date.now() });
    broadcast("task_output", { taskId, chunk: "\n✅ Approved — re-running task...\n", ts: Date.now() });
    // Kick the poll loop immediately
    this._scheduleNext(500);
  }

  denyTask(taskId) {
    setTaskStatus(taskId, "blocked", "🚫 Permission denied by user");
    broadcast("worker_approval", { taskId, decision: "denied", ts: Date.now() });
    broadcast("task_output", { taskId, chunk: "\n🚫 Denied — task blocked.\n", done: true, status: "blocked", ts: Date.now() });
  }

  status() {
    return {
      running:       this.running,
      busy:          this.busy,
      currentTaskId: this.currentTaskId,
      autoApprove:   this.autoApprove,
    };
  }

  // ── internals ───────────────────────────────────────────────────────────────

  _scheduleNext(ms) {
    if (!this.running) return;
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => this._poll(), ms ?? (this.busy ? POLL_BUSY_MS : POLL_IDLE_MS));
  }

  async _poll() {
    this._timer = null;
    if (!this.running || this.busy) { this._scheduleNext(); return; }
    const task = getNextPendingTask.get();
    if (!task) { this._scheduleNext(); return; }
    await this._executeTask(task);
    this._scheduleNext();
  }

  async _executeTask(task) {
    this.busy = true; this.currentTaskId = task.id;

    const skipPerms = this.autoApprove || this._skipPermsFor.has(task.id);
    this._skipPermsFor.delete(task.id);

    setTaskStatus(task.id, "in_progress", `🤖 Worker started${skipPerms ? " (auto-approve ON)" : ""}`);
    broadcast("worker", this.status());
    broadcast("task_output", { taskId: task.id, chunk: `🤖 Starting task #${task.seq}: ${task.title}\n\n`, ts: Date.now() });

    const prompt = this._buildPrompt(task);
    broadcast("task_prompt", { taskId: task.id, prompt, ts: Date.now() });

    let accumulated     = "";
    let permRequested   = false;

    try {
      const output = await claudeStream(
        prompt,
        (chunk) => {
          accumulated += chunk;
          broadcast("task_output", { taskId: task.id, chunk, ts: Date.now() });

          // Detect permission request mid-stream
          if (!permRequested && !skipPerms && detectPermissionRequest(accumulated)) {
            permRequested = true;
            broadcast("worker_permission_request", {
              taskId:  task.id,
              request: accumulated,
              ts:      Date.now(),
            });
          }
        },
        { timeoutMs: CLAUDE_TIMEOUT, skipPermissions: skipPerms },
      );

      // If permission was detected but Claude still completed (described what to do)
      // and we did NOT auto-approve — surface it as awaiting_approval
      if (permRequested && !skipPerms) {
        setTaskStatus(task.id, "pending", `⏳ Awaiting permission approval\n${output.slice(-400)}`);
        this.busy = false; this.currentTaskId = null;
        broadcast("worker", this.status());
        broadcast("task_output", {
          taskId: task.id,
          chunk:  "\n⏳ Paused — waiting for your approval above.\n",
          done:   true, status: "pending", ts: Date.now(),
        });
        return;
      }

      // Normal completion
      const summary = output.slice(-800).trim() || "(no output)";
      setTaskStatus(task.id, "done", `🤖 Worker completed ✅\n${summary}`);

      const task2     = stmts.getTaskById.get(task.id);
      const remaining = stmts.countRemainingTasks.get(task2.plan_id);
      if (remaining.count === 0) stmts.updatePlanStatus.run("completed", task2.plan_id);

      this.busy = false; this.currentTaskId = null;
      broadcast("worker", this.status());
      broadcast("task_output", { taskId: task.id, chunk: "\n✅ Task completed\n", done: true, status: "done", ts: Date.now() });

    } catch (err) {
      this.busy = false; this.currentTaskId = null;
      setTaskStatus(task.id, "blocked", `🤖 Worker failed ❌\n${err.message}`);
      broadcast("worker", this.status());
      broadcast("task_output", { taskId: task.id, chunk: `\n❌ ${err.message}\n`, done: true, status: "blocked", ts: Date.now() });
    }
  }

  _buildPrompt(task) {
    const parts = [
      `You are a software developer executing a specific task from a development plan.`,
      ``,
      `Plan: ${task.plan_title}`,
      `User Story: ${task.user_story}`,
      ``,
      `Task #${task.seq}: ${task.title}`,
    ];
    if (task.description)   parts.push(`Description: ${task.description}`);
    if (task.test_criteria) parts.push(`Test Criteria: ${task.test_criteria}`);
    parts.push(``, `Implement this task completely. Be concise and focused. Report what you did.`);
    return parts.join("\n");
  }
}

export const worker = new ClaudeWorker();
