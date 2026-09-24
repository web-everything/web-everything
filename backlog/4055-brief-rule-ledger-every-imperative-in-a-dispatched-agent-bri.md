---
bornAs: x446oxf
kind: story
size: 3
parent: "3593"
status: open
scope: ["we:scripts/check-brief-rules.mjs", "we:skills-src/conveyor/delivery-agent-brief.md", "we:skills-src/conveyor/fix-agent-brief.md", "we:skills-src/review/review-agent-brief.md"]
dateOpened: "2026-09-24"
tags: []
---

# Brief-rule ledger: every imperative in a dispatched agent brief names its code enforcer or is marked judgment, checked in CI

Today's recurring root cause: agents skip a prose rule in their brief (write the completion record, use Edit not Bash for card files, never end a turn on a background wait). A check scans every dispatched brief under we:skills-src for imperative lines (must, never, always, before you) and requires each to carry an enforcer tag naming the wrapper step, hook or test that makes it true without the agent, or an explicit judgment tag. Untagged imperatives fail the check. The report lists the prose-only rules by count, so the conveyor can file one mechanisation card per rule. First target set: completion-record writes (move into the dispatch wrappers of #3643), card edits via Edit (we:scripts/backlog-guard.mjs only guards Edit/Write, and a grep of we:scripts/guard-bash.mjs finds no backlog rule, so a Bash heredoc or sed rewrite of a card is not denied today; that is the first mechanisation this ledger should file), and passive-wait endings (#3594, we:scripts/guard-stop-passive-wait.mjs already covers part: tag it).

## Why (2026-09-24 incident review)

The operator's proposal 2: turn prose rules in agent briefs into code. The pieces exist but nothing connects them: #3643 moves lifecycle steps out of briefs into wrappers, #3593 catches slips after the fact, and the context sweep (the `context-sweep` skill) audits memory and the agent instructions but not the dispatched briefs. The biggest briefs carry many imperatives (a grep for must/never/always counts 70 lines in we:skills-src/conveyor/delivery-agent-brief.md and 47 in we:skills-src/conveyor/fix-agent-brief.md), and nothing records which of them code already enforces. This ledger is the missing inventory. It makes "prose-only rules" a number that goes down.

## Done when

1. **Executable** — `node we:scripts/check-brief-rules.mjs --json > <file>` lists every imperative line in every brief file under we:skills-src with its tag or `untagged`; a vitest fixture brief with one tagged, one judgment-tagged and one untagged imperative returns exit 1 and names the untagged line.
2. **Executable** — the check runs in `npm run check:standards` in report-only mode first (prints the untagged count). It becomes blocking once the count for the conveyor briefs reaches zero.
3. **Filed** — one card per untagged rule in the delivery, fix and review briefs that is script-decidable, each naming its target enforcer (wrapper step, hook, or test).
