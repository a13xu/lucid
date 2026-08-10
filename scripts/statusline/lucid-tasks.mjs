#!/usr/bin/env node
/**
 * Drill-down for the Lucid plan segment in the statusline (the /tasks command).
 * Prints the active plan(s) of the project it is run from, with the full task
 * list, status icons, and notes.
 *
 * Installed by `lucid setup statusline`, which substitutes __LUCID_ROOT__ with
 * the absolute path of this Lucid installation. Edit the packaged template under
 * scripts/statusline/, not the installed copy.
 *
 * Usage: node lucid-tasks.mjs [--all]   (--all also shows completed plans)
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const LUCID_ROOT = "__LUCID_ROOT__";
const DB_PATH = process.env.MEMORY_DB_PATH || join(homedir(), ".claude", "memory.db");

const ICONS = { pending: "⬜", in_progress: "🔄", done: "✅", blocked: "🚫" };

const lucidRequire = createRequire(pathToFileURL(join(LUCID_ROOT, "build", "index.js")));

function plansAreScoped(db) {
  try {
    return db.prepare("PRAGMA table_info(plans)").all().some((c) => c.name === "project");
  } catch {
    return false;
  }
}

async function main() {
  const showAll = process.argv.includes("--all");
  let db;
  try {
    const Database = lucidRequire("better-sqlite3");
    db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  } catch (e) {
    console.log("Lucid DB unavailable:", e.message);
    return;
  }

  const where = showAll ? "" : "WHERE status = 'active'";
  let plans = db.prepare(`SELECT * FROM plans ${where} ORDER BY updated_at DESC LIMIT 50`).all();

  // Scope to the project this command was run in. Legacy rows (project = '')
  // predate scoping and are listed separately below instead of being dropped.
  let legacy = [];
  let scope = null;
  try {
    const { resolveScope, isSameProject } =
      await import(pathToFileURL(join(LUCID_ROOT, "build", "project.js")).href);
    if (plansAreScoped(db)) {
      scope = resolveScope(process.cwd());
      legacy = plans.filter((p) => !p.project);
      plans = plans.filter((p) => isSameProject(p.project, scope.id));
    }
  } catch { /* build/project.js unavailable — show everything, as before */ }

  if (scope) console.log(`Project: ${scope.name} (${scope.id})`);

  if (!plans.length && !legacy.length) {
    console.log(showAll ? "No plans for this project." : "No active plans here. Use --all to include completed ones.");
    db.close();
    return;
  }

  for (const plan of plans.slice(0, 10)) {
    const tasks = db.prepare("SELECT * FROM plan_tasks WHERE plan_id = ? ORDER BY seq").all(plan.id);
    const done = tasks.filter((t) => t.status === "done").length;

    console.log(`\n📋 [${plan.id}] ${plan.title} — ${plan.status} — ${done}/${tasks.length} done`);
    if (plan.description) console.log(`   ${plan.description}`);

    for (const t of tasks) {
      console.log(`   ${ICONS[t.status] || "❓"} ${t.seq}. [${t.id}] ${t.title}`);
      if (t.description) console.log(`        ${t.description}`);
      if (t.test_criteria) console.log(`        done when: ${t.test_criteria}`);
      if (t.notes) {
        try {
          for (const n of JSON.parse(t.notes)) {
            // Notes can be multi-line worker logs — keep the first line only.
            const line = String(n.text).split(/\r?\n/)[0];
            console.log(`        📝 ${line.length > 120 ? line.slice(0, 119) + "…" : line}`);
          }
        } catch { /* notes not JSON — skip */ }
      }
    }
  }

  if (legacy.length) {
    console.log(`\n⚠ ${legacy.length} plan(s) with no project (created before scoping):`);
    for (const p of legacy) {
      console.log(`   [${p.id}] ${p.title} — ${p.status}`);
    }
    console.log("   Close them with plan_archive, or remove them with plan_delete.");
  }

  console.log("");
  db.close();
}

main();
