---
bornAs: xt96sbx
kind: story
size: 5
parent: "6268"
status: open
blockedBy: ["6266"]
scope: ["we:scripts/lib/operator-override-floor.mjs", "we:scripts/lib/operator-override-store.mjs", "we:scripts/operations/operator-override.mjs", "we:scripts/lib/__tests__/operator-override-floor.test.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# we: operator override slice 3 - guard floor confirm-and-flag on write and on read

Build the guard floor of decision 6268 (we:docs/agent/platform-decisions.md#operator-override-settings-layer): a safe-direction table per key (no entry means loosening), a loosening write refused until the operator confirms, and the reader ignoring any loosening entry with no recorded confirmation.

The floor module is new and exports the safe-direction table and one classifier, `isLooseningOverride(key, value)`, which the write operation (we:scripts/operations/operator-override.mjs, from slice 1) and the needs-you feed (slice 4) both call. The "refused with a non-zero exit" and "confirmation authority" tests below drive that write operation.

The confirmation is the `confirmLoosen` field of the request file that the operator's review approved, so it is covered by slice 1's protected-CI attestation (the `#6246` slice 2 A10 trust root). A `--confirm-loosen` flag, terminal, local `gh` login or any other local signal is never a confirmation on its own. Bind each confirmation to the exact log entry: entryId, key, value and expiry, with that attestation recorded on the write. Neither an older confirmation for the same key nor a snapshot that reuses an id with altered contents authorizes a later write. Apply this check to slice 1's latest-entry-per-key view before returning effective entries; rejected latest entries fall back to lower layers without reviving history.

**This slice lands only through a human.** Slice 1 adds the floor module, its test, the store module and the operation module to the drain's human-only path list (`GATE_PATH_PREFIXES`), so this slice's own PR is held for the operator, not landed by the drain.

## Acceptance

- [A1] **Executable** — `npm run test:unit --` (vitest) on we:scripts/lib/__tests__/operator-override-floor.test.mjs (a new file) fails before the module exists and passes after. Named tests, one per guarantee:
  - `a loosening write without the confirmation flag is refused with a non-zero exit and nothing is written`
  - `a confirmed loosening write is logged with its confirmation`
  - `every key declares its safe direction; a key with no entry counts as loosening`
  - `the reader ignores a loosening entry that has no recorded confirmation (hand-edited snapshot)`
  - `the hard-coded confirmed-broken always-block cannot be reached by any override`
  - `a confirmation not covered by a verified operator attestation is refused` (a `--confirm-loosen` flag with no approved request, a request approved without `confirmLoosen`, and a `confirmLoosen` added after the approved head; reuses slice 1's `forged-override-operator` fixtures)
  - `an unreadable safe-direction table treats every key as loosening: unconfirmed writes are refused and unconfirmed entries are ignored on read`
  - `the reader ignores the whole snapshot when it cannot be checked against the safe-direction table`
  - `an expired confirmation cannot authorize a loosening entry even if the entry has not expired`
  - `a snapshot cannot create, replace or extend the append-only log confirmation for a loosening entry`
  - `a confirmation recorded for one entry does not authorize a different loosening entry for the same key`
  - `reusing a confirmed entryId with a different key, value or expiry in the snapshot does not authorize it`
  - `an expired entry stops applying and never revives a superseded confirmation`
  - `an invalid or unconfirmed latest entry never revives a superseded override`
  - `confirmation authority, actor, channel, time and instruction come from the attested log write, not snapshot fields`
  - `hostile key and value text is treated as data by the safe-direction classifier and never executed`

## Non-goals

- [N1] Does not add the needs-you display (slice 4) and does not change the store format (slice 1).

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — the key name and value are matched against the table, never evaluated.
2. **Truncated reads** — a snapshot that cannot be checked against the table is ignored whole.
3. **Shared state files** — the confirmation is recorded in the append-only log; the snapshot never overrides it.
4. **Fail closed** — unknown guard direction or unreadable table is treated as loosening.
5. **Identity scoping** — the confirmation counts only when it is part of a request approved by an allowlisted operator review and verified through slice 1's protected-CI attestation; test `a confirmation not covered by a verified operator attestation is refused`.
6. **State over time** — a confirmation applies to the entry it was recorded with, and an expired entry stops applying.
7. **Who wrote it** — each confirmation entry carries actor, channel, time and the operator instruction.
