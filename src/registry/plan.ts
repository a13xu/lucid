import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  handlePlanCreate, PlanCreateSchema,
  handlePlanList,   PlanListSchema,
  handlePlanGet,    PlanGetSchema,
  handlePlanUpdateTask, PlanUpdateTaskSchema,
} from "../tools/plan.js";
import { tx, type RegistryCtx, type ToolMap } from "./shared.js";

export function registerPlanTools(server: McpServer, ctx: RegistryCtx): ToolMap {
  const { db, stmts } = ctx;

  return {
    plan_create: server.registerTool("plan_create", {
      title: "Plan Create",
      description:
        "Create a plan with user story, ordered tasks, and test criteria. " +
        "Call BEFORE writing any code to establish intent and acceptance criteria.",
      inputSchema: PlanCreateSchema.shape,
    }, tx("plan_create", (args) => handlePlanCreate(db, stmts, args))),

    plan_list: server.registerTool("plan_list", {
      title: "Plan List",
      description: "List plans with progress summary. Defaults to active plans.",
      inputSchema: PlanListSchema.shape,
    }, tx("plan_list", (args) => handlePlanList(stmts, args))),

    plan_get: server.registerTool("plan_get", {
      title: "Plan Get",
      description: "Get full plan details: tasks, test criteria, status, and notes.",
      inputSchema: PlanGetSchema.shape,
    }, tx("plan_get", (args) => handlePlanGet(stmts, args))),

    plan_update_task: server.registerTool("plan_update_task", {
      title: "Plan Update Task",
      description:
        "Update a task status. Auto-completes the plan when all tasks are done. " +
        "Statuses: pending → in_progress → done (or blocked).",
      inputSchema: PlanUpdateTaskSchema.shape,
    }, tx("plan_update_task", (args) => handlePlanUpdateTask(stmts, args))),
  };
}
