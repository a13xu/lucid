import { z } from "zod";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const TestGeneratorSchema = z.object({
  code: z.string().describe("Source code of the function, component, or API handler to test"),
  test_framework: z
    .enum(["vitest", "jest", "playwright"])
    .describe("Test framework to use"),
  test_type: z
    .enum(["unit", "integration", "e2e"])
    .describe("Type of tests to generate"),
  component_framework: z
    .enum(["vue", "react", "none"])
    .optional()
    .default("none")
    .describe("Frontend framework (for component tests)"),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract a function/component name from source code for use in test labels */
function extractName(code: string): string {
  const patterns = [
    /export\s+(?:default\s+)?(?:async\s+)?function\s+(\w+)/,
    /export\s+const\s+(\w+)\s*=/,
    /const\s+(\w+)\s*=.*=>/,
    /class\s+(\w+)/,
    /def\s+(\w+)\s*\(/,
  ];
  for (const re of patterns) {
    const m = code.match(re);
    if (m?.[1]) return m[1];
  }
  return "subject";
}

function buildVitestUnit(name: string, code: string, component: string): string {
  if (component === "vue") {
    return `import { describe, it, expect, vi } from "vitest";
import { mount } from "@vue/test-utils";
import ${name} from "./${name}.vue";

describe("${name}", () => {
  it("renders without errors", () => {
    const wrapper = mount(${name});
    expect(wrapper.exists()).toBe(true);
  });

  it("renders with default props", () => {
    const wrapper = mount(${name}, {
      props: {
        // TODO: add required props
      },
    });
    expect(wrapper.html()).toMatchSnapshot();
  });

  it("emits expected events", async () => {
    const wrapper = mount(${name});
    // TODO: trigger interaction
    // await wrapper.find("button").trigger("click");
    // expect(wrapper.emitted()).toHaveProperty("update");
  });

  it("handles empty/null props gracefully", () => {
    // TODO: mount with edge-case props
    expect(() => mount(${name}, { props: {} })).not.toThrow();
  });
});`;
  }

  if (component === "react") {
    return `import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ${name} } from "./${name}";

describe("${name}", () => {
  it("renders without crashing", () => {
    const { container } = render(<${name} />);
    expect(container).toBeTruthy();
  });

  it("renders expected content", () => {
    render(<${name} />);
    // TODO: assert visible text/elements
    // expect(screen.getByText("Expected Text")).toBeInTheDocument();
  });

  it("handles user interaction", async () => {
    const onAction = vi.fn();
    render(<${name} onAction={onAction} />);
    // TODO: trigger interaction
    // fireEvent.click(screen.getByRole("button"));
    // expect(onAction).toHaveBeenCalledOnce();
  });

  it("handles edge cases (empty, null, undefined props)", () => {
    // TODO: render with edge-case props
    expect(() => render(<${name} />)).not.toThrow();
  });
});`;
  }

  // Pure function
  return `import { describe, it, expect, vi, beforeEach } from "vitest";
import { ${name} } from "./${name}";

describe("${name}", () => {
  // Happy path
  it("returns correct result for typical input", () => {
    // TODO: replace with real input/output
    const result = ${name}(/* happy path args */);
    expect(result).toBeDefined();
  });

  // Edge cases
  it("handles empty input", () => {
    // TODO: empty/zero/null input
    // expect(${name}("")).toEqual(/* expected */);
  });

  it("handles boundary values", () => {
    // TODO: boundary conditions
    // expect(${name}(0)).toBe(/* expected */);
    // expect(${name}(Number.MAX_SAFE_INTEGER)).toBe(/* expected */);
  });

  // Error path
  it("throws on invalid input", () => {
    expect(() => ${name}(/* invalid args */)).toThrow();
  });

  // Mocks
  it("calls dependencies with correct arguments", () => {
    const mockDep = vi.fn().mockReturnValue("mocked");
    vi.mock("./${name}", () => ({ dependency: mockDep }));
    ${name}(/* args with mock */);
    // expect(mockDep).toHaveBeenCalledWith(/* expected args */);
  });
});`;
}

function buildJestUnit(name: string, code: string, component: string): string {
  const vitestVersion = buildVitestUnit(name, code, component);
  return vitestVersion
    .replace(/from "vitest"/g, 'from "@jest/globals"')
    .replace(/import \{ describe, it, expect, vi, beforeEach \} from "@jest\/globals";/, `import { describe, it, expect, jest, beforeEach } from "@jest/globals";`)
    .replace(/vi\.fn/g, "jest.fn")
    .replace(/vi\.mock/g, "jest.mock")
    .replace(/vi\.spyOn/g, "jest.spyOn");
}

function buildPlaywrightE2E(name: string): string {
  return `import { test, expect, type Page } from "@playwright/test";

// E2E tests for: ${name}
// These run in a real browser — start your dev server first.

test.describe("${name} — E2E", () => {
  test.beforeEach(async ({ page }: { page: Page }) => {
    // TODO: navigate to the page under test
    await page.goto("http://localhost:3000/YOUR_ROUTE");
  });

  test("page loads and shows expected content", async ({ page }: { page: Page }) => {
    await expect(page).toHaveTitle(/TODO: expected title/);
    // await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  });

  test("primary user flow completes successfully", async ({ page }: { page: Page }) => {
    // TODO: simulate the main user journey
    // await page.getByLabel("Email").fill("user@example.com");
    // await page.getByRole("button", { name: "Submit" }).click();
    // await expect(page.getByText("Success")).toBeVisible();
  });

  test("error state is shown for invalid input", async ({ page }: { page: Page }) => {
    // TODO: trigger error state
    // await page.getByRole("button", { name: "Submit" }).click();
    // await expect(page.getByRole("alert")).toBeVisible();
  });

  test("is accessible (no critical violations)", async ({ page }: { page: Page }) => {
    // Requires @axe-core/playwright
    // const accessibilityScanResults = await new AxeBuilder({ page }).analyze();
    // expect(accessibilityScanResults.violations).toEqual([]);
  });
});`;
}

function buildIntegrationTest(name: string, framework: string): string {
  const importLine =
    framework === "vitest"
      ? 'import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";'
      : 'import { describe, it, expect, jest, beforeAll, afterAll } from "@jest/globals";';

  return `${importLine}
// Integration tests for: ${name}
// These tests use real implementations (DB, filesystem, network) or heavy mocks.

describe("${name} — Integration", () => {
  beforeAll(async () => {
    // TODO: set up test database / test server
    // await setupTestDb();
  });

  afterAll(async () => {
    // TODO: tear down
    // await cleanupTestDb();
  });

  it("handles the full happy-path workflow", async () => {
    // TODO: end-to-end through real layers
    // const result = await ${name}(realDependency, realArgs);
    // expect(result).toMatchObject({ status: "ok" });
  });

  it("rolls back on error (atomicity)", async () => {
    // TODO: inject failure, verify no side-effects persisted
  });

  it("respects authorization boundaries", async () => {
    // TODO: call with unauthorized context, expect rejection
  });
});`;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

// Example call:
//   handleTestGenerator({ code: "export function add(a, b) { return a + b; }", test_framework: "vitest", test_type: "unit", component_framework: "none" })

export function handleTestGenerator(
  args: z.infer<typeof TestGeneratorSchema>,
): string {
  const { code, test_framework, test_type, component_framework } = args;
  const name = extractName(code);
  const cf = component_framework ?? "none";

  let testCode: string;
  let filename: string;

  if (test_type === "e2e") {
    testCode = buildPlaywrightE2E(name);
    filename = `${name}.e2e.spec.ts`;
  } else if (test_type === "integration") {
    testCode = buildIntegrationTest(name, test_framework);
    filename = `${name}.integration.spec.ts`;
  } else {
    // unit
    if (test_framework === "jest") {
      testCode = buildJestUnit(name, code, cf);
    } else {
      testCode = buildVitestUnit(name, code, cf);
    }
    filename = `${name}.spec.ts`;
  }

  const lines: string[] = [
    `✅ Tests generated for: ${name}`,
    `📄 Filename: ${filename}`,
    `🔧 Framework: ${test_framework} | Type: ${test_type} | Component: ${cf}`,
    ``,
    "```typescript",
    testCode,
    "```",
    ``,
    `💡 Reasoning: Generated ${test_type} test scaffold for \`${name}\` using ${test_framework}. ` +
      `Covers: happy path, edge cases (empty/null/boundary), error path, and mock setup. ` +
      `TODO comments mark where you must fill in concrete values. ` +
      (test_type === "e2e"
        ? "Start your dev server before running playwright tests."
        : test_type === "integration"
          ? "Set up a test database/environment in beforeAll."
          : "Run with `npx vitest` or `npx jest` after filling in the TODOs."),
  ];

  return lines.join("\n");
}
