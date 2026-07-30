import { describe, it, expect } from "vitest";
import { tokenize, rankByRelevance } from "../src/retrieval/tfidf.js";

describe("tokenize", () => {
  it("lowercases and strips punctuation", () => {
    expect(tokenize("Hello, World! Foo-Bar")).toEqual(["hello", "world", "foo", "bar"]);
  });

  it("drops tokens shorter than 3 chars", () => {
    expect(tokenize("ab abc")).toEqual(["abc"]);
  });

  it("filters English and code-keyword stopwords", () => {
    expect(tokenize("return the function const database")).toEqual(["database"]);
  });

  it("keeps underscores as part of identifiers", () => {
    expect(tokenize("get_context")).toEqual(["get_context"]);
  });
});

describe("rankByRelevance", () => {
  const files = [
    { filepath: "a.ts", text: "database sqlite prepared statements schema" },
    { filepath: "b.ts", text: "react component render props state" },
    { filepath: "c.ts", text: "database connection pool database database" },
  ];

  it("returns empty for empty file list", () => {
    expect(rankByRelevance("query", [])).toEqual([]);
  });

  it("gives zero scores when query has no usable terms", () => {
    const ranked = rankByRelevance("the and for", files);
    expect(ranked).toHaveLength(3);
    expect(ranked.every((r) => r.score === 0)).toBe(true);
  });

  it("ranks files containing the query term above those without", () => {
    const ranked = rankByRelevance("database", files);
    const paths = ranked.map((r) => r.filepath);
    expect(paths.indexOf("c.ts")).toBeLessThan(paths.indexOf("b.ts"));
    expect(paths.indexOf("a.ts")).toBeLessThan(paths.indexOf("b.ts"));
    expect(ranked[ranked.length - 1]!.filepath).toBe("b.ts");
    expect(ranked[ranked.length - 1]!.score).toBe(0);
  });

  it("weights higher term frequency higher", () => {
    const ranked = rankByRelevance("database", files);
    expect(ranked[0]!.filepath).toBe("c.ts");
  });

  it("reports matched terms", () => {
    const ranked = rankByRelevance("database sqlite", files);
    const a = ranked.find((r) => r.filepath === "a.ts")!;
    expect(a.matchedTerms.sort()).toEqual(["database", "sqlite"]);
  });

  it("gives rare terms more weight than ubiquitous ones (IDF)", () => {
    const docs = [
      { filepath: "x.ts", text: "common rare" },
      { filepath: "y.ts", text: "common alpha" },
      { filepath: "z.ts", text: "common beta" },
    ];
    const ranked = rankByRelevance("common rare", docs);
    expect(ranked[0]!.filepath).toBe("x.ts");
    expect(ranked[0]!.score).toBeGreaterThan(ranked[1]!.score);
  });
});
