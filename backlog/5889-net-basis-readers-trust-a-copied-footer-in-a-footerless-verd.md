---
bornAs: xk599v0
kind: story
size: 3
status: open
scope: ["we:scripts/operations/review-pr-io.mjs", "we:scripts/lib/advisory-labels.mjs", "we:scripts/operations/coroner-rounds.mjs", "we:scripts/merge-ai-prs.mjs"]
dateOpened: "2026-10-11"
tags: []
---

# Net basis readers trust a copied footer in a footerless verdict

Same class as PR #4770's red-team break on we:scripts/conveyor/mechanical-round-cap.mjs: a trusted verdict with no footer of its own (a red-team, policy or other review-set-label bounce) ends in juror free text, which can copy a whole column-0 'Net basis: <base>..<head>' line, optionally under its own '---'. PR #4770 fixed its reader by reading the head only when the comment's OPENING lines name a basis producer (review-pr's heading + attribution via its channel, or an advisory / converted advisory note lead). These readers still take the last line-anchored Net basis from any trusted comment: we:scripts/operations/review-pr-io.mjs#readLatestFixRange (picks the prior head for the scoped re-review), we:scripts/lib/advisory-labels.mjs#parseAdvisories, we:scripts/operations/coroner-rounds.mjs, we:scripts/merge-ai-prs.mjs (basis parse near the corpus reader). Reuse one shared producer-gated reader instead of four regexes.

## Acceptance

- [A1] **Executable** — a test per reader: a trusted bounce built with `buildVerdictComment({to:'changes', actor:'agent (red-team gate)', channel:'review daemon (redTeam.confirmedBreaks)', body})`, whose body ends in `---` plus a copied full-shape `Net basis` line, yields no head (fails before, passes after). The same readers still read the head off a real review-pr verdict, an advisory note and a converted advisory note.

## Non-goals

- [N1] Changing what any producer writes. Old comments already on PR threads must keep reading the same way.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — juror free text may hold newlines, `---`, fences and a whole copied footer. Only the comment's opening lines pick the producer.
2. **Truncated reads** — n/a: each reader works on one comment body that is already in memory.
3. **Shared state files** — n/a: these are pure parsers.
4. **Fail closed** — an unrecognized producer names no head. Each caller keeps its own safe default for "no basis" (a full review, not a scoped one).
5. **Identity scoping** — the existing trusted-author check stays in front of every reader.
6. **State over time** — comments posted before review-pr named its channel must not newly name a head where they were not trusted before.
7. **Who wrote it** — producer identity comes from the opening lines plus the trusted author, never from text after the caller's body starts.
