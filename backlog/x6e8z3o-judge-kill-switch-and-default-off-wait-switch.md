---
kind: story
size: 3
parent: "xaojq81"
status: open
blockedBy: ["xfnv9ay"]
scope: ["we:scripts/lib/judge-switches.mjs", "we:scripts/conveyor/judge-switch.mjs", "we:scripts/lib/__tests__/judge-switches.test.mjs"]
dateOpened: "2026-10-03"
preparedDate: "2026-10-03"
preparedAgainstSha: "e1f0523e0881357fc863f3e88da72e0164eb7091"
tags: []
---

# Judge kill switch and default-off wait switch

A machine-local switch store with set/clear/status verbs turns the independent judge off without a PR (fail-closed: an unreadable store means judge off) and holds an optional N-hour wait before the judge may clear, default off so a judge clear is immediate.

Builds rules 5–6 of `we:docs/agent/platform-decisions.md#independent-judge-clears-review-human-outside-protected-list` (decision xne1udi). Nothing reads the switches yet; `xfnv9ay` takes the state as input and `xq3kn88` / `xfetp9j` read it.

## Design

Mirror the shape of `we:scripts/readiness/dispatch-pause.mjs` (a single advisory state file, SET / CLEAR / STATUS verbs, atomic temp-file-then-rename write, env-var path override) with one deliberate inversion: **this store fails CLOSED**. The dispatch pause fails open because a missing file must not stop work; here a missing or broken file must not let the judge clear.

- **Pure core** `we:scripts/lib/judge-switches.mjs`: `parseJudgeSwitches(raw)` → `{ judgeEnabled, waitHours, by, at, reason }`, and `planJudgeSwitchWrite(current, verb, args)`.
  - **The judge is ON only when the store says so.** `judgeEnabled` is `true` only when the file exists, parses, and holds `judgeEnabled: true`. **The file does not exist → `judgeEnabled: false` (fail closed), with `parseError: 'store-absent'`.** An absent store is not a safe default: a store that vanishes, is deleted, or is looked for in the wrong place must stop the judge, never start it. The operator's ruling to run the judge now is carried out by one explicit `on` command (the verb below), which creates the store; nothing turns the judge on by default.
  - The file exists but is unreadable, not JSON, or has a wrong-typed field → `judgeEnabled: false` (fail closed), with a `parseError` field naming why.
  - `waitHours` defaults to 0 (wait off, the ruled default) whenever the store is readable and sets no wait. It must be a whole number from 0 to 168; anything else is refused at write time, and read as `judgeEnabled: false` if found on disk.
- **Store location is fixed, not derived from the lane or process.** One JSON file named `judge-switches` (with the JSON extension) in the operator-owned coordination folder `workspace/.operations/coordination` under `<home>`, where `<home>` is the OS account's home directory from the password database (`os.userInfo().homedir`), **not** `$HOME`, not the working directory, not the git toplevel, not the lane clone, and **not** `WE_COORDINATION_ROOT` (that variable can be set per process, and a lane or a test run could point it at an empty directory where the file is "absent" or at a forged file where it says ON). The path is one exported constant, `JUDGE_SWITCHES_PATH`, defined in `we:scripts/lib/judge-trusted-paths.mjs` (`xfnv9ay`, which also feeds the guard hooks) and imported here, never redeclared; **there is no environment variable and no flag that changes it**. Every lane, the conveyor and the runners read the same one file. The file is outside the repo, so a PR cannot edit it, and lane sessions are denied writes to it by the guard hooks (`xfnv9ay`, Must 3b: `guard-bash` denies the `on`, `off` and `wait` verbs and any direct write to the path, `guard-lane` denies Edit and Write; `status` and reads stay allowed) — "outside the repo" alone would not stop a lane agent running as the same account from switching the judge back on; its writer code (`we:scripts/lib/judge-switches.mjs`, `we:scripts/conveyor/judge-switch.mjs`) is on the protected list (`xfnv9ay`). Tests never touch the real path: the pure functions take the path and an `fs` as arguments, and only the CLI/readers call them with the constant.
- **CLI** `we:scripts/conveyor/judge-switch.mjs` with verbs `off --reason=…`, `on --reason=…` (creates the store, including the parent folder, if absent), `wait --hours=N --reason=…` (N=0 turns the wait off), and `status`. `--reason` is required for every write and is stored with `by` (the `CLAUDE_CODE_SESSION_ID` actor, else the OS user) and `at`. `status` prints the resolved path, the state and any parse error. No verb needs a PR: the file lives outside the repo.

