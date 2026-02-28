/**
 * In-memory sliding-window rate limiter.
 *
 * No external dependencies — uses a circular timestamp buffer per key.
 * Configurable per-tool limits; heavy operations have tighter defaults.
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface RateLimitConfig {
  /** Window duration in milliseconds (default: 60_000 = 1 minute) */
  windowMs: number;
  /** Max requests allowed within the window */
  maxRequests: number;
}

// Default per-tool limits (requests per minute)
const DEFAULT_LIMITS: Record<string, RateLimitConfig> = {
  // Heavy — decompress + score all files
  get_context:   { windowMs: 60_000, maxRequests: 20 },
  grep_code:     { windowMs: 60_000, maxRequests: 30 },
  sync_project:  { windowMs: 60_000, maxRequests: 5  },

  // Medium
  recall:        { windowMs: 60_000, maxRequests: 60 },
  recall_all:    { windowMs: 60_000, maxRequests: 20 },
  validate_file: { windowMs: 60_000, maxRequests: 30 },
  check_drift:   { windowMs: 60_000, maxRequests: 30 },

  // Light — default for anything not listed
  _default:      { windowMs: 60_000, maxRequests: 120 },
};

// ---------------------------------------------------------------------------
// Sliding window implementation
// ---------------------------------------------------------------------------

/** Circular buffer of request timestamps for one key. */
class SlidingWindow {
  private timestamps: number[] = [];

  constructor(private readonly windowMs: number, private readonly max: number) {}

  /** Returns true if the request is allowed; records the timestamp. */
  allow(): boolean {
    const now = Date.now();
    const cutoff = now - this.windowMs;

    // Drop expired entries
    this.timestamps = this.timestamps.filter((t) => t > cutoff);

    if (this.timestamps.length >= this.max) return false;

    this.timestamps.push(now);
    return true;
  }

  /** Remaining requests in current window. */
  remaining(): number {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    const active = this.timestamps.filter((t) => t > cutoff).length;
    return Math.max(0, this.max - active);
  }

  /** Milliseconds until oldest request falls out of window. */
  retryAfterMs(): number {
    if (this.timestamps.length === 0) return 0;
    const oldest = Math.min(...this.timestamps);
    return Math.max(0, oldest + this.windowMs - Date.now());
  }
}

// ---------------------------------------------------------------------------
// Rate limiter registry
// ---------------------------------------------------------------------------

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
  limit: number;
  windowMs: number;
}

class RateLimiter {
  private windows = new Map<string, SlidingWindow>();
  private overrides = new Map<string, RateLimitConfig>();

  /** Override limits from config (called at startup). */
  configure(overrides: Record<string, Partial<RateLimitConfig>>): void {
    for (const [tool, cfg] of Object.entries(overrides)) {
      const base = DEFAULT_LIMITS[tool] ?? DEFAULT_LIMITS["_default"]!;
      this.overrides.set(tool, { ...base, ...cfg });
    }
  }

  private getConfig(tool: string): RateLimitConfig {
    return this.overrides.get(tool) ?? DEFAULT_LIMITS[tool] ?? DEFAULT_LIMITS["_default"]!;
  }

  private getWindow(key: string, cfg: RateLimitConfig): SlidingWindow {
    let w = this.windows.get(key);
    if (!w) {
      w = new SlidingWindow(cfg.windowMs, cfg.maxRequests);
      this.windows.set(key, w);
    }
    return w;
  }

  check(tool: string): RateLimitResult {
    const cfg = this.getConfig(tool);
    const window = this.getWindow(tool, cfg);
    const allowed = window.allow();
    return {
      allowed,
      remaining: window.remaining(),
      retryAfterMs: allowed ? 0 : window.retryAfterMs(),
      limit: cfg.maxRequests,
      windowMs: cfg.windowMs,
    };
  }

  /** Reset all counters (useful in tests). */
  reset(): void {
    this.windows.clear();
  }
}

// Singleton — one rate limiter per server process
export const rateLimiter = new RateLimiter();

/** Format a rate-limit rejection message. */
export function rateLimitMessage(tool: string, result: RateLimitResult): string {
  const retryAfterSec = Math.ceil(result.retryAfterMs / 1000);
  return (
    `🚦 Rate limit exceeded for "${tool}": ` +
    `${result.limit} requests/${result.windowMs / 1000}s allowed. ` +
    `Retry after ${retryAfterSec}s.`
  );
}
