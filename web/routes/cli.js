import { Router } from "express";
import { spawn } from "child_process";

const router = Router();

const ALLOWED_BINARY = "claude";
const MAX_OUTPUT_BYTES = 1024 * 1024; // 1 MB cap

/**
 * POST /api/cli-execute
 * Body: { args: string[] }  — arguments passed to the `claude` binary
 * Example: { args: ["--version"] }
 * Returns: { stdout, stderr, exitCode }
 */
router.post("/cli-execute", (req, res) => {
  const { args } = req.body;

  if (!Array.isArray(args)) {
    return res.status(400).json({ error: "args must be an array of strings" });
  }

  for (const a of args) {
    if (typeof a !== "string") {
      return res.status(400).json({ error: "each arg must be a string" });
    }
  }

  let stdoutBuf = "";
  let stderrBuf = "";
  let truncated = false;

  const child = spawn(ALLOWED_BINARY, args, {
    env: { ...process.env },
    shell: false,
  });

  child.stdout.on("data", (chunk) => {
    if (stdoutBuf.length < MAX_OUTPUT_BYTES) {
      stdoutBuf += chunk.toString();
    } else {
      truncated = true;
    }
  });

  child.stderr.on("data", (chunk) => {
    if (stderrBuf.length < MAX_OUTPUT_BYTES) {
      stderrBuf += chunk.toString();
    } else {
      truncated = true;
    }
  });

  child.on("error", (err) => {
    res.status(500).json({ error: err.message });
  });

  child.on("close", (exitCode) => {
    res.json({ stdout: stdoutBuf, stderr: stderrBuf, exitCode, truncated });
  });
});

export default router;
