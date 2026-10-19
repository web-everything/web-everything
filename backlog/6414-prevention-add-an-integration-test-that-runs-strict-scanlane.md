---
bornAs: xbacxf9
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/lane-transcript-attribution.mjs", "we:scripts/lib/host-overload-settings.mjs", "we:scripts/lib/lane-transcript-backfill.mjs", "we:scripts/lib/__tests__/lane-transcript-attribution.test.mjs", "we:scripts/lib/__tests__/host-overload-settings.test.mjs", "we:scripts/lib/__tests__/lane-transcript-backfill.test.mjs"]
dateOpened: "2026-10-18"
tags: []
---

# Prevention — Add an integration test that runs strict scanLaneTranscripts through the real recentTranscriptFil… (from web-everything/web-everything#5624 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/lane-transcript-attribution.mjs:253` — Add an integration test that runs strict `scanLaneTranscripts` through the real `recentTranscriptFiles` with more than `maxFiles` fixture files. Add a review-checklist item that a new strict mode must be exercised without injected seams.
2. `we:scripts/lib/host-overload-settings.mjs:59` — Reject blank env strings before coercion, for example `env[name].trim()===''` is invalid. Add a table-driven test of blank values for every numeric leaf.
3. `we:scripts/lib/host-overload-settings.mjs:57` — Add a policy-settings test, or a lint, that every env-parsed leaf rejects '', whitespace and hex-style strings; parse env numbers with a strict /^\d+(\.\d+)?$/ check before Number().
4. `we:scripts/lib/lane-transcript-backfill.mjs:27` — Add parameterized entrypoint tests proving interactive admission and noninteractive refusal under the same overloaded reading.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5624@0ebfc169af73682de649a6d805680c9d3b32b187

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
