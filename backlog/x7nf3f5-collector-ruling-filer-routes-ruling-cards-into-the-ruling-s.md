---
kind: story
size: 3
parent: "x87psvt"
status: open
scaffoldedBy: "fix-5608"
dateScaffolded: "2026-10-21"
blockedBy: ["xpabefb"]
scope: ["we:scripts/operations/land-ruling-card.mjs", "we:scripts/operations/card-batch-file.mjs", "we:scripts/lib/card-batch-policy.json", "we:scripts/operations/__tests__/land-ruling-card.test.mjs", "we:scripts/operations/__tests__/card-batch-file.test.mjs", "we:scripts/lib/__tests__/card-batch-policy.test.mjs"]
dateOpened: "2026-10-21"
tags: []
---

# Collector ruling filer routes ruling cards into the ruling stream and enables it

Decision x5ioz96 fork 1 skeptic amendment: a card must wire the ruling filer to the collector, otherwise ruling stays declared and unused and rulings keep being hand-batched (lane/rulings-1018-cards). After xpabefb declares ruling disabled, add the ruling-card filer and flip the shipped default to enabled. No ruling filer exists today (rulings are hand-batched), so this card creates one: we:scripts/operations/land-ruling-card.mjs, the caller that files a ruling card through we:scripts/operations/card-batch-file.mjs with kind ruling. Flipping the default changes two of xpabefb's planned cases that assert the shipped defaults, and this card replaces both:
- `ruling is declared with disabled 8/60 defaults` (we:scripts/lib/__tests__/card-batch-policy.test.mjs) becomes `ruling ships enabled with 8/60 defaults`.
- `disabled ruling refuses kind-disabled, not unknown kind` (we:scripts/operations/__tests__/card-batch-file.test.mjs) keeps its assertion but sets `enabled: false` through an explicit setting override, so the disabled-stream refusal stays covered.

The cards in the ruling stream are ordinary cards (for example `kind: story`, `status: open`) filed as the outcome of an operator ruling; the hand-batched ruling PRs carry exactly such cards. Provenance therefore lives in the filing call, not in the card: the caller passes the id of the decision the card comes from, and the filer accepts the card only when that decision card exists on main with `status: resolved` and a `## Ruling` section quoting the operator. A missing, unknown or unresolved decision id is refused before the card reaches the collector.

## Acceptance

- [A1] **Executable** — `node --test we:scripts/operations/__tests__/land-ruling-card.test.mjs we:scripts/operations/__tests__/card-batch-file.test.mjs we:scripts/lib/__tests__/card-batch-policy.test.mjs` fails before this item lands and passes after. Planned cases:
  - `land-ruling-card files through the collector with kind ruling` (we:scripts/operations/__tests__/land-ruling-card.test.mjs).
  - `ruling cards are admitted into the ruling batch, not filing` (we:scripts/operations/__tests__/card-batch-file.test.mjs).
  - `high and urgent ruling cards bypass the collector` (we:scripts/operations/__tests__/card-batch-file.test.mjs).
  - `ruling ships enabled with 8/60 defaults` (we:scripts/lib/__tests__/card-batch-policy.test.mjs) — replaces xpabefb's disabled-default case.
  - `disabled ruling refuses kind-disabled, not unknown kind` (we:scripts/operations/__tests__/card-batch-file.test.mjs) — rewritten to disable ruling through an explicit override, since the shipped default is now enabled.
  - `story card citing a resolved ruling is filed into the ruling batch` (we:scripts/operations/__tests__/land-ruling-card.test.mjs) — a `kind: story`, `status: open` card whose cited decision is resolved with a `## Ruling` section is admitted.
  - `ruling card without operator provenance is refused` (we:scripts/operations/__tests__/land-ruling-card.test.mjs) — a missing decision id, an unknown one, and one whose decision is not resolved or has no `## Ruling` section are each refused, and nothing is admitted.
  - `unparseable or partial card is refused` (we:scripts/operations/__tests__/land-ruling-card.test.mjs) — a card with broken frontmatter, and a read that returns a partial file, are each refused and nothing is admitted.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] No change to how rulings are made or ratified; this only batches cards filed from an already-resolved ruling.
- [N2] No new collector mechanics: admission, sealing and retirement are the other slices'.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — the card's frontmatter and the cited decision's Ruling section are parsed; a card that fails to parse is refused, never filed (case `unparseable or partial card is refused`).
2. **Truncated reads** — an unreadable or partial card file is refused, never filed (case `unparseable or partial card is refused`).
3. **Shared state files** — the filer goes through `card-batch-file`, so the existing per-kind lease covers the collector state; the filer itself keeps no state.
4. **Fail closed** — no provenance, a parse error or a coordinator refusal leaves the card unfiled and reported, never admitted (cases `ruling card without operator provenance is refused`, `unparseable or partial card is refused`).
5. **Identity scoping** — the ruling stream is its own kind, keyed by repo; a ruling card never lands in the filing batch (case `ruling cards are admitted into the ruling batch, not filing`).
6. **State over time** — n/a: the filer is stateless; batch lifecycle is x5nmdnt's.
7. **Who wrote it** — a card is accepted only when it cites a resolved decision whose `## Ruling` section quotes the operator; a mechanical caller cannot file into the ruling stream without one.
