import { z } from "zod";
import type { Statements } from "../database.js";
import { SESSION_TUNABLES } from "../guardian/session-tracker.js";

// ---------------------------------------------------------------------------
// session_status — show current session-cost state and hint thresholds
// ---------------------------------------------------------------------------

export const SessionStatusSchema = z.object({
  session_id: z.string().optional()
    .describe("Specific session id. Defaults to the most recently active session."),
  limit: z.number().int().positive().max(50).optional()
    .describe("How many recent sessions to list when session_id is omitted (default 5)."),
});

export function handleSessionStatus(
  stmts: Statements,
  args: z.infer<typeof SessionStatusSchema>,
): string {
  const limit = args.limit ?? 5;

  if (args.session_id) {
    const row = stmts.getCliSession.get(args.session_id);
    if (!row) return `No session found with id=${args.session_id}`;
    return formatSession(row, true);
  }

  const recent = stmts.recentCliSessions.all(limit);
  if (recent.length === 0) {
    return [
      `No Claude Code sessions tracked yet.`,
      ``,
      `Hints fire at:`,
      `  /compact at ${SESSION_TUNABLES.COMPACT_HINT_AT} prompts (re-emitted every ${SESSION_TUNABLES.COMPACT_HINT_EVERY})`,
      `  /clear   at ${SESSION_TUNABLES.CLEAR_HINT_AT} prompts (one-shot)`,
      `  cache-cold after ${SESSION_TUNABLES.CACHE_STALE_SECONDS}s idle`,
    ].join("\n");
  }

  const lines: string[] = [
    `📊 Recent Claude Code sessions (top ${recent.length}):`,
    ``,
  ];
  for (const r of recent) lines.push(formatSession(r, false));
  lines.push(``);
  lines.push(`Thresholds: /compact@${SESSION_TUNABLES.COMPACT_HINT_AT} (+${SESSION_TUNABLES.COMPACT_HINT_EVERY}), ` +
             `/clear@${SESSION_TUNABLES.CLEAR_HINT_AT}, cache-cold>${SESSION_TUNABLES.CACHE_STALE_SECONDS}s`);
  return lines.join("\n");
}

function formatSession(r: import("../database.js").CliSessionRow, full: boolean): string {
  const idle = Math.floor(Date.now() / 1000) - r.last_activity_at;
  const idleStr = idle < 60 ? `${idle}s` : idle < 3600 ? `${Math.round(idle / 60)}m` : `${Math.round(idle / 3600)}h`;
  const status =
    r.prompt_count >= SESSION_TUNABLES.CLEAR_HINT_AT  ? "🔴" :
    r.prompt_count >= SESSION_TUNABLES.COMPACT_HINT_AT ? "🟠" : "🟢";

  const head = `${status} ${r.session_id.slice(0, 8)}…  ${r.prompt_count} prompts  idle=${idleStr}  compacts=${r.compact_count}`;
  if (!full) return "  " + head;

  return [
    head,
    `   started:    ${new Date(r.started_at * 1000).toISOString()}`,
    `   last activ: ${new Date(r.last_activity_at * 1000).toISOString()}`,
    r.last_compact_event_at
      ? `   last compact: ${new Date(r.last_compact_event_at * 1000).toISOString()}`
      : `   last compact: —`,
    r.cwd ? `   cwd: ${r.cwd}` : ``,
  ].filter(Boolean).join("\n");
}
