#!/usr/bin/env node
/**
 * Lucid statusline for Claude Code.
 *
 * Installed by `lucid setup statusline`, which substitutes __LUCID_ROOT__ with
 * the absolute path of this Lucid installation. Do not edit the installed copy —
 * re-run the setup command instead; the template lives in the package under
 * scripts/statusline/.
 *
 * Reads the session JSON on stdin, prints one line:
 *   model | 5h quota left | weekly quota left | Lucid stats | plan progress | commands.
 * Quota comes from Anthropic's own OAuth usage endpoint (the same one /usage
 * uses) with the local Claude Code token — it is only ever sent to
 * api.anthropic.com. Every segment degrades gracefully: the bar must never crash.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const LUCID_ROOT = "__LUCID_ROOT__";
const DB_PATH = process.env.MEMORY_DB_PATH || join(homedir(), ".claude", "memory.db");
const QUOTA_CACHE = join(homedir(), ".claude", "lucid-quota-cache.json");
const QUOTA_TTL_MS = 60 * 1000;
/**
 * How long a cached reading may still be served after a failed refresh. The
 * usage endpoint rate-limits (HTTP 429) when several Claude Code windows render
 * at once, and dropping the segment on every hiccup makes the bar flicker
 * between two widths. Quota moves slowly, and reset times are absolute, so a
 * reading this recent is still worth showing; past it, show nothing.
 */
const QUOTA_STALE_MAX_MS = 30 * 60 * 1000;
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

// Anchored at the Lucid build so Node's resolver finds better-sqlite3 whether
// deps sit inside the package or hoisted into a global node_modules root.
const lucidRequire = createRequire(pathToFileURL(join(LUCID_ROOT, "build", "index.js")));

function readStdin() {
  try {
    return JSON.parse(readFileSync(0, "utf8").replace(/^﻿/, "").trim());
  } catch {
    return {};
  }
}

// ---------- Quota (5h session + weekly) ----------

const RO_DAYS = ["Du", "Lu", "Ma", "Mi", "Jo", "Vi", "Sâ"];

function pct(utilization) {
  // Defensive: the endpoint may report a 0-1 fraction or a 0-100 percent.
  const u = utilization <= 1 ? utilization * 100 : utilization;
  return Math.max(0, Math.min(100, u));
}

function miniBar(leftPct) {
  const filled = Math.round((leftPct / 100) * 5);
  return "▓".repeat(filled) + "░".repeat(5 - filled);
}

function fmtReset(iso, withDay) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const hm = String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  return withDay ? `${RO_DAYS[d.getDay()]} ${hm}` : hm;
}

function quotaBucket(data, keys) {
  for (const k of keys) {
    const b = data && data[k];
    if (b && typeof b.utilization === "number") return b;
  }
  return null;
}

function buildQuotaSegments(data) {
  const segments = [];
  const five = quotaBucket(data, ["five_hour", "session", "fiveHour"]);
  if (five) {
    const left = 100 - pct(five.utilization);
    let seg = `⏳ 5h ${miniBar(left)} ${Math.round(left)}% left`;
    const reset = five.resets_at || five.resetsAt;
    if (reset) seg += ` ·${fmtReset(reset, false)}`;
    segments.push(seg);
  }
  const week = quotaBucket(data, ["seven_day", "sevenDay", "weekly"]);
  if (week) {
    const left = 100 - pct(week.utilization);
    let seg = `📆 7d ${miniBar(left)} ${Math.round(left)}% left`;
    const reset = week.resets_at || week.resetsAt;
    if (reset) seg += ` ·${fmtReset(reset, true)}`;
    segments.push(seg);
  }
  // Model-scoped weekly limits from the limits[] array (e.g. Fable weekly).
  if (Array.isArray(data && data.limits)) {
    for (const l of data.limits) {
      if (l && l.kind === "weekly_scoped" && typeof l.percent === "number") {
        const label = (l.scope && l.scope.model && l.scope.model.display_name) || "scoped";
        segments.push(`${label} ${Math.round(100 - pct(l.percent))}%`);
      }
    }
  }
  return segments;
}

function readQuotaCache() {
  try {
    const c = JSON.parse(readFileSync(QUOTA_CACHE, "utf8"));
    if (Array.isArray(c.segments) && typeof c.ts === "number") return c;
  } catch { /* no usable cache */ }
  return null;
}

async function quotaSegments(debug) {
  const cached = readQuotaCache();
  if (!debug && cached && Date.now() - cached.ts < QUOTA_TTL_MS) return cached.segments;

  // Every failure path lands here rather than on []: a refresh that fails is a
  // reason to keep showing the last reading, not to blank the segment.
  const lastKnown = () =>
    cached && Date.now() - cached.ts < QUOTA_STALE_MAX_MS ? cached.segments : [];

  try {
    const credsFile = join(homedir(), ".claude", ".credentials.json");
    const creds = JSON.parse(readFileSync(credsFile, "utf8")).claudeAiOauth;
    if (!creds || !creds.accessToken) return lastKnown();
    if (creds.expiresAt && creds.expiresAt < Date.now()) return lastKnown();
    const res = await fetch(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${creds.accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
      },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) {
      // 429 is routine: several windows rendering at once share this endpoint.
      if (debug) console.error("usage endpoint HTTP", res.status);
      return lastKnown();
    }
    const data = await res.json();
    if (debug) console.error(JSON.stringify(data, null, 2));
    const segments = buildQuotaSegments(data);
    try { writeFileSync(QUOTA_CACHE, JSON.stringify({ ts: Date.now(), segments })); } catch { /* ignore */ }
    return segments;
  } catch (e) {
    if (debug) console.error("quota error:", e.message);
    return lastKnown();
  }
}

