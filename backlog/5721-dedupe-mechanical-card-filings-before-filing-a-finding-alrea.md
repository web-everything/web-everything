---
bornAs: xi4c329
kind: story
size: 3
priority: high
status: resolved
scope: ["we:scripts/lib/card-dedupe.mjs", "we:scripts/lib/__tests__/card-dedupe.test.mjs", "we:scripts/operations/land-prevention-card.mjs", "we:scripts/operations/__tests__/land-prevention-card.test.mjs", "we:scripts/operations/card-dedupe-replay.mjs", "we:scripts/settings/card-dedupe.json"]
dateOpened: "2026-10-10"
dateResolved: "2026-10-10"
tags: []
---

# Dedupe mechanical card filings before filing: a finding already on an open card becomes an Also raised by line

Operator, 2026-10-10 ~10:40 ET: stop filing near-duplicate follow-up cards. The mechanical filers (approval-time prevention filer, the review loop's prevention and round-budget / late-findings cards) all land through we:scripts/operations/land-prevention-card.mjs, and each filed a fresh card per PR even when an open card already asked for the same guard on the same file; the coroner/build queue showed about 30 such cards at its front.

Before filing, match each finding against the open cards (origin/main backlog plus cards in open filing PRs) by target file, defect class and claim similarity (deterministic tokens, no LLM). A match appends an Also raised by line to the existing card (landed through the same lane, gate and PR) instead of filing; no match files as today. Never across different files or classes; never into a claimed (active) card. Setting cards.dedupe plus a similarity threshold through the policy cascade: standard default (off), platform preference (we:scripts/lib/delivery-platform-preferences.json, missing is no preference), repo override (we:scripts/settings/card-dedupe.json), env; the source of each key is logged.

## Done when

1. **Executable** — `npm run test:unit -- card-dedupe land-prevention-card` fails before (no dedupe: the duplicate is filed as a new card) and passes after.
2. **Must (refuse on error)** — a dedupe failure, an unreadable PR list, or a card that stopped being open between plan and write files the finding as before; a match is never dropped.
3. **Must (non-code inputs)** — a finding cited on a backlog card, config or doc file is matched only against findings with the same target and class; a claimed (status active) card is never edited.
4. **Replay** — the we:scripts/operations/card-dedupe-replay.mjs report counts how many of last week's mechanical filings would have been mentions.

## Acceptance

- [A1] **Executable** — `npm run test:unit -- card-dedupe land-prevention-card`: the duplicate-becomes-mention and claimed-card-race cases fail on the old landing job and pass after.

## Non-goals

- [N1] No LLM similarity, no cross-file or cross-class merging, no edits to the file-item operation, and no rewrite of cards already filed (the replay only reports).

## Edge cases this change must handle

1. **Untrusted text** — the mention claim is reviewer text already bounded by the landing job; parentheses and backticks are stripped and it is capped at 300 characters.
2. **Truncated reads** — the open-PR card lookup is capped at 60 cards; a gh failure means no PR candidates, so the finding is filed as before.
3. **Shared state files** — the existing card is edited only in the job's own leased lane and lands through the normal gate and PR.
4. **Fail closed** — any dedupe error, or a match whose mention could not be written, files the finding; a match is never dropped.
5. **Identity scoping** — only `status: open` cards are targets, re-checked on the lane copy right before the write.
6. **State over time** — a retried filing finds its mention line (and key) already on the card and adds nothing.
7. **Who wrote it** — n/a: the matcher reads card text only; it grants no trust to who filed a card.

## Progress

- Hook point: every mechanical filer lands through the detached landing job, so the dedupe runs there, after the lane is acquired and before file-item; we:scripts/operations/file-item.mjs is untouched. The matcher (we:scripts/lib/card-dedupe.mjs) needs the same target (a finding cited on a backlog card targets the card corpus), the same guard class, and IDF-weighted token Jaccard of at least 0.3.
- Replay of 2026-10-03..09 (415 mechanical filings, 1182 findings): 11 filings become mention-only (no new card), 20 more move some findings to mentions, 44 findings in all become mentions. Plain Jaccard caught only 1 filing: most look-alike cards ask for different guards on the same file, and the most repeated guard (reject a card whose Done-when still says TODO) was cited on a different card each time.
