import http from "http";
import express from "express";
import cors from "cors";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import plansRouter from "./routes/plans.js";
import tasksRouter from "./routes/tasks.js";
import testsRouter from "./routes/tests.js";
import orchestratorRouter from "./routes/orchestrator.js";
import autoToolsRouter    from "./routes/auto-tools.js";
import workerRouter       from "./routes/worker.js";
import playwrightRouter   from "./routes/playwright.js";
import chatRouter         from "./routes/chat.js";
import cliRouter          from "./routes/cli.js";
import { attachTerminalWS } from "./routes/terminal-ws.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT ?? 3069;

app.use(cors());
app.use(express.json());
app.use(express.static(join(__dirname, "public")));
app.use("/xterm", express.static(join(__dirname, "node_modules/@xterm/xterm/lib")));
app.use("/xterm/css", express.static(join(__dirname, "node_modules/@xterm/xterm/css")));
app.use("/xterm/addon-fit", express.static(join(__dirname, "node_modules/@xterm/addon-fit/lib")));
app.use("/xterm/addon-web-links", express.static(join(__dirname, "node_modules/@xterm/addon-web-links/lib")));

app.use("/api", orchestratorRouter);
app.use("/api", autoToolsRouter);
app.use("/api", workerRouter);
app.use("/api", playwrightRouter);
app.use("/api", chatRouter);
app.use("/api", cliRouter);
app.use("/api", plansRouter);
app.use("/api", tasksRouter);
app.use("/api", testsRouter);

// SPA fallback
app.get(/^(?!\/api).*/, (_req, res) => {
  res.sendFile(join(__dirname, "public", "index.html"));
});

const server = http.createServer(app);

attachTerminalWS(server);

server.listen(PORT, () => {
  console.error(`[web] Server running at http://localhost:${PORT}`);
});
