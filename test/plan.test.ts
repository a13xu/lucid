import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// initDatabase() reads MEMORY_DB_PATH at call time — point it at a scratch file
// before importing anything that touches the DB.
const TMP_DIR = mkdtempSync(join(tmpdir(), "lucid-plan-test-"));
process.env["MEMORY_DB_PATH"] = join(TMP_DIR, "test.db");
process.env["LUCID_PROJECT_ROOT"] = join(TMP_DIR, "projects", "alpha");
process.env["LUCID_PROJECT_NAME"] = "alpha";

const { initDatabase, prepareStatements } = await import("../src/database.js");
const {
  canonicalProjectId, isSameProject, getProjectScope, resetProjectScopeCache,
} = await import("../src/project.js");
const {
  handlePlanCreate, handlePlanList, handlePlanGet, handlePlanUpdateTask,
  handlePlanArchive, handlePlanDelete, handlePlanCleanup,
} = await import("../src/tools/plan.js");

const db = initDatabase();
const stmts = prepareStatements(db);

const TASKS = [
  { title: "task one", description: "d1", test_criteria: "c1" },
  { title: "task two", description: "d2", test_criteria: "c2" },
];

function createPlan(title: string) {
  return handlePlanCreate(db, stmts, {
    title, description: "desc", user_story: "As a dev, I want X, so that Y", tasks: TASKS,
  });
}

