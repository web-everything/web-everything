# Bun vs vitest for scripts/__tests__ (perf item 72b)

Decision: **no switch. Default stays vitest.** `npm run test:bun:scripts` is opt-in, for measurement only.
Condition was: clearly better on BOTH a big run and 1-5 file runs. It fails on the big run and ties on small runs.

Bun 1.4.2, `--isolate --preload ./bun-test.preload.ts`, `check-standards.test.mjs` excluded from both. Host: 12 cpu, load 10-27 (shared, noisy).

## Big run (scripts/__tests__, one run each)
| Runner | Wall | Peak RSS | Result | Load at start |
|---|---|---|---|---|
| vitest | 216 s | 1.8 GB | 6906 pass, 13 skip, 0 fail (183 files) | ~10 |
| bun | 1150 s | 2.9 GB | 7219 pass, 17 fail (219 files) | ~10 |

Bun is 5.3x slower and 1.6x heavier. Only one big run each (time box).

## Small run (gemini-direct-task, operator-queue, lane-drain-numbering), 3 runs each
| Run | vitest wall / RSS / load | bun wall / RSS / load |
|---|---|---|
| 1 | 30.6 s / 471 MB / 14.3 | 28.8 s / 153 MB / 13.9 |
| 2 | 30.1 s / 474 MB / 17.7 | 29.2 s / 152 MB / 26.9 |
| 3 | 28.0 s / 468 MB / 20.6 | 28.0 s / 148 MB / 18.9 |

Wall time is a tie (tests dominate, not startup). Bun uses about 1/3 the memory.

## Bun failures (17), by category
- Subprocess / `process.execPath` is Bun, not Node: backlog.mjs CLI ephemeral-clone smoke (claim, resolve), we-scan parity (4), prototype-tracker real command line, per-file backlog index.
- `gh`/git fixture and stub differences: pr-land --delegation (3), #4874 commits-file shape, merge-ai-prs 500+ PR fixture, local timeout retry admission.
- `it.each` `%j` / `%s` title formatting not supported: feedback capture contract, guard-monitor-subagent.
- Other: finding-1 header fence test.
Not triaged one by one (out of scope for 72b).
