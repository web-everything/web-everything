---
bornAs: xx7o40x
kind: story
size: 5
parent: "6122"
status: open
scope: ["we:scripts/lib/card-number-allocator.mjs", "we:scripts/backlog.mjs"]
dateOpened: "2026-10-19"
tags: []
---

# Card numbers assigned at birth (slice 0)

Slice 0 of epic 6122 (ruling 2026-10-19, point 1): new cards are numbered at birth as NNN-slug, so the x<6> fallback is rare. Graduate lane/proto-number-at-birth (we:scripts/lib/card-number-allocator.mjs: withNumberingLock + create-only refs/number-reservations/NNN) and wire it into scaffold and file-item; fail closed to the legacy x<6> path (that fallback is then ledgered, per 6121/6127). Known gap: the allocator records no id->number mapping (reservation blobs carry owner/time/num, not the card id), so replay is not idempotent and readers cannot map an id to a number. Add a create-only refs/card-ids/<id> -> number ref (or a JSONL row) so one id has one number and one number has one id. Settings live under backlog.cardNumbering.* (numberAtBirth.enabled, remote best-effort|required). Prototype first with before/after proof, then PR. Do not build in the ruling PR.

## Acceptance

- [A1] **Executable** — a new card filed through `file-item` is created as `NNN-slug` with `bornAs: x<6>`; replaying the same id returns the same number; two ids never receive one number. The allocator test file fails before this lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] The ledger, the nightly rename batch and the mode switch (6121, 6126, 6127). This slice only numbers new cards at birth and records the id-to-number mapping.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — ids must match `HASH_RE`; reservation blobs are parsed with a strict shape.
2. **Truncated reads** — a short `ls-remote` or ref read is treated as failure and falls back to the legacy x-id path.
3. **Shared state files** — create-only refs are the cross-host compare-and-swap; the local state is written under `withNumberingLock`.
4. **Fail closed** — if the remote cannot be reached the card is born as `x<6>` (the ledgered fallback), never with a guessed number; `remote: required` refuses instead.
5. **Identity scoping** — `refs/card-ids/<id>` is global per repo; one id has one number and one number has one id.
6. **State over time** — a number reserved by a card that never lands is a burned gap, as today.
7. **Who wrote it** — `n/a: refs are written by the author's own session through the allocator; ledger authentication is the optional ledgerAuth setting (6121).`
