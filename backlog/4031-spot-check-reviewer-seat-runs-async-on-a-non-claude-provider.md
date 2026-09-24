---
bornAs: xwq410e
kind: story
size: 5
parent: "3318"
relatedTo: ["3330", "3887", "3867", "3313"]
status: open
scope: ["we:scripts/lib/jury-core.mjs", "we:scripts/operations/review-dispatch.mjs", "we:scripts/lib/judge-panel.mjs"]
dateOpened: "2026-09-24"
tags: []
---

# Spot-check reviewer seat runs async on a non-Claude provider, and its cost is measured

Rule 7 of #delegation-trial-record-graduation lets any provider fill the reviewer seat for the spot-check pass, and #3867 ratified that the pass runs asynchronously, off the landing path. Make the spot-check (#every-pr-gets-a-look-advisory-floor) juror default to a non-Claude provider (Codex is allowed for tool-free judging per rule 7; Gemini also possible) so the review costs ~no Claude usage; run it async after land, never in the merge path; record cost + wall time for the first 10 runs and report against the #3318 ~$0.43/PR full-lens baseline. #3313's '~$12.50 across 29 PRs' figure equals 29 x $0.43, i.e. the full-lens cost -- so the floor's own real cost is still unmeasured. Checked we:backlog/3593 (a syntactic scanner plus standing supervisor over subagent transcript compliance) as a possible vehicle for the async pass -- it targets mid-session agent behavioral compliance, not a post-land PR diff review, so it does not fit and is not linked here.

## Done when

1. **Executable** — the spot-check juror roster resolution (`we:scripts/lib/jury-core.mjs#resolveRoster`)
   defaults the `spot-check` care level to a non-Claude provider (Codex for tool-free judging; Gemini
   allowed) and a unit test pins that default.
2. **Executable** — the dispatch (`we:scripts/operations/review-dispatch.mjs`) runs the spot-check pass
   asynchronously after land, never inside the merge path, and a test shows a merge is never held on it.
3. **Observable** — cost (`costUsd`) and wall time are recorded for the first 10 real spot-check runs and
   reported against the #3318 ~$0.43/PR full-lens baseline, distinguishing the floor's own cost from the
   `~$12.50 across 29 PRs` figure (#3313), which is the full-lens cost (29 × $0.43), not the floor's.

## Folded into #3330 (2026-09-24)

This card's scope sits entirely inside #3330 ("Always-on advisory sanity check over the no-reason PRs that
reach no reviewer"), which already required the floor and its cost measurement. Its genuinely new content —
the non-Claude provider default, the now-statute async/non-blocking footing (rule 7 of
`#delegation-trial-record-graduation`, ratified via #3867), the every-PR (Claude-built and delegated alike)
scope note, and the #3313 cost-baseline correction — has been merged into #3330's body. No independent work
should be scoped under this id; track it under #3330.

**Left `status: open` rather than closing it.** Nothing under this card has shipped, so `resolve` would book
points for undelivered work — the exact failure `we:backlog/2982-how-a-folded-duplicate-backlog-item-retires-foldedinto-point.md`
was opened over. `parkedReason: superseded` was retired 2026-06-22 (`we:src/_data/backlogMeta.js`) and
`status: folded` is #2982's own recommended-but-unratified fork, not yet implemented in the schema or
`check:standards`. #2982 is prepared (`preparedDate: 2026-08-17`) but not ratified; once it lands, retire
this card through that mechanism instead. Until then this note plus the existing `relatedTo: ["3330"]` is
the fold record, per `we:skills-src/consolidate-backlog-items/SKILL.md`'s own "fold = report only, no
mutation, pending the folded-duplicate retirement decision."
