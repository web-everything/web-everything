---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/4354-survive-a-claude-account-switch-mid-session-without-losing-w.md", "we:backlog/4355-build-queue-ordering-read-the-real-cleared-queue-and-let-pri.md"]
dateOpened: "2026-10-09"
tags: []
---

# Prevention — Add named planned tests launchPersistsWorkerWithoutCallerBookkeeping and resumeIncludesLaneWithou… (from web-everything/web-everything#4641 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:backlog/4354-survive-a-claude-account-switch-mid-session-without-losing-w.md:59` — Add named planned tests `launchPersistsWorkerWithoutCallerBookkeeping` and `resumeIncludesLaneWithoutLaunchRecord`; require behavioral rulings to reference concrete test assertions before implementation preparation completes.
2. `we:backlog/4355-build-queue-ordering-read-the-real-cleared-queue-and-let-pri.md:25` — Specify planned tests `classPrecedesScore` and `agingNeverPromotesIntoP0`, asserting conflicting class/score ordering and promotion behavior immediately before and at eight hours, including P1 remaining outside P0; require concrete test mappings during preparation.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4641@0a62c90e108736d48864b11ed89a998a6ef6506e

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
