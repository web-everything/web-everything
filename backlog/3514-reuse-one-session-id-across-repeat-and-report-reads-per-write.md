---
bornAs: x5c8zep
kind: story
size: 1
status: active
scope: ["we:scripts/measure-judge-spawn.mjs"]
dateOpened: "2026-09-06"
dateStarted: "2026-09-12"
tags: [cost, prompt-caching, measurement, operations]
crossRef: { url: /backlog/3369-decouple-agent-dispatch-from-the-claude-cli-introduce-a-mult/, label: "#3369 names this file among four spawn call sites" }
relatedReport: reports/2026-09-06-backlog-split-analysis.md
---

# Reuse one session id across `--repeat` and report reads-per-write

[`we:scripts/measure-judge-spawn.mjs`](../scripts/measure-judge-spawn.mjs) already holds its prompt prefix
byte-identical and already emits the raw cache split under `--json`. What it does **not** do is exercise the
warm-read case, because each iteration mints a fresh session id — so the one number #3006 actually wants,
**reads per write**, never appears.

## Precisely what is missing, and what is not

Not missing, verified: `MANDATE`, `INPUT` and `SHAPE` are module constants (lines 49–59) under the file's own
comment *"Held constant across both arms and across runs"*; `runOnce` returns `usage: o.usage` (line 91); and
`--json` emits `pairs`. Falsifier runnable today — `--repeat=3 --json` already prints
`pairs[].treatment.usage`.

Missing:
- lines 157 and 160 derive a **fresh session id per iteration**, so successive iterations never present the
  same session and no warm read is ever measured;
- the human-readable summary (lines 170–199) derives no reads-per-write or hit rate, though the data is there.

Hence `size: 1`. An earlier draft of this item called it "add a warm-prefix arm" and sized it 3 — that was
wrong, and the correction is recorded in the 2026-09-06 split analysis because the error class matters more
than the sizing.

## Relationship to #3369 is a crossRef, not a blocker

#3369's body names this file among four spawn call sites it will rewrite, but **neither of its children scopes
it** — #3370 scopes `we:scripts/lib/judge-spawn.mjs` and `we:scripts/operations/cli-adapter.mjs`, #3371 scopes
`we:scripts/lib/judge-spawn.mjs`. Different files, so there is no dispatcher collision and no real prerequisite
edge. A sweep confirmed no other open item claims this file.

## Done when

1. **Executable** — `--repeat=N` reuses one session id per arm and the summary prints reads-per-write and cache
   hit rate, stamped with the existing conditions block; a run with `N>1` reports a non-zero cache read where
   today it reports none.
2. The conditions discipline is preserved — no figure is printable without the block that produced it.