/** plan_create prints "[TASK n #<id> pending]" — pull the real ids back out. */
function taskIdsFrom(output: string): number[] {
  return [...output.matchAll(/\[TASK \d+ #(\d+) /g)].map((m) => Number(m[1]));
}

function planIdFrom(output: string): number {
  return Number(/\[PLAN #(\d+)/.exec(output)![1]);
}

beforeEach(() => {
  db.exec("DELETE FROM plan_tasks; DELETE FROM plans;");
  resetProjectScopeCache();
});

afterAll(() => {
  db.close();
  rmSync(TMP_DIR, { recursive: true, force: true });
});

describe("canonicalProjectId", () => {
  it("normalises separators and trailing slashes", () => {
    expect(canonicalProjectId("C:\\a\\b\\")).toBe("C:/a/b");
  });

  it("upper-cases the drive letter so one project cannot become two", () => {
    expect(canonicalProjectId("c:/a/b")).toBe(canonicalProjectId("C:/a/b"));
  });
});

describe("isSameProject", () => {
  it("matches a project against itself", () => {
    expect(isSameProject("C:/repo", "C:/repo")).toBe(true);
  });

  it("matches sessions started in a subdirectory, in both directions", () => {
    expect(isSameProject("C:/repo", "C:/repo/packages/api")).toBe(true);
    expect(isSameProject("C:/repo/packages/api", "C:/repo")).toBe(true);
  });

  it("does not match a sibling sharing a name prefix", () => {
    expect(isSameProject("C:/repo-old", "C:/repo")).toBe(false);
  });

  it("never matches legacy unscoped rows", () => {
    expect(isSameProject("", "C:/repo")).toBe(false);
  });
});

describe("plan_create", () => {
  it("reports the real task rowids, not derived ones", () => {
    const out = createPlan("p1");
    const ids = taskIdsFrom(out);
    expect(ids).toHaveLength(2);
    for (const id of ids) {
      expect(stmts.getTaskById.get(id)).toBeTruthy();
    }
  });

  it("stamps the current project", () => {
    const planId = planIdFrom(createPlan("p1"));
    const plan = stmts.getPlanById.get(planId)!;
    expect(plan.project).toBe(getProjectScope().id);
    expect(plan.project_name).toBe("alpha");
  });

  it("warns about other active plans in the same project", () => {
    createPlan("first");
    expect(createPlan("second")).toContain("1 other active plan(s)");
  });
});

describe("plan_list scoping", () => {
  it("hides plans belonging to another project", () => {
    const planId = planIdFrom(createPlan("foreign"));
    stmts.updatePlanProject.run("C:/some/other/repo", "other", planId);

    const scoped = handlePlanList(stmts, { status: "active", scope: "project" });
    expect(scoped).not.toContain("foreign");
    expect(scoped).toContain("use scope:\"all\"");

    expect(handlePlanList(stmts, { status: "active", scope: "all" })).toContain("foreign");
  });

  it("keeps legacy unscoped plans visible and marked", () => {
    const planId = planIdFrom(createPlan("legacy"));
    stmts.updatePlanProject.run("", "", planId);

    const scoped = handlePlanList(stmts, { status: "active", scope: "project" });
    expect(scoped).toContain("legacy");
    expect(scoped).toContain("[unscoped — legacy]");
  });
});

describe("plan_update_task", () => {
  it("auto-completes the plan only when no task is left", () => {
    const out = createPlan("p1");
    const planId = planIdFrom(out);
    const [t1, t2] = taskIdsFrom(out);

    const first = handlePlanUpdateTask(stmts, { task_id: t1!, status: "done" });
    expect(first).not.toContain("🎉");
    expect(stmts.getPlanById.get(planId)!.status).toBe("active");

    const second = handlePlanUpdateTask(stmts, { task_id: t2!, status: "done" });
    expect(second).toContain("🎉");
    expect(stmts.getPlanById.get(planId)!.status).toBe("completed");
  });

  it("names what is still blocking the plan", () => {
    const out = createPlan("p1");
    const [t1, t2] = taskIdsFrom(out);
    handlePlanUpdateTask(stmts, { task_id: t2!, status: "blocked" });

    const res = handlePlanUpdateTask(stmts, { task_id: t1!, status: "done" });
    expect(res).toContain("1 task(s) left");
    expect(res).toContain(`#${t2}`);
    expect(res).toContain("blocked");
  });

  it("appends notes without dropping earlier ones", () => {
    const [t1] = taskIdsFrom(createPlan("p1"));
    handlePlanUpdateTask(stmts, { task_id: t1!, status: "in_progress", note: "first" });
    handlePlanUpdateTask(stmts, { task_id: t1!, status: "blocked", note: "second" });

    const notes = JSON.parse(stmts.getTaskById.get(t1!)!.notes) as Array<{ text: string }>;
    expect(notes.map((n) => n.text)).toEqual(["first", "second"]);
  });
});

describe("plan_archive", () => {
  it("closes a plan whose tasks are stuck, preserving task history", () => {
    const out = createPlan("stuck");
    const planId = planIdFrom(out);
    const [t1] = taskIdsFrom(out);
    handlePlanUpdateTask(stmts, { task_id: t1!, status: "in_progress" });

    const res = handlePlanArchive(stmts, { plan_id: planId, status: "abandoned", reason: "worker died" });
    expect(res).toContain("abandoned");
    expect(stmts.getPlanById.get(planId)!.status).toBe("abandoned");
    // Task status is the record of what happened — archiving must not rewrite it.
    expect(stmts.getTaskById.get(t1!)!.status).toBe("in_progress");
    expect(stmts.getTaskById.get(t1!)!.notes).toContain("worker died");
  });

  it("reopens an archived plan", () => {
    const planId = planIdFrom(createPlan("p1"));
    handlePlanArchive(stmts, { plan_id: planId, status: "abandoned" });
    expect(handlePlanArchive(stmts, { plan_id: planId, status: "active" })).toContain("reopened");
    expect(stmts.getPlanById.get(planId)!.status).toBe("active");
  });

  it("is a no-op when already in the target status", () => {
    const planId = planIdFrom(createPlan("p1"));
    expect(handlePlanArchive(stmts, { plan_id: planId, status: "active" })).toContain("nothing to do");
  });

  it("errors on a missing plan", () => {
    expect(handlePlanArchive(stmts, { plan_id: 99999, status: "completed" })).toContain("not found");
  });
});

describe("plan_delete", () => {
  it("cascades to plan_tasks", () => {
    const out = createPlan("doomed");
    const planId = planIdFrom(out);
    const ids = taskIdsFrom(out);

    handlePlanDelete(stmts, { plan_id: planId, confirm: true });

    expect(stmts.getPlanById.get(planId)).toBeUndefined();
    for (const id of ids) {
      expect(stmts.getTaskById.get(id)).toBeUndefined();
    }
  });
});

describe("plan_cleanup", () => {
  const staleTs = () => Math.floor(Date.now() / 1000) - 100 * 3600;

  it("ignores plans that are still fresh", () => {
    createPlan("fresh");
    expect(handlePlanCleanup(stmts, { stale_hours: 72, scope: "project", dry_run: false }))
      .toContain("Nothing to clean up");
  });

  it("archives plans idle past the threshold", () => {
    const planId = planIdFrom(createPlan("stale"));
    db.prepare("UPDATE plans SET updated_at = ? WHERE id = ?").run(staleTs(), planId);

    const res = handlePlanCleanup(stmts, { stale_hours: 72, scope: "project", dry_run: false });
    expect(res).toContain("Archived 1 stale plan(s)");
    expect(stmts.getPlanById.get(planId)!.status).toBe("abandoned");
  });

  it("changes nothing on a dry run", () => {
    const planId = planIdFrom(createPlan("stale"));
    db.prepare("UPDATE plans SET updated_at = ? WHERE id = ?").run(staleTs(), planId);

    const res = handlePlanCleanup(stmts, { stale_hours: 72, scope: "project", dry_run: true });
    expect(res).toContain("would be archived");
    expect(stmts.getPlanById.get(planId)!.status).toBe("active");
  });
});

describe("plan_get", () => {
  it("shows the project and the real task ids", () => {
    const out = createPlan("p1");
    const planId = planIdFrom(out);
    const ids = taskIdsFrom(out);

    const res = handlePlanGet(stmts, { plan_id: planId });
    expect(res).toContain("Project: alpha");
    expect(res).toContain(`#${ids[0]}`);
  });
});
