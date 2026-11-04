---
kind: story
size: 3
status: active
scaffoldedBy: "fix-6345"
dateScaffolded: "2026-11-03"
scope: ["we:scripts/readiness/forge-egress.sh", "we:scripts/readiness/forge-setup.sh"]
dateOpened: "2026-11-03"
tags: []
---

# Contain Forge cold installs beyond destination IP (registry shares CDN addresses)

Follow-up from PR 6345 review (security residual). The slot egress allowlist matches resolved registry.npmjs.org IPs and tcp/443 only. Those IPs are shared CDN addresses, so a slot process can reach any host served from them (curl --resolve with its own SNI). Choose real containment: run cold installs as a non-slot installer user, or route them through an SNI-aware proxy, then drop the slot users' registry allowance. Test: a slot-user connection to a non-registry host on a registry IP is refused. Interim: residual documented in forge-egress.sh header.

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
