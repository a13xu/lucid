/**
 * Session Tracker — emits session-cost hints into a Claude Code session.
 * Driven by UserPromptSubmit and PreCompact hooks.
 *
 *   1) idle > CACHE_STALE_SECONDS       → cache cold; the next turn re-bills it.  (default on)
 *   2) prompt_count >= COMPACT_HINT_AT  → suggest /compact (re-emitted every N).  (opt-in)
 *   3) prompt_count >= CLEAR_HINT_AT    → suggest /clear  (one-shot).             (opt-in)
 *
 * The prompt-count hints are off unless their env var is set. A prompt count
 * says nothing about context size on 1M-token models: Claude Code auto-compacts
 * near the window limit and the status bar's ctx segment shows real usage, so a
 * fixed "/compact at 15 prompts" only pushed sessions to throw away context early.
 *
 * Cache TTL defaults to 1 h — what Claude Code sessions on a subscription get.
 * API-key sessions on the 5-minute cache set LUCID_CACHE_STALE_SECONDS=300.
 *
 * Emitted hints are written to STDOUT so the UserPromptSubmit hook injects them
 * into Claude's context (Claude Code convention). Empty stdout = no hint.
 */

import type { Statements } from "../database.js";

/** Positive number from env, or null when unset/invalid. */
const optNum = (envKey: string): number | null => {
  const v = process.env[envKey];
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

const COMPACT_HINT_AT     = optNum("LUCID_COMPACT_HINT_AT");
const COMPACT_HINT_EVERY  = optNum("LUCID_COMPACT_HINT_EVERY") ?? 10;
const CLEAR_HINT_AT       = optNum("LUCID_CLEAR_HINT_AT");
const CACHE_STALE_SECONDS = optNum("LUCID_CACHE_STALE_SECONDS") ?? 3600;
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
    COMPACT_HINT_AT !== null &&
    (newCount === COMPACT_HINT_AT ||
     (newCount > COMPACT_HINT_AT &&
      (newCount - COMPACT_HINT_AT) % COMPACT_HINT_EVERY === 0));
  if (compactDue) {
    hints.push(formatCompactHint(newCount, existing.compact_count));
    stmts.markCompactHint.run(now, sessionId);
  }

  // ── /clear hint: one-shot at CLEAR_HINT_AT ─────────────────────────────────
  if (CLEAR_HINT_AT !== null && newCount >= CLEAR_HINT_AT && existing.last_clear_hint_at === null) {
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
    `The user may want /compact at the next natural task boundary.`,
  ].join(" ");
}

function formatClearHint(promptCount: number): string {
  return [
    `[Lucid · session-cost]`,
    `Session has reached ${promptCount} prompts.`,
    `If the user is switching to an unrelated task, /clear is cheaper than /compact — fresh context costs less than a summary.`,
  ].join(" ");
}

function formatColdCacheHint(idleSeconds: number): string {
  const mins = Math.round(idleSeconds / 60);
  return [
    `[Lucid · session-cost]`,
    `${mins}m idle: the prompt cache (${Math.round(CACHE_STALE_SECONDS / 60)}-min TTL) has likely expired, so this turn re-reads the transcript at full price.`,
    `If the session is long and the next task is unrelated, /clear avoids paying that again on every turn.`,
  ].join(" ");
}

export const SESSION_TUNABLES = {
  COMPACT_HINT_AT,
  COMPACT_HINT_EVERY,
  CLEAR_HINT_AT,
  CACHE_STALE_SECONDS,
  IDLE_HINT_MIN_PROMPTS,
} as const;
