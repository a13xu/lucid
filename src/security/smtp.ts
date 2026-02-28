/**
 * Minimal SMTP client — Node.js built-ins only (net + tls + crypto).
 *
 * Supports:
 *  - Direct TLS (port 465, implicit SSL)
 *  - STARTTLS (port 587, explicit upgrade)
 *  - AUTH LOGIN
 *  - Plain-text message body
 */

import * as net from "net";
import * as tls from "tls";

export interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  /** Must come from LUCID_SMTP_PASS env var — never hardcoded */
  pass: string;
  from: string;
  /** true = direct TLS (port 465); false/omit = STARTTLS (port 587) */
  secure?: boolean;
  timeoutMs?: number;
}

export interface SmtpMessage {
  to: string;
  subject: string;
  body: string;
}

// ---------------------------------------------------------------------------
// Response reader
// ---------------------------------------------------------------------------

type AnySocket = net.Socket | tls.TLSSocket;

function readResponse(socket: AnySocket, timeoutMs: number): Promise<{ code: number; lines: string[] }> {
  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error("SMTP read timeout")), timeoutMs);

    const handler = (chunk: Buffer) => {
      buf += chunk.toString("utf-8");
      // A complete (possibly multi-line) SMTP response ends with "DDD text\r\n"
      // where DDD is followed by a space (not a dash, which denotes continuation)
      if (/\r?\n$/.test(buf)) {
        const rawLines = buf.split(/\r?\n/).filter((l) => l.length > 0);
        const last = rawLines[rawLines.length - 1]!;
        // Final line: code + space (e.g. "250 OK")
        if (/^\d{3} /.test(last)) {
          clearTimeout(timer);
          socket.removeListener("data", handler);
          const code = parseInt(last.slice(0, 3), 10);
          resolve({ code, lines: rawLines });
        }
      }
    };

    socket.on("data", handler);
    socket.once("error", (e) => { clearTimeout(timer); reject(e); });
  });
}

async function cmd(socket: AnySocket, command: string, timeout: number): Promise<{ code: number; lines: string[] }> {
  await new Promise<void>((res, rej) => {
    socket.write(command + "\r\n", "utf-8", (err) => (err ? rej(err) : res()));
  });
  return readResponse(socket, timeout);
}

function expect(res: { code: number; lines: string[] }, ...codes: number[]): void {
  if (!codes.includes(res.code)) {
    throw new Error(`SMTP unexpected response ${res.code}: ${res.lines.join(" | ")}`);
  }
}

function b64(s: string): string {
  return Buffer.from(s, "utf-8").toString("base64");
}

// ---------------------------------------------------------------------------
// Main send function
// ---------------------------------------------------------------------------

export async function sendEmail(cfg: SmtpConfig, msg: SmtpMessage): Promise<void> {
  const timeout = cfg.timeoutMs ?? 15_000;

  let socket: AnySocket;

  if (cfg.secure) {
    // Direct TLS — connect already encrypted
    socket = await new Promise<tls.TLSSocket>((resolve, reject) => {
      const s = tls.connect({ host: cfg.host, port: cfg.port, servername: cfg.host });
      s.once("secureConnect", () => resolve(s));
      s.once("error", reject);
      setTimeout(() => reject(new Error("TLS connect timeout")), timeout);
    });
  } else {
    // Plain TCP first (STARTTLS later)
    socket = await new Promise<net.Socket>((resolve, reject) => {
      const s = net.createConnection({ host: cfg.host, port: cfg.port });
      s.once("connect", () => resolve(s));
      s.once("error", reject);
      setTimeout(() => reject(new Error("TCP connect timeout")), timeout);
    });
  }

  try {
    // 1. Server greeting
    expect(await readResponse(socket, timeout), 220);

    // 2. EHLO
    const ehlo = await cmd(socket, `EHLO lucid-security`, timeout);
    expect(ehlo, 250);

    // 3. STARTTLS upgrade (plain TCP only)
    if (!cfg.secure) {
      expect(await cmd(socket, "STARTTLS", timeout), 220);

      // Wrap plain socket in TLS
      socket = await new Promise<tls.TLSSocket>((resolve, reject) => {
        const upgraded = tls.connect({
          socket: socket as net.Socket,
          host: cfg.host,
          servername: cfg.host,
        });
        upgraded.once("secureConnect", () => resolve(upgraded));
        upgraded.once("error", reject);
        setTimeout(() => reject(new Error("STARTTLS upgrade timeout")), timeout);
      });

      // EHLO again after TLS
      expect(await cmd(socket, `EHLO lucid-security`, timeout), 250);
    }

    // 4. AUTH LOGIN
    expect(await cmd(socket, "AUTH LOGIN", timeout), 334);
    expect(await cmd(socket, b64(cfg.user), timeout), 334);
    expect(await cmd(socket, b64(cfg.pass), timeout), 235);

    // 5. Envelope
    expect(await cmd(socket, `MAIL FROM:<${cfg.from}>`, timeout), 250);
    expect(await cmd(socket, `RCPT TO:<${msg.to}>`, timeout), 250);

    // 6. Message body
    expect(await cmd(socket, "DATA", timeout), 354);

    const date = new Date().toUTCString();
    const body = [
      `Date: ${date}`,
      `From: ${cfg.from}`,
      `To: ${msg.to}`,
      `Subject: ${msg.subject}`,
      `MIME-Version: 1.0`,
      `Content-Type: text/plain; charset=UTF-8`,
      ``,
      msg.body,
      `.`,
    ].join("\r\n");

    expect(await cmd(socket, body, timeout), 250);

    // 7. Quit
    await cmd(socket, "QUIT", timeout);
  } finally {
    socket.destroy();
  }
}
