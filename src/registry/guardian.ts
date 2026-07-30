import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  handleValidateFile, ValidateFileSchema,
  handleCheckDrift, CheckDriftSchema,
  handleGetChecklist,
} from "../tools/guardian.js";
import {
  handleGetCodingRules,
  handleCheckCodeQuality, CheckCodeQualitySchema,
} from "../tools/coding-guard.js";
import { tx, type RegistryCtx, type ToolMap } from "./shared.js";

// CheckCodeQualitySchema uses .refine(); pass the raw shape to MCP and re-parse
// inside the handler so the refinement runs.
const checkCodeQualityShape = {
  path: z.string().optional().describe("Absolute or relative path to the file to analyze."),
  code: z.string().optional().describe("Code snippet to analyze inline."),
  language: z.enum(["python", "javascript", "typescript", "vue", "generic"]).optional()
    .describe("Language hint. Auto-detected from file extension if path is provided."),
} as const;

export function registerGuardianTools(server: McpServer, _ctx: RegistryCtx): ToolMap {
  return {
    validate_file: server.registerTool("validate_file", {
      title: "Validate File",
      description:
        "Run Logic Guardian validation on a source file. Detects LLM drift: logic inversions, " +
        "null propagation, type confusion, copy-paste drift, silent exceptions. Python/JS/TS.",
      inputSchema: ValidateFileSchema.shape,
    }, tx("validate_file", (args) => handleValidateFile(args))),

    check_drift: server.registerTool("check_drift", {
      title: "Check Drift",
      description: "Analyze a code snippet for LLM drift patterns without saving to disk.",
      inputSchema: CheckDriftSchema.shape,
    }, tx("check_drift", (args) => handleCheckDrift(args))),

    get_checklist: server.registerTool("get_checklist", {
      title: "Get Checklist",
      description: "Get the full Logic Guardian validation checklist (5 passes).",
    }, tx("get_checklist", () => handleGetChecklist())),

    coding_rules: server.registerTool("coding_rules", {
      title: "Coding Rules",
      description:
        "Get the 25 Golden Rules coding checklist. Covers clarity, naming, single responsibility, " +
        "frontend rules, library selection, architecture separation.",
    }, tx("coding_rules", () => handleGetCodingRules())),

    check_code_quality: server.registerTool("check_code_quality", {
      title: "Check Code Quality",
      description:
        "Analyze a file or snippet against the 25 Golden Rules. Detects size violations, vague naming, " +
        "deep nesting, dead code, inline styles, prop explosion, fetch-in-component.",
      inputSchema: checkCodeQualityShape,
    }, tx("check_code_quality", (args) => handleCheckCodeQuality(CheckCodeQualitySchema.parse(args)))),
  };
}
