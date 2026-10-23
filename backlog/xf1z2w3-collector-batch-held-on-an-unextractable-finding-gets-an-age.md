---
kind: story
size: 3
parent: "x87psvt"
status: open
blockedBy: ["x5nmdnt"]
scope: ["we:scripts/operations/card-batch-extract.mjs", "we:scripts/operations/card-batch.mjs", "we:scripts/operations/card-batch-io.mjs", "we:scripts/operations/card-batch-seal-io.mjs", "we:scripts/operations/__tests__/card-batch-extract.test.mjs", "we:scripts/operations/__tests__/card-batch.test.mjs", "we:scripts/operations/__tests__/card-batch-io.test.mjs", "we:scripts/operations/__tests__/card-batch-seal-io.test.mjs"]
dateOpened: "2026-10-18"
tags: []
---

# Collector batch held on an unextractable finding gets an age escape

Per decision x5ioz96 fork 4 skeptic amendment: a finding that names no single card file, or several, holds the batch for a person with no age escape today. After a bounded age (a setting with its source logged) the hold escalates to the operator as needs-you (posted once; a failed post retries on the next tick, case `aged-hold escalation retries a failed post and posts once`) and the batch no longer blocks admission of new cards into a fresh batch. The admission refusal lives in the planner (`state?.sealedAt` refuses `batch-sealed` in we:scripts/operations/card-batch.mjs), so the escape must change admission there, not only the extract module. The planner is pure, so the write that frees the active slot (archive the held state to `sealed/`, then retire the slot) is in we:scripts/operations/card-batch-io.mjs or the seal job's retire in we:scripts/operations/card-batch-seal-io.mjs. The held batch's own members are never dropped: they stay on the held PR, which keeps its hold label and is named in the needs-you escalation, until a person resolves the finding.

