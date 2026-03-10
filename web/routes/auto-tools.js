/**
 * Lucid Auto-Tools REST API
 * Exposes sync_file, init_project, validate_file, check_code_quality
 * as HTTP endpoints so hook scripts can call them without MCP.
 *
 * Uses a dedicated DB connection (separate from web/db.js) importing
 * from the compiled MCP build. Both connections use WAL mode so
 * concurrent access from MCP server + web server + hooks is safe.
 */

import { Router } from "express";
import { fileURLToPath, pathToFileURL } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUILD_DIR = join(__dirname, "..", "..", "build");

// Node.js ESM dynamic imports require file:// URLs (especially on Windows)
function buildUrl(rel) {
  return pathToFileURL(join(BUILD_DIR, rel)).href;
}

const router = Router();

// ---------------------------------------------------------------------------
// Lazy-initialized connection to the MCP build tools
// (imports resolved at first request to avoid blocking server startup)
// ---------------------------------------------------------------------------

let _ready = false;
let _stmts = null;
let _handleSyncFile, _handleSyncProject, _handleInitProject;
let _handleValidateFile, _handleCheckCodeQuality;

async function ensureReady() {
  if (_ready) return true;
  try {
    const { initDatabase, prepareStatements } = await import(buildUrl("database.js"));
    const { handleSyncFile, handleSyncProject } = await import(buildUrl("tools/sync.js"));
    const { handleInitProject }                 = await import(buildUrl("tools/init.js"));
    const { handleValidateFile }                = await import(buildUrl("tools/guardian.js"));
    const { handleCheckCodeQuality }            = await import(buildUrl("tools/coding-guard.js"));

    const db = initDatabase();
    _stmts = prepareStatements(db);
    _handleSyncFile        = handleSyncFile;
    _handleSyncProject     = handleSyncProject;
    _handleInitProject     = handleInitProject;
    _handleValidateFile    = handleValidateFile;
    _handleCheckCodeQuality = handleCheckCodeQuality;
    _ready = true;
    return true;
  } catch (err) {
    console.error("[auto-tools] Failed to load build:", err.message);
    return false;
  }
}

// Warm up on startup (non-blocking)
ensureReady().catch(() => {});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

router.get("/auto/ping", (_req, res) => res.json({ ok: true }));

router.post("/auto/sync-file", async (req, res) => {
  const { path } = req.body ?? {};
  if (!path) return res.status(400).json({ error: "path required" });
  if (!await ensureReady()) return res.status(503).json({ error: "Lucid build not available" });
  try {
    const result = _handleSyncFile(_stmts, { path });
    res.json({ ok: true, result });
    // Fire-and-forget: trigger E2E tests whose tags overlap with this file
    fetch(`http://localhost:${process.env.PORT ?? 3069}/api/e2e/trigger-by-file`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_path: path }),
    }).catch(() => {});
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.post("/auto/sync-project", async (req, res) => {
  const { directory } = req.body ?? {};
  if (!await ensureReady()) return res.status(503).json({ error: "Lucid build not available" });
  try {
    const result = _handleSyncProject(_stmts, { directory: directory || undefined });
    res.json({ ok: true, result });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.post("/auto/init-project", async (req, res) => {
  const { directory } = req.body ?? {};
  if (!await ensureReady()) return res.status(503).json({ error: "Lucid build not available" });
  try {
    const result = await _handleInitProject(_stmts, { directory: directory || undefined });
    res.json({ ok: true, result });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.post("/auto/validate-file", async (req, res) => {
  const { path } = req.body ?? {};
  if (!path) return res.status(400).json({ error: "path required" });
  if (!await ensureReady()) return res.status(503).json({ error: "Lucid build not available" });
  try {
    const result = _handleValidateFile({ path });
    res.json({ ok: true, result });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.post("/auto/check-quality", async (req, res) => {
  const { path, code, language } = req.body ?? {};
  if (!path && !code) return res.status(400).json({ error: "path or code required" });
  if (!await ensureReady()) return res.status(503).json({ error: "Lucid build not available" });
  try {
    const result = _handleCheckCodeQuality({ path, code, language });
    res.json({ ok: true, result });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

export default router;
