---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/readiness/forge-exec-run.mjs", "we:scripts/readiness/__tests__/forge-setup-heredoc-imports.test.mjs", "we:scripts/readiness/__tests__/forge-exec-run.test.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Prevention — Add a test that fakes /usr/sbin/nft through PATH or a test harness and covers both the covered-ui… (from web-everything/web-everything#7326 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/readiness/forge-exec-run.mjs:1806` — Add a test that fakes `/usr/sbin/nft` through PATH or a test harness and covers both the covered-uid and mixed-uid cases. Also add a check:standards rule that each new CLI subcommand has a success-path test.
2. `we:scripts/readiness/forge-exec-run.mjs:1811` — Add a tier-1 bundled-CLI test named 'egress-self-check rejects an uncovered later UID', with controlled egress rules covering the first UID only and an assertion of nonzero exit status; also assert success when all supplied UIDs are covered.
3. `we:scripts/readiness/__tests__/forge-setup-heredoc-imports.test.mjs:52` — Add a deterministic bundled-CLI test with mixed UID coverage and gate it with a mutation that truncates iteration to the first UID.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7326@b685a0cd0ef08f50f84102cc76f7526db34a657a

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