The aged-hold archive carries a `heldForFinding` marker. The seal scan (`sealDueBatches`) is a consumer of every `sealed/` archive, and today it relaunches any archive with `sealedAt` that is not at `label-on-green` and has no `sealFailure`. A relaunch would run remove-hold, ready and label-on-green on a PR that still carries an unresolved blocking finding, so it could merge. With the marker, the scan only reads the PR state (x5nmdnt's rows) and never launches a seal job for it.

## Acceptance

- [A1] **Executable** — `node --test we:scripts/operations/__tests__/card-batch-extract.test.mjs we:scripts/operations/__tests__/card-batch.test.mjs we:scripts/operations/__tests__/card-batch-io.test.mjs we:scripts/operations/__tests__/card-batch-seal-io.test.mjs` fails before this item lands and passes after. Planned cases:
  - `expired unextractable hold escalates with the age setting's source logged` (we:scripts/operations/__tests__/card-batch-extract.test.mjs) — a hold older than the setting escalates as needs-you, and the log names the setting's value and source.
  - `aged-hold escalation retries a failed post and posts once` (we:scripts/operations/__tests__/card-batch-seal-io.test.mjs) — the `heldForFinding` archive records the escalation as pending until it is posted, and the seal scan (`sealDueBatches`) drives the retry from that record, as x5nmdnt does for `closedUnmerged`. Fault injection: the first needs-you post fails. The next scan posts it once, later ticks post nothing more, and admission is never re-blocked meanwhile (the slot stays freed). Same shape as x5nmdnt's `closed-unmerged escalation retries without re-blocking admission`.
  - `hold younger than the age setting keeps blocking admission` (we:scripts/operations/__tests__/card-batch.test.mjs) — admission still refuses `batch-sealed`.
  - `unreadable hold timestamp keeps blocking admission` (we:scripts/operations/__tests__/card-batch.test.mjs) — a missing or unparseable hold time counts as not aged: admission refuses `batch-sealed` and nothing escalates.
  - `hold age is read from this batch only` (we:scripts/operations/__tests__/card-batch.test.mjs) — a young hold on this batch stays blocking (admission refuses `batch-sealed`, nothing escalates) while an aged hold exists for (a) another kind in the same repo, (b) the same kind in another repo, and (c) another PR of the same kind; none of them frees this slot.
  - `aged unextractable hold admits into a fresh batch` (we:scripts/operations/__tests__/card-batch.test.mjs) — admission returns `admit` with a new batchRef, end to end through the planner.
  - `aged hold keeps its members on the held PR` (we:scripts/operations/__tests__/card-batch-extract.test.mjs) — the held batch's members and hold label are unchanged, and the escalation names the PR.
  - `aged hold archives to sealed/ and frees the active slot` (we:scripts/operations/__tests__/card-batch-io.test.mjs) — through the IO layer, not the planner: the held state is written to `sealed/` with `heldForFinding` and every member, the active slot is retired, and the next real admission creates a fresh batch branch.
  - `aged-hold archive is never relaunched by the seal scan and keeps its hold label` (we:scripts/operations/__tests__/card-batch-seal-io.test.mjs) — `sealDueBatches` spawns no seal job for it, and its PR keeps the hold label and stays draft.
  - `aged-hold archive write failure keeps the slot held` (we:scripts/operations/__tests__/card-batch-io.test.mjs) — fault injection on the aged-hold path itself: a failing write of the `heldForFinding` archive leaves the active slot held with every member, admission keeps refusing `batch-sealed`, and nothing escalates as freed.
  - `aged-hold archive whose PR merges retires with the merged marker` (we:scripts/operations/__tests__/card-batch-seal-io.test.mjs) — a `heldForFinding` archive whose PR merged gets the merged terminal marker, no seal-job spawn and no escalation.
  - `aged-hold archive whose PR closes unmerged is surfaced` (we:scripts/operations/__tests__/card-batch-seal-io.test.mjs) — a `heldForFinding` archive whose PR closes unmerged gets the `closedUnmerged` record, and the escalation names the PR and every member; no seal job is spawned.
  - `aged-hold archive with an unreadable PR stays held and unmarked` (we:scripts/operations/__tests__/card-batch-seal-io.test.mjs) — an API error or unknown state gives no marker, no escalation and no spawn; the next scan reads it again.
  - `extracted member cannot re-enter a collector` (we:scripts/operations/__tests__/card-batch-extract.test.mjs) — statute rule 4: admission of an extracted card is refused.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] It does not resolve the unextractable finding; a person does, from the escalation.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: the finding text is not parsed here; the extract module has already decided it is unextractable.
2. **Truncated reads** — an unreadable hold timestamp counts as not aged, so the hold keeps blocking; it never counts as expired (case `unreadable hold timestamp keeps blocking admission`).
3. **Shared state files** — the archive and slot retirement run under the per-kind lease, archive first, through the same write path as x5nmdnt (its fault-injection case `archive failure preserves the active slot and retry preserves every member` pins the order).
4. **Fail closed** — if the archive write fails, the slot stays held and admission keeps refusing `batch-sealed` (case `aged-hold archive write failure keeps the slot held`: the same archive-then-retire write as x5nmdnt, called from the aged-hold path); the seal scan never relaunches an aged-hold archive (case `aged-hold archive is never relaunched by the seal scan and keeps its hold label`).
5. **Identity scoping** — the hold's age is per batch (repo, kind, PR) (case `hold age is read from this batch only`).
6. **State over time** — an aged hold leaves the active slot as a `sealed/` archive. If a person later merges its PR, it retires; if they close it without a merge, x5nmdnt's seal-scan row archives it as `closedUnmerged` and surfaces its members; if its PR state is unreadable, it stays held and unmarked. Its cards are never silently dropped (cases `aged-hold archive whose PR merges retires with the merged marker`, `aged-hold archive whose PR closes unmerged is surfaced`, `aged-hold archive with an unreadable PR stays held and unmarked`). The split row is n/a here: the extract step never runs on an unextractable finding, so no remainder or journal names this PR.
7. **Who wrote it** — n/a: only the coordinator writes hold state and archives.
