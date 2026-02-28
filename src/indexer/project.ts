import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join, extname, basename } from "path";
import type { Statements } from "../database.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IndexResult {
  entity: string;
  type: string;
  observations: number;
  source: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readFile(path: string): string | null {
  try {
    return readFileSync(path, { encoding: "utf-8" });
  } catch {
    return null;
  }
}

function upsert(
  stmts: Statements,
  name: string,
  type: string,
  observations: string[]
): void {
  const existing = stmts.getEntityByName.get(name);
  if (existing) {
    const current: string[] = JSON.parse(existing.observations);
    const merged = [...current];
    for (const obs of observations) {
      if (!merged.includes(obs)) merged.push(obs);
    }
    stmts.updateEntity.run(JSON.stringify(merged), existing.id as number);
  } else {
    stmts.insertEntity.run(name, type, JSON.stringify(observations));
  }
}

function relate(stmts: Statements, from: string, to: string, type: string): void {
  const fromRow = stmts.getEntityByName.get(from);
  const toRow = stmts.getEntityByName.get(to);
  if (fromRow && toRow) {
    stmts.insertRelation.run(fromRow.id as number, toRow.id as number, type);
  }
}

// ---------------------------------------------------------------------------
// Parsers per file type
// ---------------------------------------------------------------------------

