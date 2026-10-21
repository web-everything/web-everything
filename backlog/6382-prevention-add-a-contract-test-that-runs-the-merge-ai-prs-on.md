---
bornAs: xdr3al3
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/merge-ai-prs.mjs", "we:scripts/lib/enqueue-on-event.mjs", "we:scripts/__tests__/merge-ai-prs.test.mjs", "we:scripts/lib/__tests__/enqueue-on-event.test.mjs"]
dateOpened: "2026-10-14"
tags: []
---

# Prevention — Add a contract test that runs the merge-ai-prs --only --json path against a stubbed strategy and… (from web-everything/web-everything#5256 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/merge-ai-prs.mjs:6578` — Add a contract test that runs the merge-ai-prs `--only --json` path against a stubbed strategy and asserts the `enqueueOutcomes` shape. Re-check it when #5217 lands.
2. `we:scripts/lib/enqueue-on-event.mjs:560` — Reuse the honourSetting stripping helper (remove the 'catch-up' cause and keep entries with other causes) instead of deleting outright, and add a mixed-entry test.
3. `we:scripts/lib/enqueue-on-event.mjs:556` — Reset or delete the counter on any non-miss outcome. Prune counters against the catch-up candidate list on each snapshot.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5256@f52faad53c7a71de2a43fad3c7efd125adfe1ba5

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
