import Database from "better-sqlite3";
import { randomUUID } from "crypto";

const MAX_ACTIONS_KEPT = 200;
// Fields whose values may be large blobs — truncate in stored args
const BLOB_FIELDS = new Set(["code", "content", "observations", "body", "data", "text"]);

export interface InstanceInfo {
  instance_id: string;
  pid: number;
  label: string;
}

let _instanceInfo: InstanceInfo | null = null;

function sanitizeArgs(args: unknown): string {
  if (!args || typeof args !== "object") return JSON.stringify(args ?? {});
  const copy: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    if (typeof v === "string" && BLOB_FIELDS.has(k) && v.length > 200) {
      copy[k] = `[${v.length} chars]`;
    } else {
      copy[k] = v;
    }
  }
  return JSON.stringify(copy);
}

export function registerInstance(db: Database.Database): InstanceInfo {
  if (_instanceInfo) return _instanceInfo;

  const instance_id = randomUUID();
  const pid = process.pid;
  const label = process.env["LUCID_INSTANCE_LABEL"] ?? "";

  db.prepare(
    "INSERT OR REPLACE INTO instances (instance_id, pid, label, started_at, last_heartbeat, status) VALUES (?, ?, ?, unixepoch(), unixepoch(), 'active')"
  ).run(instance_id, pid, label);

  _instanceInfo = { instance_id, pid, label };

  // Prepared statements for heartbeat (compiled once)
  const hbStmt = db.prepare(
    "UPDATE instances SET last_heartbeat = unixepoch(), status = 'active' WHERE instance_id = ?"
  );
  const staleStmt = db.prepare(
    "UPDATE instances SET status = 'stale' WHERE status = 'active' AND last_heartbeat < unixepoch() - 45 AND instance_id != ?"
  );
  const deadStmt = db.prepare(
    "UPDATE instances SET status = 'dead' WHERE status != 'dead' AND last_heartbeat < unixepoch() - 120 AND instance_id != ?"
  );

  const timer = setInterval(() => {
    try {
      hbStmt.run(instance_id);
      staleStmt.run(instance_id);
      deadStmt.run(instance_id);
    } catch { /* suppress — never break the tool handler */ }
  }, 15_000);
  timer.unref();

  const markDead = () => {
    try {
      db.prepare("UPDATE instances SET status = 'dead' WHERE instance_id = ?").run(instance_id);
    } catch { /* suppress */ }
  };

  // "exit" fires during an already-in-progress exit — no process.exit() needed
  process.once("exit", markDead);
  // SIGTERM/SIGINT: mark dead then let the process exit (must call process.exit()
  // explicitly, otherwise the signal listener swallows the default exit behaviour)
  process.once("SIGTERM", () => { markDead(); process.exit(0); });
  process.once("SIGINT",  () => { markDead(); process.exit(0); });

  console.error(`[lucid] Instance registered: ${instance_id} (PID ${pid})`);
  return _instanceInfo;
}

export function getInstanceInfo(): InstanceInfo | null {
  return _instanceInfo;
}

export function logAction(
  db: Database.Database,
  tool_name: string,
  args: unknown,
  result_ok: boolean,
  duration_ms: number,
): void {
  if (!_instanceInfo) return;
  try {
    const args_json = sanitizeArgs(args);
    db.prepare(
      "INSERT INTO instance_actions (instance_id, tool_name, args_json, result_ok, duration_ms) VALUES (?, ?, ?, ?, ?)"
    ).run(_instanceInfo.instance_id, tool_name, args_json, result_ok ? 1 : 0, duration_ms);

    // Keep only the last MAX_ACTIONS_KEPT rows per instance
    db.prepare(`
      DELETE FROM instance_actions
      WHERE instance_id = ?
        AND id NOT IN (
          SELECT id FROM instance_actions
          WHERE instance_id = ?
          ORDER BY id DESC
          LIMIT ${MAX_ACTIONS_KEPT}
        )
    `).run(_instanceInfo.instance_id, _instanceInfo.instance_id);
  } catch { /* suppress — never propagate to caller */ }
}
