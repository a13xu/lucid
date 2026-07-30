import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { rateLimiter, rateLimitMessage } from "../src/security/ratelimit.js";

describe("rateLimiter", () => {
  beforeEach(() => {
    rateLimiter.reset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows up to the configured limit, then blocks", () => {
    rateLimiter.configure({ test_tool_a: { maxRequests: 3, windowMs: 60_000 } });
    expect(rateLimiter.check("test_tool_a").allowed).toBe(true);
    expect(rateLimiter.check("test_tool_a").allowed).toBe(true);
    expect(rateLimiter.check("test_tool_a").allowed).toBe(true);
    const fourth = rateLimiter.check("test_tool_a");
    expect(fourth.allowed).toBe(false);
    expect(fourth.retryAfterMs).toBeGreaterThan(0);
  });

  it("isolates limits per tool", () => {
    rateLimiter.configure({
      test_tool_b: { maxRequests: 1, windowMs: 60_000 },
      test_tool_c: { maxRequests: 1, windowMs: 60_000 },
    });
    expect(rateLimiter.check("test_tool_b").allowed).toBe(true);
    expect(rateLimiter.check("test_tool_b").allowed).toBe(false);
    expect(rateLimiter.check("test_tool_c").allowed).toBe(true);
  });

  it("rolls over after the window expires", () => {
    vi.useFakeTimers();
    rateLimiter.configure({ test_tool_d: { maxRequests: 1, windowMs: 1000 } });
    expect(rateLimiter.check("test_tool_d").allowed).toBe(true);
    expect(rateLimiter.check("test_tool_d").allowed).toBe(false);
    vi.advanceTimersByTime(1001);
    expect(rateLimiter.check("test_tool_d").allowed).toBe(true);
  });

  it("uses _default config for unknown tools", () => {
    const r = rateLimiter.check("never_configured_tool");
    expect(r.allowed).toBe(true);
    expect(r.limit).toBe(120);
  });

  it("reports remaining count", () => {
    rateLimiter.configure({ test_tool_e: { maxRequests: 5, windowMs: 60_000 } });
    const first = rateLimiter.check("test_tool_e");
    expect(first.remaining).toBe(4);
  });

  it("formats a human-readable rejection message", () => {
    const msg = rateLimitMessage("get_context", {
      allowed: false, remaining: 0, retryAfterMs: 2500, limit: 20, windowMs: 60_000,
    });
    expect(msg).toContain("get_context");
    expect(msg).toContain("Retry after 3s");
  });
});
