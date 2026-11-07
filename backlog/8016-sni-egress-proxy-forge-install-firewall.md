---
bornAs: xw6rjgy
kind: epic
status: active
scaffoldedBy: "r665-card"
dateScaffolded: "2026-11-06"
dateOpened: "2026-11-06"
tags: []
---

# SNI-filtering egress proxy for Forge install firewall (closes CDN shared-IP residual from #6345)

PR #6345 (red-team result a428e54cc667b9e9, head e94bffb) confirmed that the Forge install firewall allows egress by IP and port, so CDN-shared hosts stay reachable. The residual is documented in the script header. The operator accepted it for now (R665: "Ok, acceptable risk for now"). The real fix is a name-checking (SNI) egress proxy, built as its own epic under Forge security as a product. Code paths: we:scripts/readiness/forge-egress.sh, we:scripts/readiness/forge-setup.sh, we:backlog/8007-contain-forge-cold-installs-beyond-destination-ip-registry-s.md.

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
