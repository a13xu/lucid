// Reward / penalize / show_rewards tool handlers

import { z } from "zod";
import type { Statements, ExperienceRow, FileRewardRow } from "../database.js";
import {
  getLastExperienceId,
  rewardExperience,
  decayedReward,
  getFileRewardsMap,
} from "../memory/experience.js";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const RewardSchema = z.object({
  note: z.string().optional().describe("Optional note about what worked"),
});

export const PenalizeSchema = z.object({
  note: z.string().optional().describe("Optional note about what was missing or wrong"),
});

export const ShowRewardsSchema = z.object({
  query: z.string().optional().describe("Filter experiences by query text"),
  topK: z.number().int().min(1).max(50).optional().describe("Number of top results to show (default 10)"),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatAge(unixSec: number): string {
  const diffSec = Math.floor(Date.now() / 1000) - unixSec;
  if (diffSec < 3600) return `${Math.round(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.round(diffSec / 3600)}h ago`;
  return `${Math.round(diffSec / 86400)} days ago`;
}

function parseFps(contextFps: string): string[] {
  try {
    return JSON.parse(contextFps) as string[];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// reward — explicit +1 on the last experience
// ---------------------------------------------------------------------------

export function handleReward(
  stmts: Statements,
  args: z.infer<typeof RewardSchema>
): string {
  const lastId = getLastExperienceId();
  if (lastId === null) {
    return "❌ No recent get_context() call to reward. Call get_context() first.";
  }

  const result = rewardExperience(lastId, 1.0, args.note ?? null, stmts);
  if (!result) {
    return `❌ Experience #${lastId} not found in database.`;
  }

  const lines = [
    `✅ Experience #${lastId} rewarded (+1)`,
    `   Query: "${result.query}"`,
  ];
  if (args.note) lines.push(`   Note: ${args.note}`);

  if (result.fps.length > 0) {
    lines.push(`   Rewarded files:`);
    for (const fp of result.fps.slice(0, 5)) {
      lines.push(`     +1.0  ${fp}`);
    }
    if (result.fps.length > 5) lines.push(`     … and ${result.fps.length - 5} more`);
  }

  // Show accumulated reward for these files
  const allRewards = stmts.getFileRewards.all() as FileRewardRow[];
  const relevant = allRewards.filter((fr) => result.fps.includes(fr.filepath));
  if (relevant.length > 0) {
    const total = relevant.reduce((sum, fr) => sum + fr.total_reward, 0);
    lines.push(`   Total reward score for these files: ${total.toFixed(1)} (accumulated)`);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// penalize — explicit -1 on the last experience
// ---------------------------------------------------------------------------

export function handlePenalize(
  stmts: Statements,
  args: z.infer<typeof PenalizeSchema>
): string {
  const lastId = getLastExperienceId();
  if (lastId === null) {
    return "❌ No recent get_context() call to penalize. Call get_context() first.";
  }

  const result = rewardExperience(lastId, -1.0, args.note ?? null, stmts);
  if (!result) {
    return `❌ Experience #${lastId} not found in database.`;
  }

  const lines = [
    `❌ Experience #${lastId} penalized (-1)`,
    `   Query: "${result.query}"`,
  ];
  if (args.note) lines.push(`   Note: ${args.note}`);

  if (result.fps.length > 0) {
    lines.push(`   Penalized files:`);
    for (const fp of result.fps.slice(0, 5)) {
      lines.push(`     -1.0  ${fp}`);
    }
    if (result.fps.length > 5) lines.push(`     … and ${result.fps.length - 5} more`);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// show_rewards — display top experiences + most rewarded files
// ---------------------------------------------------------------------------

export function handleShowRewards(
  stmts: Statements,
  args: z.infer<typeof ShowRewardsSchema>
): string {
  const topK = args.topK ?? 10;
  const lines: string[] = [];

  // Get experiences
  let experiences: ExperienceRow[];
  if (args.query) {
    try {
      // FTS search: append * for prefix match
      const ftsQuery = args.query.trim().split(/\s+/).map((t) => `${t}*`).join(" ");
      experiences = stmts.searchExperiencesFTS.all(ftsQuery, topK) as ExperienceRow[];
    } catch {
      // Fall back to top by reward if FTS query is malformed
      experiences = stmts.getTopExperiences.all(topK) as ExperienceRow[];
    }
  } else {
    experiences = stmts.getTopExperiences.all(topK) as ExperienceRow[];
  }

  if (experiences.length === 0) {
    lines.push("No rewarded experiences yet. Use get_context() then reward() to start building context memory.");
  } else {
    lines.push("🏆 Top rewarded experiences (decayed):", "");
    for (const exp of experiences) {
      const decayed = decayedReward(exp.reward, exp.rewarded_at);
      const ageStr = exp.rewarded_at ? formatAge(exp.rewarded_at) : "never rewarded";
      const sign = exp.reward >= 0 ? "+" : "";
      lines.push(`#${exp.id}  ${sign}${decayed.toFixed(1)}  "${exp.query}"  (${ageStr})`);
      const fps = parseFps(exp.context_fps);
      if (fps.length > 0) {
        const shown = fps.slice(0, 3).join(", ");
        const extra = fps.length > 3 ? ` +${fps.length - 3} more` : "";
        lines.push(`     → ${shown}${extra}`);
      }
      if (exp.feedback) lines.push(`     note: ${exp.feedback}`);
    }
  }

  // Most rewarded files (decayed)
  lines.push("", "📁 Most rewarded files:");
  const topFiles = stmts.getTopFileRewards.all(topK) as FileRewardRow[];
  if (topFiles.length === 0) {
    lines.push("  (none yet)");
  } else {
    topFiles.forEach((fr, i) => {
      const decayed = decayedReward(fr.total_reward, fr.last_rewarded);
      lines.push(`  ${i + 1}. ${fr.filepath}  reward=${decayed.toFixed(1)}  used=${fr.use_count}x`);
    });
  }

  return lines.join("\n");
}
