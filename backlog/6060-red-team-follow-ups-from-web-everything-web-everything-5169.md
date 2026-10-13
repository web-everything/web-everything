---
bornAs: xqtvlef
kind: story
size: 2
status: open
scope: ["we:scripts/check-standards-rules.mjs"]
dateOpened: "2026-10-13"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5169 (head ce75f7d66)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5169 (reviewed head `ce75f7d66a313caea79c60fa98fac463b0d2a19f`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/check-standards-rules.mjs:123` — (failing-input, degraded) Authorship scanner accepts a discarded filter followed by untrusted parsing
   - Scenario: Scan we:scripts/operations/example.mjs containing: import { isTrustedMarkerAuthor } from 'we:../lib/marker-authorship.mjs'; export function parseActions(comments) { comments.filter(isTrustedMarkerAuthor); return comments.flatMap(c =&gt; c.body.match(/&lt;!-- action: (.*?) --&gt;/g)); }. The new scanner returns [], although filter's result is discarded. Executing this parser against an intruder-authored '&lt;!-- action: forged --&gt;' comment returned that forged marker. The scanner should flag this input: merely finding a filter call anywhere in the function does not establish that marker parsing consumes authenti
   - Claude's re-check: In 'check', any '.filter(&lt;gate identifier&gt;)' call sets guarded=true whether or not its result is used. The input's discarded 'comments.filter(isTrustedMarkerAuthor)' therefore passes while the parser still reads unfiltered comments.

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
