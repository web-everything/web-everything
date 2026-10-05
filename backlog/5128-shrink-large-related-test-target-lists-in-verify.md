---
bornAs: x25udmp
kind: story
size: 3
status: open
scope: ["we:scripts/verify-lane.mjs"]
dateOpened: "2026-10-05"
tags: []
---

# Shrink large related-test target lists in verify

Fixer and ci-heal verifies ran vitest related on ~70 target files although the diffs were 5-16 files. Cause: literal-reference discovery plus the related graph pulling in every test touching widely shared core modules (guard-bash, jury-core). Consider caching the related-test set by file content, or sharding core-module verifies into one heavy slot each.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
