---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/review-facts.mjs", "we:skills-src/conveyor/review-daemon.mjs", "we:scripts/lib/__tests__/review-facts.test.mjs", "we:skills-src/conveyor/__tests__/review-daemon.test.mjs"]
dateOpened: "2026-10-06"
tags: []
---

# Prevention — Add a test, with a fixture, that a green store result alongside a live pending re-run does not al… (from web-everything/web-everything#4102 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/review-facts.mjs:78` — Add a test, with a fixture, that a green store result alongside a live pending re-run does not allow. Alternatively, keep the live check-runs read for the allow path and use the store only for the head and the refusal.
2. `we:skills-src/conveyor/review-daemon.mjs:857` — Compute the log status with the same `judgeMirror` / `lookupInMirror` verdict the reads use, and unit-test `warmReviewFacts` with a mirror whose last refresh failed.
3. `we:skills-src/conveyor/review-daemon.mjs:799` — Add a test that calls `buildCliDaemonEffects().runReview` with a fake `tick` and asserts that the forwarded `dispatch` uses `readReviewCiGateFactsFirst` and that the tag provider's `readLabels` hits the lookup.
4. `we:scripts/lib/review-facts.mjs:46` — A strict branch-coverage gate (e.g., 100% branch coverage required for new files) that would force the catch block in warmReviewFacts to be exercised, organically proving the 'never throws' property.
5. `(no file cited)` — A determinism test simulating a store failure alongside a moved live head to ensure the gate falls back to live instead of acting on the stale failure.
6. `(no file cited)` — A wrapper integration test that strictly passes mocks for all dependencies (env, readHead) and asserts that no underlying defaults are invoked.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4102@1293ece4a1b82f2a1ba25f069eee95c2d63e7e6c

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
