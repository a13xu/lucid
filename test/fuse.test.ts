import { describe, it, expect } from "vitest";
import { fuseRanks, toFtsQuery, RRF_K } from "../src/retrieval/fuse.js";
import { extractSeeds } from "../src/tools/grep.js";

describe("fuseRanks", () => {
  it("scores by reciprocal rank across lists", () => {
    const scores = fuseRanks([["a", "b"], ["b", "a"]]);
    // a: 1/61 + 1/62, b: 1/62 + 1/61 — symmetric
    expect(scores.get("a")).toBeCloseTo(scores.get("b")!);
  });

  it("ranks an item found by two retrievers above one found by one", () => {
    const scores = fuseRanks([["a", "b"], ["a", "c"]]);
    expect(scores.get("a")!).toBeGreaterThan(scores.get("b")!);
    expect(scores.get("a")!).toBeGreaterThan(scores.get("c")!);
  });

  it("ignores empty lists", () => {
    const scores = fuseRanks([[], ["a"]]);
    expect(scores.get("a")).toBeCloseTo(1 / (RRF_K + 1));
  });

  it("applies priors on the RRF scale", () => {
    const scores = fuseRanks([["a"]], new Map([["b", 1]]));
    // prior weight 1.0 == a #1 rank in one list
    expect(scores.get("b")).toBeCloseTo(scores.get("a")!);
  });

  it("prior boosts an already-ranked item", () => {
    const scores = fuseRanks([["a", "b"]], new Map([["b", 1]]));
    expect(scores.get("b")!).toBeGreaterThan(scores.get("a")!);
  });
});

describe("toFtsQuery", () => {
  it("quotes and ORs identifier terms", () => {
    expect(toFtsQuery("database schema")).toBe('"database" OR "schema"');
  });

  it("keeps underscores and lowercases", () => {
    expect(toFtsQuery("Get_Context")).toBe('"get_context"');
  });

  it("strips FTS syntax characters", () => {
    expect(toFtsQuery('foo* NEAR "bar"')).toBe('"foo" OR "near" OR "bar"');
  });

  it("returns null when nothing usable remains", () => {
    expect(toFtsQuery("!?# @")).toBeNull();
    expect(toFtsQuery("")).toBeNull();
  });

  it("caps the number of terms", () => {
    const q = toFtsQuery(Array.from({ length: 30 }, (_, i) => `term${i}`).join(" "));
    expect(q!.split(" OR ")).toHaveLength(12);
  });
});

describe("extractSeeds", () => {
  it("extracts literal runs from plain patterns", () => {
    expect(extractSeeds("handleSync")).toEqual(["handlesync"]);
  });

  it("splits on regex metacharacters", () => {
    expect(extractSeeds("handle(Sync|Get)File")).toEqual(["handle", "sync", "get", "file"]);
  });

  it("drops the last char before a quantifier", () => {
    // "colou?" — the u is optional, seed must not include it
    expect(extractSeeds("colou?r")).toEqual(["colo"]);
  });

  it("drops runs shorter than 3 chars", () => {
    expect(extractSeeds("ab.cd")).toEqual([]);
  });

  it("dedupes seeds", () => {
    expect(extractSeeds("foo.*foo")).toEqual(["foo"]);
  });
});
