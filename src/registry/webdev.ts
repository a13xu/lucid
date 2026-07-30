import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  GenerateComponentSchema, handleGenerateComponent,
  ScaffoldPageSchema,      handleScaffoldPage,
  SeoMetaSchema,           handleSeoMeta,
  AccessibilityAuditSchema, handleAccessibilityAudit,
  ApiClientSchema,         handleApiClient,
  TestGeneratorSchema,     handleTestGenerator,
  ResponsiveLayoutSchema,  handleResponsiveLayout,
  SecurityScanSchema,      handleSecurityScan,
  DesignTokensSchema,      handleDesignTokens,
  PerfHintsSchema,         handlePerfHints,
} from "../tools/webdev/index.js";
import { tx, type RegistryCtx, type ToolMap } from "./shared.js";

export function registerWebdevTools(server: McpServer, _ctx: RegistryCtx): ToolMap {
  return {
    generate_component: server.registerTool("generate_component", {
      title: "Generate Component",
      description:
        "Generate a complete component scaffold from a description. React (TSX/JSX) or Vue/Nuxt. " +
        "Styling: Tailwind, CSS Modules, or none.",
      inputSchema: GenerateComponentSchema.shape,
    }, tx("generate_component", (args) => handleGenerateComponent(args))),

    scaffold_page: server.registerTool("scaffold_page", {
      title: "Scaffold Page",
      description:
        "Generate a full page scaffold with layout, SEO head meta, and placeholder sections. " +
        "Nuxt (useHead), Next.js (Metadata API), or plain Vue.",
      inputSchema: ScaffoldPageSchema.shape,
    }, tx("scaffold_page", (args) => handleScaffoldPage(args))),

    seo_meta: server.registerTool("seo_meta", {
      title: "SEO Meta",
      description:
        "Generate complete SEO metadata: HTML meta tags, Open Graph, Twitter Card, JSON-LD " +
        "(Article, Product, WebSite, WebPage).",
      inputSchema: SeoMetaSchema.shape,
    }, tx("seo_meta", (args) => handleSeoMeta(args))),

    accessibility_audit: server.registerTool("accessibility_audit", {
      title: "Accessibility Audit",
      description:
        "Audit HTML/JSX/Vue snippets for WCAG violations. Checks: alt text, labels, empty buttons, " +
        "tabindex, click handlers, target=_blank. Returns severity + WCAG criterion + corrected code.",
      inputSchema: AccessibilityAuditSchema.shape,
    }, tx("accessibility_audit", (args) => handleAccessibilityAudit(args))),

    api_client: server.registerTool("api_client", {
      title: "API Client",
      description:
        "Generate a typed TypeScript async function for a REST endpoint. Includes types, " +
        "error handling (throws on non-2xx), usage example. Auth: bearer/cookie/apikey/none.",
      inputSchema: ApiClientSchema.shape,
    }, tx("api_client", (args) => handleApiClient(args))),

    test_generator: server.registerTool("test_generator", {
      title: "Test Generator",
      description:
        "Generate a complete test file. Covers happy path, edge cases, error path, mock setup. " +
        "Frameworks: Vitest, Jest, Playwright. Component: Vue Test Utils or React Testing Library.",
      inputSchema: TestGeneratorSchema.shape,
    }, tx("test_generator", (args) => handleTestGenerator(args))),

    responsive_layout: server.registerTool("responsive_layout", {
      title: "Responsive Layout",
      description:
        "Generate a responsive mobile-first layout from a wireframe description. " +
        "Tailwind utility classes, CSS Grid (named areas), or Flexbox + media queries.",
      inputSchema: ResponsiveLayoutSchema.shape,
    }, tx("responsive_layout", (args) => handleResponsiveLayout(args))),

    security_scan: server.registerTool("security_scan", {
      title: "Security Scan",
      description:
        "Scan JS/TS/HTML/Vue for web security vulns: XSS, code injection, SQL injection, " +
        "hardcoded secrets, open redirects, prototype pollution, path traversal, insecure CORS. " +
        "Context-aware (frontend/backend/api).",
      inputSchema: SecurityScanSchema.shape,
    }, tx("security_scan", (args) => handleSecurityScan(args))),

    design_tokens: server.registerTool("design_tokens", {
      title: "Design Tokens",
      description:
        "Generate a complete design system token set from a brand color and mood. " +
        "11-step color scales, neutrals, semantic aliases, type/spacing/radius/shadow tokens. " +
        "Output: CSS vars, Tailwind config, or JSON.",
      inputSchema: DesignTokensSchema.shape,
    }, tx("design_tokens", (args) => handleDesignTokens(args))),

    perf_hints: server.registerTool("perf_hints", {
      title: "Perf Hints",
      description:
        "Analyze a component or page for Core Web Vitals issues. Detects LCP image priority, " +
        "CLS dimensions, render-blocking scripts, fetch-in-render, INP, missing memoization, " +
        "whole-library imports. Issues ranked by CWV metric impact.",
      inputSchema: PerfHintsSchema.shape,
    }, tx("perf_hints", (args) => handlePerfHints(args))),
  };
}
