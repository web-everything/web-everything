---
bornAs: xcw0nxo
kind: decision
parent: "3383"
status: open
dateOpened: "2026-09-23"
tags: []
---

# Review daemon running a live overlay vs the independent-review invariant

Open sub-question left by ruling #3681 (we:docs/agent/platform-decisions.md#resident-daemon-reload-lifecycle clause 7). The operator allowed every daemon, the review daemon included, to run live overlays (unmerged fix branches). we:docs/agent/platform-decisions.md#drain-daemon-self-hosting-boundary clause 3 says a self-updating daemon may never approve its own daemon-code change (the #809 self-approval hole), and the re-prep excluded review clones from unmerged code for that reason. The ruling did not say how the two fit: (a) the review daemon never clears a PR whose commits are in one of its own active overlays (it escalates or skips it); (b) clause 3 is amended so an overlay's graduation PR is always reviewed by a daemon not running it; (c) accept the risk and amend clause 3. No default was stated. Clause 3 stands unamended until this is ruled.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.
