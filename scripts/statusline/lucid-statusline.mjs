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

function fmtReset(ts, withDay) {
  // ISO string from the OAuth endpoint; stdin rate_limits may hand an epoch.
  const d = typeof ts === "number" ? new Date(ts < 1e12 ? ts * 1000 : ts) : new Date(ts);
  if (isNaN(d.getTime())) return "";
  const hm = String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  return withDay ? `${RO_DAYS[d.getDay()]} ${hm}` : hm;
}

/**
 * usedPct must arrive ALREADY normalised to 0-100. The 0-1-fraction handling
 * lives in pct() at the OAuth call site only — stdin's used_percentage is
 * documented as a percentage, where a legitimate 0.4 means 0.4% used and must
 * not be re-read as a fraction.
 */
function quotaSeg(icon, label, usedPct, resetsAt, withDay) {
  const left = Math.max(0, Math.min(100, 100 - usedPct));
  let seg = `${icon} ${label} ${miniBar(left)} ${Math.round(left)}% left`;
  if (resetsAt) {
    const r = fmtReset(resetsAt, withDay);
    if (r) seg += ` ·${r}`;
  }
  return seg;
}

/**
 * 5h/7d quota straight from the session JSON — Claude Code ≥2.1.251 pipes
 * `rate_limits` on stdin, which beats the OAuth fetch on every axis: always
 * fresh, no token read, no network, no 429. Returns null on older versions so
 * the caller can fall back to the fetch.
 */
function stdinRateLimitSegments(input) {
  const rl = input && input.rate_limits;
  if (!rl) return null;
  const segments = [];
  if (rl.five_hour && typeof rl.five_hour.used_percentage === "number") {
    segments.push(quotaSeg("⏳", "5h", rl.five_hour.used_percentage, rl.five_hour.resets_at, false));
  }
  if (rl.seven_day && typeof rl.seven_day.used_percentage === "number") {
    segments.push(quotaSeg("📆", "7d", rl.seven_day.used_percentage, rl.seven_day.resets_at, true));
  }
  return segments.length ? segments : null;
}

function quotaBucket(data, keys) {
  for (const k of keys) {
    const b = data && data[k];
    if (b && typeof b.utilization === "number") return b;
  }
  return null;
}

function buildQuota(data) {
  // core = 5h + 7d; scoped = per-model weekly caps from limits[] (e.g. Fable),
  // which stdin rate_limits does not carry — the OAuth endpoint stays their
  // only source, so the two groups are cached separately.
  const core = [];
  const five = quotaBucket(data, ["five_hour", "session", "fiveHour"]);
  if (five) core.push(quotaSeg("⏳", "5h", pct(five.utilization), five.resets_at || five.resetsAt, false));
  const week = quotaBucket(data, ["seven_day", "sevenDay", "weekly"]);
  if (week) core.push(quotaSeg("📆", "7d", pct(week.utilization), week.resets_at || week.resetsAt, true));

  const scoped = [];
  if (Array.isArray(data && data.limits)) {
    for (const l of data.limits) {
      if (l && l.kind === "weekly_scoped" && typeof l.percent === "number") {
        const label = (l.scope && l.scope.model && l.scope.model.display_name) || "scoped";
        scoped.push(`${label} ${Math.round(100 - pct(l.percent))}%`);
      }
    }
  }
  return { core, scoped };
}

function readQuotaCache() {
  try {
    const c = JSON.parse(readFileSync(QUOTA_CACHE, "utf8"));
    if (typeof c.ts !== "number") return null;
    if (Array.isArray(c.core)) return { ts: c.ts, core: c.core, scoped: Array.isArray(c.scoped) ? c.scoped : [] };
    // Pre-split cache: core and scoped strings are mixed together. Usable only
    // when the caller wants everything; a scoped-only read must refetch.
    if (Array.isArray(c.segments)) return { ts: c.ts, core: c.segments, scoped: null };
  } catch { /* no usable cache */ }
  return null;
}

/**
 * Quota via the OAuth usage endpoint. With scopedOnly=true only the per-model
 * weekly caps are returned — used when stdin already delivered 5h/7d, which
 * that endpoint alone still cannot.
 */
async function quotaSegments(debug, scopedOnly = false) {
  const cached = readQuotaCache();
  const pick = (q) => {
    if (scopedOnly) return q.scoped;   // null = mixed legacy cache → unusable
    return q.scoped === null ? q.core : [...q.core, ...q.scoped];
  };

  if (!debug && cached && Date.now() - cached.ts < QUOTA_TTL_MS) {
    const hit = pick(cached);
    if (hit) return hit;
  }

  // Every failure path lands here rather than on []: a refresh that fails is a
  // reason to keep showing the last reading, not to blank the segment.
  const lastKnown = () => {
    if (cached && Date.now() - cached.ts < QUOTA_STALE_MAX_MS) {
      const w = pick(cached);
      if (w) return w;
    }
    return [];
  };

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
    const { core, scoped } = buildQuota(data);
    try { writeFileSync(QUOTA_CACHE, JSON.stringify({ ts: Date.now(), core, scoped })); } catch { /* ignore */ }
    return scopedOnly ? scoped : [...core, ...scoped];
  } catch (e) {
    if (debug) console.error("quota error:", e.message);
    return lastKnown();
  }
}

// ---------- Context window ----------

/**
 * Context usage from the session JSON (Claude Code pipes context_window on
 * stdin). ⚠ from 85%: auto-compact fires around that mark, so past it the
 * number is a prompt to reach a task boundary, not trivia.
 */
function contextSegments(input) {
  const cw = input && input.context_window;
  if (!cw || typeof cw.used_percentage !== "number") return [];
  const used = Math.max(0, Math.min(100, cw.used_percentage));
  return [`🪟 ctx ${Math.round(used)}%${used >= 85 ? " ⚠" : ""}`];
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

  // 5h/7d from stdin when this Claude Code provides them (≥2.1.251); the OAuth
  // endpoint then only supplies what stdin cannot — per-model weekly caps. On
  // older versions the endpoint carries everything, as before.
  const stdinQuota = stdinRateLimitSegments(input);
  if (stdinQuota) {
    parts.push(...stdinQuota);
    parts.push(...(await quotaSegments(debug, true)));
  } else {
    parts.push(...(await quotaSegments(debug)));
  }
  parts.push(...contextSegments(input));
  parts.push(...(await lucidSegments(cwd)));
  parts.push(...watchSegments());

  process.stdout.write(parts.join(" | "));
}

main();
