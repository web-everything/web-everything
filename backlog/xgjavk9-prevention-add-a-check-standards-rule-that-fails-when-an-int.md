---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:conformance-vectors/time-track.vectors.ts", "we:conformance-vectors/__tests__/time-track.vectors.test.ts", "we:src/_data/intents/time-track.json", "we:conformance-vectors/__tests__/time-track.vectors.test.mjs"]
dateOpened: "2026-11-22"
tags: []
---

# Prevention — Add a check:standards rule that fails when an intent lists events, or a stacking or axis claim, w… (from web-everything/web-everything#7352 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:conformance-vectors/time-track.vectors.ts:55` — Add a check:standards rule that fails when an intent lists `events`, or a stacking or axis claim, with no matching vector id in its suite. Failing that, make a guarantee-to-vector table a required section of the card.
2. `we:conformance-vectors/time-track.vectors.ts:57` — Review lens: cross-read the intent description against each vector description for observable cardinalities such as how many markers or slots there are. Also have the contract state how each lane exposes the marker.
3. `we:conformance-vectors/__tests__/time-track.vectors.test.ts:84` — Once the downstream driver or matcher helper exists, route the vector expectations through it in these tests. Until then, name the tests for what they check.
4. `we:conformance-vectors/time-track.vectors.ts:62` — Add a conformance-vectors lint or check:standards rule. It would require that every vector `expect` key that is a bare boolean (or any `expect` key at all) is paired with an oracle-sensitivity test, and that every event in an intent's `events` array has at least one vector.
5. `we:conformance-vectors/__tests__/time-track.vectors.test.ts:13` — Add a CI-gated test that loads both repository-qualified JSON paths and checks their matching intent identity.
6. `we:conformance-vectors/time-track.vectors.ts:61` — Add concrete coordinate, lane-bound, and changed-domain vectors with named corpus tests pinning their expected observations, and require those tests in CI.
7. `we:conformance-vectors/time-track.vectors.ts:62` — Add a deterministic oracle test using a specified temporal domain and range that rejects collapsed and incorrectly mapped positions.
8. `we:src/_data/intents/time-track.json:16` — Add a deterministic rescale vector and a named corpus test requiring the axis-change step and updated item and marker position assertions.
9. `we:conformance-vectors/time-track.vectors.ts:55` — Add a deterministic layout vector asserting ordered, vertically separated lane bounds and a named test requiring those observations.
10. `we:conformance-vectors/__tests__/time-track.vectors.test.ts:13` — Add a deterministic catalog-to-suite integrity gate that requires each associated intent and semantics entry to exist and match.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7352@d7ce58f3022b4382fa9577bea243c5c170f22be4

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
