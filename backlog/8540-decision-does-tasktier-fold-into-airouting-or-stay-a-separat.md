---
bornAs: xnoz7ww
kind: decision
size: 2
status: open
dateOpened: "2026-11-16"
preparedDate: "2026-11-16"
preparedAgainstSha: "583f4e883d39e45b8d160fe9b7f397ccc925b7e3"
tags: []
related: ["7132,8380"]
---

# Decision: does taskTier fold into aiRouting or stay a separate setting

Card 7132 (held entry 263, operator "sounds good" 2026-10-12) proposes a `taskTier` setting. aiRouting (design 2026-11-14) came after it and also sets model and effort per role. Prepared 2026-11-16.

## Recommended path at a glance

| Item | Default | Main alternative, and why it is not the default | Confidence |
| --- | --- | --- | --- |
| Fork 1 — taskTier and aiRouting | **(a) fold taskTier into aiRouting as an optional tier table that roles may reference** | (b) separate setting: two settings name model and effort for one task, so precedence must be invented | Medium-high |

## Evidence

- 7132 asks for one cascade setting: task kinds map to tiers; each tier maps per vendor to a model and an effort; per-launch log names tier, model, effort and winning layer; it would supersede `codex.modelByTask`.
- aiRouting already has per-role `{provider, model, effort, account}`, one choke point (`routeForRole`), the same cascade helper and a log line with sources. Roles (review, fix, build, prepare, ci-heal, worker, judge, helper) are task kinds.
- `codex.modelByTask` is already one of the knobs aiRouting inherits from; no `taskTier` code exists in `scripts/`.

## Fork 1 — taskTier and aiRouting

*Fork-existence:* a launch has one winning model and effort. If both settings can set it, one must be beaten by the other; two independent owners cannot both be the source.

- **(a) Fold in. [default]** `aiRouting.tiers` names tiers; a role's entry may say `tier: "complex"` instead of repeating model and effort. Land after the aiRouting role PRs; 7132 is retitled to that slice.
- **(b) Separate cascade under aiRouting.** aiRouting `inherit` falls through to `taskTier`, which falls through to today's code. Two settings, two files, two validators, and a precedence rule to document.
- **(c) Drop taskTier.** Explicit per-role model and effort in aiRouting are enough. Rejected: loses the one-vocabulary tier idea the operator approved.

**Skeptic:** SURVIVES-WITH-AMENDMENT. The attack that tiers cut across roles (one tier for several roles, one role in two tiers by task) is real; amended: a role may carry a tier or explicit values, never both.
**Screen:** clear.

## Done when

1. **Executable** — `grep -l '^## Ruling' we:backlog/*does-tasktier*.md` lists this card (it fails until the operator has ruled and a `## Ruling` section names the chosen option for each fork).

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
