/**
 * Secure environment variable access.
 *
 * Rules:
 * - Never expose raw values in error messages or logs
 * - Always validate format before use
 * - Mask secrets in any diagnostic output
 */

// ---------------------------------------------------------------------------
// Core getters
// ---------------------------------------------------------------------------

/** Get a required env var. Throws a safe error (no value leak) if missing. */
export function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val || val.trim() === "") {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return val.trim();
}

/** Get an optional env var with a typed default. */
export function optionalEnv(key: string, defaultValue: string): string {
  const val = process.env[key];
  return val && val.trim() !== "" ? val.trim() : defaultValue;
}

/** Get a numeric env var. Returns default if missing or non-numeric. */
export function numericEnv(key: string, defaultValue: number): number {
  const raw = process.env[key];
  if (!raw) return defaultValue;
  const n = Number(raw.trim());
  return Number.isFinite(n) ? n : defaultValue;
}

/** Get a boolean env var ("true"/"1"/"yes" → true, anything else → false). */
export function boolEnv(key: string, defaultValue: boolean): boolean {
  const raw = process.env[key];
  if (!raw) return defaultValue;
  return /^(true|1|yes)$/i.test(raw.trim());
}

// ---------------------------------------------------------------------------
// Masking for logs / diagnostics
// ---------------------------------------------------------------------------

const SECRET_PATTERNS = [
  /key/i, /secret/i, /token/i, /password/i, /pwd/i, /auth/i, /credential/i,
];

/** Mask a value for safe logging. Shows first 4 and last 2 chars only. */
export function maskSecret(value: string): string {
  if (value.length <= 8) return "***";
  return `${value.slice(0, 4)}…${value.slice(-2)}`;
}

/** Safe env dump for diagnostics — masks any key that looks sensitive. */
export function safeDump(keys: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of keys) {
    const val = process.env[key];
    if (!val) { result[key] = "<not set>"; continue; }
    const isSensitive = SECRET_PATTERNS.some((p) => p.test(key));
    result[key] = isSensitive ? maskSecret(val) : val;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Format validators (called before using values)
// ---------------------------------------------------------------------------

const URL_RE = /^https?:\/\/[^\s/$.?#].[^\s]*$/i;

/** Validate a URL-format env var. Throws with safe message on failure. */
export function requireEnvUrl(key: string): string {
  const val = requireEnv(key);
  if (!URL_RE.test(val)) {
    throw new Error(`Environment variable ${key} must be a valid URL (got invalid format)`);
  }
  return val;
}

/** Validate that an API key looks like a real key (non-trivial length). */
export function requireEnvApiKey(key: string, minLength = 16): string {
  const val = requireEnv(key);
  if (val.length < minLength) {
    throw new Error(`Environment variable ${key} appears to be too short for an API key (min ${minLength} chars)`);
  }
  return val;
}
