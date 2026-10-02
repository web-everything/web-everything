---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:src/wip/wip-read.ts", "we:src/wip/progress-policy.ts", "we:src/wip/progress-read.ts", "we:src/wip/wip-view.ts", "we:src/wip/__tests__/wip-read.test.mjs", "we:src/wip/__tests__/progress-policy.test.mjs", "we:src/wip/__tests__/progress-read.test.mjs", "we:src/wip/__tests__/wip-view.test.mjs"]
dateOpened: "2026-10-02"
tags: []
---

# Prevention — Only cache the reader when resolveHealthPaths resolved every path. Add a readWip test where the first resol… (from chalbert/plateau-app#197 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:src/wip/wip-read.ts:491` — Only cache the reader when resolveHealthPaths resolved every path. Add a readWip test where the first resolution fails and the second succeeds.
2. `we:src/wip/progress-policy.ts:103` — Use `[ \t]*` instead of `\s*` in line-anchored patterns. Add a safe-regex or adversarial-input timing check to check:standards for regexes over external files.
3. `we:src/wip/progress-read.ts:95` — Add a contract-example-driven test that feeds each pinned health example's affectedJobRefs through the running-job cross-check. Normalise refs in one shared helper.
4. `we:src/wip/wip-view.ts:585` — Add a deterministic rendering test with snapshot.observedAt well before receivedAt and the current clock, asserting that expired budget windows and overdue overnight checks immediately render stale.

Idempotency key (do not edit): approval-prevention-key:chalbert/plateau-app#197@e8bc39b8f7c1f698bf58d93d123b2fd2fce6d6b8

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
