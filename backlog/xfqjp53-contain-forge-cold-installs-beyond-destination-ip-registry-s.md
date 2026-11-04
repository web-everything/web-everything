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

- [A1] **Executable** — `npx vitest run we:scripts/readiness/__tests__/forge-egress.test.mjs` passes with a test showing a slot-user connection to a non-registry host served from a registry IP is refused; it fails while the allowlist is destination-IP only.
- [A2] **Executable** — a test shows the slot user can reach only loopback services the design names, since `oifname "lo" accept` currently lets slot users reach every local listening service (an undocumented trust boundary).

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] Does not widen the allowlist and does not change how the registry IP set is resolved or aged (the grace window stays as is).

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — a slot process picks its own SNI/Host for a shared CDN IP; the containment must not trust anything the slot sends (hence installer-user or SNI-aware proxy, not a destination match).
2. **Truncated reads** — n/a: no output is parsed by the containment.
3. **Shared state files** — the installer user's npm cache must not be writable by slot users, or a slot could poison it.
4. **Fail closed** — if the installer user or proxy is unavailable, the cold install falls back to local; it never falls back to slot egress.
5. **Identity scoping** — registry access belongs to the installer identity only; slot users lose their registry allowance.
6. **State over time** — CDN IPs rotate; the containment must not depend on a stale IP snapshot.
7. **Who wrote it** — installer inputs (lockfile, registry config) come from the repo under build; treat them as untrusted and run the installer without slot credentials. Loopback reach (`oifname "lo" accept`) is documented here as part of the trust boundary.
