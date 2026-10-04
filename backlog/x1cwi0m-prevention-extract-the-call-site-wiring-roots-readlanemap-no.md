---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/wip-publish.ts", "we:scripts/__tests__/wip-publish.test.mjs"]
dateOpened: "2026-10-04"
tags: []
---

# Prevention — Extract the call-site wiring (roots → readLaneMap/noteFork/watchDirs args) into a small testable function… (from plateauapp/plateau-app#204 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this PR's latest advisory review named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/wip-publish.ts:126` — Extract the call-site wiring (roots → readLaneMap/noteFork/watchDirs args) into a small testable function. Alternatively add a lint or standards check that `readLaneMap`/`noteFork` in `scripts/` never receive the code-root variable.
2. `we:scripts/wip-publish.ts:102` — Add a smoke check, in the post-deploy build or a script test, that runs `readWip` and `resolveLanePath` against a real code clone distinct from the state root and asserts a non-empty lane path and a watch on the directory the queue store writes.

Idempotency key (do not edit): approval-prevention-key:plateauapp/plateau-app#204@6426000c39cee2cc15025ad61f53c58c6b6e49e3

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
