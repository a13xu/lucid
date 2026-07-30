import express from "express";
import { randomBytes, timingSafeEqual } from "crypto";
import type { Server } from "http";
import type { Statements } from "../database.js";
import { createRoutes } from "./routes.js";

export interface HttpServerOptions {
  port?: number;
  host?: string;
  /** Overrides LUCID_HTTP_TOKEN; mainly for tests. */
  token?: string;
  /** "warn" logs unauthenticated calls but allows them (compat mode, default); "enforce" rejects with 401. */
  authMode?: "warn" | "enforce";
}

function tokensMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function startHttpServer(
  stmts: Statements,
  options: HttpServerOptions = {}
): Server {
  const { port = 7821, host = "127.0.0.1" } = options;
  const authMode = options.authMode ?? (process.env["LUCID_HTTP_AUTH"] === "enforce" ? "enforce" : "warn");

  const token = options.token ?? process.env["LUCID_HTTP_TOKEN"] ?? randomBytes(24).toString("hex");
  if (!options.token && !process.env["LUCID_HTTP_TOKEN"]) {
    process.stderr.write(
      `[Lucid] No LUCID_HTTP_TOKEN set — generated for this session: ${token}\n` +
      `[Lucid] Pass it as the x-lucid-token header. Set LUCID_HTTP_AUTH=enforce to reject unauthenticated requests.\n`
    );
  }

  const app = express();
  app.use(express.json());

  app.use((req, res, next) => {
    if (req.path === "/health") return next();
    const provided = req.header("x-lucid-token");
    if (provided !== undefined && tokensMatch(provided, token)) return next();
    if (authMode === "enforce") {
      res.status(401).json({ ok: false, error: "Missing or invalid x-lucid-token header" });
      return;
    }
    process.stderr.write(
      `[Lucid] ⚠️  Unauthenticated HTTP request: ${req.method} ${req.path} — allowed (warn mode). ` +
      `Set LUCID_HTTP_AUTH=enforce to block.\n`
    );
    next();
  });

  app.use("/", createRoutes(stmts));

  return app.listen(port, host, () => {
    process.stderr.write(`[Lucid] HTTP server listening on ${host}:${port} (auth: ${authMode})\n`);
  });
}
