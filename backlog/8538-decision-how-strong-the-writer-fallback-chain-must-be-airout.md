---
bornAs: xe4a0ie
kind: decision
size: 2
status: open
dateOpened: "2026-11-16"
preparedDate: "2026-11-16"
preparedAgainstSha: "583f4e883d39e45b8d160fe9b7f397ccc925b7e3"
tags: []
related: ["8380,8299"]
---

# Decision: how strong the writer fallback chain must be (aiRouting fix-chain strength rule)

Context: card 8380 part (a), and the aiRouting design note in the handoff folder (code-writing chains must end with Claude; every safety check runs after). Prepared 2026-11-16.

## Recommended path at a glance

| Item | Default | Main alternative, and why it is not the default | Confidence |
| --- | --- | --- | --- |
| Fork 1 — strength rule for writer chains | **(c) keep today's hard rule (ends with Claude, unique, known ids) and add a warning when a later rung is weaker than an earlier one** | (b) refuse non-monotonic chains: needs a rank table that cannot order argon against codex-alt | Medium |

## Evidence

- `we:scripts/lib/fix-executor-chain.mjs` already refuses a chain unless it ends with `claude`, has unique rungs and only known ids. It does not check order: `[codex-alt, codex, claude]` is accepted.
- Rungs are provider/model/effort profiles (`codex`, `codex-alt` gpt-6-astra high, `argon` gemini-4-argon-high, `claude`). There is no strength number; vendors do not compare on one scale.
- `criticalClaudeFromRung` (default 2) already sends critical work to Claude from that rung, so a weak-first order costs a retry, not a wrong writer on critical work.

## Fork 1 — strength rule for writer chains

*Fork-existence:* a chain either refuses an out-of-order list or accepts it. Both cannot hold for the same input.

- **(a) Only today's hard rule.** No order check; silent inversion.
- **(b) Refuse non-monotonic chains.** Fails closed, but needs a maintained rank table, and `argon` versus `codex-alt` has no honest order. The refusal would reject valid operator intent.
- **(c) Accept any order; log a warning per inversion; keep the hard rule. [default]** Evidence above: the cost of inversion is bounded by `criticalClaudeFromRung`. The warning pairs with 8380 part (b), the warning on resolver fallback. Promote to (b) if a rank table is ever needed elsewhere.

**Skeptic:** SURVIVES. The attack that (c) lets a bad chain run silently is answered by the warning and the existing critical-work gate.
**Screen:** clear.

## Done when

1. **Executable** — `grep -l '^## Ruling' we:backlog/*how-strong-the-writer*.md` lists this card (it fails until the operator has ruled and a `## Ruling` section names the chosen option for each fork).

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
