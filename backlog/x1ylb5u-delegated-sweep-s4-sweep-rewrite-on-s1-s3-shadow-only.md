---
kind: story
size: 5
status: open
blockedBy: ["xnueoyl"]
scope: ["we:scripts/conveyor/delegated-clearance-sweep.mjs", "we:scripts/conveyor/soak/breaks/"]
dateOpened: "2026-10-29"
tags: []
---

# Delegated sweep S4: sweep rewrite on S1-S3, shadow only

Rewrite the delegated-clearance sweep on the shared checks (readRedTeamDisposition/resolveDisposition, approvalReleases, admitClearHuman as the only gate, isTrustedMarkerAuthor) and the S3 store; shadow mode only until a valid deadline. Owns I3 dismissal never outlives a later block, I5 refusal is final, I9 shadow until a valid deadline. Test matrix: one test per invariant, 18 named past-break regressions, plus soak breaks concurrent-state-overwrite and dismissal-after-block. Blocked by S3 (and S1 landed).

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
