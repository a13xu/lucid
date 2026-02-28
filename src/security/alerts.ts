/**
 * Security alert dispatcher.
 *
 * Channels (all optional, configured via lucid-admin.json + env vars):
 *   - Webhook  (generic HTTP POST, HMAC-SHA256 signed)
 *   - Slack    (incoming webhook)
 *   - Email    (SMTP via smtp.ts)
 *
 * Sensitive values MUST come from environment variables:
 *   LUCID_SMTP_PASS        — SMTP password
 *   LUCID_WEBHOOK_SECRET   — HMAC signing secret for webhook
 *
 * Config is stored in  <project>/.claude/lucid-admin.json  (non-sensitive fields only).
 */

import { createHmac } from "crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { safeFetch } from "./ssrf.js";
import { sendEmail, type SmtpConfig } from "./smtp.js";
import type { Severity } from "./waf.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AlertEvent {
  severity: Severity;
  rule: string;
  tool: string;
  detail: string;
  timestamp: string;     // ISO-8601
  projectDir?: string;
}

export interface AdminConfig {
  adminName?: string;
  adminEmail?: string;
  smtpHost?: string;
  smtpPort?: number;
  smtpUser?: string;
  smtpFrom?: string;
  webhookUrl?: string;
  slackWebhookUrl?: string;
  /** Severities that trigger an alert (default: ["critical", "high"]) */
  alertOn?: Severity[];
  projectName?: string;
}

// ---------------------------------------------------------------------------
// Config loader
// ---------------------------------------------------------------------------

let _config: AdminConfig | null = null;
let _configDir: string | null = null;

export const ADMIN_CONFIG_FILE = "lucid-admin.json";

export function loadAdminConfig(projectDir: string): AdminConfig {
  _configDir = join(projectDir, ".claude");
  const path = join(_configDir, ADMIN_CONFIG_FILE);

  if (existsSync(path)) {
    try {
      _config = JSON.parse(readFileSync(path, "utf-8")) as AdminConfig;
    } catch {
      _config = {};
    }
  } else {
    _config = {};
  }

  return _config;
}

export function saveAdminConfig(projectDir: string, cfg: AdminConfig): void {
  const dir = join(projectDir, ".claude");
  mkdirSync(dir, { recursive: true });

  // Merge with existing
  const existing = loadAdminConfig(projectDir);
  const merged = { ...existing, ...cfg };
  _config = merged;

  // Strip any sensitive fields that shouldn't be persisted to disk
  // (user might accidentally pass smtpPass — we silently drop it)
  const safe = { ...merged } as Record<string, unknown>;
  delete safe["smtpPass"];
  delete safe["webhookSecret"];

  writeFileSync(join(dir, ADMIN_CONFIG_FILE), JSON.stringify(safe, null, 2) + "\n", "utf-8");
}

export function getAdminConfig(): AdminConfig {
  return _config ?? {};
}

export function isAdminConfigured(): boolean {
  const c = _config ?? {};
  return !!(c.adminEmail || c.webhookUrl || c.slackWebhookUrl);
}

// ---------------------------------------------------------------------------
// HMAC webhook signature
// ---------------------------------------------------------------------------

function signPayload(body: string): string | null {
  const secret = process.env["LUCID_WEBHOOK_SECRET"];
  if (!secret) return null;
  return "sha256=" + createHmac("sha256", secret).update(body, "utf-8").digest("hex");
}

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

async function dispatchWebhook(url: string, event: AlertEvent): Promise<void> {
  const body = JSON.stringify({
    source: "lucid-security",
    ...event,
  });

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const sig = signPayload(body);
  if (sig) headers["X-Lucid-Signature"] = sig;

  const res = await safeFetch(url, { method: "POST", headers, body });
  if (!res.ok) throw new Error(`Webhook HTTP ${res.status}`);
}

