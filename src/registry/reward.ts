import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  handleReward, RewardSchema,
  handlePenalize, PenalizeSchema,
  handleShowRewards, ShowRewardsSchema,
} from "../tools/reward.js";
import { tx, type RegistryCtx, type ToolMap } from "./shared.js";

export function registerRewardTools(server: McpServer, ctx: RegistryCtx): ToolMap {
  const { stmts } = ctx;

  return {
    reward: server.registerTool("reward", {
      title: "Reward",
      description:
        "Signal that the last get_context() result was helpful (+1 reward). " +
        "Files in that context will be ranked higher in future similar queries.",
      inputSchema: RewardSchema.shape,
    }, tx("reward", (args) => handleReward(stmts, args))),

    penalize: server.registerTool("penalize", {
      title: "Penalize",
      description:
        "Signal that the last get_context() result was unhelpful (-1 reward). " +
        "Files in that context will be ranked lower in future similar queries.",
      inputSchema: PenalizeSchema.shape,
    }, tx("penalize", (args) => handlePenalize(stmts, args))),

    show_rewards: server.registerTool("show_rewards", {
      title: "Show Rewards",
      description:
        "Show the top rewarded experiences and most rewarded files. " +
        "Rewards decay exponentially (half-life ~14 days).",
      inputSchema: ShowRewardsSchema.shape,
    }, tx("show_rewards", (args) => handleShowRewards(stmts, args))),
  };
}
