---
bornAs: xy5r0uf
kind: story
size: 5
parent: "6122"
status: open
blockedBy: ["6121"]
scope: ["we:scripts/backlog/card-number.mjs", "we:scripts/backlog/__fixtures__/card-ledger-fixtures.mjs", "we:scripts/backlog/__tests__/card-number.test.mjs", "we:src/_data/__tests__/backlog-card-number.test.ts", "we:src/_data/__tests__/backlogRedirects.test.ts", "we:scripts/__tests__/ci-card-ledger-fetch.test.mjs", "we:src/_data/backlog.js", "we:src/_data/backlogRedirects.js", "we:src/backlog-redirects.njk", "we:src/backlog-pages.njk", "we:src/_includes/backlog-badges.njk", "we:scripts/backlog.mjs", "we:.github/workflows/deploy.yml", "we:.github/workflows/ci.yml"]
dateOpened: "2026-10-13"
tags: [backlog, numbering, ledger, renderer]
---

# Backlog readers and renderers resolve card numbers through the ledger

Slice (b) of epic 6122: one resolver (id to number, number to id, x-id fallback) used by the 11ty loader, the backlog pages and redirects, and we:scripts/backlog.mjs.

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
  x-id display for rendering; it never fails the build. Fetch and preserve the file history and signature
  verification inputs required by slice (a), not just a shallow tip or raw JSONL. Propagate failed fetches as
  unreadable-ledger status to checks; a stale local ref must not turn a failed merge_group fetch into success.
  The standards gate fails closed in merge_group (slice (c)), even when the renderer can build with x-ids.

## MVP

Resolver, loader `displayNum`, number redirects, and `we:scripts/backlog.mjs show <NNN>` for an x-named card.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — ledger values reach templates only as validated integers or `HASH_RE` ids; titles are
   unchanged and escaped as today.
2. **Truncated reads** — a truncated or missing ledger yields x-id display for every ledger-dependent card
   and no ledger-number redirects, including ids present in a valid-looking prefix. Both ESM and CJS
   consumers check slice (a)'s `readable` status before using mappings; numeric files keep their own numbers.
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

Each security guarantee has a named test, in the same fixtures for both readers (slice (a)'s
`rejectsUntrustedIntroducerBehindTrustedTip`, `trustRootReadFromBaseNotTreeUnderCheck` and partial-line
fixtures), so the CJS twin cannot ship with weaker checks than the ESM resolver. The fixtures live in one
shared module, `we:scripts/backlog/__fixtures__/card-ledger-fixtures.mjs` (fixture repos with signed and
forged rows, a test trust root and a partial line), imported by every test file below:

- `we:scripts/backlog/__tests__/card-number.test.mjs` (ESM resolver and `show`):
  - `esmRejectsUntrustedRowUnderTrustedTip` — the forged row gives no `displayNum` and no `idFor` mapping;
    `show <forged number>` fails.
  - `esmPartialFinalLineYieldsNoDisplayNumber` — a valid row then a partial line: x-id display for every
    ledger-dependent card, including the valid-prefix one.
  - `esmIgnoresTrustRootInTreeUnderCheck` — a key added in the working tree does not authenticate a row.
  - `esmMissingHistoryFallsBackToXId`.
- `we:src/_data/__tests__/backlog-card-number.test.ts` (CJS twin through the real loader):
  `cjsRejectsUntrustedRowUnderTrustedTip`, `cjsPartialFinalLineYieldsNoDisplayNumber`,
  `cjsIgnoresTrustRootInTreeUnderCheck`, `cjsMissingHistoryFallsBackToXId`, plus
  `cjsAndEsmAgreeOnEveryFixture` (same input, same `displayNum` map).
- `we:src/_data/__tests__/backlogRedirects.test.ts`: `redirectsEmitNothingForUnreadableLedger` (forged row,
  partial line, missing history, failed fetch, missing or invalid base trust root: no `/backlog/<NNN>/` or
  `/backlog/<x-id>/` ledger redirect),
  and the ledgered/unledgered cases above.
- `we:scripts/__tests__/ci-card-ledger-fetch.test.mjs` (workflow integration):
  `ciFetchesLedgerHistoryBeforeConsumers` and `failedFetchIsUnreadableDespiteStaleRef` (CI and deploy fetch
  full history before any consumer runs; a failed fetch reaches merge_group checks as unreadable even with a
  stale local ledger ref).

## Proof plan

On a fixture: before slice (d) no real x-named card is on main (shadow-mode cards are renamed before they
land), and the trust root is read from the base ref, so a fixture row on the real ledger would be untrusted
and lock it. In a lane, make a scratch clone whose `origin` is a local bare copy of the lane, with a test
trust root on its main, a fixture x-named card, and a fixture `ops/card-numbers` row signed by the test key.
Start a throwaway dev server from the scratch clone on a spare port (never the operator's running server),
and stop it by PID when done. Before (lane without this slice): `/backlog/<its number>/` is a 404 and
`we:scripts/backlog.mjs show <number>` fails. After: the redirect lands on the canonical page, the page shows
the number, and `show` resolves it. Paste the curl output.

## Done when

- The backlog index and detail pages show ledger numbers for x-named cards and the x-id for unledgered ones.
- `/backlog/<NNN>/` resolves for numeric and ledgered x-named cards alike.

## Acceptance

- [A1] **Executable** — `npm run test:unit -- we:scripts/backlog/__tests__/card-number.test.mjs
  we:src/_data/__tests__/backlog-card-number.test.ts we:src/_data/__tests__/backlogRedirects.test.ts
  we:scripts/__tests__/ci-card-ledger-fetch.test.mjs` fails before this lands and passes after.
- [A2] The named ESM and CJS security tests above are required acceptance checks; a CJS twin that skips
  introducer authentication, the base-ref trust root or the partial-line rule must make them red.

## Non-goals

- [N1] No change to canonical URLs or existing file names.
- [N2] No gate change; that is slice (c).
