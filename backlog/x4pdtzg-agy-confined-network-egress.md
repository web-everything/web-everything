---
kind: investigation
size: 3
status: active
scaffoldedBy: "agy-7134-r2"
dateScaffolded: "2026-11-20"
scope: ["we:scripts/lib/agy-sandbox.mjs", "we:scripts/lib/__tests__/agy-sandbox.test.mjs", "we:scripts/lib/__tests__/agy-confined-launcher.test.mjs"]
dateOpened: "2026-11-20"
tags: []
related: ["7134"]
---

# Narrow outbound model-API access for confined agy build (loopback allowlist proxy design)

Design and prove narrowly scoped model-API egress before confined agy can launch in production. The current profile denies network access and the production guard remains unavailable. A per-run proxy must restrict destinations, redirects and request budgets without giving the worker general network access. This card records required proofs; it does not authorize enabling the provider.

## Acceptance

- [A1] **Executable** — Planned `REAL denies direct and non-model egress` in `we:scripts/lib/__tests__/agy-sandbox.test.mjs`: direct loopback, arbitrary remote destinations, local/private addresses and non-model proxy destinations fail, while an explicitly authorized dummy model request succeeds. Run `npm run test:unit -- <test-file>` using that file's repository-relative path after the `we:` prefix on an unnested Darwin host; a skipped probe is not proof.
- [A2] Planned `refuses unsafe model proxy requests` in `we:scripts/lib/__tests__/agy-confined-launcher.test.mjs`: reject redirects outside the destination allowlist, DNS rebinding, unrecognized methods, oversized requests, exhausted rate budgets, absent or wrong per-run authentication, and browser Origin headers. Assert zero upstream requests on every rejection. The design must document numeric body, response, rate and timeout limits before implementation.
- [A3] Planned `keeps provider unavailable without egress proof` in `we:scripts/lib/__tests__/agy-sandbox.test.mjs`: settings and environment overrides cannot lift the production refusal before the required live proofs are recorded. **Must on error:** unavailable proxy, incomplete evidence or quota exhaustion refuses the run with provider fallback. **Must for every input kind:** documentation, tests, configuration and data cannot select destinations or relax admission.

## Non-goals

- [N1] No general network grant, provider enablement, credential-isolation waiver or public proxy endpoint. No remotely accessible reset endpoint; rate state belongs to one run and is discarded only when that run ends.

## Edge cases this change must handle

1. **Untrusted text** — Task text, URLs, header encodings and redirects cannot expand the destination allowlist; A2 asserts no upstream call.
2. **Truncated reads** — Reject partial allowlists, incomplete proof records and over-limit bodies; A2/A3 assert refusal.
3. **Shared state files** — No shared proxy credentials or rate state between runs; A2 must include concurrent runs with distinct tokens.
4. **Fail closed** — Network remains denied when proxy setup or required proofs fail; A1/A3 assert refusal and fallback.
5. **Identity scoping** — Bind each proxy token to one run and exact model destination; A2 rejects a token from another run.
6. **State over time** — Expired tokens and a restarted proxy cannot reset the current run's request budget; A2 covers expiry and restart.
7. **Who wrote it** — Launcher-owned policy controls egress; worker-authored config and proof text cannot authorize it; A3 covers forged evidence.

## Duplicate admission

agy confined build stays unavailable until model API egress is designed

no existing card covers sandbox egress for agy