function indexClaudeMd(path: string, stmts: Statements, results: IndexResult[]): void {
  const content = readFile(path);
  if (!content) return;

  // Indexează fiecare secțiune H2 ca observație separată pe entitatea proiectului
  const sections = content.split(/\n##\s+/).filter(Boolean);

  const observations: string[] = [];
  for (const section of sections) {
    const lines = section.trim().split("\n");
    const title = lines[0]?.trim() ?? "directive";
    const body = lines.slice(1).join("\n").trim();
    if (body.length > 0) {
      observations.push(`[${title}] ${body.slice(0, 300)}`);
    }
  }

  if (observations.length > 0) {
    upsert(stmts, "CLAUDE.md directives", "convention", observations);
    results.push({ entity: "CLAUDE.md directives", type: "convention", observations: observations.length, source: "CLAUDE.md" });
  }
}

function indexPackageJson(path: string, stmts: Statements, results: IndexResult[]): void {
  const content = readFile(path);
  if (!content) return;

  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(content) as Record<string, unknown>;
  } catch {
    return;
  }

  const name = (pkg["name"] as string | undefined) ?? "project";
  const version = (pkg["version"] as string | undefined) ?? "unknown";
  const description = (pkg["description"] as string | undefined) ?? "";
  const projectName = name.replace(/^@[\w-]+\//, ""); // strip scope

  const obs: string[] = [`version: ${version}`];
  if (description) obs.push(`description: ${description}`);

  // Scripts
  const scripts = pkg["scripts"] as Record<string, string> | undefined;
  if (scripts) {
    for (const [k, v] of Object.entries(scripts).slice(0, 6)) {
      obs.push(`script ${k}: ${v}`);
    }
  }

  upsert(stmts, projectName, "project", obs);
  results.push({ entity: projectName, type: "project", observations: obs.length, source: "package.json" });

  // Dependențe principale
  const deps = {
    ...(pkg["dependencies"] as Record<string, string> | undefined ?? {}),
    ...(pkg["devDependencies"] as Record<string, string> | undefined ?? {}),
  };
  for (const [dep, ver] of Object.entries(deps).slice(0, 20)) {
    upsert(stmts, dep, "tool", [`version: ${ver}`, `used in: ${projectName}`]);
    relate(stmts, projectName, dep, "depends_on");
  }
  if (Object.keys(deps).length > 0) {
    results.push({ entity: `${Object.keys(deps).length} dependencies`, type: "tool", observations: 1, source: "package.json" });
  }
}

function indexPyprojectToml(path: string, stmts: Statements, results: IndexResult[]): void {
  const content = readFile(path);
  if (!content) return;

  const nameMatch = content.match(/^name\s*=\s*["']([^"']+)["']/m);
  const versionMatch = content.match(/^version\s*=\s*["']([^"']+)["']/m);
  const descMatch = content.match(/^description\s*=\s*["']([^"']+)["']/m);

  const name = nameMatch?.[1] ?? "project";
  const obs: string[] = [];
  if (versionMatch?.[1]) obs.push(`version: ${versionMatch[1]}`);
  if (descMatch?.[1]) obs.push(`description: ${descMatch[1]}`);

  // Dependencies
  const depsSection = content.match(/\[tool\.poetry\.dependencies\]([\s\S]*?)(?=\[|$)/)?.[1]
    ?? content.match(/dependencies\s*=\s*\[([\s\S]*?)\]/)?.[1]
    ?? "";

  const deps = [...depsSection.matchAll(/["']?([\w-]+)["']?\s*[=:]/g)].map((m) => m[1]).filter(Boolean);
  for (const dep of deps.slice(0, 20)) {
    upsert(stmts, dep!, "tool", [`used in: ${name}`]);
    relate(stmts, name, dep!, "depends_on");
  }

  upsert(stmts, name, "project", obs);
  results.push({ entity: name, type: "project", observations: obs.length, source: "pyproject.toml" });
}

function indexReadme(path: string, projectName: string, stmts: Statements, results: IndexResult[]): void {
  const content = readFile(path);
  if (!content) return;

  // Prima secțiune (descriere)
  const firstParagraph = content.replace(/^#[^\n]*\n/, "").trim().split("\n\n")[0] ?? "";
  if (firstParagraph.length < 10) return;

  upsert(stmts, projectName, "project", [
    `README: ${firstParagraph.slice(0, 400)}`,
  ]);
  results.push({ entity: projectName, type: "project", observations: 1, source: "README.md" });
}

function indexMcpJson(path: string, stmts: Statements, results: IndexResult[]): void {
  const content = readFile(path);
  if (!content) return;

  let cfg: { mcpServers?: Record<string, unknown> };
  try {
    cfg = JSON.parse(content) as typeof cfg;
  } catch {
    return;
  }

  const servers = cfg.mcpServers ?? {};
  for (const [serverName, config] of Object.entries(servers)) {
    const c = config as { command?: string; args?: string[] };
    const obs = [`MCP server configured in project`];
    if (c.command) obs.push(`command: ${c.command} ${(c.args ?? []).join(" ")}`);
    upsert(stmts, serverName, "tool", obs);
    results.push({ entity: serverName, type: "tool", observations: obs.length, source: ".mcp.json" });
  }
}

function indexLogicGuardianYaml(path: string, stmts: Statements, results: IndexResult[]): void {
  const content = readFile(path);
  if (!content) return;

  // Extrage known_drift_patterns
  const patternMatches = [...content.matchAll(/id:\s*["']?(DRIFT-\d+)["']?\s*\n\s*name:\s*["']?([^\n"']+)["']?\s*\n\s*description:\s*["']?([^\n"']+)/g)];
  for (const m of patternMatches) {
    const [, id, name, desc] = m;
    upsert(stmts, `${id}: ${name!.trim()}`, "pattern", [
      `drift pattern: ${desc!.trim()}`,
      "source: logic-guardian.yaml",
    ]);
  }

  // Invarianți de proiect
  const invariantsMatch = content.match(/project_invariants:([\s\S]*?)(?=\n\w|\n#|$)/);
  if (invariantsMatch) {
    const invariants = [...invariantsMatch[1].matchAll(/-\s+"([^"]+)"/g)].map((m) => m[1]);
    if (invariants.length > 0) {
      upsert(stmts, "project invariants", "convention", invariants);
      results.push({ entity: "project invariants", type: "convention", observations: invariants.length, source: "logic-guardian.yaml" });
    }
  }

  if (patternMatches.length > 0) {
    results.push({ entity: `${patternMatches.length} drift patterns`, type: "pattern", observations: patternMatches.length, source: "logic-guardian.yaml" });
  }
}

// Source file indexing — extrage exporturi, clase, funcții principale
const SOURCE_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs"]);
const SKIP_DIRS = new Set(["node_modules", ".git", "build", "dist", "__pycache__", ".next", "venv", ".venv", "target", ".cache", "coverage", ".nyc_output"]);
const MAX_SOURCE_FILES = 10_000;

function indexSourceFile(filepath: string, rootDir: string, projectName: string, stmts: Statements): string[] {
  const content = readFile(filepath);
  if (!content) return [];

  const exports: string[] = [];
  const lang = extname(filepath);

  // TypeScript / JavaScript
  if ([".ts", ".tsx", ".js", ".jsx"].includes(lang)) {
    for (const m of content.matchAll(/export\s+(?:async\s+)?(?:function|class|const|type|interface)\s+(\w+)/g)) {
      exports.push(m[1]!);
    }
  }

  // Python
  if (lang === ".py") {
    for (const m of content.matchAll(/^(?:def|class|async def)\s+(\w+)/gm)) {
      if (!m[1]!.startsWith("_")) exports.push(m[1]!);
    }
  }

  if (exports.length === 0) return [];

  // Cale relativă față de rădăcina proiectului
  const relPath = filepath.replace(/\\/g, "/").replace(rootDir.replace(/\\/g, "/") + "/", "");
  const obs = [`exports from ${relPath}: ${exports.slice(0, 10).join(", ")}`];
  upsert(stmts, projectName, "project", obs);
  return exports;
}

function scanSources(dir: string, projectName: string, stmts: Statements, results: IndexResult[]): void {
  const rootDir = dir.replace(/\\/g, "/");
  let fileCount = 0;
  const exportedSymbols: string[] = [];

  function walk(d: string): void {
    if (fileCount >= MAX_SOURCE_FILES) return;
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry)) continue;
      const full = join(d, entry);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        walk(full);
      } else if (SOURCE_EXTS.has(extname(entry).toLowerCase())) {
        const syms = indexSourceFile(full, rootDir, projectName, stmts);
        exportedSymbols.push(...syms);
        fileCount++;
        if (fileCount >= MAX_SOURCE_FILES) return;
      }
    }
  }

  walk(dir);

  if (fileCount > 0) {
    results.push({
      entity: projectName,
      type: "project",
      observations: fileCount,
      source: `${fileCount} source files (${exportedSymbols.length} exports)`,
    });
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export function indexProject(directory: string, stmts: Statements): IndexResult[] {
  const results: IndexResult[] = [];
  const dir = directory.replace(/\\/g, "/");

  // Detectează numele proiectului din package.json sau pyproject.toml
  let projectName = basename(dir);
  const pkgPath = join(dir, "package.json");
  if (existsSync(pkgPath)) {
    const raw = readFile(pkgPath);
    if (raw) {
      try {
        const pkg = JSON.parse(raw) as { name?: string };
        if (pkg.name) projectName = pkg.name.replace(/^@[\w-]+\//, "");
      } catch { /* ignore */ }
    }
  }

  // 1. CLAUDE.md — cel mai important
  const claudeMdPaths = ["CLAUDE.md", ".claude/CLAUDE.md", "claude.md"];
  for (const p of claudeMdPaths) {
    const full = join(dir, p);
    if (existsSync(full)) {
      indexClaudeMd(full, stmts, results);
      break;
    }
  }

  // 2. package.json
  if (existsSync(join(dir, "package.json"))) {
    indexPackageJson(join(dir, "package.json"), stmts, results);
  }

  // 3. pyproject.toml
  if (existsSync(join(dir, "pyproject.toml"))) {
    indexPyprojectToml(join(dir, "pyproject.toml"), stmts, results);
  }

  // 4. README
  for (const p of ["README.md", "readme.md", "Readme.md"]) {
    if (existsSync(join(dir, p))) {
      indexReadme(join(dir, p), projectName, stmts, results);
      break;
    }
  }

  // 5. MCP config
  for (const p of [".mcp.json", "mcp.json"]) {
    if (existsSync(join(dir, p))) {
      indexMcpJson(join(dir, p), stmts, results);
      break;
    }
  }

  // 6. Logic Guardian config
  if (existsSync(join(dir, "logic-guardian.yaml"))) {
    indexLogicGuardianYaml(join(dir, "logic-guardian.yaml"), stmts, results);
  }

  // 7. Surse
  scanSources(dir, projectName, stmts, results);

  return results;
}
