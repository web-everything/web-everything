---
kind: story
size: 5
parent: "xdlnylv"
status: open
blockedBy: ["x5qtv82"]
scope: ["we:scripts/backlog/card-number.mjs", "we:src/_data/backlog.js", "we:src/_data/backlogRedirects.js", "we:src/backlog-redirects.njk", "we:src/backlog-pages.njk", "we:src/_includes/backlog-badges.njk", "we:scripts/backlog.mjs", "we:.github/workflows/deploy.yml", "we:.github/workflows/ci.yml"]
dateOpened: "2026-10-13"
tags: [backlog, numbering, ledger, renderer]
---

# Backlog readers and renderers resolve card numbers through the ledger

Slice (b) of epic xdlnylv: one resolver (id to number, number to id, x-id fallback) used by the 11ty loader, the backlog pages and redirects, and we:scripts/backlog.mjs.

## Design

- Resolver `we:scripts/backlog/card-number.mjs` over `readCardLedger` from slice (a):
  `displayNum(id)` = the id for a numeric file name, the ledger number for a ledgered `x<6>`, else the `x<6>`
  itself. `idFor(ref)` = number to id (for `#NNN` refs to x-named cards), id unchanged otherwise.
- 11ty loader `we:src/_data/backlog.js` (CommonJS; `ID_TOKEN` mirror at :60, `num` parse at :370-378): keep
  `num` as the file token (the identity key, so nothing keyed by `num` changes) and add `displayNum`. Read the
  ledger through a small CJS twin with a "keep in sync" pointer, as the `ID_TOKEN` mirror already does.
- Templates show `displayNum` where they show the number today (`we:src/backlog-pages.njk`,
  `we:src/_includes/backlog-badges.njk`). Canonical permalink stays `backlog/{{ item.id }}/`.
- Redirects `we:src/_data/backlogRedirects.js:18`: also emit `/backlog/<displayNum>/` and `/backlog/<x-id>/`
  for each ledgered x-card, pointing at its canonical page. Numeric cards are unchanged.
- `blockedBy` / `parent` edge resolution (`we:src/_data/backlog.js:435-487`) accepts either form through
  `idFor`.
- `we:scripts/backlog.mjs` `show`, `claim`, `resolve` and friends accept a ledger number for an x-named card.
- CI and deploy fetch `ops/card-numbers` before the build (`we:.github/workflows/ci.yml`,
  `we:.github/workflows/deploy.yml`), the same way they fetch `ops/quarantine`. A failed fetch degrades to the
  x-id display; it never fails the build.

## MVP

Resolver, loader `displayNum`, number redirects, and `we:scripts/backlog.mjs show <NNN>` for an x-named card.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — ledger values reach templates only as validated integers or `HASH_RE` ids; titles are
   unchanged and escaped as today.
2. **Truncated reads** — a truncated or missing ledger yields the x-id display for unknown ids, never a wrong
   number.
3. **Shared state files** — readers never write the ledger; the build reads a fetched ref, not a working file.
4. **Fail closed** — a ledger conflict (one id with two numbers) shows the x-id and logs the conflict; it never
   picks one.
5. **Identity scoping** — `num` (identity) and `displayNum` (display) stay separate fields so no keyed lookup
   silently changes meaning.
6. **State over time** — a deploy built before the row existed shows the x-id until the next build; the
   redirect for the number appears on that next build.
7. **Who wrote it** — only rows accepted by slice (a)'s reader (drain-authored) are shown.

## Test plan

Unit tests for the resolver (numeric, ledgered x, unledgered x, conflict, number to id) and for
`backlogRedirects` (emits `/backlog/<NNN>/` for a ledgered x-card, nothing for an unledgered one). A
`we:scripts/backlog.mjs show` test against a fixture ledger.

## Proof plan

Live: pick a real x-named card with a shadow row from slice (a) (or a fixture card in a lane). Before:
`/backlog/<its number>/` is a 404 on the running dev server and `we:scripts/backlog.mjs show <number>` fails. After: the
redirect lands on the canonical page, the page shows the number, and `show` resolves it. Paste curl output.

## Done when

- The backlog index and detail pages show ledger numbers for x-named cards and the x-id for unledgered ones.
- `/backlog/<NNN>/` resolves for numeric and ledgered x-named cards alike.

## Acceptance

- [A1] **Executable** — `npm run test:unit -- we:scripts/backlog/__tests__/card-number.test.mjs` fails before this
  lands and passes after.

## Non-goals

- [N1] No change to canonical URLs or existing file names.
- [N2] No gate change; that is slice (c).
