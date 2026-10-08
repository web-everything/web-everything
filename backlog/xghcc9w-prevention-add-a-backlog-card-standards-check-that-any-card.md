---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/xdbmlt1-pr-comments-rendered-from-ledger-rows-per-family-fallback-an.md", "we:backlog/x2ddqp8-hosted-ledger-store-adapter-in-the-plateau-cloud-a-table-in.md", "we:backlog/x34aj42-drain-ledger-shadow-the-drain-runs-the-pure-ledger-gate-besi.md", "we:backlog/xhftkfc-mirror-level-setting-how-much-derived-pr-state-the-github-ad.md"]
dateOpened: "2026-10-08"
tags: []
---

# Prevention — Add a backlog-card standards check that any card whose acceptance imports external or untrusted t… (from web-everything/web-everything#4493 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:backlog/xdbmlt1-pr-comments-rendered-from-ledger-rows-per-family-fallback-an.md:22` — Add a backlog-card standards check that any card whose acceptance imports external or untrusted text into trusted state must have an acceptance item naming author or provenance verification. Failing that, add a review-lens note.
2. `we:backlog/x2ddqp8-hosted-ledger-store-adapter-in-the-plateau-cloud-a-table-in.md:19` — Add a card template or standards-check rule requiring a threat-model or authn/tenant-isolation acceptance item on any card that introduces a network-exposed or hosted component.
3. `we:backlog/x34aj42-drain-ledger-shadow-the-drain-runs-the-pure-ledger-gate-besi.md:33` — Add a planned test named shadowUnreadableLedgerPreservesLabelDecision in we:scripts/lib/__tests__/pr-merge-gate-ledger.test.mjs, asserting both an unchanged merge decision and an unreadable journal entry. Mutation verification was impossible with read-only access.
4. `we:backlog/xhftkfc-mirror-level-setting-how-much-derived-pr-state-the-github-ad.md:21` — Plan manualLabelChangesCannotClearLedgerHold in we:scripts/conveyor/__tests__/pr-label-mirror.test.mjs, asserting that removing a hold or adding a clearing label preserves the derived hold and blocked merge decision, while adding a hold tightens state.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4493@7b602eafaf59fb039c5ce1d532af8952a1515421

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
