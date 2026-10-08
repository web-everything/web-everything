---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/daemon-rebuild/prepare.mjs", "we:scripts/lib/lane-repair.mjs", "we:scripts/lib/daemon-rebuild/__tests__/prepare.test.mjs", "we:scripts/lib/__tests__/lane-repair.test.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# Prevention — Add a prepareRebuild-level test with a HEAD-object-missing clone asserting it re-clones. Alternat… (from web-everything/web-everything#4402 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this PR's latest advisory review named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/daemon-rebuild/prepare.mjs:201` — Add a prepareRebuild-level test with a HEAD-object-missing clone asserting it re-clones. Alternatively, call the repair as the first step under the lock, before the safety gates.
2. `we:scripts/lib/lane-repair.mjs` — Add a deterministic regression in we:scripts/lib/__tests__/clone-repair.test.mjs that checks healthy → damaged with remote pruning → throttled call, asserting the final call retains ok:false and nonempty problems; invalidate the healthy stamp when damage is detected. This guard needs filing.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4402@212eed02a1fd84ba12e953ee521a1ae6e23a36c4

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
