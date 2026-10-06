---
bornAs: xp1cr0h
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/queue-prune.mjs", "we:scripts/conveyor/queue.mjs", "we:scripts/conveyor/__tests__/queue-prune.test.mjs", "we:scripts/conveyor/__tests__/queue.test.mjs"]
dateOpened: "2026-10-06"
tags: []
---

# Prevention — Delete the receipt after a successful apply, or reject it when at is older than a few minutes. Ad… (from web-everything/web-everything#4077 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/queue-prune.mjs:210` — Delete the receipt after a successful apply, or reject it when `at` is older than a few minutes. Add a CLI test that applies twice, re-adds the ids, and expects the second apply to be refused.
2. `we:scripts/conveyor/queue.mjs` — A deterministic `import/no-unresolved` lint rule to verify module resolution at build time.
3. `we:scripts/conveyor/queue.mjs` — Strict coverage thresholds or TDD enforcement for documented failure paths.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4077@379c6cc19ef5babe9f13c10dd0a65e541ebf8eb1

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
