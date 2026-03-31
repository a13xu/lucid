import { Router } from "express";
import type { Statements } from "../database.js";
import { handleSyncFile, handleSyncProject } from "../tools/sync.js";
import { handleGetContext } from "../tools/context.js";
import { handleValidateFile } from "../tools/guardian.js";
import { getCurrentVersion } from "../tools/updater.js";

export function createRoutes(stmts: Statements): Router {
  const router = Router();

  // POST /sync — sync a single file
  router.post("/sync", (req, res) => {
    try {
      const result = handleSyncFile(stmts, req.body as { path: string });
      res.json({ ok: true, result });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e) });
    }
  });

  // POST /sync-project — sync entire project directory
  router.post("/sync-project", (req, res) => {
    try {
      const result = handleSyncProject(stmts, req.body as { directory?: string });
      res.json({ ok: true, result });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e) });
    }
  });

  // GET /context?q=...&maxTokens=4000 — retrieve relevant context
  router.get("/context", async (req, res) => {
    try {
      const result = await handleGetContext(stmts, {
        query: String(req.query["q"] ?? ""),
        maxTokens: req.query["maxTokens"] ? Number(req.query["maxTokens"]) : 4000,
      });
      res.json({ ok: true, result });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e) });
    }
  });

  // POST /validate — validate a file for drift/quality issues
  router.post("/validate", (req, res) => {
    try {
      const result = handleValidateFile(req.body as { path: string; lang?: string });
      res.json({ ok: true, result });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e) });
    }
  });

  // GET /health — liveness check
  router.get("/health", (_req, res) => {
    res.json({ ok: true, version: getCurrentVersion() });
  });

  return router;
}
