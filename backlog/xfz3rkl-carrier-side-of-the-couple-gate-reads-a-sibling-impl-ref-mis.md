---
kind: story
size: 3
status: open
scope: ["we:scripts/merge-ai-prs.mjs", "we:scripts/lib/couple-cascade.mjs"]
dateOpened: "2026-11-07"
tags: []
---

# Carrier side of the couple gate reads a sibling impl ref missing from the open-PR listing as 'landed' even wh…

Flow-sim gap R7a-G2, class K17 (partial page read as complete). Failing input: Carrier we#9 manifest repos [{plateau-app, lane/x1},{we, lane/x1b}] (distinct refs, or same ref via the cascade check b). plateau-app has >= OPEN_PR_LIST_LIMIT open PRs so the listing is full-page, or its `gh pr list` threw (collectOpenPrContext returns {prs:[], failed:true}). The impl plateau-app#5 (head lane/x1, ready-to-merg… Cited: we:scripts/merge-ai-prs.mjs:2102-2115, we:scripts/merge-ai-prs.mjs:2089, we:scripts/lib/couple-cascade.mjs:95-99, we:scripts/merge-ai-prs.mjs:7284. Soak-break sketch: Fixture: seedCouple with distinct refs and a fake-gh `pr list --repo plateau-app` that throws (or returns exactly OPEN_PR_LIST_LIMIT rows without the impl). Action: one drain pass. Assertion that fails today: we carrier MERGED while plateau-app impl is OPEN; …

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
