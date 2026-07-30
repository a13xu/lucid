/**
 * Session Tracker — emits hints to invoke /compact or /clear when a Claude Code
 * session grows expensive. Driven by UserPromptSubmit and PreCompact hooks.
 *
 * Cost model: Anthropic prompt cache has a 5-minute TTL. Beyond that the next
 * turn re-reads the entire transcript. Long sessions also pay per-turn linearly
 * with transcript length even when warm. Two pressures, two hints:
 *
 *   1) prompt_count >= COMPACT_HINT_AT  → suggest /compact (re-emitted every N).
 *   2) prompt_count >= CLEAR_HINT_AT    → suggest /clear  (one-shot).
 *   3) idle > CACHE_STALE_SECONDS       → cache cold; warn next turn re-bills.
 *
 * Emitted hints are written to STDOUT so the UserPromptSubmit hook injects them
 * into Claude's context (Claude Code convention). Empty stdout = no hint.
 */

import type { Statements } from "../database.js";

const num = (envKey: string, fallback: number): number => {
  const v = process.env[envKey];
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

const COMPACT_HINT_AT     = num("LUCID_COMPACT_HINT_AT",     15);
const COMPACT_HINT_EVERY  = num("LUCID_COMPACT_HINT_EVERY",  10);
const CLEAR_HINT_AT       = num("LUCID_CLEAR_HINT_AT",       30);
const CACHE_STALE_SECONDS = num("LUCID_CACHE_STALE_SECONDS", 300);
/** Below this many prompts, idle gaps don't matter — short session, cheap. */
const IDLE_HINT_MIN_PROMPTS = 5;

export interface SessionTickResult {
  session_id: string;
  prompt_count: number;
  hints: string[];
  cache_likely_cold: boolean;
  idle_seconds: number;
}

/** Fired once per UserPromptSubmit. Returns hints to surface to Claude. */
export function tickSession(
  stmts: Statements,
  sessionId: string,
  cwd: string | null,
): SessionTickResult {
  if (process.env["LUCID_SESSION_HINTS_DISABLED"] === "1") {
    return { session_id: sessionId, prompt_count: 0, hints: [], cache_likely_cold: false, idle_seconds: 0 };
  }

  const now = Math.floor(Date.now() / 1000);
  const existing = stmts.getCliSession.get(sessionId);

  if (!existing) {
    stmts.insertCliSession.run(sessionId, now, now, cwd);
    return { session_id: sessionId, prompt_count: 1, hints: [], cache_likely_cold: false, idle_seconds: 0 };
  }

  const idleSeconds = now - existing.last_activity_at;
  const cacheCold = idleSeconds > CACHE_STALE_SECONDS;
  stmts.tickCliSession.run(now, sessionId);

  const newCount = existing.prompt_count + 1;
  const hints: string[] = [];

  // ── /compact hint: at threshold, then every N prompts after ────────────────
  const compactDue =
    newCount === COMPACT_HINT_AT ||
    (newCount > COMPACT_HINT_AT &&
     (newCount - COMPACT_HINT_AT) % COMPACT_HINT_EVERY === 0);
  if (compactDue) {
    hints.push(formatCompactHint(newCount, existing.compact_count));
    stmts.markCompactHint.run(now, sessionId);
  }

  // ── /clear hint: one-shot at CLEAR_HINT_AT ─────────────────────────────────
  if (newCount >= CLEAR_HINT_AT && existing.last_clear_hint_at === null) {
    hints.push(formatClearHint(newCount));
    stmts.markClearHint.run(now, sessionId);
  }

  // ── Cache-cold hint: only meaningful past warmup ───────────────────────────
  if (cacheCold && newCount >= IDLE_HINT_MIN_PROMPTS) {
    hints.push(formatColdCacheHint(idleSeconds));
  }

  return { session_id: sessionId, prompt_count: newCount, hints, cache_likely_cold: cacheCold, idle_seconds: idleSeconds };
}

/** Fired by PreCompact hook — resets per-session counters. */
export function markCompactEvent(stmts: Statements, sessionId: string): void {
  const now = Math.floor(Date.now() / 1000);
  // Insert a placeholder row if hook fires before any UserPromptSubmit
  if (!stmts.getCliSession.get(sessionId)) {
    stmts.insertCliSession.run(sessionId, now, now, null);
  }
  stmts.markCompactEvent.run(now, sessionId);
}

// ---------------------------------------------------------------------------
// Hint formatters — kept terse: every word costs tokens once injected.
// ---------------------------------------------------------------------------

function formatCompactHint(promptCount: number, prevCompacts: number): string {
  const tail = prevCompacts > 0 ? ` (${prevCompacts} prior /compact in this session)` : "";
  return [
    `[Lucid · session-cost]`,
    `Session is at ${promptCount} prompts${tail}. Per-turn cost grows with transcript length even when cached.`,
    `→ Run /compact mid-task to summarize earlier turns and reduce input tokens for the next ~${COMPACT_HINT_EVERY} prompts.`,
  ].join(" ");
}

function formatClearHint(promptCount: number): string {
  return [
    `[Lucid · session-cost]`,
    `Session has reached ${promptCount} prompts.`,
    `→ If you are switching to a new task with little overlap, prefer /clear over /compact — fresh context is cheaper than a summary.`,
  ].join(" ");
}

function formatColdCacheHint(idleSeconds: number): string {
  const mins = Math.round(idleSeconds / 60);
  return [
    `[Lucid · session-cost]`,
    `${mins}m idle: prompt cache (5-min TTL) is cold. This turn rebuilds it from scratch (~3-4× the cached cost).`,
    `→ For long pauses, run /compact before resuming so the rebuilt cache covers a smaller transcript.`,
  ].join(" ");
}

export const SESSION_TUNABLES = {
  COMPACT_HINT_AT,
  COMPACT_HINT_EVERY,
  CLEAR_HINT_AT,
  CACHE_STALE_SECONDS,
  IDLE_HINT_MIN_PROMPTS,
} as const;
