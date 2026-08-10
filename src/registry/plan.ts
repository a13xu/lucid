import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  handlePlanCreate,     PlanCreateSchema,
  handlePlanList,       PlanListSchema,
  handlePlanGet,        PlanGetSchema,
  handlePlanUpdateTask, PlanUpdateTaskSchema,
  handlePlanArchive,    PlanArchiveSchema,
  handlePlanDelete,     PlanDeleteSchema,
  handlePlanCleanup,    PlanCleanupSchema,
} from "../tools/plan.js";
import { tx, type RegistryCtx, type ToolMap } from "./shared.js";

export function registerPlanTools(server: McpServer, ctx: RegistryCtx): ToolMap {
  const { db, stmts } = ctx;

  return {
    plan_create: server.registerTool("plan_create", {
      title: "Plan Create",
      description:
        "Create a plan with user story, ordered tasks, and test criteria. " +
        "Call BEFORE writing any code to establish intent and acceptance criteria. " +
        "The plan is stamped with the current project, so it stays out of other projects' lists.",
      inputSchema: PlanCreateSchema.shape,
    }, tx("plan_create", (args) => handlePlanCreate(db, stmts, args))),

    plan_list: server.registerTool("plan_list", {
      title: "Plan List",
      description:
        "List plans with progress summary. Defaults to active plans of the current project; " +
        "pass scope:\"all\" to include every project.",
      inputSchema: PlanListSchema.shape,
    }, tx("plan_list", (args) => handlePlanList(stmts, args))),

    plan_get: server.registerTool("plan_get", {
      title: "Plan Get",
      description: "Get full plan details: project, tasks with their real ids, test criteria, status, and notes.",
      inputSchema: PlanGetSchema.shape,
    }, tx("plan_get", (args) => handlePlanGet(stmts, args))),

    plan_update_task: server.registerTool("plan_update_task", {
      title: "Plan Update Task",
      description:
        "Update a task status. Auto-completes the plan when every task is done, and lists what " +
        "is still open otherwise. Statuses: pending → in_progress → done (or blocked).",
      inputSchema: PlanUpdateTaskSchema.shape,
    }, tx("plan_update_task", (args) => handlePlanUpdateTask(stmts, args))),

    plan_archive: server.registerTool("plan_archive", {
      title: "Plan Archive",
      description:
        "Close a plan without finishing every task — use when work was dropped or a worker died " +
        "leaving tasks stuck in_progress/blocked. Task history is preserved. " +
        "status:\"active\" reopens an archived plan.",
      inputSchema: PlanArchiveSchema.shape,
    }, tx("plan_archive", (args) => handlePlanArchive(stmts, args))),

    plan_delete: server.registerTool("plan_delete", {
      title: "Plan Delete",
      description:
        "Permanently delete a plan and all of its tasks. Requires confirm:true. " +
        "Prefer plan_archive — deletion cannot be undone.",
      inputSchema: PlanDeleteSchema.shape,
    }, tx("plan_delete", (args) => handlePlanDelete(stmts, args))),

    plan_cleanup: server.registerTool("plan_cleanup", {
      title: "Plan Cleanup",
      description:
        "Sweep active plans left idle past a threshold (default 72h) and archive them as abandoned. " +
        "Scoped to the current project by default. Use dry_run:true to preview.",
      inputSchema: PlanCleanupSchema.shape,
    }, tx("plan_cleanup", (args) => handlePlanCleanup(stmts, args))),
  };
}
