---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/soak/run-shard.mjs", "we:scripts/__tests__/heavy-run-admitted-callers.test.mjs", "we:scripts/conveyor/soak/__tests__/run-shard.test.mjs"]
dateOpened: "2026-10-04"
tags: []
---

# Prevention — Lint rule in check:standards flagging npx pkg in scripts/ without --no-install. Alternatively, re… (from web-everything/web-everything#3930 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/soak/run-shard.mjs:32` — Lint rule in check:standards flagging `npx <pkg>` in scripts/ without `--no-install`. Alternatively, resolve node_modules/.bin/vitest explicitly.
2. `we:scripts/__tests__/heavy-run-admitted-callers.test.mjs:34` — Add deterministic subprocess-contract tests asserting the executed command and arguments, held-slot behavior, and stdout preservation, and run them in the existing test gate.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#3930@38adde3069c44d684e30ac18304dd00c71c6611a

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
