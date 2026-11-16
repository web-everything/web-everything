---
bornAs: x950qv1
kind: story
size: 1
status: resolved
scope: ["we:scripts/operations/land-prevention-card.mjs", "we:scripts/operations/__tests__/land-prevention-card.test.mjs"]
dateOpened: "2026-09-29"
dateStarted: "2026-09-30"
dateResolved: "2026-09-30"
preparedDate: "2026-09-30"
preparedAgainstSha: "c30c1b7399ebf54666a676354fea07810cb1f1a6"
tags: []
---

# Prevention-card writer escapes wiki-link syntax quoted from reviewer prose

Live 2026-09-29: orphan card 8432 (from PR #2872) quoted reviewer prose that describes double-square-bracket wiki-link syntax, so the card literally contained it and failed check-standards' wiki-link rule; the sweep (PR #2901) had to drop it. MVP: the approval-time prevention-card body builder (we:scripts/lib/approval-prevention-notice.mjs / we:scripts/operations/land-prevention-card.mjs) escapes or code-spans double-bracket sequences in quoted reviewer text; then re-run the sweep so 8432 lands. Must: unit test with a bracket-containing finding; live proof: 8432 lands via the sweep.

## Premise check (current `main`, 2026-09-30)

Still open. No commit names #4457 or `4457` beyond the filing/JIT-number commits. `boundCardText` (`we:scripts/operations/land-prevention-card.mjs:122-133`) strips invisibles, neutralizes `<!--`/`-->` and caps length, but does nothing for `[[`…`]]`. The wiki-link rule is `we:scripts/check-standards-rules.mjs:834` (`/\[\[[^\]]*\]\]/g`, run on prose with inline-code spans and fenced blocks already skipped). Orphan `8432` no longer exists in the tree (the sweep, PR #2901, dropped it), so its exact text is not recoverable from `main`.

**Scope correction:** the frontmatter `scope:` named `we:scripts/lib/approval-prevention-notice.mjs`, but that file only *builds* the digest; the single chokepoint every card crosses before it is written is `boundLandPreventionCardInput` in `we:scripts/operations/land-prevention-card.mjs` (its header: "the one chokepoint"). Fixing it there covers the notice-builder's output without touching that file. Scope is corrected to the writer plus its test.

## Design

Escape in `boundCardText` (`we:scripts/operations/land-prevention-card.mjs:122`), right beside the `<!--` neutralization, so title, digest and scope all get it by construction. Replace every `[[` with `[\[` and every `]]` with `]\]`: markdown renders the backslash-escaped brackets as the literal characters a reader expects, and the scan regex (`\[\[[^\]]*\]\]`) can no longer match because no two brackets are adjacent. Backslash-escaping is chosen over code-spanning because reviewer text can itself contain backticks, so wrapping it in a span could break or invert an existing span.

- Implementation: `.replace(/\[(?=\[)/g, '[\\')` and `.replace(/\](?=\])/g, ']\\')` — a lookahead inserts a backslash after every bracket that is followed by the same bracket, so an unbalanced `[[`/`]]` is defused too and a triple `[[[` becomes `[\[\[` (no adjacent pair left).
- Order: after the `INVISIBLE_CHARS_RE` strip (so a zero-width char cannot sit between two brackets and later become adjacent), before the length cap.
- Known cost: the escape also runs inside inline code spans, so a quoted `[[1,2]]` in a span becomes `[\[1,2]\]` (backslashes render literally there). Uglier, still lint-clean; accepted.
- Key-line bypass (adversarial review finding): `boundLandPreventionCardInput` keeps the idempotency key line verbatim when its tail matches `/^[\x21-\x7e]{1,300}$/` (`we:scripts/operations/land-prevention-card.mjs:152`), which admits `[`/`]`, so forged digest text ending in a fake key line with a bracket pair would skip `boundCardText`. The builder's real key (`approval-prevention-key:<repo>#<pr>@<sha>`) never has brackets, so tighten that regex to `/^[\x21-\x5a\x5c\x5e-\x7e]{1,300}$/` (printable ASCII minus `[` and `]`); a bracketed tail is then treated as ordinary digest text and escaped.
- `we:scripts/lib/approval-prevention-notice.mjs` is NOT edited.

## MVP

Musts: the two replaces in `boundCardText`, the bracket-free key-line regex tightening (same chokepoint, closes a bypass of the same bug), plus the tests below.

Out of scope (→ Follow-ups): the #2749 review-loop builder `buildPreventionFilingInput` (`we:scripts/lib/review-loop-policy.mjs`), which files cards by a different path and does not cross `boundCardText`; a general "escape all check-standards body-lint classes" pass (localhost, absolute-path and cross-item file links are WARN-only today); re-filing `8432` itself.

## Test plan

In `we:scripts/operations/__tests__/land-prevention-card.test.mjs`, next to the existing `boundCardText` case (line ~327):
- `boundCardText` of a finding describing `[[memory-link]]` returns text containing no `[[`…`]]` match: asserts `findBadBodyLinks(out)` (imported from `we:scripts/check-standards-rules.mjs`) is `[]`. Red today: the text passes through unchanged and the scan reports a `wikilink`.
- Edge cases, RED today: unbalanced `[[` and `]]`, and a triple `[[[x]]]`, each still yield a `wikilink`/adjacent pair before the fix. Regression guards (pass before and after, `findBadBodyLinks` already skips code spans): `[[` inside an existing backtick span, a single `[x]`, a markdown link `[a](b)` untouched.
- `boundLandPreventionCardInput` with `[[…]]` in title, digest body and scope: all three are clean (RED today); a real builder key line stays byte-identical (guard).
- Key-line bypass, RED today: a digest ending in the separator plus `approval-prevention-key:[[x]]` yields a `wikilink` in the bounded digest before the fix, none after.
- Round trip: render the bounded digest into a card body shape and assert `findBadBodyLinks` over the whole body is `[]` (the real gate's own detector, not a copy of the regex).

## Proof plan

- Before/after on the real detector: `node -e` builds a bracket-containing finding through `buildApprovalPreventionFilingInput` → `boundLandPreventionCardInput`, prints `findBadBodyLinks` over the body on `main` (one `wikilink` finding) vs on the lane (none).
- Live: run the landing job's gate path on a bracket-containing card in the lane (`we:scripts/check-standards.mjs --json` unscoped) and show it passes where the pre-change card fails. If the PR #2872 review comment is still retrievable, re-run its approval-time filing so `8432` (or its successor) lands via the normal PR path; if not, record that the orphan's text is gone and the replayed synthetic card stands as the proof.
- `npm run check:standards` green.

## Follow-ups

- Apply the same escape to the #2749 review-loop builder (`buildPreventionFilingInput`), or route it through the same bounding.
- Decide whether the `WARN`-class body links (`localhost`, `/Users/`, links to another backlog item's file) should also be neutralized at this chokepoint.

## Done when

1. **Executable** — `npx vitest run we:scripts/operations/__tests__/land-prevention-card.test.mjs` passes; the new wiki-link cases fail on the pre-change code (the bounded card still trips `findBadBodyLinks`).