async function dispatchSlack(webhookUrl: string, event: AlertEvent): Promise<void> {
  const icon = event.severity === "critical" ? "🚨" : "⚠️";
  const payload = {
    text: `${icon} *Lucid Security Alert* — ${event.severity.toUpperCase()}`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `${icon} *[${event.severity.toUpperCase()}] ${event.rule}*\n` +
            `*Tool:* \`${event.tool}\`\n` +
            `*Detail:* ${event.detail}\n` +
            `*Project:* ${_config?.projectName ?? "unknown"}\n` +
            `*Time:* ${event.timestamp}`,
        },
      },
    ],
  };

  const res = await safeFetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Slack HTTP ${res.status}`);
}

async function dispatchEmail(event: AlertEvent): Promise<void> {
  const cfg = _config ?? {};

  const smtpPass = process.env["LUCID_SMTP_PASS"];
  if (!smtpPass) throw new Error("LUCID_SMTP_PASS env var not set");
  if (!cfg.adminEmail) throw new Error("adminEmail not configured");
  if (!cfg.smtpHost) throw new Error("smtpHost not configured");

  const smtpCfg: SmtpConfig = {
    host: cfg.smtpHost,
    port: cfg.smtpPort ?? 587,
    user: cfg.smtpUser ?? cfg.adminEmail,
    pass: smtpPass,
    from: cfg.smtpFrom ?? `Lucid Security <${cfg.smtpUser ?? cfg.adminEmail}>`,
    secure: cfg.smtpPort === 465,
  };

  const icon = event.severity === "critical" ? "🚨" : "⚠️";
  const subject = `${icon} [${event.severity.toUpperCase()}] Lucid Security Alert — ${event.rule}`;

  const body = [
    `Lucid Security Alert`,
    `${"─".repeat(40)}`,
    ``,
    `Severity : ${event.severity.toUpperCase()}`,
    `Rule     : ${event.rule}`,
    `Tool     : ${event.tool}`,
    `Detail   : ${event.detail}`,
    `Project  : ${cfg.projectName ?? "unknown"}`,
    `Time     : ${event.timestamp}`,
    ``,
    `─────────────────────────────────────────`,
    `This alert was sent automatically by lucid.`,
    `Configure alerts in .claude/lucid-admin.json`,
  ].join("\n");

  await sendEmail(smtpCfg, { to: cfg.adminEmail, subject, body });
}

// ---------------------------------------------------------------------------
// Main dispatch — fire-and-forget safe
// ---------------------------------------------------------------------------

const SEVERITY_ORDER: Record<Severity, number> = { low: 0, medium: 1, high: 2, critical: 3 };

export async function sendAlert(event: AlertEvent): Promise<void> {
  const cfg = _config ?? {};
  const alertOn: Severity[] = cfg.alertOn ?? ["critical", "high"];

  // Check if this severity is configured to alert
  const minSeverity = Math.min(...alertOn.map((s) => SEVERITY_ORDER[s]));
  if (SEVERITY_ORDER[event.severity] < minSeverity) return;

  const errors: string[] = [];

  // Dispatch to all configured channels concurrently
  const dispatches: Promise<void>[] = [];

  if (cfg.webhookUrl) {
    dispatches.push(
      dispatchWebhook(cfg.webhookUrl, event).catch((e: Error) => {
        errors.push(`webhook: ${e.message}`);
      })
    );
  }

  if (cfg.slackWebhookUrl) {
    dispatches.push(
      dispatchSlack(cfg.slackWebhookUrl, event).catch((e: Error) => {
        errors.push(`slack: ${e.message}`);
      })
    );
  }

  if (cfg.adminEmail && cfg.smtpHost) {
    dispatches.push(
      dispatchEmail(event).catch((e: Error) => {
        errors.push(`email: ${e.message}`);
      })
    );
  }

  await Promise.all(dispatches);

  if (errors.length > 0) {
    console.error(`[lucid:alerts] ⚠️  Failed to deliver ${errors.length} alert(s): ${errors.join("; ")}`);
  }
}

/** Send a test alert to verify all configured channels work. */
export async function sendTestAlert(projectDir: string): Promise<string[]> {
  loadAdminConfig(projectDir);

  const event: AlertEvent = {
    severity: "low",
    rule: "TEST",
    tool: "init_project",
    detail: "Lucid security alerts are correctly configured and working.",
    timestamp: new Date().toISOString(),
    projectDir,
  };

  const results: string[] = [];
  const cfg = _config ?? {};

  if (cfg.webhookUrl) {
    try {
      await dispatchWebhook(cfg.webhookUrl, event);
      results.push("✅ Webhook: test alert delivered");
    } catch (e) {
      results.push(`❌ Webhook: ${(e as Error).message}`);
    }
  }

  if (cfg.slackWebhookUrl) {
    try {
      await dispatchSlack(cfg.slackWebhookUrl, event);
      results.push("✅ Slack: test alert delivered");
    } catch (e) {
      results.push(`❌ Slack: ${(e as Error).message}`);
    }
  }

  if (cfg.adminEmail && cfg.smtpHost) {
    try {
      await dispatchEmail(event);
      results.push(`✅ Email: test alert sent to ${cfg.adminEmail}`);
    } catch (e) {
      results.push(`❌ Email: ${(e as Error).message}`);
    }
  }

  if (results.length === 0) {
    results.push("⚠️  No alert channels configured yet");
  }

  return results;
}
