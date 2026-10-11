---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/mechanical-round-cap.mjs"]
dateOpened: "2026-10-11"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#4779 (head e85da89ac)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#4779 (reviewed head `e85da89ac2105ebfd2667caa68f9e20e925bf5db`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/conveyor/mechanical-round-cap.mjs:122` — (failing-input, degraded) A quoted reviewed-sha marker survives a real Net basis footer naming a different commit
   - Scenario: Let A, B and C be distinct full 40-character SHAs. A trusted changes verdict quotes '&lt;!-- reviewed-sha: A --&gt;' inside a finding, then ends with the genuine 'Net basis: '0..C'' footer. A later trusted mechanical-round marker accompanies proven mechanical head B with priorHead=A and netDiffIdentical=false. The probe returned reviewedHeadsOf=[A,C] and mechanicalRoundGrant={ok:true,action:'review',allowance:1}, although A was never judged. Removing only the quoted marker returned prior-head-unreviewed. The parser retains the last match of each syntax independently; changes verdicts do not append a
   - Claude's re-check: 'reviewedHeadsOf' keeps the last match of each regex separately, and 'REVIEWED_MARKER_RE' is not line-anchored. A quoted '&lt;!-- reviewed-sha: A --&gt;' therefore survives next to a genuine 'Net basis: 0..C' footer, giving [A, C]. 'verdictJudged(c, A)' is then true, so 'onPrior' is non-empty and the 'prior-head-unreviewed' refusal is skipped. The Net basis regex is line-anchored but the marker regex is not, so the quote is not ignored.

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
