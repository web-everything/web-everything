---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/daemon-rebuild/plan.mjs", "we:scripts/lib/daemon-rebuild/prepare.mjs", "we:scripts/lib/__tests__/daemon-rebuild-stack-tops.test.mjs", "we:scripts/lib/daemon-rebuild/__tests__/plan.test.mjs", "we:scripts/lib/daemon-rebuild/__tests__/prepare.test.mjs"]
dateOpened: "2026-10-25"
tags: []
---

# Prevention — A mutation or branch-coverage check on new conditionals in we:scripts/lib/daemon-rebuild/plan.mjs… (from web-everything/web-everything#5937 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/daemon-rebuild/plan.mjs:603` — A mutation or branch-coverage check on new conditionals in we:scripts/lib/daemon-rebuild/plan.mjs, or a review-lens rule that each new guard condition names a test that flips when it is inverted.
2. `we:scripts/lib/daemon-rebuild/plan.mjs:428` — Require each guarantee sentence in we:docs/agent/testing.md to name its test, or add a check:standards rule linking guarantee prose to a test id.
3. `we:scripts/lib/daemon-rebuild/prepare.mjs:414` — Extract one shared `parseRebuildMergeLine` helper, or `isRebuildMergeParents`, used by all three readers. Add a check:standards rule that bans open-coded `ps.length` checks on rebuild merge parents.
4. `we:scripts/lib/daemon-rebuild/plan.mjs:424` — Add a case that mutates only this clause (an auto-rebase repair containing a pinned, conflicting base) to the stack-tops suite. Run the project's mutation probe on guard clauses added to `planRebuild`.
5. `we:scripts/lib/__tests__/daemon-rebuild-stack-tops.test.mjs` — Add conflicting-base cases and a deterministic mutation check that removes the HEAD-evidence guard and requires these named cases to fail.
6. `we:scripts/lib/daemon-rebuild/plan.mjs:603` — Add a named conflicting-base/intervening-newcomer regression and a deterministic mutation check requiring it to fail when the blocked condition is bypassed.
7. `we:scripts/lib/__tests__/daemon-rebuild-stack-tops.test.mjs` — Add the conflicting-base parameterized regression and a targeted mutation gate that removes the HEAD containment check and requires this named test to fail.
8. `we:scripts/lib/daemon-rebuild/plan.mjs:604` — Add the conflicting-base priority regression and a targeted mutation gate that disables `blocked` and requires the named regression to fail.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5937@4c0c3ff69c08ca5288139e275d57976019c292ee

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
