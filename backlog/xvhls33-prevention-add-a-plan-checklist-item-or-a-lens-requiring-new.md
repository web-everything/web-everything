---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/5745-drain-no-merge-while-a-fix-or-ci-heal-claim-is-live.md"]
dateOpened: "2026-10-14"
tags: []
---

# Prevention — Add a plan-checklist item, or a lens, requiring new fail-closed lock-store reads to cite the exis… (from web-everything/web-everything#5314 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:backlog/5745-drain-no-merge-while-a-fix-or-ci-heal-claim-is-live.md:40` — Add a plan-checklist item, or a lens, requiring new fail-closed lock-store reads to cite the existing grace/TTL for entry-less dirs. Also add a test that an entry-less dir older than the grace does not block indefinitely.
2. `we:backlog/5745-drain-no-merge-while-a-fix-or-ci-heal-claim-is-live.md:46` — Add a unit case for attachLiveFixClaim with a null claimKey that documents the intended behaviour, either open or closed.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5314@362d97a2486f66ce0f9068c812898d56124cbb31

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
