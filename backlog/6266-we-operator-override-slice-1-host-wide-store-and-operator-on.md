---
bornAs: xkwhvyg
kind: story
size: 5
parent: "6268"
status: open
scope: ["we:scripts/lib/operator-override-store.mjs", "we:scripts/operations/operator-override.mjs", "we:scripts/lib/__tests__/operator-override-store.test.mjs", "we:scripts/operations/run.mjs", "we:scripts/operations/__tests__/http-adapter.test.mjs", "we:scripts/guard-bash.mjs", "we:scripts/__tests__/guard-bash.test.mjs", "we:scripts/operations/effect-executor.mjs", "we:scripts/operations/__tests__/effect-executor.test.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# we: operator override slice 1 - host-wide store and operator-only write CLI with audit log and expiry

Build the store of decision 6268 (we:docs/agent/platform-decisions.md#operator-override-settings-layer): a host-wide path outside any lane clone, one readOperatorOverrides read interface, and an operator-only operator-override set operation that rejects agent callers, appends a change log and supports expiry.

The store module, the operation module and the store test are new files. The operation is registered in `OPERATIONS` in we:scripts/operations/run.mjs, the way existing operations are, and gets its module-map entry in we:scripts/operations/__tests__/http-adapter.test.mjs. Every input is a `--flag` (the CLI adapter rejects positional arguments), so the command is `node we:scripts/operations/run.mjs operator-override --key=<key> --value=<value> --instruction=… --reason=… [--expires=…]`.

**Authority.** The write follows the existing operator-only pattern of `land-human-only` (we:scripts/operations/land-human-only-io.mjs): `operatorTerminalPresent` refuses any call without an interactive terminal or from a recognized agent or CI session, and the actor is the operator's own `gh` login from `resolveOperatorCredential`, never a `--actor` flag. The channel is `terminal`.

**The HTTP route.** An operation with an effect step gets `POST …/runs` routes from the HTTP adapter, which drives the run with `attemptedBy: 'unknown'`. Only the CLI adapter's terminal path drives it with `attemptedBy: 'human'`. Today we:scripts/operations/effect-executor.mjs records `attemptedBy` but never passes it on. This slice passes it to the effect sink, and the operator-override sink refuses unless `attemptedBy === 'human'` and `operatorTerminalPresent()` holds. So a write started over HTTP is refused even when the server process itself runs in the operator's terminal. The HTTP adapter itself is not changed (its route table stays a function of the step kinds).

**Read interface.** `readOperatorOverrides()` returns `{ readable, entries }`. `readable` is false when the store or snapshot cannot be read or parsed, so a caller can tell "unreadable" from "no overrides". Each entry carries `key`, `value`, `entryId` (the log line it came from), `actor`, `channel`, `at`, `instruction`, `reason`, `expiresAt` and the recorded confirmation, if any. Slices 2, 3 and 4 build on exactly this shape.

## Acceptance

- [A1] **Executable** — `npm run test:unit --` (vitest) on we:scripts/lib/__tests__/operator-override-store.test.mjs (a new file), we:scripts/operations/__tests__/http-adapter.test.mjs, we:scripts/operations/__tests__/effect-executor.test.mjs and we:scripts/__tests__/guard-bash.test.mjs. The store test fails before the module exists and passes after. Named tests, one per guarantee:
  - `set then readOperatorOverrides returns the value with source operator-db`
  - `the store path is host-wide and never inside a lane clone`
  - `an agent caller is rejected by the write operation and nothing is written`
  - `a write started through POST …/runs is refused by the sink and nothing is written, even when the server process has a terminal`
  - `the effect executor passes attemptedBy to the sink` (in we:scripts/operations/__tests__/effect-executor.test.mjs)
  - `the actor comes from the operator's gh login, and an --actor flag is refused`
  - `each write records instruction, actor, channel, time, reason and optional expiry`
  - `readOperatorOverrides returns each entry with entryId, actor, at, instruction, expiresAt and confirmation`
  - `an unreadable store returns readable false, which differs from an empty store`
  - `the change log is append-only and a write never edits earlier lines`
  - `an expired override is ignored on read and logged once; the log keeps it`
  - `a snapshot that fails to parse is skipped whole and logged`
  - `the module map covers every operation the repo declares` (the existing http-adapter test, green with the new entry)

## Non-goals

- [N1] Does not wire the layer into the cascade (slice 2), the guard floor (slice 3), the needs-you flag (slice 4) or any plateau DB work.
- [N2] The store module exports `SETTABLE_OVERRIDE_KEYS`: the referral safety keys, the merge-queue switches `refreshOnUnsatisfiedWorkflows` and `refreshOnStaleMergeGate`, and the cascade keys whose reader uses `cascadePolicy(...).value` (never a `.layered` reader that applies env itself). Any other key is refused by the write (named test: `a key outside SETTABLE_OVERRIDE_KEYS is refused and nothing is written`), so an override that no resolver reads is never stored. Slice 2 proves every listed key is read.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — the verbatim instruction is stored as a quoted JSON string, never executed or interpolated.
2. **Truncated reads** — a snapshot or log line that fails to parse is skipped whole and logged, never half-applied, and the read reports `readable: false`.
3. **Shared state files** — the log is append-only under a lock; the snapshot is replaced atomically.
4. **Fail closed** — an unreadable store or an agent caller means no write and no applied override.
5. **Identity scoping** — actor and channel come from `operatorTerminalPresent` and `resolveOperatorCredential`, not from a flag.
6. **State over time** — expired entries are ignored on read and the log keeps them.
7. **Who wrote it** — every entry carries actor, channel, time, instruction and reason.
8. **Trust boundary** — the store sits outside any lane clone, so a lane's Edit/Write grant does not cover it. we:scripts/guard-bash.mjs denies agent shell writes to the store path, tested in we:scripts/__tests__/guard-bash.test.mjs as `an agent shell write to the operator-override store is denied`. Any write that still gets past this is caught by the reader floor (slice 3) and shown in the needs-you feed (slice 4).
