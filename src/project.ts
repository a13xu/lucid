/**
 * Project scope resolution.
 *
 * Plans live in a single shared database (~/.claude/memory.db) but are worked on
 * from many different checkouts. Without a scope key every project sees every
 * other project's plans — the statusline shows a stale plan from another repo and
 * `plan_list` returns generic noise. This module derives the key.
 *
 * The MCP server is spawned by Claude Code with cwd = the directory the session
 * was started in, so cwd is the input; the root is found by walking up to the
 * nearest project marker.
 */

import { existsSync, readFileSync } from "fs";
import { basename, dirname, join, resolve } from "path";
import { homedir } from "os";

export interface ProjectScope {
  /** Canonical, comparable key: absolute path, forward slashes, upper-case drive letter. */
  id: string;
  /** Human label shown in tool output and the statusline. */
  name: string;
  /** Resolved project root on disk, native separators. */
  root: string;
}

/** A `.git` directory wins over every other marker — it is the real repo boundary. */
const GIT_MARKER = ".git";

/** Checked only when no `.git` is found on the way up. Order is irrelevant (any match wins). */
const PROJECT_MARKERS = [
  "CLAUDE.md",
  "lucid.config.json",
  ".claude",
  "package.json",
  "pyproject.toml",
  "go.mod",
  "Cargo.toml",
  "composer.json",
];

/**
 * Normalise a path into a stable comparison key.
 *
 * Windows hands out drive letters in both cases depending on who spawned the
 * process — `~/.claude.json` in the wild already contains both `C:/x` and `c:/x`
 * for the same directory. Without this, one project silently becomes two.
 */
export function canonicalProjectId(p: string): string {
  const abs = resolve(p).replace(/\\/g, "/").replace(/\/+$/, "");
  return abs.replace(/^([a-z]):/, (_m, drive: string) => `${drive.toUpperCase()}:`);
}

function readJsonSafe(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Walk up from `start` to the project root.
 *
 * The home directory is never a project root: `~/.claude` exists for every user
 * and would otherwise swallow any session started outside a real project.
 */
export function findProjectRoot(start: string): string {
  const startAbs = resolve(start);
  const homeId = canonicalProjectId(homedir());
  let dir = startAbs;
  let nearestMarker: string | null = null;

  for (;;) {
    if (canonicalProjectId(dir) !== homeId) {
      if (existsSync(join(dir, GIT_MARKER))) return dir;
      if (nearestMarker === null && PROJECT_MARKERS.some((m) => existsSync(join(dir, m)))) {
        nearestMarker = dir;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;   // filesystem root reached
    dir = parent;
  }

  return nearestMarker ?? startAbs;
}

function resolveProjectName(root: string): string {
  const envName = process.env["LUCID_PROJECT_NAME"];
  if (envName) return envName;

  const admin = readJsonSafe(join(root, ".claude", "lucid-admin.json"));
  if (admin && typeof admin["projectName"] === "string" && admin["projectName"]) {
    return admin["projectName"];
  }

  const pkg = readJsonSafe(join(root, "package.json"));
  if (pkg && typeof pkg["name"] === "string" && pkg["name"]) {
    return pkg["name"];
  }

  return basename(root) || root;
}

let _cached: ProjectScope | null = null;

/**
 * The project this server instance is working on. Cached — cwd cannot change
 * for the lifetime of an MCP server process.
 */
export function getProjectScope(): ProjectScope {
  if (_cached) return _cached;

  const root = process.env["LUCID_PROJECT_ROOT"]
    ? resolve(process.env["LUCID_PROJECT_ROOT"])
    : findProjectRoot(process.cwd());

  _cached = { id: canonicalProjectId(root), name: resolveProjectName(root), root };
  return _cached;
}

export function resetProjectScopeCache(): void {
  _cached = null;
}

/**
 * True when `planProject` refers to the same project as `scopeId`, or to a
 * directory nested inside it. A session started in `repo/packages/api` must
 * still see plans stamped with `repo` — and vice versa.
 *
 * Legacy rows (`project = ''`, written before scoping existed) match nothing;
 * callers surface them separately so they stay visible instead of vanishing.
 */
export function isSameProject(planProject: string, scopeId: string): boolean {
  if (!planProject || !scopeId) return false;
  if (planProject === scopeId) return true;
  return planProject.startsWith(`${scopeId}/`) || scopeId.startsWith(`${planProject}/`);
}
