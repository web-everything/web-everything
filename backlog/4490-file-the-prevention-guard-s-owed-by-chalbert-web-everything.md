---
bornAs: xt4jynt
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/check-standards.mjs", "we:scripts/lib/citation-check.mjs", "we:scripts/lib/git-grep-gate.mjs", "we:scripts/lib/__tests__/git-grep-gate.test.mjs", "we:scripts/__tests__/citation-check.test.mjs", "we:scripts/__tests__/check-standards.test.mjs"]
dateOpened: "2026-09-29"
preparedDate: "2026-10-09"
preparedAgainstSha: "d94901c295a89f3bc92cc2377a7211bc9cf1f3c0"
tags: []
---

# File the prevention guard(s) owed by chalbert/web-everything#2943's independent review

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/check-standards.mjs:1783` — Extract a shared `runGitGrepGate(pattern, { emit })` helper into lib that all citation gates call. Unit-test its exit-1 and non-1 branches once, so every gate gets the guard.
2. `we:scripts/lib/citation-check.mjs:173` — A unit test asserting that an item missing `num` does not pollute the resolution set, or a structural validation/filter before calling `String()`.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#2943@eb93119506db1f5e3a8115135cb6ca5ceb46a1ad

## Done when

1. **Executable** — `npx vitest run we:scripts/lib/__tests__/git-grep-gate.test.mjs we:scripts/__tests__/citation-check.test.mjs we:scripts/__tests__/check-standards.test.mjs` (drop the `we:` prefix when typing it) fails before this item lands (the helper module does not exist; `buildBacklogResolvableIds([{}])` returns a set containing `"undefined"`) and passes after.

## Progress

- Premise check (2026-10-09, `main` d94901c): goal NOT delivered. `git log` shows only the filing commit (c6383dfa2) and its JIT renumber xt4jynt→#4490; no `runGitGrepGate` exists anywhere under the scripts tree.
- Drift corrected: the card's cites `we:scripts/check-standards.mjs:1783` and `we:scripts/lib/citation-check.mjs:173` moved. Current sites: raw `git grep` + exit-code handling at `we:scripts/check-standards.mjs:230` (`gitGrep`, swallows every error), `we:scripts/check-standards.mjs:288` (`scopedGrepLines`, status 1 → `[]`, else `null`), `we:scripts/check-standards.mjs:1827` (gate 6f-ii-c, catch-all swallow), `we:scripts/check-standards.mjs:1892` (gate 6f-ii-d, status≠1 → emit4 scan-error). Second guard: `buildBacklogResolvableIds` at `we:scripts/lib/citation-check.mjs:173` area (`String(b.num)`).
- Scope corrected: old scope named `we:scripts/__tests__/check-standards.test.mjs` and a non-existent `we:scripts/lib/__tests__/citation-check.test.mjs`. Real citation tests live in `we:scripts/__tests__/citation-check.test.mjs`; lib module tests live under `we:scripts/lib/__tests__/` (vitest only collects `we:scripts/**/__tests__/**/*.test.mjs`; a test placed beside its module is not run). New helper + its test (`we:scripts/lib/__tests__/git-grep-gate.test.mjs`) added to scope; `we:scripts/__tests__/check-standards.test.mjs` stays in scope for the gate-wiring test. size unchanged (3).

## Design

Guard 1 — new `we:scripts/lib/git-grep-gate.mjs` exporting `runGitGrepGate(pattern, { args, cwd, run = execFileSync, emit, kind, file })`. It runs `git grep --threads=1 -nE -e <pattern> -- <pathspecs>` with `maxBuffer` 16MB and returns `{ ok: true, lines }`. Exit status 1 → `{ ok: true, lines: [] }` (genuine no match). Any other failure (git missing, maxBuffer overflow, status ≥2) → calls `emit(message, { kind, file, global: true })` and returns `{ ok: false, lines: [] }`; it never returns a silent "clean" for a failed scan. `run` is injectable so the test needs no real git.
Wire it into the two gates that already parse `git grep -n` output: gate 6f-ii-d (`we:scripts/check-standards.mjs:1892`, replacing the hand-written try/catch with the same emit4 behavior) and gate 6f-ii-c (`we:scripts/check-standards.mjs:1827`, whose catch-all currently swallows real failures; it now emits via `emit3`, matching 6f-ii-d). `scopedGrepLines` (`we:scripts/check-standards.mjs:288`) keeps its `null`-fallback contract (callers use `??`) so it is left alone; `gitGrep` (`we:scripts/check-standards.mjs:230`, `-l -F`, different output shape) is out of the MVP.
Guard 2 — in `buildBacklogResolvableIds` (`we:scripts/lib/citation-check.mjs`), filter items to those with a string/number `num` (non-null, non-empty) before `String()`, so `{}`/`{num: undefined}`/`{num: null}` never add `"undefined"`/`"null"` to the set; also tolerate a non-object entry.

Review notes (folded in): (a) `buildBacklogResolvableIds` has other callers (`we:scripts/check-backlog-item.mjs`, `we:scripts/check-standards-rules.mjs`); the build must confirm none relies on the `"undefined"` entry (run their tests). (b) Wiring 6f-ii-c to `emit3` is a deliberate behaviour change: under `CITATION_GATES_ENFORCED` a git failure there now hard-fails instead of passing silently. (c) `runGitGrepGate` is a separate primitive from `we:scripts/lib/git-run.mjs`: it owns the grep-specific "status 1 = no match" contract; it may call that runner internally if its signature fits, otherwise stays on `execFileSync`. (d) The gate wiring is not unit-testable; the test plan adds a source assertion in `we:scripts/__tests__/check-standards.test.mjs` (`citation gates delegate scans and forward failures to their emitters`) that both gates call `runGitGrepGate` with `emit3`/`emit4` and that the raw `execFileSync('git', ['grep'` call is gone from them.

## MVP

Musts: (1) `runGitGrepGate` + unit tests of exit-1 and non-1 branches; (2) gates 6f-ii-c and 6f-ii-d call it; (3) `buildBacklogResolvableIds` filters bad `num`, with a test.
Out of scope (Follow-ups): migrating `gitGrep` (`-l -F`) and `scopedGrepLines`; migrating non-citation `git grep` call sites elsewhere.

## Test plan

In `we:scripts/lib/__tests__/git-grep-gate.test.mjs` (injected `run`; it must sit under `__tests__/` to match vitest's `we:scripts/**/__tests__/**/*.test.mjs` include glob — a test placed beside its module is silently not collected):
- exit status 1 → `{ok:true, lines:[]}` and `emit` never called. RED before: module missing.
- non-1 status (e.g. 128, and an `ENOBUFS` error with no status) → `emit` called once with the `kind`, `ok:false`. RED before: module missing; the 6f-ii-c catch-all would stay silent.
- success → lines split on newline, blanks dropped, pathspecs passed after `--`.
- a pattern starting with `-` is passed after `-e`, never parsed as an option.
- failure note keeps only the first line: injected `run` throws an `Error` whose `message` is multi-line → the string handed to `emit` contains the first line and none of the later lines. RED before: module missing.
In `we:scripts/__tests__/check-standards.test.mjs`:
- `citation gates delegate scans and forward failures to their emitters` — a source assertion that gates 6f-ii-c and 6f-ii-d call `runGitGrepGate` with `emit3` and `emit4` respectively and that the raw `execFileSync('git', ['grep'` call is gone from both. RED before: both gates still hand-roll the call, and 6f-ii-c's catch-all swallows real failures; it also fails if the helper is added but 6f-ii-c is left unmigrated.
In `we:scripts/__tests__/citation-check.test.mjs`:
- `buildBacklogResolvableIds([{num:'1'},{},{num:null},{num:undefined},null])` → set equals `{'1'}` (RED: contains `"undefined"`/`"null"`).
- numeric `num: 5` and `bornAs` hash still resolve (regression guard).

## Proof plan

Before/after on the live repo: a `node -e` call of `buildBacklogResolvableIds([{}])` shows `has('undefined') === true` before and `false` after. Run `check:standards` on the lane (stays green). Then drive `runGitGrepGate` with an injected failing `run` in a one-off script to show it emits the scan-error kind instead of reporting clean.

## Edge cases this change must handle

1. **Untrusted text** — the grep pattern is a fixed constant; the helper passes it via `-e` after fixed flags and keeps only the first line of `e.message` in the failure note. Tests: the `-`-leading pattern bullet (option parsing) and the multi-line-`message` bullet (first-line truncation).
2. **Truncated reads** — `maxBuffer` set; overflow (`ENOBUFS`) is a non-1 failure → emit, not "none". Tested.
3. **Shared state files** — n/a: no state file is read or written.
4. **Fail closed** — core of the change: only exit 1 means "no match"; every other outcome emits and returns `ok:false`.
5. **Identity scoping** — n/a: no keys; `buildBacklogResolvableIds` keeps both NNN and `bornAs` spellings (regression test).
6. **State over time** — n/a: stateless, per-run.
7. **Who wrote it** — n/a: no trust is granted from comments/refs/labels.

## Follow-ups

- Migrate `gitGrep` (`we:scripts/check-standards.mjs:230`) and `scopedGrepLines` (`we:scripts/check-standards.mjs:288`) onto `runGitGrepGate` (different `-l -F` shape / null contract).
- Sweep other raw `git grep` + catch-all call sites for the same fail-closed treatment.
