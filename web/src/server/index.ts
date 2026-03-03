import express from "express";
import cors from "cors";
import plansRouter from "./routes/plans";
import tasksRouter from "./routes/tasks";
import testsRouter from "./routes/tests";

const app = express();
const PORT = Number(process.env["PORT"] ?? 3001);

app.use(cors());
app.use(express.json());

// Mount all routers under /api
app.use("/api", plansRouter);
app.use("/api", tasksRouter);
app.use("/api", testsRouter);

// Health check
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", ts: Date.now() });
});

app.listen(PORT, () => {
  console.error(`[web] Server on port ${PORT}`);
});

export default app;
