import { join } from "path";
import { homedir } from "os";
import { existsSync, readFileSync } from "fs";

export const ORIGINAL_CODING_RULES = `# 25 Golden Rules — Code Quality Checklist

## Section 1: General Quality (Rules 1–10)

- [ ] **Rule 1 — File Size**: File is under 500 lines (components under 300).
      PASS: file has fewer lines. FAIL: file exceeds limit — split into modules.

- [ ] **Rule 2 — Function Length**: Every function/method is under 60 lines.
      PASS: function is focused and short. FAIL: function exceeds 60 lines — break it up.

- [ ] **Rule 3 — Meaningful Names**: No vague variable names (x, tmp, data, val, obj, foo, bar).
      No vague function names (doSomething, handleStuff, processData, manage, doWork).
      PASS: names explain purpose. FAIL: name is a placeholder — rename to intent.

- [ ] **Rule 4 — Single Responsibility**: Functions/methods do exactly ONE thing.
      If the name contains "And" or "Or", it is doing two things.
      PASS: one verb, one concept. FAIL: split into two functions.

- [ ] **Rule 5 — No Dead Code**: No commented-out code blocks (3+ consecutive lines with =, (, {, ;).
      PASS: code is live. FAIL: remove dead code — use version control for history.

- [ ] **Rule 6 — Explicit Error Handling**: Errors are caught, logged, or re-thrown.
      No silent swallowing (catch {} or except: pass).
      PASS: every error path is handled. FAIL: add logging or re-throw.

- [ ] **Rule 7 — No Magic Numbers**: Numeric literals are replaced with named constants.
      PASS: constants have descriptive names. FAIL: extract to a named constant.

- [ ] **Rule 8 — Max 3 Nesting Levels**: Code is not nested more than 3 levels deep.
      PASS: deepest indent is 3 levels. FAIL: extract logic or use early returns.

- [ ] **Rule 9 — DRY (Don't Repeat Yourself)**: No near-duplicate blocks of code.
      PASS: logic is extracted into a shared function. FAIL: refactor duplicates.

- [ ] **Rule 10 — Explicit Return Types**: Typed languages declare return types on public functions.
      PASS: all public functions have explicit return types. FAIL: add return type annotation.

## Section 2: Frontend Components (Rules 11–18)

- [ ] **Rule 11 — Component Size**: UI components are under 300 lines.
      PASS: component is focused. FAIL: extract sub-components or custom hooks.

- [ ] **Rule 12 — No Inline Styles**: No style={{ }} in JSX/Vue templates.
      PASS: styles are in CSS/SCSS/CSS-in-JS. FAIL: move to stylesheet or styled component.

- [ ] **Rule 13 — Prop Limit**: Components accept at most 8 props.
      PASS: props are few and cohesive. FAIL: group related props into an object.

- [ ] **Rule 14 — Prefer Composition**: Large components are split into sub-components.
      No "god components" handling layout + data + formatting + interaction.
      PASS: each component has one visual/logical role. FAIL: extract a sub-component.

- [ ] **Rule 15 — No Direct DOM Access**: No document.querySelector / getElementById in components.
      PASS: refs are used (useRef, ref=). FAIL: replace with ref mechanism.

- [ ] **Rule 16 — Data Fetching in Services/Hooks**: No fetch() or axios calls in component body.
      PASS: data fetching is in a custom hook or service. FAIL: extract to useXxx hook.

- [ ] **Rule 17 — One Styling System**: File uses only one styling approach
      (Tailwind OR styled-components OR CSS modules — not all three).
      PASS: consistent styling. FAIL: standardize on one approach.

- [ ] **Rule 18 — No Nested Ternaries in JSX**: JSX conditionals use if/else or variables, not nested ternaries.
      PASS: conditions are readable. FAIL: extract condition to a variable or early return.

## Section 3: Architecture (Rules 19–25)

- [ ] **Rule 19 — Single Source of Truth**: State is not duplicated across multiple stores or components.
      PASS: one authoritative source for each piece of state. FAIL: remove duplication.

- [ ] **Rule 20 — UI/Logic Separation**: Business logic is not inside UI components.
      PASS: components call services/hooks; logic lives elsewhere. FAIL: extract to service.

- [ ] **Rule 21 — Dependency Abstraction**: External APIs/SDKs are wrapped in adapter/service layers.
      PASS: swapping a library touches one file. FAIL: add an abstraction layer.

- [ ] **Rule 22 — No Circular Imports**: Module dependency graph is a DAG (no cycles).
      PASS: import graph has no cycles. FAIL: restructure modules to remove the cycle.

- [ ] **Rule 23 — Config in Dedicated Files**: Magic strings and environment-specific values are in config files.
      PASS: config is centralized. FAIL: extract to config.ts or .env.

- [ ] **Rule 24 — Public API Coverage**: Every exported function has a corresponding test.
      PASS: public API is covered by tests. FAIL: write a test for the new export.

- [ ] **Rule 25 — No God Objects**: Classes/modules are focused — no object that knows everything.
      PASS: objects have clear, narrow responsibilities. FAIL: split the god object.

---

## Quick Check Before Marking Done

1. Run \`check_code_quality\` on modified files — fix HIGH severity issues.
2. Run \`validate_file\` (Logic Guardian) — fix correctness bugs first.
3. Verify rules 3, 4, 8 manually (naming and nesting are hard to auto-detect fully).
4. For frontend work, verify rules 12, 15, 16 — these are the most common oversights.
`;

// Opt-in: if a pre-compressed copy exists at ~/.lucid/compressed-prompts/coding-rules.txt
// (produced by `npm run compress-prompts`), serve that instead. Falls back to the
// original on any error so this is always safe.
function loadCompressed(): string | null {
  try {
    const p = join(homedir(), ".lucid", "compressed-prompts", "coding-rules.txt");
    if (!existsSync(p)) return null;
    const text = readFileSync(p, "utf-8").trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

export const CODING_RULES = loadCompressed() ?? ORIGINAL_CODING_RULES;
