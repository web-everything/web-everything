---
kind: story
size: 3
status: open
scope: ["we:scripts/lib/drain-mq-failure-recovery-io.mjs", "we:docs/agent/testing.md", "we:scripts/lib/__tests__/drain-mq-failure-recovery-io.test.mjs"]
dateOpened: "2026-11-23"
tags: []
---

# Prevention — Add a caller-wiring test or check:standards rule: every exported guard outcome field (recoveryAct… (from web-everything/web-everything#7343 review)

Filed mechanically by the unattended review loop (#2749) — every finding below reduced web-everything/web-everything#7343's review (reviewed head `58c48ae61254127bc1fbcc09b5f8eb5a9b2fa025`) to prevention-outstanding by naming a guard neither captured nor filed:

1. `we:scripts/lib/drain-mq-failure-recovery-io.mjs:93` — Add a caller-wiring test or check:standards rule: every exported guard outcome field (recoveryAction) must have a non-test consumer in we:merge-ai-prs.mjs. Alternatively require an integration test that drives enqueueWithSameHeadGuard to a published route.
2. `we:docs/agent/testing.md:6332` — Make the landing checklist require a recorded receipt for each live-proof row before the card closes. Add a gate that fails when a PR's acceptance rows are still marked BLOCKED or Await at merge.
3. `we:scripts/lib/drain-mq-failure-recovery-io.mjs:100` — A repo check that every exported recovery entry point has a non-test caller, or an integration test through merge-ai-prs that asserts routing.
4. `we:docs/agent/testing.md:6366` — Require a recorded receipt, or an explicit waiver card, as a merge precondition for acceptance rows marked BLOCKED.

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
