/**
 * SSRF (Server-Side Request Forgery) prevention.
 *
 * Validates URLs before any outbound fetch call to ensure they point to
 * legitimate external services and not to internal network resources.
 */

// ---------------------------------------------------------------------------
// Private/reserved IP ranges to block
// ---------------------------------------------------------------------------

// IPv4 ranges that should never be reachable from outside
const BLOCKED_IPV4_PATTERNS: RegExp[] = [
  /^127\./,                        // loopback
  /^10\./,                         // RFC-1918 class A
  /^172\.(1[6-9]|2\d|3[01])\./,   // RFC-1918 class B
  /^192\.168\./,                   // RFC-1918 class C
  /^169\.254\./,                   // link-local / AWS metadata
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,  // CGNAT (RFC-6598)
  /^0\./,                          // "this" network
  /^255\./,                        // broadcast
  /^::1$/,                         // IPv6 loopback
  /^fc00:/i,                       // IPv6 unique local
  /^fe80:/i,                       // IPv6 link-local
];

// Hostnames that are always blocked
const BLOCKED_HOSTS: Set<string> = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata",
]);

// Cloud metadata endpoints
const BLOCKED_PATHS_PREFIX: string[] = [
  "/latest/meta-data",   // AWS EC2 metadata
  "/computeMetadata",    // GCP metadata
  "/metadata/instance",  // Azure IMDS
  "/odata/",             // Azure (generic)
];

// ---------------------------------------------------------------------------
// Allowlist (set from env/config at startup)
// ---------------------------------------------------------------------------

let _allowedHosts: Set<string> = new Set();

/** Register a trusted host (called once at startup with Qdrant URL etc.) */
export function allowHost(urlOrHost: string): void {
  try {
    const host = new URL(urlOrHost).hostname.toLowerCase();
    _allowedHosts.add(host);
  } catch {
    _allowedHosts.add(urlOrHost.toLowerCase());
  }
}

export function resetAllowedHosts(): void {
  _allowedHosts = new Set();
}

// ---------------------------------------------------------------------------
// Core validation
// ---------------------------------------------------------------------------

export interface UrlCheckResult {
  allowed: boolean;
  reason?: string;
}

export function validateUrl(rawUrl: string): UrlCheckResult {
  // 1. Must be parseable
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { allowed: false, reason: "Malformed URL" };
  }

  // 2. Only http/https allowed
  if (!["http:", "https:"].includes(parsed.protocol)) {
    return { allowed: false, reason: `Protocol not allowed: ${parsed.protocol}` };
  }

  const hostname = parsed.hostname.toLowerCase();
  const path = parsed.pathname;

  // 3. Check blocked hostnames
  if (BLOCKED_HOSTS.has(hostname)) {
    return { allowed: false, reason: `Blocked hostname: ${hostname}` };
  }

  // 4. Check blocked IPv4 patterns
  for (const pattern of BLOCKED_IPV4_PATTERNS) {
    if (pattern.test(hostname)) {
      return { allowed: false, reason: `Blocked IP range: ${hostname}` };
    }
  }

  // 5. Check cloud metadata paths
  for (const prefix of BLOCKED_PATHS_PREFIX) {
    if (path.startsWith(prefix)) {
      return { allowed: false, reason: `Blocked metadata path: ${path}` };
    }
  }

  // 6. If allowlist is populated, host must be in it
  if (_allowedHosts.size > 0 && !_allowedHosts.has(hostname)) {
    return { allowed: false, reason: `Host not in allowlist: ${hostname}` };
  }

  return { allowed: true };
}

/** Throw if URL is not allowed. Use before every outbound fetch. */
export function assertSafeUrl(url: string): void {
  const result = validateUrl(url);
  if (!result.allowed) {
    throw new Error(`SSRF guard blocked request: ${result.reason}`);
  }
}

/** Resolve and return timeout-wrapped fetch (default 10s). */
export async function safeFetch(
  url: string,
  init: RequestInit = {},
  timeoutMs = 10_000
): Promise<Response> {
  assertSafeUrl(url);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
