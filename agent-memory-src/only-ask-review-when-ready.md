---
name: only-ask-review-when-ready
description: Never ask the operator to review a PR until it is out of draft, checks are green, and the advisory review and red-team have run on its current head
metadata:
  type: feedback
---

Only put a PR in front of the operator for review when it is actually ready: not a draft, required checks green (or only red from the review hold itself), and the advisory review plus the red team have finished on the CURRENT head. Before listing a PR as "your review", check it with `gh pr view <n> --json isDraft,labels,statusCheckRollup`.

**Why:** on 2026-10-26 the orchestrator listed #6001, #6002, #6003 and plateau-app #227 as "your review, in order" right after a worker opened them. All four were drafts with failing or pending checks and no advisory review (the review daemon was frozen). Operator: "Ok so you should not have told me to review".

**How to apply:** when a worker opens a PR that will need a human, say "opened, I'll bring it to you when it's ready". Track it, and present it only once the readiness check passes.
