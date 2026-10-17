---
bornAs: x301ve5
kind: story
size: 3
status: active
scaffoldedBy: "fix-5393"
dateScaffolded: "2026-10-15"
scope: ["we:scripts/review-set-label.mjs", "we:scripts/operations/review-pr-io.mjs"]
dateOpened: "2026-10-15"
tags: []
---

# Unattended accept label write must pin the reviewed head (expect-head) so a push after the gate is not stamped reviewed

PR #5393 self-review: the unattended accept gate compares the live head to the reviewed head once, then the LABEL effect runs review-set-label --to=accepted without --expect-head, which reads the head at write time and stamps it as reviewed. A push landing between the gate read and the label write gets an unreviewed head marked reviewed. Pass the reviewed head and finding fingerprint from the LABEL sink (pinned-accept mode) so the write refuses a moved head.

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
