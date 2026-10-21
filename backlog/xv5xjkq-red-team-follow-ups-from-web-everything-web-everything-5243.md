---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/review-precedents-io.mjs", "we:scripts/lib/review-precedents.mjs"]
dateOpened: "2026-10-14"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5243 (head 54e662a11)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5243 (reviewed head `54e662a112c6d5bfe66a57eb24ed6d5876f1f4b1`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/review-precedents-io.mjs:38` — (edge-case, degraded) Distinct repositories collide in the precedent storage path
   - Scenario: precedentGitPath('a-b/c') and precedentGitPath('a/b-c') both return review-precedents/a-b-c.jsonl. Append a draft sourced from a-b/c plus a legitimate operator promotion, then read the library for a/b-c. The read returns that foreign active record, and withPrecedents injects it when its scope matches. The in-memory transport probe reproduced this. Repository identities should map to distinct paths, and reads should prevent foreign records from acquiring authority.
   - Claude's re-check: precedentGitPath maps '/' to '-', so 'a-b/c' and 'a/b-c' both give review-precedents/a-b-c.jsonl. Both repo names pass the repo regex. Neither parsePrecedentLog nor foldPrecedents checks the record's source.repo, so a promoted foreign record is read and injected.
2. `we:scripts/lib/review-precedents.mjs:158` — (edge-case, degraded) A future-dated direct citation pins an obsolete verdict despite the clock-skew guard
   - Scenario: Append two source-less citationEvent records for the same repo, PR, head, seat and precedent: first verdict='accept', at='2099-01-01T00:00:00Z' from a misconfigured clock; then verdict='changes', at='2026-10-14T12:00:00Z' from the corrected clock. Both appends report one added row, even with appendPrecedentEvents.now fixed to the honest time, but folding the stored log still returns accept. Future stamps are clamped only in the temporary append view; readPrecedents folds the original timestamps, and direct citations rank by at. The skewed row should not indefinitely override subsequent honest
   - Claude's re-check: Source-less citations rank by their own 'at' in evidenceTime. clampFutureStamps is applied only to the append-time staleness view, while readPrecedents folds the raw events. A 2099 accept therefore beats a later 2026 changes in latestBy/strictlyNewer. Both appends store a row, because the event ids differ.

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
