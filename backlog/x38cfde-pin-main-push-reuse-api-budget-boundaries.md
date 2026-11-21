---
kind: story
size: 2
status: open
scope: ["we:scripts/ci/__tests__/main-push-skip-cli.test.mjs", "we:scripts/ci/__tests__/main-push-skip.test.mjs", "we:scripts/ci/main-push-skip.mjs"]
dateOpened: "2026-11-21"
tags: [ci, prevention]
---

# Pin main push reuse API budget boundaries

The two later-round card suggestions in PR #7224's 2026-11-21 advisory review
identify the same missing coverage: the CLI promises 30 API calls and ten pages per
inventory without named boundary tests. Add deterministic CLI fixtures that count
calls and prove full-CI fallback at exhaustion.

## Design

Extend the fake executable fixtures in
`we:scripts/ci/__tests__/main-push-skip-cli.test.mjs`. Count each API invocation,
including check-suite reads and the artifact ZIP download. Generate complete
100-row pages with distinct identities; no network calls or production credentials.

## MVP

Exercise the CLI at the exact budget, one needed call beyond it, a complete tenth
page and an inventory requiring an eleventh page. Preserve fail-closed behavior.

## Acceptance

- [A1] Planned `we:scripts/ci/__tests__/main-push-skip-cli.test.mjs`, case `exactly thirty calls can authorize reuse`: valid proof completes within the shared budget, counting the ZIP download.
- [A2] Planned same file, case `thirty-first API call is refused`: the required next read produces `skip=false` and the fake API records no thirty-first invocation.
- [A3] Planned same file, case `ten complete inventory pages are accepted`: run and artifact inventories independently consume ten valid pages within the shared budget.
- [A4] Planned same file, case `eleventh inventory page cannot authorize reuse`: oversized or inconsistent inventory yields full CI and no eleventh-page read.

## Non-goals

Increasing limits, weakening page validation or adding mutation testing to CI.

## Edge cases

Count attempts as well as endpoint types; cover separate inventories sharing one
budget, partial last pages and changing totals. Foreign workflows must not spend
check-suite calls. Input is fixture JSON and inert argv; no shared runtime state,
rollback or live writes are involved. Unknown evidence must continue to run full CI.

## Test plan

Run the targeted unit-test command for
`we:scripts/ci/__tests__/main-push-skip-cli.test.mjs`.
Assert both the decision and exact call count, so returning full CI before reaching
the intended boundary cannot satisfy the exhaustion case.

## Proof plan

Show named cases fail before their coverage is implemented; use the normal
revert-red mechanism to assess source mutations without hand-removing guards.
