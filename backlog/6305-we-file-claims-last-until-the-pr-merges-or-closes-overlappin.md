---
bornAs: xs4eugq
kind: story
size: 3
# Intended parent: 6899; set parent when that epic exists in the backlog.
status: open
dateOpened: "2026-10-18"
tags: []
---

# we: File claims last until the PR merges or closes; overlapping work stacks on the holding PR

Operator 2026-10-18: a PR's file claim is released at PR open today, so other cards freely change the same files and become rival PRs (live: #5529/#5604/#5605/#5606/#5599 all edit one backlog card; #5482/#5492/#5462/#5520 all edit we:review-set-label.mjs). The fix daemon then serialises them (85 waits/day, median 48 min). Fix: the claim persists until merge or close; new work on a held file uses the stacked-PR flow (epic 6899, slice 6898 --stack-on) instead of a rival PR. Fixer serialisation stays as is (operator: loosening it is a recipe for conflict). Acceptance: [A1] Executable with named tests: the claim survives open-pr; it is released on merge or close; a second card on a held file is offered stack-on rather than a rival PR. Scope: the free-scope registry and its release points (grep free-scope and release in we:scripts/), plus the open-pr/worker release step.

## Acceptance

- [A1] **Executable** — named tests, all must fail before this lands and pass after:
  - `claim survives open-pr` — a file claim held by an open PR is still held after open-pr runs.
  - `claim is released on merge` — the claim clears when the PR merges.
  - `claim is released on close` — the claim clears when the PR is closed unmerged.
  - `second card on a held file is offered stack-on` — the second card gets the stack-on offer (epic 6899, slice 6898 --stack-on) and no rival PR is opened.

Acceptance also requires all planned edge-case tests E1–E5 below.

Run: the `verify` operation on the lane checkout (we:scripts/operations/run.mjs verify --checkout=<lane path>).

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] Does not change fixer serialisation. Does not loosen any refusal in the fix daemon.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: no new text input; claim records are written by our own tooling.
2. **Truncated reads** — a truncated read must still refuse the claim (fail closed, see 4). Planned test E1 below.
3. **Shared state files** — the free-scope registry is shared across lanes; writes keep the existing lock. Planned test E2 below.
4. **Fail closed** — an unreadable or missing registry entry counts as held, not free. Planned test E1 below.
5. **Identity scoping** — a claim is released only by the PR or card that holds it, never by another card. Planned test E3 below.
6. **State over time** — a claim whose PR is already merged or closed is released on the next registry check. Planned test E4 below.
7. **Who wrote it** — the claim records the PR number and card id that took it. Planned test E5 below.

### Planned edge-case tests

These cases must be added during implementation; they are not existing passing tests.

| ID | Repository-qualified planned test file | Named case | Observable assertion |
| --- | --- | --- | --- |
| E1 | `we:scripts/operations/__tests__/free-scope-io.test.mjs` | `registry failures remain held` | For separate truncated-content, unreadable-registry, and missing-entry fixtures, acquisition is refused and no replacement claim is written. |
| E2 | `we:scripts/operations/__tests__/free-scope-io.test.mjs` | `registry writes retain the lock` | Instrument the existing lock and registry writer: every claim mutation occurs after lock acquisition and before lock release; a competing writer cannot mutate while that lock is held. |
| E3 | `we:scripts/operations/__tests__/free-scope-io.test.mjs` | `only the claim owner can release` | A release attempted by another card leaves the owner's claim unchanged and overlapping acquisition refused; the matching owner can release it. |
| E4 | `we:scripts/operations/__tests__/free-scope-io.test.mjs` | `terminal PR claim clears on the next registry check` | For separate merged-PR and closed-PR fixtures, the first registry check removes the terminal PR's claim and permits acquisition of its files without a later cleanup pass; an open PR retains its claim. |
| E5 | `we:scripts/operations/__tests__/free-scope-io.test.mjs` | `claim records PR number and card id` | After creating and persisting a claim, re-read the registry and assert the exact holding PR number and card id both survive. |

Prevention follow-up: [#5590 — deterministic card-validation gate](5590-prevention-add-a-check-standards-rule-for-backlog-cards-ever.md) tracks requiring every behavioral edge-case requirement to reference a repository-qualified planned test file, named case, and observable assertion (also raised by PR #5611).
