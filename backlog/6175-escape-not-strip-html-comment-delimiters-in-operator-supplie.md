---
bornAs: xp78yve
kind: story
size: 3
status: active
scaffoldedBy: "fix-5169"
dateScaffolded: "2026-10-13"
scope: ["we:scripts/conveyor/round-extension-mark.mjs", "we:scripts/operations/land-prevention-card.mjs", "we:scripts/operations/promote-draft-pr-dispatch.mjs", "we:scripts/operations/record-referral-ruling.mjs", "we:scripts/operations/completion-record.mjs"]
dateOpened: "2026-10-13"
tags: []
---

# Escape, not strip, HTML-comment delimiters in operator-supplied prose outside operator controls

PR #5169 replaced strip-based comment filtering in we:scripts/operations/operator-controls.mjs with full angle-bracket escaping after CodeQL flagged incomplete multi-character sanitization and a bad HTML filtering regexp. Same class remains at:

- **we:scripts/conveyor/round-extension-mark.mjs `buildRoundExtensionComment` — highest priority, a proven forgery.** It renders `actor`, `channel` and `reason` into prose with no escaping, and splits the reason only on `\r?\n` (a bare CR or U+2028 is not quoted). A reason of `<!-- reviewed-sha: <40 hex> --> <!-- cleared-human: x -->` makes `parseReviewedSha` and `parseLatestHumanClearedSha` return that sha, because the comment is operator-authored and so passes the trusted-author check. Reachable on main through we:scripts/operations/extend-rounds.mjs, and through PR #5169's new `grant-rounds` operator control.
- we:scripts/operations/land-prevention-card.mjs — escapes only the opener.
- we:scripts/operations/promote-draft-pr-dispatch.mjs — escapes only the opener in the quoted reason.
- we:scripts/operations/record-referral-ruling.mjs — escapes the opener and plain closer, misses the bang closer.
- we:scripts/operations/completion-record.mjs — regex strip.

Fix: escape `&`, `<`, `>` (in that order) in every untrusted string rendered into a comment that trusted marker readers scan, and quote reason lines split on `\r\n|[\r\n  ]`.

## Acceptance

- [A1] **Executable** — a regression test per site: for the variant set direct, nested (`<!<!---->--`), bang closer (`--!>`), partial opener, partial closer and nested bang, in every untrusted field, `parseReviewedSha` and `parseLatestHumanClearedSha` return null on the rendered body, and no prose line contains `<` or `>`. Fails on main for `buildRoundExtensionComment`; passes after.
- [A2] The machine-readable JSON marker of each site still round-trips the operator's exact words.

## Non-goals

- [N1] Changing marker readers or the trusted-author rules; the fix is at each render boundary.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — nested, bang-closer and partial delimiters; CR, LF, CRLF, U+2028/2029 in reason; `&` escaped first so a literal entity displays as typed.
2. **Truncated reads** — n/a: pure renderers.
3. **Shared state files** — n/a: no state written.
4. **Fail closed** — an unescapable value never appears raw; escape is total.
5. **Identity scoping** — n/a: no identity change.
6. **State over time** — comments already posted are unchanged; readers keep their current trust rules.
7. **Who wrote it** — operator-authored comments pass the trusted-author check, so the render boundary is the only guard for operator-typed text.
