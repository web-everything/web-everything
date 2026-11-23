---
bornAs: xykd1x3
kind: story
size: 2
status: open
scope: ["plateau:src/wip/wip-read.ts", "plateau:src/wip/wip-read.test.ts"]
dateOpened: "2026-09-28"
preparedDate: "2026-09-30"
preparedAgainstSha: "c95b5628eb1aefc7b7e52a12cd9fb17597303dce"
tags: []
---

# /wip reads the conveyor queue from the old in-checkout location

**Scope.** plateau:src/wip/wip-read.ts's conveyor-queue read only (~L307). Audited every /wip file
(plateau:src/wip/*.ts) for other `.conveyor/` reads that might have moved the same way (dispatch-pause,
land-advance opt-in) — none exist today; only this one hardcodes the old path.

**Problem.** It does `join(weRoot, ...)` down to `we:.conveyor/queue.json` — the pre-#2816 in-checkout location. Since
we:scripts/lib/automation-home.mjs (we:backlog/4288, epic we:backlog/4075) landed, the live queue lives in the
automation state home; the canonical resolver is we:scripts/conveyor/queue-store.mjs's exported
`resolveQueuePath()` (falls back through `legacyQueuePaths()` for a one-release compat read). /wip's "Queued"
count and rows are silently reading a stale/empty file.

**Fix.** Dynamic-import `resolveQueuePath` from `weRoot` at read time, the way plateau:src/wip/stranded-read.ts
already loads we:scripts/backlog-stranded-sweep.mjs (`pathToFileURL(...).href` + `await import`) — no copied
path logic, no new hardcoded string.

**Risks.** An older sibling WE checkout may predate the new export. Keep the existing `attempt()` fallback
(empty array, `conveyor-queue` degraded) so a stale `weRoot` degrades honestly instead of throwing raw — same
shape as today's ENOENT handling.

**Tasks.** (1) swap the `join(...)`+`readFileSync` read for the dynamic-imported resolver; (2) keep the
degraded-fallback shape; (3) update/add the test doubles above; (4) `npm test` in plateau-app.

## Design

Premise re-checked against current `main` (2026-09-30): still live. plateau:src/wip/wip-read.ts:307-314 wraps
`JSON.parse(readFileSync(join(weRoot, '.conveyor', …)))` in `attempt('conveyor-queue', [], …)`, with
ENOENT → `[]`. Nothing else in plateau:src/wip/*.ts reads `.conveyor/`. The WE side is as the card says:
we:scripts/conveyor/queue-store.mjs exports `resolveQueuePath()` (:222, state-home path, `CONVEYOR_QUEUE_FILE`
override) and `readQueueFile(path?)` (:260), which already does the legacy-location fallback via
`resolveQueueSource` (:250), parses through `parseQueue`, and returns `[]` on a missing/corrupt file.

Mechanism: add a small `loadQueueStore(weRoot)` beside the read in plateau:src/wip/wip-read.ts (or a sibling plateau:src/wip/queue-read.ts),
copying `loadSweepCore` in plateau:src/wip/stranded-read.ts:63-68 — `await import(/* @vite-ignore */
pathToFileURL(join(weRoot, …, we:scripts/conveyor/queue-store.mjs)).href)`, throwing a plain Error if the module
lacks `resolveQueuePath`/`readQueueFile`. The `conveyor-queue` `attempt()` becomes `async` and returns
`store.readQueueFile(store.resolveQueuePath())` — the resolver stays the single path authority and the legacy
one-release fallback comes for free, so no path string and no ENOENT branch remain in plateau. A stale sibling
`weRoot` (no export, or no file) throws inside `attempt()` → `[]` + `conveyor-queue` in `degraded`, exactly today's
honest-degrade shape. Env note: the publisher process resolves the state home through the same
`we:scripts/lib/automation-home.mjs` default the conveyor writes to, so no env plumbing is added.

## MVP

Musts only: (1) the conveyor-queue read goes through the dynamic-imported `resolveQueuePath()`/`readQueueFile()`
from `weRoot`; (2) an old-shaped `weRoot` degrades to `[]` + `conveyor-queue` degraded, never a raw throw; (3) the
tests below. OUT of scope (Follow-ups): caching the imported module across reads, and surfacing WHICH source
(canonical vs legacy) the queue came from on the page.

## Test plan

In plateau:src/wip/wip-read.test.ts (currently no conveyor-queue case; the fixture `weRoot` is a tmp dir like the
stranded suite at :376+):
- **reads via the resolver, not a hardcoded join** — tmp `weRoot` with `we:scripts/conveyor/queue-store.mjs` stub whose
  `resolveQueuePath` points at a state-home file holding `[{num:'4341',addedAt:…}]` while `<weRoot>/we:.conveyor/queue.json`
  holds a different stale entry; asserts `cleared` equals the state-home entries. RED today: the old code reads the
  stale in-checkout file.
- **old-shaped `weRoot` degrades** — tmp `weRoot` whose `we:scripts/conveyor/queue-store.mjs` exports no `resolveQueuePath`; asserts
  `cleared` is `[]` and `degraded` contains `conveyor-queue`, no throw. RED today: the old code silently returns the
  stale file with no degrade.
- **missing module degrades** — `weRoot` with no `we:scripts/conveyor/` at all → `[]` + degraded (guards the import
  failure path).
- **resolver present, `readQueueFile` missing** — stub exporting only `resolveQueuePath` → `[]` + degraded.
- **happy path, empty queue** — stub returns `[]` → `cleared` is `[]` and `degraded` does NOT contain `conveyor-queue`.
All cases use self-contained stub `.mjs` files (no relative imports) written into the tmp `weRoot` — never the
real module, so the host's `CONVEYOR_QUEUE_FILE`/`CONVEYOR_STATE_ROOT` cannot leak in. The "old-shaped" and
"missing module" cases are RED today on the `degraded` assertion (the old code returns `[]` with no degrade
marker); the resolver case is RED because it seeds a stale `<weRoot>/we:.conveyor/queue.json` the old code reads.
Type: widen the `cleared` element to `addedAt: string | null` (`readQueueFile` can return null) and confirm
plateau:src/wip's model + page tolerate a null `addedAt`.
Run `npx vitest run plateau:src/wip/wip-read.test.ts` then `npm test` in plateau-app.

## Proof plan

Step 0: diff the `com.plateau.wip-publisher` launchd plist env (and HOME) against the CLI's — a
`CONVEYOR_STATE_ROOT`/`CONVEYOR_QUEUE_FILE` set on one side only would make them read different files, so "no env
plumbing" is verified, not assumed; also confirm wev-control's we:scripts/conveyor/queue-store.mjs exports
`resolveQueuePath`. Use a moment when the state-home queue is non-empty and differs from the legacy file, or the
proof is vacuous.
Before: capture `node we:scripts/conveyor/queue.mjs list` from ~/workspace/wev-control vs the live "Queued" list at
https://plateau-app.nicgilbert.workers.dev/wip (they disagree when the state-home queue differs from the stale
in-checkout file). After the fix ships and `com.plateau.wip-publisher` republishes: the page's "Queued" rows equal
the CLI list. Also a CLI probe: run `readWip` against wev-control's `weRoot` from a script and diff its `cleared`
against `we:scripts/conveyor/queue.mjs list --json`.

## Follow-ups

- Cache the dynamic-imported queue-store module per `weRoot` (the publisher reads every 10 s).
- Show on /wip when the queue came from the legacy fallback location (so the operator sees a not-yet-migrated queue).

## Done when

1. **Executable** — `npx vitest run plateau:src/wip/wip-read.test.ts` passes with a case asserting the
   conveyor-queue read goes through `resolveQueuePath()` (not a hardcoded `we:.conveyor/queue.json` join),
   plus the old-shaped-`weRoot` degrade case.
