---
bornAs: xctsi6q
kind: decision
parent: "5488"
status: open
dateOpened: "2026-11-20"
tags: [decision-filing, plateau-app]
relatedTo: ["5488", "5785"]
preparedDate: "2026-11-20"
---

# When do GitHub labels stop being the source of truth?

Ask: Move label authority with each job's switch. Keep labels as display and accept only declared, authorized human commands through them.

## Digest

Prepared, not ratified. Two forced invariants replace the original single fork. #5488 owns migration order; this card defines authority and command ingestion. Grounding: end-state §1.1/1.7, norms research and Prow/Tide.

## Fork 1 — When authority moves off labels

One decision kind has exactly one authority.

Fork existence: the excluded branch is (b), because switched roles would still read labels as state.

- (a) **Per role, at its flip (default): authority register moves labels → stream; forge-sync writes display labels.** Require shadow/replay equivalence, N/N-1 claim generation visible to legacy, drain re-check and tested rollback. Keep legacy readers until the flip holds; after deletion, rollback cannot revive them.
- (b) Keep labels authoritative until the final role flips. *Excluded:* switched roles would still read labels as state. All roles may flip on the same day as a schedule under (a).

Evidence:
- `longshore-end-state-2026-11-20` §1.1/2.2/5; `longshore-conformity-tool-prep` CF-STATE-002.
- Prep counted 149 label readers at `cd0e13d14c` (matcher-dependent range 145–151); `we:scripts/lib/merge-gate-ci.mjs:49/:114` is a concrete authority reader.

Skeptic: SURVIVES-WITH-AMENDMENT; removed timing arguments, bounded rollback, classified register/claim shapes against Ship (#5407). Screen: clear.

## Fork 2 — What happens to human-set labels

Ignoring controls loses existing operator authority; reading them as state restores the defect.

Fork existence: (b) and (c) are the excluded branches; only the command registry keeps controls without a second authority.

- (a) **Declared command registry (default), covering additions and removals.** Log actor, event, PR, reviewed head and seq; authorize through operator policy, including delegated agents. Recognize kernel echoes by effectId/effect log, never shared bot identity. Separate kernel echoes, unflipped legacy-role writes and other authorized/refused commands.
- (b) Ignore labels. *Excluded:* loses hold/clear controls.
- (c) Read label presence as engine state. *Excluded:* violates one authority per kind.

Evidence:
- [Tide config](https://docs.prow.k8s.io/docs/components/core/tide/config/) and [Event Interception](https://martinfowler.com/articles/patterns-legacy-displacement/), fetched 2026-11-20.
- `rulings-active` rule 57, R931/R1035; `2026-11-20-ship-benchmark` SE-WI-001.

Skeptic: SURVIVES-WITH-AMENDMENT; effect-log echo detection avoids dropping real commands from shared identities; removal and legacy writes now explicit. Screen: clear.

## Supported by default

#5488 schedules flips (drain last); label names/colours remain display and external dashboards keep working. Ship owns observable state/register/claim shapes.

## Must-hold rules from the threat-model red team

- Authorize by GitHub user/App id, never login; human-only clears require signed-off records for the reviewed head.
- Clear commands name their head and refuse mismatch; label events supply no head.
- Dedupe/order by event id; refuse merges while missed events may exist.
- Labels read by old jobs as approvals must be head-bound, written after saved verdicts and removed first on withdrawal.
- Switch/rollback is logged/authorized; unreadable register refuses. Import holds, never approvals.

Details: `_redteam-format-group`.

## What ratifying unlocks

Authority-register and forge command-ingest slices; ci-heal first. “D3 yes” accepts both defaults.

## Trust boundary and threat model

Triage rights do not authorize commands. Unknown actors/commands refuse; never trust label presence as proof of a decision. Freeze reviewed heads and event identity.

Full prep (Standards decisions-prep set):

```text
D3-xctsi6q.md
```

Source and proposed artifact filenames (handoff references are by name only):

```text
2026-11-20-ship-benchmark.md
D3-xctsi6q.md
_redteam-format-group.md
longshore-conformity-tool-prep.md
longshore-end-state-2026-11-20.md
rulings-active.md
```
