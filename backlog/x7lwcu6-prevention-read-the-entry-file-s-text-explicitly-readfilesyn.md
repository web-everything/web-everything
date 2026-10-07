---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/test-result-cache.mjs", "we:scripts/lib/__tests__/test-result-cache.test.mjs"]
dateOpened: "2026-10-07"
tags: []
---

# Prevention — Read the entry file's text explicitly (readFileSync(abs)) and pass only the other files as closur… (from web-everything/web-everything#4297 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/test-result-cache.mjs:253` — Read the entry file's text explicitly (`readFileSync(abs)`) and pass only the other files as `closureTexts`. Add a unit test where a helper sorts before the test file and the test contains `fetch(`, asserting tier 'network'. A property-style test that shuffles file names would catch the whole class.
2. `we:scripts/lib/test-result-cache.mjs:175` — Make an unrecognised `@frontierui/` specifier set `result.error`. Add a unit test for it. For a stronger guard, derive FUI_ALIAS from the we:vitest.shared.ts alias map and have a test assert the two agree.
3. `we:scripts/lib/test-result-cache.mjs:60` — Strip only comment spans (`/\*[\s\S]*?\*/` and `//` to end of line), not whole lines. Add a closure test with an inline block comment before an import. Longer term, have the S3 tracer cross-check the static closure against real reads.
4. `we:scripts/lib/test-result-cache.mjs:268` — Add a separate `reusable` field, or require `!needsTrace` before any hit is honoured. Add a unit test asserting that a `needsTrace` tier is never reusable. File this as a S2/S3 acceptance criterion.
5. `we:scripts/lib/test-result-cache.mjs:88` — Throw on an unbalanced `{`. Add a unit test for a malformed glob, or give loadPolicy a schema validation step.
6. `we:scripts/lib/test-result-cache.mjs:259` — Add deterministic keyFor regression tests where network and real-checkout tests import an earlier-sorting helper, asserting their tiers and cacheable=false; read the entry test explicitly when classifying.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4297@6dd8d50586d5e49502b33e3532025af9e1588cad

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
