# Vendored third-party code

## `egm/` — Elephant-Goldfish Model

- **Source:** https://github.com/google/elephant-goldfish-model
- **Commit:** 403d8881d62022490637d740657b33f01e321ea8 (2026-10-30)
- **Path copied:** `distributions/claude/` (the upstream Claude runtime package)
- **License:** Apache-2.0 (`egm/LICENSE`). Copyright 2026 Google LLC. Upstream
  states that EGM is not an officially supported Google product, and Lucid is
  neither affiliated with nor endorsed by Google.

These files are unmodified. `lucid setup egm` (`src/setup/egm.ts`) applies the
changes needed to run outside the plugin system when it writes the installed
copy, and marks every file it changed.

To update: replace `egm/` with `distributions/claude/` from a newer upstream
commit, update the commit above, then run `npm test`. Do not edit files in `egm/`.
