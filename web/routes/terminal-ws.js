import { WebSocketServer } from "ws";
import { spawn } from "child_process";

// Shell to spawn: prefer bash (available in MINGW64 / Linux / macOS)
const SHELL = process.platform === "win32" ? "bash" : "/bin/bash";
const SHELL_ARGS = [];

/**
 * Attaches a WebSocket server at /ws/terminal on the given http.Server.
 * Each connection spawns a new shell process with bidirectional I/O.
 *
 * Protocol (client → server):
 *   - JSON string `{"type":"resize","cols":N,"rows":N}` — terminal resize
 *   - Any other string/binary — forwarded as-is to shell stdin
 *
 * Protocol (server → client):
 *   - Raw bytes from shell stdout/stderr → forwarded as Buffer
 */
export function attachTerminalWS(server) {
  const wss = new WebSocketServer({ server, path: "/ws/terminal" });

  wss.on("connection", (ws) => {
    // Build a clean environment: inherit everything EXCEPT Claude session vars
    // that would block "claude" CLI from running inside the terminal.
    const {
      CLAUDECODE: _c,
      CLAUDE_CODE_ENTRYPOINT: _e,
      CLAUDE_CODE_SESSION_ID: _s,
      ...inheritedEnv
    } = process.env;

    const child = spawn(SHELL, SHELL_ARGS, {
      env: {
        ...inheritedEnv,
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
        FORCE_COLOR: "1",
      },
      shell: false,
    });

    // Forward child stdout → websocket
    child.stdout.on("data", (data) => {
      if (ws.readyState === 1 /* OPEN */) {
        ws.send(data, { binary: true });
      }
    });

    // Forward child stderr → websocket
    child.stderr.on("data", (data) => {
      if (ws.readyState === 1 /* OPEN */) {
        ws.send(data, { binary: true });
      }
    });

    child.on("close", (code) => {
      if (ws.readyState === 1 /* OPEN */) {
        const msg = `\r\n\x1b[33m[shell exited: code ${code}]\x1b[0m\r\n`;
        ws.send(Buffer.from(msg));
        ws.close();
      }
    });

    child.on("error", (err) => {
      if (ws.readyState === 1 /* OPEN */) {
        const msg = `\r\n\x1b[31m[spawn error: ${err.message}]\x1b[0m\r\n`;
        ws.send(Buffer.from(msg));
        ws.close();
      }
    });

    // Forward websocket messages → child stdin
    ws.on("message", (msg) => {
      try {
        const text = msg instanceof Buffer ? msg.toString("utf8") : String(msg);

        // Check for resize control message
        let parsed;
        try { parsed = JSON.parse(text); } catch (_) { /* not JSON */ }

        if (parsed && parsed.type === "resize") {
          // Without node-pty we can't resize the PTY, but we accept the message
          // so the client doesn't block on it.
          return;
        }

        // Regular keystroke / paste → stdin
        if (child.stdin.writable) {
          child.stdin.write(msg);
        }
      } catch (_) {
        // swallow
      }
    });

    ws.on("close", () => {
      if (!child.killed) {
        child.kill();
      }
    });

    ws.on("error", () => {
      if (!child.killed) {
        child.kill();
      }
    });
  });

  return wss;
}
