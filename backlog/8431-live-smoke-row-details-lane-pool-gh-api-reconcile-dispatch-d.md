---
bornAs: x3erq2w
kind: story
size: 3
status: active
scaffoldedBy: "fix-5460"
dateScaffolded: "2026-10-17"
scope: ["we:scripts/lib/daemon-live-smoke.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# Live-smoke row details (lane-pool, gh api, reconcile/dispatch dry-run) carry a child's first stderr line — move them to the allow-listed summary + 0600 file design from PR 5460

PR 5460's operator send-back made boot and dispatch smoke details carry only an allow-listed summary, with the raw stderr tail in a 0600 file under the daemon state dir. The other rows in we:scripts/lib/daemon-live-smoke.mjs (lane-pool list/acquire, gh api, gh pr list, reconcile-pass dry-run, dispatch dry-run, the per-check child wrapper) still embed the first line of child stderr in their detail, which reaches held state and self-sync alerts. Their transient-fault classifier (TRANSIENT_FAILURE_PATTERNS) matches that text, so the change must classify in-process before summarizing.

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
