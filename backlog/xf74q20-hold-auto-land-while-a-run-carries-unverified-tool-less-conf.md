---
kind: story
size: 3
status: open
dateOpened: "2026-10-12"
tags: []
---

# Hold auto-land while a run carries unverified tool-less CONFIRMED claims

The confirmation turn (#4815) turns a tool-less seat's CONFIRMED broken claim into an advisory note whenever the verifier is unavailable, skipped or malformed, and retries on the next run. Between runs a verdict can accept and a land step can follow with the claim never checked. Surface the run's `unverifiedClaims` to the confirm and auto-land decision so a run with an unverified broken claim cannot auto-land until a later run settles it, and pin it with a test through the real operation.

Found by the converge panel's security lens on #4815 (a carve-out there: the card's ruling is that an unverified claim never blocks the run, so holding a land is a separate policy call).

## Acceptance

- [A1] **Executable** — `npx vitest run we:scripts/operations/__tests__/review-pr.test.mjs` includes a case where a failed verifier turn leaves a tool-less CONFIRMED claim unverified and the run does not reach an auto-land accept; it fails before this item lands and passes after.
- [A2] **Executable** — the same suite includes the control: a reproduced or not-reproduced claim (settled) does not hold the land.

## Non-goals

- [N1] Making an unverified claim a mandatory referral again (it stays an advisory note).
- [N2] Retiring a claim on a single answer (that is the sibling card `xztd0mv`).

## Edge cases this change must handle

1. **Untrusted text** — the held-land note names the claim through `foldUntrusted`, never raw juror text.
2. **Truncated reads** — an unreadable PR head leaves every claim unverified, so it holds the land; it never reads as "nothing to verify".
3. **Shared state files** — n/a: the hold is derived from the run's own `reduce` finding, no new file.
4. **Fail closed** — a missing or malformed `unverifiedClaims` field holds the land; only an explicit empty list releases it.
5. **Identity scoping** — the hold names the claim by seat and finding key, scoped to the run's head; a new head starts fresh.
6. **State over time** — a later run on the same head that settles the claim (either way) releases the hold; a restart mid-run keeps it.
7. **Who wrote it** — the hold is read from the operation's own reduce output, never from a comment a PR author can post.
