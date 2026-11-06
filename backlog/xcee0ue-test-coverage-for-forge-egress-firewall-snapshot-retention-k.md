---
kind: story
size: 2
status: open
scope: ["we:scripts/readiness/forge-egress.sh", "we:scripts/readiness/forge-setup.sh", "we:scripts/readiness/__tests__/forge-egress.test.mjs"]
dateOpened: "2026-11-06"
tags: []
---

# Test coverage for Forge egress firewall: snapshot retention KEEP, single registry snapshot per apply, cold npm installs under firewall

PR 6345 review left three untested paths in we:scripts/readiness/forge-egress.sh: snapshot retention with a non-default KEEP value, one registry snapshot per apply, and cold npm installs running under the firewall. Add tests for each in we:scripts/readiness/__tests__/forge-egress.test.mjs.

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
