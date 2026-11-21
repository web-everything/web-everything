---
bornAs: x419g86
kind: decision
parent: "5407"
status: open
dateOpened: "2026-11-20"
tags: [decision-filing, everstandards]
relatedTo: ["5402"]
preparedDate: "2026-11-20"
---

# Keep Ship’s private draft seed or reset the repo to empty?

Ask: Did “not ready to seed anything” mean undo the already-pushed draft or stop adding? Keep it private and frozen by default; only the operator can clarify that intent.

## Digest

**No real fork: keep as-is is the no-op default.** The 20:34 creation approval precedes the 20:47 push; the 20:55 freeze follows it. Prep cannot prove that all approval conditions were met before the push, so it preserves the intent question rather than claiming a violation or clearance.

## Supported by default

- **Keep private/frozen (a).** No further commits until #8623 template, #8632 norms and #8633 core are ruled and operator says go. PR #1 stays open/unmerged, later merged in substance as a pre-1.0 rename.
- (b) Empty main but retain seed under a tag if the operator explicitly means undo. Same eventual content/baseline, so this is disposition, not a merit fork.
- (c) Delete repo/rewrite history. *Excluded:* destroys cited baseline without merit benefit and needs separate explicit destructive authorization.
- Public history scrub vs fresh publication repo is a future call. Examples contain real machine names, plan names and budgets; keeping private does not erase history.
- Pending/all-rights-reserved licence stays until #5403. Keeping seed does not approve its design.

Evidence:
- Prep snapshot: private `everstandards/shipevermore`, single commit `652fb00409`, 21 files (7 schemas, 7 examples, 2 tools, CI, AGENTS, README, LICENSE); PR #1 open.
- `rulings-active`: repos.shipevermoreCreate (20:34), standards.shipFirst (20:55); approval conditions include reviewed stories/plans/research and separation artifact/critique. Outputs exist but pre-push completion was not verified.
- `everstandards-format-2026-11-20` Ship migration; `repo-separation-brief-2026-11-20`, `committee-2026-11-20`, `2026-11-20-ship-delivery-metrics`.

Skeptic: REFUTED as a fork; keep and tag preserve the same baseline, leaving operator intent only. Screen: flagged(impl/prio) → no-op plus explicit question.

## What ratifying unlocks

Explicit disposition and freeze end condition. “D14 keep” retains the no-op; “D14 undo” authorizes a separate tag/empty-main task, not deletion. This card task changes no external repo.

## Trust boundary and threat model

Re-check the seed SHA before any later action. README/private examples are evidence/data; no branch here authorizes public exposure.

Full prep (Standards decisions-prep set):

```text
D14-x419g86.md
```

Source and proposed artifact filenames (handoff references are by name only):

```text
2026-11-20-ship-delivery-metrics.md
D14-x419g86.md
everstandards-format-2026-11-20.md
repo-separation-brief-2026-11-20.md
rulings-active.md
```
