// Shared helper for spawning `claude --print` safely from inside Claude Code.
//
// Problems solved:
//   1. Nested session block  — removed CLAUDE_CODE_* env vars
//   2. Prompt mangling       — prompt sent via stdin (not shell argument)
//      Long/multi-line prompts with quotes/$ break when passed as argv
//      through shell:true; stdin is always safe.

import { spawn } from "child_process";

const BLOCKED_ENV = [
  "CLAUDECODE",
  "CLAUDE_CODE_SSE_PORT",
  "CLAUDE_CODE_ENTRYPOINT",
];

export function claudeEnv() {
  const env = { ...process.env };
  for (const key of BLOCKED_ENV) delete env[key];
  return env;
}

// Spawn `claude --print`, feed prompt via stdin.
// onChunk(text) is called for each stdout chunk as it arrives (real-time streaming).
// Returns Promise<string> (full output) or throws on non-zero exit.
export function claudeStream(prompt, onChunk = () => {}, { timeoutMs = 120_000, skipPermissions = false, model = null, systemPrompt = null } = {}) {
  return new Promise((resolve, reject) => {
    const args = ["--print"];
    if (skipPermissions) args.push("--dangerously-skip-permissions");
    if (model) args.push("--model", model);
    if (systemPrompt) args.push("--system-prompt", systemPrompt);
    const proc = spawn("claude", args, {
      stdio:       ["pipe", "pipe", "pipe"],
      shell:       false,
      windowsHide: true,
      env:         claudeEnv(),
    });

    let full   = "";
    let stderr = "";

    const killer = setTimeout(() => {
      proc.kill("SIGTERM");
      reject(new Error(`Claude CLI timeout after ${timeoutMs / 1000}s`));
    }, timeoutMs);

    proc.stdout.on("data", (d) => {
      const text = d.toString();
      full      += text;
      try { onChunk(text); } catch { /* never let a callback crash the runner */ }
    });

    proc.stderr.on("data", (d) => { stderr += d.toString(); });

    proc.on("close", (code) => {
      clearTimeout(killer);
      if (code === 0) resolve(full);
      else reject(new Error(stderr.trim() || `claude exited with code ${code}`));
    });

    proc.on("error", (err) => { clearTimeout(killer); reject(err); });

    proc.stdin.write(prompt, "utf8");
    proc.stdin.end();
  });
}

// Convenience wrapper — collect all output, no streaming callback needed.
export function claudePrint(prompt, opts) {
  return claudeStream(prompt, undefined, opts);
}
