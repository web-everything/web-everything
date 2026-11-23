---
kind: story
size: 3
status: open
scope: ["we:docs/agent/testing.md", "we:scripts/lib/drain-mq-failure-recovery-io.mjs", "we:scripts/lib/drain-queue-safety.mjs", "we:scripts/lib/__tests__/drain-mq-failure-recovery-io.test.mjs", "we:scripts/lib/__tests__/drain-queue-safety.test.mjs"]
dateOpened: "2026-11-23"
tags: []
---

# Prevention — Add a pre-land checklist gate that blocks marking a card 'fix' done while its acceptance manifest… (from web-everything/web-everything#7343 review)

Filed mechanically by the unattended review loop (#2749) — every finding below reduced web-everything/web-everything#7343's review (reviewed head `58c48ae61254127bc1fbcc09b5f8eb5a9b2fa025`) to prevention-outstanding by naming a guard neither captured nor filed:

1. `we:docs/agent/testing.md:6395` — Add a pre-land checklist gate that blocks marking a card 'fix' done while its acceptance manifest has BLOCKED/UNVERIFIED rows. File a card to record the real update-branch commit committer and verification for one live refresh.
2. `we:scripts/lib/drain-mq-failure-recovery-io.mjs:93` — Add a standards rule or test asserting every exported route*OnHold entry point has at least one non-test importer. File a card to wire routeMqFailureOnHold into enqueueWithSameHeadGuard, with an integration test.
3. `we:scripts/lib/drain-queue-safety.mjs:420` — Add a merge-ai-prs-level dry-run test, or have the guard accept a read-only store separately from the refresh write options.
4. `we:scripts/lib/drain-queue-safety.mjs:409` — Add a same-head-retry case where PUT throws and assert hold, a single claim, and the refresh-first decision. A branch-coverage threshold on we:scripts/lib/drain-queue-safety.mjs would also catch this.
5. `we:docs/agent/testing.md:6385` — Make the acceptance manifest machine-checked: a standards rule that fails a PR whose Acceptance lists a live-proof row with no receipt, or require a filed follow-up card id on each BLOCKED row.
6. `we:docs/agent/testing.md:6397` — Add a caller-level test in merge-ai-prs tests asserting that a held guard with recoveryAction 'fixer' invokes routeMqFailureOnHold. Back it with a lint that every producer of a `recoveryAction` value has a named consumer.
7. `we:scripts/lib/drain-queue-safety.mjs:309` — Add the refused-PUT case, asserting zero further writes on a second run and that store.has(key) is true. Review lens: every prose 'including X' clause needs a named test for X.

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
