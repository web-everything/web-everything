---
kind: epic
parent: "3383"
status: open
scope: ["we:scripts/lib/card-batch-policy.mjs"]
dateOpened: "2026-10-18"
tags: []
---

# we: collector PR streams build - per-stream card batching ruling (x5ioz96)

Build the ruling of decision x5ioz96 (we:docs/agent/platform-decisions.md#collector-pr-card-batching-streams): self-heal a stuck sealed batch first, then the ruling stream declared and disabled with follow-up and expedite folded into filing, numbering at seal, resumable seal timeouts, and an age escape for a batch held on an unextractable finding.

## Acceptance

- [A1] **Executable** — every planned case named in the [A1] of x5nmdnt, x1mmp60, x245i7o, xf1z2w3, xpabefb and x7nf3f5 exists and passes. Passing the suites alone is not enough: each named case must assert its behaviour. Cases where slices interact are owned by the later slice and listed here so they are tested together: `timeout during number-members then resume leaves each member numbered exactly once` (x245i7o over x1mmp60), `aged-hold archive is never relaunched by the seal scan and keeps its hold label` (xf1z2w3 over x5nmdnt's scan), and the two xpabefb default cases that x7nf3f5 replaces. Once x7nf3f5 lands, its replacements (`ruling ships enabled with 8/60 defaults`, and `disabled ruling refuses kind-disabled, not unknown kind` with an explicit override) satisfy those two xpabefb cases.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] Code PRs never join a collector; the shared-rule-file conflicts stay with card 6250.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: an epic; each slice states its own handling (x5nmdnt, x1mmp60, x245i7o, xf1z2w3, xpabefb, x7nf3f5).
2. **Truncated reads** — n/a: an epic; see the slices.
3. **Shared state files** — n/a: an epic; see the slices.
4. **Fail closed** — n/a: an epic; see the slices.
5. **Identity scoping** — n/a: an epic; see the slices.
6. **State over time** — n/a: an epic; the cross-slice cases are listed in [A1].
7. **Who wrote it** — n/a: an epic; see the slices.
