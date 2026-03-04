import express from "express";
import cors from "cors";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import plansRouter from "./routes/plans.js";
import tasksRouter from "./routes/tasks.js";
import testsRouter from "./routes/tests.js";
import orchestratorRouter from "./routes/orchestrator.js";
import autoToolsRouter   from "./routes/auto-tools.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT ?? 3001;

app.use(cors());
app.use(express.json());
app.use(express.static(join(__dirname, "public")));

app.use("/api", orchestratorRouter);
app.use("/api", autoToolsRouter);
app.use("/api", plansRouter);
app.use("/api", tasksRouter);
app.use("/api", testsRouter);

// SPA fallback
app.get(/^(?!\/api).*/, (_req, res) => {
  res.sendFile(join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.error(`[web] Server running at http://localhost:${PORT}`);
});
