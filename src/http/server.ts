import express from "express";
import type { Server } from "http";
import type { Statements } from "../database.js";
import { createRoutes } from "./routes.js";

export interface HttpServerOptions {
  port?: number;
  host?: string;
}

export function startHttpServer(
  stmts: Statements,
  options: HttpServerOptions = {}
): Server {
  const { port = 7821, host = "127.0.0.1" } = options;

  const app = express();
  app.use(express.json());
  app.use("/", createRoutes(stmts));

  return app.listen(port, host, () => {
    process.stderr.write(`[Lucid] HTTP server listening on ${host}:${port}\n`);
  });
}
