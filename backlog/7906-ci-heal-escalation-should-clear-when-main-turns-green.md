---
bornAs: xrommtm
kind: story
size: 2
status: open
scope: ["we:ci.yml"]
dateOpened: "2026-11-02"
tags: []
---

# ci-heal escalation should clear when main turns green

MED priority hint. ## (held 2026-10-27 12:15 ET) ci-heal escalation should clear when main turns green #6007 and #5969 were escalated because "main's own CI fails the same tests" (main was red until about 10:33 ET). Main is green now, but ci-heal "will not re-dispatch until a new push", so both stay stuck by hand. Fix: store the main sha the escalation blamed. When main CI is green on a later sha, drop the escalation and re-run the PR's failed jobs automatically. Prove it on #6007/#5969. - #5954 is another "only a person may enqueue" false positive (three-dot file list shows we:ci.yml and scripts from a stale base; the PR is card-only). Same root as #5993, the classify-on-net-diff card.

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
