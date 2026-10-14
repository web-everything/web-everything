---
bornAs: xr3p1p6
kind: story
size: 2
status: open
scope: ["we:scripts/lib/pr-list-paged.mjs"]
dateOpened: "2026-10-13"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5238 (head 7e2c78b96)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5238 (reviewed head `7e2c78b96cf91636168e609742f9af1c93285636`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/pr-list-paged.mjs:202` — (edge-case, degraded) Snapshot seeding resets heavy-field age, bypassing heavyMaxAgeSeconds
   - Scenario: With heavyMaxAgeSeconds=600, fetch heavy fields at t=0. Refresh the shared snapshot at t=590s with unchanged updatedAt/headRefOid: fetchSnapshot correctly reuses those fields and preserves heavyMeta.fetchedAtMs=0. At t=650s, that snapshot remains servable under the default 75s TTL. Project its rows using the drain's requested fields and seed listOpenPrsPagedHydrated: it replaces the original fetch time with 650s and returns reused=1, hydrated=0, although the fields exceed the 600s age limit. A subsequent snapshot refresh at t=710s cannot replace this artificially fresh drain cache. Read-only p
   - Claude's re-check: The seeding loop stamps every matching seed with fetchedAtMs: nowMs and never checks the age of its body/files. The seed rows carry no fetch time, and the new test asserts the reset. Heavy fields older than heavyMaxAgeSeconds are therefore reused with a new freshness window instead of being re-hydrated. The snapshot-side heavyMeta details are outside the diff, but the age-limit bypass is shown.

## Acceptance

- [A1] **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] TODO: what this item deliberately does not do — or `n/a: <why>` when nothing is excluded.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
