---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/__tests__/remote-verify.test.mjs", "we:backlog/7059-bind-remote-verification-evidence-to-a-protected-gate-defini.md", "we:.github/workflows/remote-verify.yml", "we:scripts/verify-lane.mjs", "we:backlog/7060-prevent-cross-repository-checkout-authentication-drift-in-re.md", "we:scripts/__tests__/verify-lane.test.mjs"]
dateOpened: "2026-10-25"
tags: []
---

# Prevention — Add a table-driven CLI usage case that asserts exit 3 and no marker for each invalid flag form. A… (from web-everything/web-everything#5878 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/__tests__/remote-verify.test.mjs:1` — Add a table-driven CLI usage case that asserts exit 3 and no marker for each invalid flag form. A coverage threshold on the `MODE === 'remote'` block in we:scripts/verify-lane.mjs would be a deterministic gate.
2. `we:backlog/7059-bind-remote-verification-evidence-to-a-protected-gate-defini.md:1` — Split acceptance items by lane when a card spans producer and consumer. Add a lane-verify test, 'marker with remote provenance is re-verified at gate time', in the follow-up that owns the consumer.
3. `we:.github/workflows/remote-verify.yml:1` — Require a recorded run URL and SHA in the PR before merge, tracked by card 7060 A3. Longer term, add a land-time check that a workflow-adding PR links one successful run.
4. `we:.github/workflows/remote-verify.yml:47` — Add a check:standards rule requiring persist-credentials: false on every actions/checkout step in workflows that run npm ci, unless the step is explicitly allow-listed. The planned 7060 external-checkout rule could be extended to cover this.
5. `we:scripts/verify-lane.mjs:255` — Use a branch-specific endpoint (`repos/<slug>/branches/main`, reading `.commit`) and have the CLI test assert the branch-qualified path. This could be a lint over `commits/<branchname>` API paths in scripts.
6. `we:backlog/7059-bind-remote-verification-evidence-to-a-protected-gate-defini.md:23` — Add a named consumer regression test covering missing and mismatched provenance, and require it in the unit-test gate.
7. `we:backlog/7060-prevent-cross-repository-checkout-authentication-drift-in-re.md:16` — Gate the standards rule with table-driven tests for unknown repositories and diagnostics containing the affected workflow and step.
8. `we:backlog/7059-bind-remote-verification-evidence-to-a-protected-gate-defini.md:23` — Add the named consumer regression test and require an explicit acceptance-to-test mapping for both production and consumption.
9. `we:backlog/7060-prevent-cross-repository-checkout-authentication-drift-in-re.md:17` — Include an unknown-repository fixture in the deterministic standards-rule test suite.
10. `we:backlog/7060-prevent-cross-repository-checkout-authentication-drift-in-re.md:21` — Add a repeatable live acceptance check that records run identity, checkout/gate success, marker import, timings, and cache restoration.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5878@1a508285def78b676d853cc1c64e7c28f7ca7f64

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
