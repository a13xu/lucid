import { Router } from "express";
import { stmts } from "../db.js";

const router = Router();

// ---------------------------------------------------------------------------
// SSE client registry
// ---------------------------------------------------------------------------

const sseClients = new Set();

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(msg);
    } catch {
      sseClients.delete(client);
    }
  }
}

// ---------------------------------------------------------------------------
// DB poll — compares MAX(id) and heartbeat signature
// ---------------------------------------------------------------------------

let _lastMaxId = 0;
let _lastHbSig = "";

function pollDb() {
  try {
    const { max_id } = stmts.getMaxActionId.get();
    const instances = stmts.getAllInstancesWithLastAction.all();
    const hbSig = instances.map(i => `${i.instance_id}:${i.last_heartbeat}:${i.status}`).join("|");

    if (max_id !== _lastMaxId || hbSig !== _lastHbSig) {
      _lastMaxId = max_id;
      _lastHbSig = hbSig;
      broadcast("orchestrator", { instances, ts: Date.now() });
    }
  } catch { /* suppress */ }
}

setInterval(pollDb, 2000).unref();

// ---------------------------------------------------------------------------
// GET /api/events  — SSE endpoint
// ---------------------------------------------------------------------------

router.get("/events", (req, res) => {
  res.setHeader("Content-Type",  "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection",    "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // disable nginx buffering
  res.flushHeaders();
  if (res.socket) res.socket.setNoDelay(true); // fix Windows buffering

  // Flush current state immediately on connect
  try {
    const instances = stmts.getAllInstancesWithLastAction.all();
    res.write(`event: orchestrator\ndata: ${JSON.stringify({ instances, ts: Date.now() })}\n\n`);
  } catch { /* suppress */ }

  sseClients.add(res);

  // Keepalive comment every 25s
  const ka = setInterval(() => {
    try { res.write(": ping\n\n"); } catch { clearInterval(ka); }
  }, 25_000);
  ka.unref();

  req.on("close", () => {
    clearInterval(ka);
    sseClients.delete(res);
  });
});

// ---------------------------------------------------------------------------
// GET /api/instances/:id/actions
// ---------------------------------------------------------------------------

router.get("/instances/:id/actions", (req, res) => {
  try {
    const actions = stmts.getInstanceActions.all(req.params.id);
    res.json(actions);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
