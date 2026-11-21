---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/daemon-rebuild/audited-tip.mjs", "we:scripts/lib/daemon-rebuild/adopt.mjs", "we:scripts/lib/daemon-rebuild/prepare.mjs", "we:scripts/lib/daemon-rebuild/__tests__/audited-tip.test.mjs", "we:scripts/lib/daemon-rebuild/__tests__/adopt.test.mjs", "we:scripts/lib/daemon-rebuild/__tests__/prepare.test.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Prevention — Add a check:standards rule or test that every exported evidence helper reading merge-tree runs th… (from web-everything/web-everything#7303 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/daemon-rebuild/audited-tip.mjs:59` — Add a check:standards rule or test that every exported evidence helper reading merge-tree runs the driver-refusal gate. Track the re-land card as a hard dependency of the revert.
2. `we:scripts/lib/daemon-rebuild/adopt.mjs:147` — Land the re-land with a named test for audited-only refusal of an omitted registered overlay, and file it as a card with this PR as the blocker.
3. `we:scripts/lib/daemon-rebuild/prepare.mjs:1` — Have the revert PR template require a committed or CI-checked command that diffs against the pre-merge tree, or require the re-land card to carry the test for each removed guarantee.
4. `(no file cited)` — Capture a deterministic revert-restores-premerge-tree check comparing the reverted paths with the pre-merge tree, explicitly allowing the documented unrelated timing entries.
5. `(no file cited)` — Add a deterministic revert-integrity check comparing touched paths against the specified pre-merge tree with an explicit exception allowlist.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7303@30f507b482cb8d131090c55958157c25d0e67108

## Acceptance

- [A1] **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] TODO: what this item deliberately does not do — or `n/a: <why>` when nothing is excluded.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
