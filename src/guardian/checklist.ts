import { join } from "path";
import { homedir } from "os";
import { existsSync, readFileSync } from "fs";

export const ORIGINAL_CHECKLIST = `# Logic Guardian — Validation Checklist (5 passes)

Plausible-looking code is where drift hides, so these passes check behavior rather than
appearance. Use them for intricate logic; for small, obvious changes, running the tests
and \`validate_file\` is enough.

## Pass 1: Logic Trace
Trace the code with concrete values:
- Happy path   → real values, noting each variable's state
- Empty/zero   → null, 0, "", []
- Boundary     → first element, last element, max int, single char
- Error case   → network down, file missing, permission denied

If a trace produces output you didn't expect, fix that before moving on — later passes
assume the traces hold.

## Pass 2: Contract Verification
- [ ] Preconditions: what must be true before this runs? Is it checked?
- [ ] Postconditions: what must be true after? Can you show it?
- [ ] Invariants: what must always hold? Does the code maintain it?
- [ ] Return type: does every code path return the expected type?
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

### Logic Inversions (the most common drift pattern)
- [ ] if/else — does the condition test what you intend?
- [ ] Early returns — does the guard return the right value?
- [ ] filter/find/some — are you keeping the right elements?
- [ ] Error handling — catching and re-throwing correctly?

### State & Mutation
- [ ] Mutating a shared object where a copy was needed?
- [ ] Async state read after it might have changed?

### Copy-Paste Drift
- [ ] Every variable name updated in copied blocks?
- [ ] Conditions changed too, not just variable names?

## Pass 4: Integration Sanity
- [ ] Breaks existing callers?
- [ ] Imports/exports correct?
- [ ] If async, are all callers awaiting it?
- [ ] If a type changed, are all usages updated?

## Pass 5: Explain It
In one sentence, what does this code do? If the sentence is hard to write, or doesn't
match the code, look again.

## Signs you're pattern-matching instead of reasoning
- "This is similar to…" → trace this case's logic on its own.
- "This should work because the other one does" → verify it independently.
- "I'll copy it and change the names" → check every difference, operators included.
- "The error handling is probably fine" → trace the error path.
- "This is standard boilerplate" → confirm it fits this context.
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
