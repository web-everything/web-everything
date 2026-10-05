---
name: hold-new-cards-while-busy
description: "Hold new backlog cards while the host is busy or the PR queue is not draining: collect them in ~/workspace/.operations/handoff/cards-to-file.md and file them in one lane and one PR when quiet and stable. Blocking issues are the exception: file and fix those now."
metadata:
  type: feedback
---

**While the host is busy or the PR queue is not draining, do not file new backlog cards. Collect them in
`~/workspace/.operations/handoff/cards-to-file.md`. File them (one lane, one PR) when the host is quiet and
stable.** Blocking issues are the exception: file and fix those now.

**Why:** operator ruling 2026-10-04 (handoff rule 21). Each filed card adds a PR and queued work, which
deepens an overloaded host and a stalled PR queue. Holding costs nothing, because the card text is kept
verbatim in the list.

**How to apply:** when you find a gap and the host is loaded (heavy-admission queue long, PRs stacking up),
append the card to the list with the date and the operator approval time if any. Do not run `file-item`.
When the host is quiet, file the whole list through the `file-item` operation in one lane and one PR, then
append a "FILED ... in PR #n" line to the list. If the issue blocks current work, skip the hold: file and
fix it now.
