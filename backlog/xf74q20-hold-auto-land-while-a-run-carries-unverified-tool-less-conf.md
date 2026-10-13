---
kind: story
size: 3
status: open
dateOpened: "2026-10-12"
tags: []
---

# Hold auto-land while a run carries unverified tool-less CONFIRMED claims

The confirmation turn (#4815) first turned a tool-less seat's CONFIRMED broken claim into an advisory note whenever the verifier was unavailable, skipped or malformed, so a verdict could accept and a land step follow with the claim never checked. **Delivered on PR #5025 (round 7) by failing closed instead of adding a separate hold:** a verification that did not finish leaves the claim CONFIRMED and referred, so the head's durable referral record holds it (and a quiet same-head re-run cannot lose it); only a definitive, cited negative becomes a note, and that one answer still leaves the accept to a human. The `unverifiedClaims` hold this card describes was replaced by that.

Found by the converge panel's security lens on #4815 (a carve-out there: the card's ruling was that an unverified claim never blocks the run; the PR #5025 review overruled that, so an unverified claim now stays a referral).

## Acceptance

- [A1] **Executable** — `npx vitest run we:scripts/operations/__tests__/review-pr.test.mjs` includes a case where a failed verifier turn leaves a tool-less CONFIRMED claim unverified and the run does not reach an auto-land accept; it fails before this item lands and passes after.
- [A2] **Executable** — the same suite includes the control: a reproduced or not-reproduced claim (settled) does not hold the land.

## Non-goals

- [N1] (superseded on PR #5025 round 7) Keeping an unverified claim an advisory note: an unfinished verification now fails closed and the claim stays a mandatory referral.
- [N2] Retiring a claim on a single answer (that is the sibling card `xztd0mv`).

## Edge cases this change must handle

1. **Untrusted text** — the held-land note names the claim through `foldUntrusted`, never raw juror text.
2. **Truncated reads** — an unreadable PR head leaves every claim unverified, so it holds the land; it never reads as "nothing to verify".
3. **Shared state files** — n/a: the hold is derived from the run's own `reduce` finding, no new file.
4. **Fail closed** — a PRESENT but malformed `unverifiedClaims` (not a list, or an entry without its seat or key) holds the land. An absent field or an empty list releases it, because `reduce` omits the field when nothing is unverified; an unreadable `reduce` finding holds the land.
5. **Identity scoping** — the hold names the claim by seat and finding key, scoped to the run's head; a new head starts fresh.
6. **State over time** — a later run on the same head that settles the claim (either way) releases the hold; a restart mid-run keeps it.
7. **Who wrote it** — the hold is read from the operation's own reduce output, never from a comment a PR author can post.
