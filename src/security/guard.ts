/**
 * Security guard — orchestrates all security checks for every tool call.
 *
 * Pipeline per request:
 *   1. Rate limit check
 *   2. WAF input validation (size, injection, path traversal, ReDoS)
 *   3. Output leakage scan (before returning to caller)
 *
 * Enabled by default. Disable per-check via lucid.config.json:
 *   { "security": { "rateLimiting": false, "waf": false } }
 */

import { rateLimiter, rateLimitMessage, type RateLimitConfig } from "./ratelimit.js";
import {
  checkStringField,
  checkOutputLeakage,
  checkReDoS,
  type WafResult,
  type WafViolation,
} from "./waf.js";
import { allowHost } from "./ssrf.js";
import { sendAlert, type AlertEvent } from "./alerts.js";

// ---------------------------------------------------------------------------
// Security config (populated from lucid.config.json at startup)
// ---------------------------------------------------------------------------

export interface SecurityConfig {
  /** Enable/disable rate limiting (default: true) */
  rateLimiting?: boolean;
  /** Enable/disable WAF input checks (default: true) */
  waf?: boolean;
  /** Enable/disable output leakage scan (default: true) */
  outputScan?: boolean;
  /** Per-tool rate limit overrides */
  limits?: Record<string, Partial<RateLimitConfig>>;
  /** Trusted hostnames for outbound requests */
  trustedHosts?: string[];
}

let _cfg: Required<Omit<SecurityConfig, "limits" | "trustedHosts">> & SecurityConfig = {
  rateLimiting: true,
  waf: true,
  outputScan: true,
};

export function configureGuard(cfg: SecurityConfig): void {
  _cfg = { ..._cfg, ...cfg };

  if (cfg.limits) {
    rateLimiter.configure(cfg.limits);
  }

  if (cfg.trustedHosts) {
    for (const host of cfg.trustedHosts) allowHost(host);
  }
}

// ---------------------------------------------------------------------------
// Input guard — run before tool execution
// ---------------------------------------------------------------------------

export interface GuardResult {
  blocked: boolean;
  reason?: string;
  violations?: WafViolation[];
}

const OK: GuardResult = { blocked: false };

function blocked(reason: string, violations?: WafViolation[]): GuardResult {
  return { blocked: true, reason, violations };
}

/**
 * Per-tool WAF rules — maps each tool name to its field validation strategy.
 * Returns the first violation found, or null if clean.
 */
function wafCheckArgs(tool: string, args: Record<string, unknown>): WafResult | null {
  const str = (key: string) => (typeof args[key] === "string" ? (args[key] as string) : "");

  switch (tool) {
    case "remember":
      return firstViolation([
        checkStringField("entity",      str("entity"),      {}),
        checkStringField("observation", str("observation"), {}),
      ]);

    case "relate":
      return firstViolation([
        checkStringField("from", str("from"), {}),
        checkStringField("to",   str("to"),   {}),
      ]);

    case "recall":
    case "get_context":
      return checkStringField("query", str("query"), {});

    case "forget":
      return checkStringField("entity", str("entity"), {});

    case "sync_file":
    case "validate_file":
      return checkStringField("path", str("path"), { isPath: true });

    case "grep_code": {
      const sizeCheck = checkStringField("pattern", str("pattern"), {});
      if (sizeCheck.blocked) return sizeCheck;
      return checkReDoS(str("pattern"));
    }

    case "check_drift":
      return checkStringField("code", str("code"), {});

    case "init_project":
    case "sync_project":
      return str("directory")
        ? checkStringField("directory", str("directory"), { isPath: true })
        : null;

    default:
      return null;
  }
}

function firstViolation(results: WafResult[]): WafResult | null {
  for (const r of results) {
    if (r.blocked) return r;
  }
  return null;
}

/** Run all security checks for an inbound tool call. */
export function guardRequest(tool: string, args: unknown): GuardResult {
  // 1. Rate limiting
  if (_cfg.rateLimiting !== false) {
    const rl = rateLimiter.check(tool);
    if (!rl.allowed) {
      const msg = rateLimitMessage(tool, rl);
      // Alert on repeated rate limit hits (severity: medium)
      fireAlert({ severity: "medium", rule: "RATE_LIMIT", tool, detail: msg });
      return blocked(msg);
    }
  }

  // 2. WAF input validation
  if (_cfg.waf !== false && args && typeof args === "object") {
    const waf = wafCheckArgs(tool, args as Record<string, unknown>);
    if (waf?.blocked) {
      const v = waf.violations[0];
      const detail = v?.detail ?? "Input rejected";
      // Alert on HIGH/CRITICAL violations immediately
      if (v && (v.severity === "high" || v.severity === "critical")) {
        fireAlert({ severity: v.severity, rule: v.rule, tool, detail });
      }
      return blocked(
        `🛡️ WAF [${v?.rule ?? "UNKNOWN"}] (${v?.severity ?? "?"}): ${detail}`,
        waf.violations
      );
    }
  }

  return OK;
}

/** Fire-and-forget alert — never throws, never blocks tool execution. */
function fireAlert(event: Omit<AlertEvent, "timestamp">): void {
  sendAlert({ ...event, timestamp: new Date().toISOString() }).catch((e: Error) => {
    console.error(`[lucid:guard] Alert dispatch failed: ${e.message}`);
  });
}

// ---------------------------------------------------------------------------
// Output guard — run before returning response to caller
// ---------------------------------------------------------------------------

/** Scan output for sensitive data leakage. Logs a warning; does not block. */
export function guardOutput(tool: string, text: string): string {
  if (_cfg.outputScan === false) return text;

  const leaks = checkOutputLeakage(text);
  if (leaks.length > 0) {
    // Log to stderr (never to stdout — that's the MCP channel)
    console.error(
      `[lucid:security] ⚠️  Possible data leakage in response for "${tool}": ` +
      leaks.map((v) => v.detail).join(", ")
    );
    // Redact the response rather than blocking it
    return text + "\n\n⚠️  [Security notice: response may contain sensitive data — review before sharing]";
  }

  return text;
}
