---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/provider-capacity.mjs", "we:scripts/lib/capacity-planner.mjs", "we:scripts/lib/dispatch-routing-policy-io.mjs", "we:scripts/lib/__tests__/provider-capacity.test.mjs", "we:scripts/lib/__tests__/capacity-planner.test.mjs", "we:scripts/lib/__tests__/dispatch-routing-policy-io.test.mjs"]
dateOpened: "2026-11-20"
tags: []
---

# Prevention — Write the lookup as minimumTiers[routeKey] ?? minimumTiers[kind] ?? 0. Add a parametrized test th… (from web-everything/web-everything#7169 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/provider-capacity.mjs:103` — Write the lookup as `minimumTiers[routeKey] ?? minimumTiers[kind] ?? 0`. Add a parametrized test that runs every tier-minimum case with and without a taskType.
2. `we:scripts/lib/capacity-planner.mjs:88` — Add boundary tests at 94, 95 and 96% with queued demand to `we:capacity-planner.test.mjs`. For future cards, list each numeric threshold in the Test plan with its boundary cases.
3. `we:scripts/lib/dispatch-routing-policy-io.mjs:95` — Parameterize the guard test over every routing.builder value (claude, codex, auto) and over quota at, below and above the threshold, for each scoped pinned key. A deterministic matrix test in we:routing-settings.test.mjs would catch this class.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7169@04016c9f37f10a31e416593a5f0c65108e8bb263

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
