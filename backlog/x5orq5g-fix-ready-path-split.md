---
kind: task
status: active
scaffoldedBy: "fix-6633"
dateScaffolded: "2026-11-10"
dateOpened: "2026-11-10"
tags: []
related: ["6633"]
---

# adoption-matrix-io reads fix-ready.jsonl from WE_FIX_READY_PATH/fixReadyPath while fix-ready-record writes only settings readyRecordPath

The fix-ready ledger has two readers with two path rules: prototype-load reads settings `readyRecordPath`; the adoption matrix reads `WE_FIX_READY_PATH`, then adoption-matrix `fixReadyPath`, then a built-in default. The `fix-ready-record` writer used only `readyRecordPath`, so an override sent a record to a file the adoption matrix never read, and the CLI still exited 0. This item makes the writer refuse that split (exit 1, names both files) and pins the shipped defaults to the real reader with a contract test. Routing both readers through one shared path helper is the follow-up in N1.

## Acceptance

- [A1] **Executable** — the vitest file we:scripts/operations/__tests__/fix-ready-record.test.mjs (run with `npm run test:unit -- <that file>`) fails before this item (the `adoptionReaderPath` contract and `main()` refusal tests have no code to pass) and passes after.
- [A2] **Must** — with the shipped defaults, `readyRecordPath()` and the path the real `createAdoptionMatrixReader` asks for are the same file (test: "shipped defaults resolve to the very file the adoption matrix reads").
- [A3] **Must** — `main()` refuses with exit 1, writes nothing and names both files when `WE_FIX_READY_PATH` or `fixReadyPath` points the adoption matrix at a different file (test: "main refuses (exit 1) when an override sends the adoption matrix to a different file").
- [A4] **Must** — unreadable or malformed adoption-matrix settings fail closed with exit 2 and write nothing (test: "main fails closed (exit 2) when the adoption-matrix settings cannot be read").
- [A5] **Must** — a write that is short, throws or makes no progress never leaves a torn line: the ledger is cut back to its previous length and the writer reports failure (tests: "finishes a short write…", "refuses and cuts the ledger back when a write fails part-way…").

## Non-goals

- [N1] Does not change we:scripts/operations/adoption-matrix-io.mjs or we:scripts/operations/prototype-load-io.mjs; one shared `fixReadyPath()` helper used by every reader and the writer is a follow-up card, not this one.
- [N2] Does not make the writer follow an override: prototype-load would then stop seeing the record, so the writer refuses instead.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: the path comes from the operator's environment and settings files, not from record content; ref and sha validation is unchanged.
2. **Truncated reads** — n/a: this item reads only small settings files; the ledger read is unchanged. The write side is covered by A5 (short write cut back).
3. **Shared state files** — the ledger append stays under the existing lock; a failed write is truncated back while the lock is still held (A5).
4. **Fail closed** — an unresolvable path or unreadable adoption-matrix settings refuse with exit 2; a path split refuses with exit 1 (A3, A4).
5. **Identity scoping** — n/a: one operator ledger; no per-user or per-repo identity involved.
6. **State over time** — settings and environment are read on each run, so a changed override is seen at once; no cached path.
7. **Who wrote it** — n/a: the ledger is a local operator file; no trust marker is read or written here.

## Test plan

All tests live in we:scripts/operations/__tests__/fix-ready-record.test.mjs: the contract test against the real `createAdoptionMatrixReader`, the `adoptionReaderPath` precedence table (env, `~`, setting, env over setting), the `main()` refuse / allow / fail-closed cases, and the two write-integrity cases.

## Risks

- `adoptionReaderPath` repeats the reader's precedence rule; if the reader changes, the contract test must go red. Fixed properly by the shared helper in N1.

## Duplicate admission

variant noted in PR 6633 self-review: writer and the adoption-matrix reader can disagree on the ledger path under an override

no existing card covers the writer/adoption-matrix reader path split
