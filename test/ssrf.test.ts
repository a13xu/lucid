import { describe, it, expect, beforeEach } from "vitest";
import { validateUrl, allowHost, resetAllowedHosts } from "../src/security/ssrf.js";

describe("validateUrl", () => {
  beforeEach(() => {
    resetAllowedHosts();
  });

  it("rejects malformed URLs", () => {
    expect(validateUrl("not a url").allowed).toBe(false);
  });

  it("rejects non-http protocols", () => {
    expect(validateUrl("ftp://example.com/x").allowed).toBe(false);
    expect(validateUrl("file:///etc/passwd").allowed).toBe(false);
  });

  it("blocks localhost and loopback", () => {
    expect(validateUrl("http://localhost:7821/sync").allowed).toBe(false);
    expect(validateUrl("http://127.0.0.1/").allowed).toBe(false);
    expect(validateUrl("http://127.1.2.3/").allowed).toBe(false);
  });

  it("blocks RFC-1918 and link-local ranges", () => {
    expect(validateUrl("http://10.0.0.1/").allowed).toBe(false);
    expect(validateUrl("http://172.16.0.1/").allowed).toBe(false);
    expect(validateUrl("http://172.31.255.255/").allowed).toBe(false);
    expect(validateUrl("http://192.168.1.1/").allowed).toBe(false);
    expect(validateUrl("http://169.254.169.254/").allowed).toBe(false);
  });

  it("allows public 172.x outside the 16-31 block", () => {
    expect(validateUrl("http://172.32.0.1/").allowed).toBe(true);
  });

  it("blocks cloud metadata hostnames and paths", () => {
    expect(validateUrl("http://metadata.google.internal/").allowed).toBe(false);
    expect(validateUrl("http://example.com/latest/meta-data/iam").allowed).toBe(false);
    expect(validateUrl("http://example.com/computeMetadata/v1/").allowed).toBe(false);
  });

  it("enforces the allowlist once populated", () => {
    allowHost("https://registry.npmjs.org");
    expect(validateUrl("https://registry.npmjs.org/@a13xu/lucid/latest").allowed).toBe(true);
    expect(validateUrl("https://evil.example.com/").allowed).toBe(false);
  });

  it("accepts bare hostnames in allowHost", () => {
    allowHost("api.openai.com");
    expect(validateUrl("https://api.openai.com/v1/embeddings").allowed).toBe(true);
  });

  // WHATWG URL canonicalizes hex/decimal IPv4 literals, so the /^127\./ pattern catches these
  it("blocks hex-encoded loopback 0x7f.0.0.1", () => {
    expect(validateUrl("http://0x7f.0.0.1/").allowed).toBe(false);
  });

  it("blocks decimal-encoded loopback 2130706433", () => {
    expect(validateUrl("http://2130706433/").allowed).toBe(false);
  });

  // Known gap (Phase 2 backlog: resolve IP literals before pattern matching)

  it.fails("blocks IPv4-mapped IPv6 loopback (KNOWN GAP)", () => {
    expect(validateUrl("http://[::ffff:127.0.0.1]/").allowed).toBe(false);
  });
});
