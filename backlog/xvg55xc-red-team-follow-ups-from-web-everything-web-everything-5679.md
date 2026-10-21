---
kind: story
size: 2
status: open
scope: ["we:backlog/xojxr2o-red-team-follow-ups-from-web-everything-web-everything-5547.md"]
dateOpened: "2026-10-18"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5679 (head 6fa449060)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5679 (reviewed head `6fa44906044226ea124f2f3c792aab4705f57550`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:backlog/xojxr2o-red-team-follow-ups-from-web-everything-web-everything-5547.md:5` — (edge-case, degraded) Stale hash paths make the declared scope miss its actual target files.
   - Scenario: The scope names x28khww and xzukm4y files, but those files already exist as we:backlog/6248-the-verify-operation-prints-a-plain-pass-fail-verdict.md and we:backlog/6259-drain-pass-summary-counts-each-merged-pr-once.md. A read-only probe passed this card through mapHashReferences with their bornAs mappings, then applyLedger with a fresh ledger assigning the new card's number. Body citations were repaired, but scope retained both nonexistent paths. scopesOverlap against the real target paths returned false, and scopeLease classified both intended edits as breaches. Thus declared scope misses actual co
   - Claude's re-check: demonstrated break

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
