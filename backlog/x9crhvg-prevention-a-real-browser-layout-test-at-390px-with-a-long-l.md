---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:blocks/time-tracks/TimeTracks.ts", "we:blocks/time-tracks/TimeTracksElement.ts", "we:blocks/__tests__/unit/time-tracks/time-tracks.test.ts", "we:blocks/time-tracks/__tests__/TimeTracks.test.mjs", "we:blocks/time-tracks/__tests__/TimeTracksElement.test.mjs"]
dateOpened: "2026-11-25"
tags: []
---

# Prevention — A real-browser layout test at 390px with a long label at the domain end, asserting the item rect stays ins… (from frontier-ui/frontierui#53 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:blocks/time-tracks/TimeTracks.ts:188` — A real-browser layout test at 390px with a long label at the domain end, asserting the item rect stays inside the track and is at most two lines high.
2. `we:blocks/time-tracks/TimeTracksElement.ts:105` — A unit test over the slotted-content path asserting that title and accessible name include the rendered text.
3. `we:blocks/time-tracks/TimeTracksElement.ts:107` — A unit test mounting indented authored markup and asserting no unplaced slot exists.
4. `we:blocks/__tests__/unit/time-tracks/time-tracks.test.ts` — Assert `late.style.minWidth === '0'` now, and add a real-browser wrap test.
5. `we:blocks/__tests__/unit/time-tracks/time-tracks.test.ts` — Table-driven refusal tests per guarded field ('vertical', 1, null for orientation; '500' and NaN for config.today).
6. `we:blocks/__tests__/unit/time-tracks/time-tracks.test.ts` — A deterministic CSS check requiring every colour-bearing declaration to use var(--*), transparent or currentColor.
7. `we:blocks/__tests__/unit/time-tracks/time-tracks.test.ts:520` — File a test-plan gate or review check requiring each 'X is refused' Acceptance clause to have a table-driven test over representative bad values on every entry point (factory, JSON config, attribute). Add 'vertical' via both paths now.
8. `we:blocks/time-tracks/TimeTracks.ts:48` — File a table-driven createTimeTracks test over undefined, null, NaN and string values for today, under the same per-entry-point refusal check as the orientation gap.
9. `we:blocks/__tests__/unit/time-tracks/time-tracks.test.ts:469` — File a check:standards CSS rule requiring colour, background, border-colour, spacing and radius declarations in block CSS to be var(--token) or an explicit keyword allowlist.
10. `we:blocks/time-tracks/TimeTracksElement.ts:105` — File a test that places authored content and asserts title and the accessible name contain the visible text, and add a rendered accessibility gate (label-in-name) for demos.
11. `we:blocks/time-tracks/TimeTracks.ts:188` — File a review-lens check that any new exception branch updates the Acceptance sentence it carves out; this is not reliably script-decidable.
12. `we:blocks/__tests__/unit/time-tracks/time-tracks.test.ts` — Add a deterministic parameterized invariant test covering remaining widths below, at, and above 48px, including the endpoint.
13. `we:blocks/time-tracks/TimeTracks.ts:184` — Add a parameterized geometry test covering remaining widths below, at, and above 48px, asserting that each item's displayed left edge never precedes its mapped timestamp.

Idempotency key (do not edit): approval-prevention-key:frontier-ui/frontierui#53@022d10e0a9d31f20f05daa4f1f60098330436dfd

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
