---
bornAs: x20yczj
kind: decision
size: 2
parent: "3383"
status: open
dateOpened: "2026-11-16"
preparedDate: "2026-11-16"
preparedAgainstSha: "583f4e883d39e45b8d160fe9b7f397ccc925b7e3"
tags: []
related: ["3383,3443"]
---

# Decision: where next items come from (build-queue and plan, the 3383 priority list synced to main, or both)

Rule the source of "next items" for the orchestrator. Today the source is the `## Priority order` of #3383 on `lane/mechanical-dispatcher`. Prepared 2026-11-16.

## Recommended path at a glance

| Item | Default | Main alternative, and why it is not the default | Confidence |
| --- | --- | --- | --- |
| Fork 1 — source of next items | **(a) the build-queue and plan files** | (b) the #3383 list synced to `main`: it syncs a list frozen 8 weeks ago | High |

## Evidence

- Live users of the old source: the operator-level `/continue` and `/wip` slash commands, and `we:agent-memory-src/next-items-come-from-prototype-tracker-priority-order.md` (which tells the orchestrator to run a `git show` of that branch copy).
- The branch copy of #3383 was last changed 2026-09-24; the `main` copy 2026-09-19 and lacks 2190 lines the branch has. Neither is current.
- The build-queue and plan files in the handoff folder are rewritten daily (last 2026-11-16).
- #3891 landed the priority-order library on `main`, but the list the commands read still sits on the branch.

## Fork 1 — source of next items

*Fork-existence:* next-item picking reads one ranked list. Two lists that disagree cannot both be the source, so a precedence is forced.

- **(a) The build-queue and plan files. [default]** Change the `/continue` command, the `/wip` command (the priority reference only) and the memory file together to name them; mark the #3383 list historical.
- **(b) The #3383 priority list synced to `main`.** Keeps the card as the source and removes the branch read, but the list content is 8 weeks stale; someone must revive and maintain it, a second place to edit.
- **(c) Both.** Keep the card list as a long-range backlog and the queue files as the near-term pick. Rejected as default: two sources need a stated precedence, and the card list is not maintained.

**Skeptic:** SURVIVES-WITH-AMENDMENT. The attack that queue files are session-local scratch (not versioned on `main`) is true; amended: the ruling should say whether the handoff folder counts as durable, or the queue gets a tracked mirror. Note the `/wip` command's real dependency on the branch is `we:scripts/operations/wip-report-cli.mjs` (slice 3898), a separate matter.
**Screen:** clear.

## Done when

1. **Executable** — `grep -l '^## Ruling' we:backlog/*where-next-items*.md` lists this card (it fails until the operator has ruled and a `## Ruling` section names the chosen option for each fork).

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
