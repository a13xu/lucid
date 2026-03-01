// Reward system — lightweight RL from get_context usage signals
// Sources: explicit reward()/penalize(), implicit sync_file(), temporal decay

import type { Statements, ExperienceRow, FileRewardRow } from "../database.js";

// ---------------------------------------------------------------------------
// In-process tracking of the last created experience (server is long-running)
// ---------------------------------------------------------------------------

let _lastId: number | null = null;
export const getLastExperienceId = (): number | null => _lastId;
export const setLastExperienceId = (id: number): void => { _lastId = id; };

// ---------------------------------------------------------------------------
// Exponential decay — half-life ≈ 14 days (λ = ln(2)/14 ≈ 0.0495 ≈ 0.05)
// ---------------------------------------------------------------------------

export function decayedReward(reward: number, rewardedAt: number | null): number {
  if (rewardedAt === null || rewardedAt === 0) return 0;
  const daysSince = Math.max(0, (Date.now() / 1000 - rewardedAt) / 86400);
  return reward * Math.exp(-0.05 * daysSince);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tokenizeQuery(query: string): string {
  return query.toLowerCase().split(/\s+/).filter((t) => t.length > 1).join(" ");
}

function parseFps(contextFps: string): string[] {
  try {
    return JSON.parse(contextFps) as string[];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Create experience — called after get_context returns results
// ---------------------------------------------------------------------------

export function createExperience(
  query: string,
  contextFps: string[],
  strategy: string,
  stmts: Statements
): number {
  const result = stmts.insertExperience.run(
    query,
    tokenizeQuery(query),
    JSON.stringify(contextFps),
    strategy
  );
  const id = Number(result.lastInsertRowid);
  setLastExperienceId(id);
  return id;
}

// ---------------------------------------------------------------------------
// Reward or penalize an experience (explicit feedback)
// ---------------------------------------------------------------------------

export function rewardExperience(
  id: number,
  delta: number,
  feedback: string | null,
  stmts: Statements
): { query: string; fps: string[] } | null {
  const exp = stmts.getExperienceById.get(id) as ExperienceRow | undefined;
  if (!exp) return null;

  stmts.updateExperienceReward.run(delta, feedback, id);

  const fps = parseFps(exp.context_fps);
  for (const fp of fps) {
    stmts.upsertFileReward.run(fp, delta);
  }

  return { query: exp.query, fps };
}

// ---------------------------------------------------------------------------
// Implicit reward from sync_file — if filepath was in the last context → +0.3
// ---------------------------------------------------------------------------

const IMPLICIT_DELTA = 0.3;

export function implicitRewardFromSync(
  filepath: string,
  stmts: Statements
): boolean {
  const lastId = getLastExperienceId();
  if (lastId === null) return false;

  const exp = stmts.getExperienceById.get(lastId) as ExperienceRow | undefined;
  if (!exp) return false;

  const fps = parseFps(exp.context_fps);
  if (!fps.includes(filepath)) return false;

  stmts.updateExperienceReward.run(IMPLICIT_DELTA, null, lastId);
  stmts.upsertFileReward.run(filepath, IMPLICIT_DELTA);
  return true;
}

// ---------------------------------------------------------------------------
// Get file rewards map — for ranking boost in assembleContext()
// ---------------------------------------------------------------------------

export function getFileRewardsMap(stmts: Statements): Map<string, number> {
  const rows = stmts.getFileRewards.all() as FileRewardRow[];
  const map = new Map<string, number>();
  for (const row of rows) {
    const d = decayedReward(row.total_reward, row.last_rewarded);
    if (d > 0) map.set(row.filepath, d);
  }
  return map;
}
