---
bornAs: x2rabof
kind: story
size: 3
parent: "3383"
status: open
scope: ["we:config/platformDefaults.ts", "we:config/defineConfig.ts", "we:config/index.ts", "we:config/__tests__/", "we:scripts/lib/backlog-id-settings.mjs"]
dateOpened: "2026-10-03"
preparedDate: "2026-10-09"
preparedAgainstSha: "6d9d737f3f528a9fde2f5e162cd5d5151abe0d72"
tags: []
---

# Declare the two backlog-id settings and their platform defaults, and refuse an unbuilt value

#3732 ruled (2026-10-03) that both backlog-id forks are configurable settings extending a platform default, per we:docs/agent/platform-decisions.md#config-extends-platform-default. Declare the two dimensions: where numbering happens (producer-at-pr-open default, integration-branch) and how far reach-main reaches (tip-tree default, full-history-squash). Add the resolver the other build stories read. A declared value that is not built refuses when selected, naming itself; it never falls back silently.

## Done when

1. **Executable** — a unit test under `we:config/__tests__/` proves each setting resolves to its platform default (`producer-at-pr-open`, `tip-tree`) when the project config is silent, and to an override when one is set. It fails before this lands (the dimensions do not exist) and passes after.
2. **Executable** — the same test proves that selecting `integration-branch` or `full-history-squash` returns a refusal that names the unbuilt value, and never resolves to the default.
3. The platform defaults are data only in `we:config/platformDefaults.ts`; WE holds no implementation (#1282). Statute: `we:docs/agent/platform-decisions.md#backlog-ids-numbered-before-publish`.

## Design

Mirror the `crossProviderFallback` dimension (4772), the closest precedent.

- `we:config/defineConfig.ts` (beside `CrossProviderFallbackPolicy`, line 92; keys go in `WebEverythingConfig` next to `crossProviderFallback`, line 130): add the unions `BacklogIdNumberingSetting = 'producer-at-pr-open' | 'integration-branch'` and `BacklogIdReachSetting = 'tip-tree' | 'full-history-squash'`, plus two optional keys on `WebEverythingConfig` (`backlogIdNumbering`, `backlogIdReach`) typed `DimensionEntry<…>`. Both unions list the unbuilt value so it can be declared.
- `we:config/platformDefaults.ts`: add the two defaults as data to `PLATFORM_FLAVOR_DEFAULTS` (`producer-at-pr-open`, `tip-tree`), and a data-only `PLATFORM_BACKLOG_ID_BUILT_VALUES` listing which values are built (the two defaults only; the statute says "the two defaults are the only values this ruling asks to be built").
- Resolver lives in repo tooling, NOT in WE's TS (statute rule 3: "the resolver and enforcement code live in the repo tooling"; `we:config/defineConfig.ts` says it resolves nothing; #1282). New `we:scripts/lib/backlog-id-settings.mjs` exports `resolveBacklogIdSetting(dimension, config)`, a pure function, plus a mirror of the two defaults and the built-values list (`.mjs` cannot import the TS file; the same mirror-and-pin pattern as `we:scripts/lib/pr-merge-gate.mjs`). The unit test under `we:config/__tests__/` imports it and pins the mirror to `PLATFORM_FLAVOR_DEFAULTS` / `PLATFORM_BACKLOG_ID_BUILT_VALUES`, so Done-when 1 and 2 are met and the two copies cannot drift.
- Entry rules (resolves the string ambiguity: `isDimensionPointer` at `we:config/defineConfig.ts:213` treats any string as a pointer). Key absent gives the default. A bare string that is one of the dimension's declared values is read as that value (inline); any other bare string is a pointer and returns `unreadable-entry`. An `extendsFlavor` descriptor gives `overrides` if set, else `flavors[0]`. A descriptor or object value that is not a declared value returns `unknown-value`. A declared but unbuilt value returns `unbuilt-value`. Null, numbers, arrays return `unreadable-entry`. Result shape: `{ ok: true, value }` or `{ ok: false, refusal, value, reason }`, `reason` naming the value. A refusal never carries the default.
- `we:config/index.ts`: export the new types, defaults and built-values list (data only).
- Scope: `we:scripts/lib/gate-config.mjs` dropped (trust-chain path list, unrelated); `we:scripts/lib/backlog-id-settings.mjs` added.

## MVP

Musts only: the two declared dimensions, their platform defaults as data, the built-values list, the pure resolver (in tooling) with refuse-by-name behaviour, its pinned defaults mirror, the barrel export, and the unit test. OUT (see Follow-ups): wiring the resolver into any script, reading a real project config file, building either non-default value.

## Test plan

New `we:config/__tests__/backlog-id-settings.test.ts` (vitest, same style as `we:config/__tests__/config-contract.test.ts`). Every case fails RED before the change because the module and exports do not exist (an import-level RED; the behaviour cases then pass only once the resolver implements them):
1. Silent config `{}` resolves numbering to `producer-at-pr-open` and reach to `tip-tree` (Done-when 1).
2. Override: an inline value and an `extendsFlavor` with `overrides` resolve to the override (asserts override precedence).
3. `integration-branch` returns `ok: false`, refusal `unbuilt-value`, `reason` contains `integration-branch`, and the result is not the default (Done-when 2).
4. Same for `full-history-squash`.
5. An `extendsFlavor('bogus')` descriptor returns `unknown-value`, not the default.
6. A bare string that is not a declared value (read as a pointer), `null`, or a number returns `unreadable-entry`, not the default; a bare declared string (`'tip-tree'`) resolves inline.
7. The mirror equals `PLATFORM_FLAVOR_DEFAULTS` for both keys, and `PLATFORM_BACKLOG_ID_BUILT_VALUES` equals exactly the two defaults, explicitly excluding `integration-branch` and `full-history-squash` (Done-when 3, and no drift).
8. The two settings are independent (an unbuilt value in one does not change the other).
9. A hostile value with newlines and backticks yields a one-line `reason`.

## Proof plan

Write the test first and run it with vitest in the lane before the module exists (RED: import failure), then after (GREEN). Then a `node -e` probe importing the `.mjs` resolver and printing the result for `{}`, an override, and `integration-branch`, showing default, override and a named refusal. Gate via the npm scripts (they go through heavy-admission): `npm run check:standards` stays green.

## Edge cases this change must handle

1. Untrusted text: `reason` embeds the configured value; fold newlines and backticks so a hostile config string cannot inject lines (test case 9).
2. Truncated reads: n/a: pure function over an in-memory object, no `gh`/`git` read.
3. Shared state files: n/a: no file is read or written.
4. Fail closed: every unreadable or unrecognised entry returns a named refusal, never the default (cases 3 to 6).
5. Identity scoping: n/a: global setting names, no repo/PR key.
6. State over time: n/a: stateless pure function.
7. Who wrote it: n/a: the resolver grants no trust; it reads a value the caller passes in.

## Follow-ups

- Wiring the resolver into the scripts that read the setting: stories #4987 and #4988.
- Loading a real project config file (the string-pointer case) in the repo tooling.
- Building `integration-branch` and `full-history-squash` (not asked by the ruling).

## Progress

- Premise check 2026-10-09: `git log` for `4985`/`4985` shows only the numbering commit; no backlog-id setting exists in `we:config/`. Not delivered.
- Scope drift corrected: dropped `we:scripts/lib/gate-config.mjs` (trust-chain path list, no config settings); added `we:config/index.ts` (the barrel must export the resolver). Goal and size unchanged.
- Review round 1: moved the resolver from WE's TS to repo tooling (statute rule 3, #1282), defined the bare-string rule, fixed line refs and the vitest path.
