---
bornAs: x7xqxot
kind: story
size: 2
status: open
scope: ["we:scripts/readiness/forge-cache-prune.mjs", "we:scripts/readiness/__tests__/forge-cache-prune-running-record.test.mjs"]
dateOpened: "2026-11-15"
tags: []
---

# Reinforce forge cache prune leaked-reservation proof: require a complete final receipt and newer-phase evidence

Audit of the prune fix (R825 residual) says: (1) a leaked reservation is accepted on an aged reservation plus a receipt that only names the run; require a complete final receipt (phase, numeric code, valid lock and digests); (2) a newer record with no profile fields is ignored when choosing the authoritative phase, so an older known profile can replace whole-lock protection. Tighten both in we:scripts/readiness/forge-cache-prune.mjs with tests in we:scripts/readiness/__tests__/forge-cache-prune-running-record.test.mjs.

## Acceptance

- [A1] **Executable** — Run `npm run test:unit --` with we:scripts/readiness/__tests__/forge-cache-prune-running-record.test.mjs as the file argument. Add named cases requiring a complete final receipt before leaked-reservation bypass: matching run, final phase, finite numeric code, valid lock and both digests. A run-only receipt currently qualifies; the new cases must fail before the hardening and pass after it.
- [A2] **Must refuse on error** — malformed, conflicting, oversized or unreadable evidence yields incomplete live evidence and an empty prune list. Independently corrupt each digest in each phase for both sibling modes, including the unselected digest.
- [A3] **Must handle persisted data cautiously** — cover legacy records and a later phase with no profile fields. Missing proof must preserve the whole lock or refuse pruning. Keep the named `incomplete latest phase preserves every profile under the lock` regression: a known prepared profile must not mask a later profile-bearing but unresolved running record.
- [A4] **Producer/reader plan** — preserve both sibling modes in the running-record integration cases. A mutation emitting `siblings: false` must fail the sibling-bearing case; replacing latest-phase fallback with any-known-profile must fail A3. The named writerGuard, receipt-run, lifetime and per-digest guards must each discriminate removal of their guard.

## Non-goals

- [N1] No change to retention settings, writer leases or alert delivery. Stronger authentication against forged receipts remains a separate design question; receipt completeness alone does not prove authorship.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — validate receipt fields by type and exact digest syntax; never execute record content.
2. **Truncated reads** — retain the existing 4 MiB bounded, no-follow read and fail closed on invalid JSON.
3. **Shared state files** — a matching receipt alone must not establish termination; require all final evidence before bypass.
4. **Fail closed** — incomplete or corrupt proof preserves the cache; no deletion on a refusal.
5. **Identity scoping** — reservation run and lock must match the final evidence; legacy unleased writers retain whole-lock protection.
6. **State over time** — test the runtime boundary and later unresolved or fieldless phases against earlier known profiles.
7. **Who wrote it** — keep protected evidence ownership and writerGuard checks; document the residual trust in receipt authorship.