## MVP

1. Must turn the judge off with one command and no PR, and back on the same way.
2. Must read as judge OFF when the store is unreadable, malformed or wrong-typed (fail closed). Must treat a hand-edited file as data to validate, never as trusted.
3. Must read as judge OFF when the store does not exist (fail closed): the judge runs only after an explicit `on`. The wait defaults to none (the ruled default) once the store is readable.
3a. Must read the one fixed store path (`JUDGE_SWITCHES_PATH`, from the OS account's home), independent of the lane, the working directory, `$HOME` and `WE_COORDINATION_ROOT`; there is no override by environment variable or flag.
4. Must hold an N-hour wait when set and none when N is 0; must refuse an out-of-range N at write time.
5. Must write atomically, so a reader never sees half a file.

## Done when

1. **Executable — Musts 2–5:** a Vitest run of `we:scripts/lib/__tests__/judge-switches.test.mjs` passes; the file does not exist before this item.
2. **Observable — Musts 1, 3, 3a:** from a lane clone, with `WE_COORDINATION_ROOT` set to an empty scratch folder and `HOME` set to another scratch folder, the `we:scripts/conveyor/judge-switch.mjs` CLI's `status` prints the same fixed path under the real account home in both cases; with no store it shows OFF (`store-absent`); `on --reason=test` then `status` shows ON; `off --reason=test` then `status` shows OFF. Output pasted in the PR, and the real store left in the state the operator wants (off until they run `on`).

## Test plan

New `we:scripts/lib/__tests__/judge-switches.test.mjs` (matching sources: `we:scripts/lib/judge-switches.mjs`, `we:scripts/conveyor/judge-switch.mjs`):

- **The kill switch blocks:** after `off`, `parseJudgeSwitches` returns `judgeEnabled: false`. Red today: the switch store does not exist.
- **No file → judge OFF:** an absent store → `judgeEnabled: false`, `parseError: 'store-absent'`; after `on` it reads `judgeEnabled: true` with `waitHours: 0`; deleting the file afterwards reads OFF again. Red today: the switch store does not exist.
- **The store path is fixed:** `JUDGE_SWITCHES_PATH` equals the `judge-switches` JSON file inside `workspace/.operations/coordination` under `os.userInfo().homedir`; setting `WE_COORDINATION_ROOT`, `HOME` or the working directory to another folder (and a `WE_JUDGE_SWITCHES_PATH` variable, which must be ignored) does not change it, and a forged `judge-switches` file placed inside the folder `WE_COORDINATION_ROOT` names, saying ON, is never read. Red today: the switch store does not exist.
- A store holding a truncated `{`, an array, `judgeEnabled` as a string, or a negative `waitHours` → `judgeEnabled: false` with a `parseError`. Red today: the switch store does not exist.
- **The wait switch off → immediate:** `wait --hours=0` stores `waitHours: 0`; `wait --hours=6` stores 6; `wait --hours=999` and `wait --hours=1.5` are refused at write. Red today: the switch store does not exist.
- A write without `--reason` is refused. Red today: the switch store does not exist.
- The atomic write leaves no temp file behind and never exposes partial JSON (write through an injected fs and assert one rename). Red today: the switch store does not exist.

## Proof plan

Write the test file first and capture its failure against the missing modules. After the build, run it and paste the output. Then run the CLI live against the real fixed store (Done-when 2), with `WE_COORDINATION_ROOT` and `HOME` pointed at scratch folders to show the path does not move, and a hand-corrupted store to show `status` reporting OFF with the parse error (restore the store afterwards). Finally `npm run check:standards`.

## Follow-ups

- A digest line saying when the judge was off for part of the day belongs to `xfbj1fa`.
- Showing the switch on the operator console is a later UI card, not part of this ruling.
- Turning the judge on after this lands is one operator command (the `on --reason=…` verb of the `we:scripts/conveyor/judge-switch.mjs` CLI); the store being absent means OFF, so nothing clears until that command is run.

## Progress

- Prepared 2026-10-03 against `we:scripts/readiness/dispatch-pause.mjs` (the existing kill-switch shape, which fails open — inverted here on purpose) and `we:scripts/operations/coordination-root.mjs` (the machine-wide state root, whose `WE_COORDINATION_ROOT` override is deliberately NOT honoured here: the store path is one fixed constant). Revised after review: an absent store reads OFF (it first read ON), and the env override was removed.
