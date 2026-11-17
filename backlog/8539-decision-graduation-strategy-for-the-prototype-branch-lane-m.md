---
bornAs: xkxoyp0
kind: decision
size: 2
parent: "3383"
status: open
dateOpened: "2026-11-16"
preparedDate: "2026-11-16"
preparedAgainstSha: "583f4e883d39e45b8d160fe9b7f397ccc925b7e3"
tags: []
related: ["3443,3802,3906"]
---

# Decision: graduation strategy for the prototype branch lane/mechanical-dispatcher (whole-branch port, capability port, or superseded)

Rule how epic `we:backlog/3443-graduate-origin-lane-mechanical-dispatcher-to-main-in-small.md` ends. The branch is 314 commits ahead of `main` and frozen since 2026-09-24 (8 weeks). Evidence: the graduation census in the handoff folder (2026-11-16, read-only census of the 13 slice cards). Prepared 2026-11-16.

## Recommended path at a glance

| Item | Default | Main alternative, and why it is not the default | Confidence |
| --- | --- | --- | --- |
| Fork 1 — how the epic ends | **(b) capability port: port only what `main` lacks, by file, with a fresh diff; retire the rest into cards** | (a) faithful whole-branch port: the 09-22 rule, but 8 weeks of drift make each slice a re-diff anyway | Medium-high |

## Evidence

- 12 of 13 slices still PORT (the key files are absent on `main`); 1 (3906) is largely superseded by #4208 (resolved 2026-09-26) with residue; 0 are a clean DROP.
- Caveat: the census checked file presence only. A missing file proves the file is missing, not that no other-name capability exists on `main` (3899 host-sampler and 3906 overlap `main` code under other names).
- Live users depend on branch-only code: `/wip` runs `we:scripts/operations/wip-report-cli.mjs` from the branch (slice 3898); `/continue` reads the branch copy of #3383 (see the next-items decision).
- Ordering on the cards: 4180 and 4178 block most slices; 3910 (tail sweep) comes last. Porting is by file with a fresh diff, never a branch merge.

## Fork 1 — how the epic ends

*Fork-existence:* the epic either ports the branch whole, ports only a computed delta, or closes with no port. These cannot all hold: (a) needs every branch file landed, (c) needs none, and (b) lands a subset chosen per capability.

- **(a) Faithful whole-branch port.** Every slice lands as the branch built it (the 2026-09-22 rule, "nothing dropped"). Cost: 12 slices of re-diffing against an `main` that moved 8 weeks (3487 alone is +918 runner lines; 3908 has two merge bases); also lands code nobody uses.
- **(b) Capability port. [default]** Per slice, re-diff against current `main`, port only the capability `main` lacks, and file each skipped branch file as a short retire card that names why (superseded, no live user, or too stale). Start with the live-used slice 3898 (`/wip`), then follow the cards' own blockedBy order. Evidence: the census shows `main` already has equivalents for parts of 3906, 3899, 3904, 3905; (b) is the only option that spends effort on what is missing, and it still ends with an explicit record for every branch file.
- **(c) Declare the branch superseded and close epic #3443 with cards.** Rejected as default: 12 of 13 slices still lack their files on `main`, and `/wip` depends on one. It would strand live tooling. Revisit per slice, not for the whole epic.

**Skeptic:** SURVIVES-WITH-AMENDMENT. The attack was that the census is file presence only, so (b) rests on a weak "main lacks" test; amended: each slice's first step is a capability check by behaviour (run the branch test against `main`), not file presence. The second attack, that (b) loosens the operator's "nothing dropped" rule, is real: the ruling must name that (b) replaces it with "nothing dropped silently".
**Screen:** clear. The question stands without the dates: whole port versus delta port versus close.

## Done when

1. **Executable** — `grep -l '^## Ruling' we:backlog/*graduation-strategy-for*.md` lists this card (it fails until the operator has ruled and a `## Ruling` section names the chosen option for each fork).

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
