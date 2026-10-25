---
bornAs: xmi7iws
kind: story
size: 2
status: open
scope: ["we:scripts/merge-ai-prs.mjs", "we:scripts/lib/card-group.mjs"]
dateOpened: "2026-10-25"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5762 (head 68b1be6f1)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5762 (reviewed head `68b1be6f1fd1a15cfacbd007dd7e4a773ff890aa`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/merge-ai-prs.mjs:6583` — (edge-case, degraded) The combined PR can yield to its own held sources
   - Scenario: Group two approved PRs containing the same one-line addition. Their combined PR has the same changed-line count, so the older source outranks it in overlap ordering. The grouping hold marks only the remaining copies as skip, while replan passes the original merge-decided verdicts into buildOverlapRows. Consequently, the held source remains an eligible yield target. A probe using the real hold, target-filter and overlap functions produced combined #77 yielding to held source #1. Nothing can enqueue until the combined PR's overlap budget expires (45 minutes by default). Group-held sources should
   - Claude's re-check: demonstrated break
2. `we:scripts/lib/card-group.mjs:1142` — (failing-input, degraded) A surviving remote branch prevents grouping retries after PR creation fails
   - Scenario: Push a group's branch successfully, then fail PR creation with a transient 502. After 15 minutes, reconcile finds no PR and removes the record without removing the branch. Keep the source heads unchanged through the retry backoff, then attempt formation again. The source-derived branch name is identical, but rebuilding produces a different commit because the base or commit timestamps changed. Formation rejects the surviving branch as 'already exists at another commit'. An in-memory IO probe reproduced this sequence: the retry never called PR creation, leaving createCalls at 1. Subsequent attem
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
