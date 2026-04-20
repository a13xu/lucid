import { join } from "path";
import { homedir } from "os";
import { existsSync, readFileSync } from "fs";

export const ORIGINAL_CHECKLIST = `# Logic Guardian — Validation Checklist (5 passes)

## Pass 1: Logic Trace
Trace through the code with CONCRETE values:
- Happy path   → real values, write each variable state
- Empty/zero   → null, 0, "", []
- Boundary     → first element, last element, max int, single char
- Error case   → network down, file missing, permission denied

STOP if any trace produces unexpected output. Fix before continuing.

## Pass 2: Contract Verification
- [ ] Preconditions: what must be true BEFORE this runs? Is it checked?
- [ ] Postconditions: what must be true AFTER? Can you prove it?
- [ ] Invariants: what must ALWAYS be true? Does the code maintain it?
- [ ] Return type: does EVERY code path return the expected type?
- [ ] Side effects: are all side effects intentional?

## Pass 3: Stupid Mistakes Checklist

### Off-by-one
- [ ] < vs <= — verify with boundary values
- [ ] Array indices — last is length - 1
- [ ] Loop iterations — exactly N times?

### Null/Undefined Propagation
- [ ] Every .property access — can the object be null?
- [ ] Every array index — can the array be empty?
- [ ] Every map lookup — can the key be missing?

### Type Confusion
- [ ] String vs Number comparisons
- [ ] Integer vs Float division
- [ ] Boolean coercion edge cases

### Logic Inversions (THE #1 LLM drift pattern)
- [ ] if/else — is the condition testing what you THINK?
- [ ] Early returns — does the guard return the RIGHT value?
- [ ] filter/find/some — keeping the RIGHT elements?
- [ ] Error handling — catching and re-throwing correctly?

### State & Mutation
- [ ] Mutating shared object when you should copy?
- [ ] Async state read after it might have changed?

### Copy-Paste Drift
- [ ] ALL variable names updated in copied blocks?
- [ ] Conditions changed, not just variable names?

## Pass 4: Integration Sanity
- [ ] Breaks existing callers?
- [ ] Imports/exports correct?
- [ ] If async, all callers awaiting it?
- [ ] If type changed, all usages updated?

## Pass 5: Explain It Test
In ONE sentence: what does this code do?
If you can't explain it, or the sentence doesn't match the code → something is wrong.

## Anti-Drift Triggers
STOP if you find yourself thinking:
- "This is similar to..." → You're pattern-matching. TRACE THE LOGIC.
- "This should work because the other one does" → VERIFY INDEPENDENTLY.
- "I'll just copy and change the names" → CHECK EVERY DIFFERENCE.
- "The error handling is probably fine" → TRACE THE ERROR PATH.
- "This is standard boilerplate" → Verify it fits this context.
`;

// Opt-in: if a pre-compressed copy exists at ~/.lucid/compressed-prompts/checklist.txt
// (produced by `npm run compress-prompts`), serve that instead. Falls back to the
// original on any error so this is always safe.
function loadCompressed(): string | null {
  try {
    const p = join(homedir(), ".lucid", "compressed-prompts", "checklist.txt");
    if (!existsSync(p)) return null;
    const text = readFileSync(p, "utf-8").trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

export const CHECKLIST = loadCompressed() ?? ORIGINAL_CHECKLIST;