// ---------- Lucid DB (stats + plan progress) ----------

/**
 * Whether `plans` carries the project column yet. A read-only helper cannot run
 * the migration itself, so until the MCP server has started once we fall back
 * to the old unfiltered behaviour rather than showing nothing.
 */
function plansAreScoped(db) {
  try {
    return db.prepare("PRAGMA table_info(plans)").all().some((c) => c.name === "project");
  } catch {
    return false;
  }
}

async function lucidSegments(cwd) {
  const segments = [];
  let db;
  try {
    const Database = lucidRequire("better-sqlite3");
    db = new Database(DB_PATH, { readonly: true, fileMustExist: true });

    try {
      const e = db.prepare("SELECT COUNT(*) AS c FROM entities").get().c;
      const f = db.prepare("SELECT COUNT(*) AS c FROM file_contents").get().c;
      segments.push(`🧠 ${e}e/${f}f`);
    } catch { /* stats unavailable */ }

    try {
      // Plans of OTHER projects must never reach this bar: one shared DB is used
      // by every checkout, so an unfiltered "most recent active plan" is
      // routinely somebody else's work.
      let plan;
      let scoped = false;
      try {
        const { resolveScope, isSameProject } =
          await import(pathToFileURL(join(LUCID_ROOT, "build", "project.js")).href);
        scoped = plansAreScoped(db);
        if (scoped) {
          const scopeId = resolveScope(cwd).id;
          plan = db
            .prepare("SELECT id, title, project FROM plans WHERE status = 'active' ORDER BY updated_at DESC")
            .all()
            .find((p) => isSameProject(p.project, scopeId));
        }
      } catch { /* build/project.js unavailable — fall through to unscoped */ }

      if (!scoped) {
        plan = db
          .prepare("SELECT id, title FROM plans WHERE status = 'active' ORDER BY updated_at DESC LIMIT 1")
          .get();
      }

      if (plan) {
        const rows = db
          .prepare("SELECT status, COUNT(*) AS c FROM plan_tasks WHERE plan_id = ? GROUP BY status")
          .all(plan.id);
        const byStatus = {};
        let total = 0;
        for (const r of rows) { byStatus[r.status] = r.c; total += r.c; }
        const done = byStatus.done || 0;
        const current = db
          .prepare("SELECT title FROM plan_tasks WHERE plan_id = ? AND status = 'in_progress' ORDER BY seq LIMIT 1")
          .get(plan.id);
        const planTitle = plan.title.length > 24 ? plan.title.slice(0, 23) + "…" : plan.title;
        let seg = `📋 ${planTitle}: ${done}/${total} (${total - done} left)`;
        if (byStatus.blocked) seg += ` 🚫${byStatus.blocked}`;
        if (current) {
          const t = current.title.length > 28 ? current.title.slice(0, 27) + "…" : current.title;
          seg += ` 🔄 ${t}`;
        }
        seg += " ·/tasks";
        segments.push(seg);
      } else {
        // Reaching here means the queries succeeded and there simply is no
        // active plan for this project. Say so rather than dropping the segment:
        // an absent 📋 is indistinguishable from a broken status bar.
        segments.push("📋 no active plan ·/tasks");
      }
    } catch { /* plan info unavailable — omit the segment entirely */ }
  } catch {
    /* better-sqlite3 or DB missing — skip Lucid segments entirely */
  } finally {
    try { if (db) db.close(); } catch { /* ignore */ }
  }
  return segments;
}

// ---------- Watch daemon ----------

/**
 * The `lucid watch` daemon, if it is alive. Same check `lucid status` performs:
 * a pidfile plus signal 0, which costs microseconds and touches no network.
 *
 * Shown only when running. The daemon is optional — sync falls back to a direct
 * SQLite write without it — so "off" is the ordinary state and not worth the
 * width. A segment that never changes teaches the eye to skip the whole bar.
 */
function watchSegments() {
  try {
    const pid = Number(readFileSync(join(homedir(), ".lucid", "watch.pid"), "utf8").trim());
    if (!Number.isInteger(pid) || pid <= 0) return [];
    process.kill(pid, 0);   // throws if the process is gone (stale pidfile)
    return ["👁 watch"];
  } catch {
    return [];
  }
}

// ---------- Main ----------

async function main() {
  const debug = process.argv.includes("--debug-usage");
  const input = readStdin();
  const parts = [];

  const model = (input.model && (input.model.display_name || input.model.id)) || "Claude";
  parts.push(`⚡ ${model}`);

  const cwd =
    input.cwd ||
    (input.workspace && (input.workspace.current_dir || input.workspace.project_dir)) ||
    process.cwd();

  parts.push(...(await quotaSegments(debug)));
  parts.push(...(await lucidSegments(cwd)));
  parts.push(...watchSegments());

  process.stdout.write(parts.join(" | "));
}

main();
