---
bornAs: xxxvqhp
kind: decision
size: 2
parent: "3443"
status: open
dateOpened: "2026-11-16"
preparedDate: "2026-11-16"
preparedAgainstSha: "583f4e883d39e45b8d160fe9b7f397ccc925b7e3"
tags: []
related: ["3443,3857,4208"]
---

# Decision: lift the 2026-09-22 faithful-port hold now that aiRouting parts 1-2 are on main

The operator's 2026-09-22 hold reads: faithful port, nothing dropped, no slice until routing works (`we:backlog/3443-graduate-origin-lane-mechanical-dispatcher-to-main-in-small.md` line 216). aiRouting PR1 and PR2 are on `main`. Prepared 2026-11-16.

## Recommended path at a glance

| Item | Default | Main alternative, and why it is not the default | Confidence |
| --- | --- | --- | --- |
| Fork 1 — the hold | **(a) lift it for the slice cards, in their blockedBy order** | (b) keep it until aiRouting PR3-PR10 (every role migrated): a long wait that blocks live-used slice 3898 | Medium-high |

## Evidence

- The slice cards already say "Hold lifted 2026-09-24: the #3857 model-tier table passed a live probe and the operator started wave A" (3900 to 3910, 10 cards). The 3443 card still shows the hold ON (lines 207 and 236, then 216), so the record disagrees with itself.
- "Routing works" is on `main`: #3857 (model-tier table), #4208 (dispatch routing slice of 3906, resolved 2026-09-26), `we:scripts/lib/ai-routing.mjs` and `we:scripts/settings/ai-routing.json` (PR1 and PR2).
- Overlap risk is real: aiRouting PR4 (build/prepare) edits `we:scripts/operations/dispatch-lane-io.mjs`, which slice 3906 also ports (diff-merge).
- Today only two slash commands read branch code (census); lifting changes nothing for them until a slice lands.

## Fork 1 — the hold

*Fork-existence:* the hold either blocks slice dispatch or does not. One state is true at a time, and the cards currently carry both.

- **(a) Lift it; slices dispatch in blockedBy order. [default]** Record the lift on the 3443 card. Sequence 3906 (and any slice touching `we:scripts/operations/dispatch-lane-io.mjs`) after the aiRouting build/prepare PR, so the two do not collide. Whether a slice ports faithfully or by capability is the graduation-strategy decision's call, not this card's.
- **(b) Keep it until every aiRouting role migrates (PR3-PR10).** Safest against merge conflicts, but the wait is open-ended and holds up `/wip`'s dependency (3898).
- **(c) Lift it only for slices that do not touch dispatch files.** A middle path; it reduces to (a) plus the sequencing note, so it is folded into (a).

**Skeptic:** SURVIVES. The attack that "routing works" was meant as the whole aiRouting program failed: the operator's own 09-24 lift on the slice cards accepted the #3857 table as "routing works".
**Screen:** clear.

## Done when

1. **Executable** — `grep -l '^## Ruling' we:backlog/*lift-the-2026-09-22*.md` lists this card (it fails until the operator has ruled and a `## Ruling` section names the chosen option for each fork).

## Non-goals

- [N1] This card does not build anything; building is the follow-up the ruling files.

## Edge cases this change must handle

1. **Untrusted text** — n/a: a ruling card; no input is parsed.
2. **Truncated reads** — n/a: a ruling card; no reader.
3. **Shared state files** — n/a: no state file is written by the ruling itself.
4. **Fail closed** — n/a: until the operator rules, nothing changes; the status quo stays.
5. **Identity scoping** — n/a: only the operator rules.
6. **State over time** — the census facts are dated 2026-11-16; re-check them if the ruling waits past one week.
7. **Who wrote it** — prepared by an agent from the cited evidence; the operator ratifies or overrides.
