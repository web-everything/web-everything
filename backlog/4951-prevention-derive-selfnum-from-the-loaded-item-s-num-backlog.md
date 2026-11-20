---
bornAs: xwx7fbq
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/check-standards.mjs", "we:scripts/check-standards-rules.mjs", "we:scripts/__tests__/check-standards.test.mjs", "we:scripts/__tests__/check-standards-rules-backlog-integrity.test.mjs"]
dateOpened: "2026-10-01"
preparedDate: "2026-11-20"
preparedAgainstSha: "7d9ef61d08e6608b0a50ff2a7646fa18b6f64cd2"
tags: []
---

# Prevention — Derive selfNum from the loaded item's num (backlog.find by id) or the shared ID_TOKEN, and add a hash-i… (from chalbert/web-everything#3326 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/check-standards.mjs:1068` — Derive selfNum from the loaded item's `num` (backlog.find by id) or the shared ID_TOKEN, and add a hash-id fixture test. A lint banning ad-hoc `^(\d+)-` filename parsing in we:scripts/check-standards.mjs would also cover the class.
2. `we:scripts/__tests__/check-standards.test.mjs:827` — Store the baseline in a committed file and have the test fail only on increases from touched cards, or scope the ratchet to cards changed in the diff.
3. `we:scripts/check-standards.mjs:1068` — Add a deterministic integration test asserting that a hash-prefixed card referencing itself in deferredBlockedBy produces a standards error; extract self IDs using the repository's canonical numeric/hash ID parser.
4. `we:scripts/check-standards.mjs:1068` — A unit test in `we:scripts/__tests__/check-standards.test.mjs` asserting that a hash-prefixed item flags a self-edge when its hash is present in its own `deferredBlockedBy` array.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#3326@68cb4a99f739e457e61571d13ee1f415964c5f5b

## Progress

Preparation research against local HEAD `7d9ef61d08e6608b0a50ff2a7646fa18b6f64cd2` (2026-11-20); no preparation stamp changed.

- Old premise: the numeric-only self-ID extraction was at line 996, the rule at line 3886, and the corpus ceiling was 190. Current source: `we:scripts/check-standards.mjs:1068` still extracts only digits; `we:scripts/check-standards-rules.mjs:4159` checks a self-edge only when selfId is defined. `we:scripts/check-standards.mjs:843` builds known IDs from loaded item nums, so a known hash self-reference bypasses both self-edge and unresolved-edge checks. This is source evidence, not a claim that a live gate probe was run.
- Old scope listed the gate and test file while proposing a helper in an unlisted rules module. Corrected scope adds `we:scripts/check-standards-rules.mjs`; the existing matching test home is `we:scripts/__tests__/check-standards.test.mjs:638`. The original hash-self-edge goal remains outstanding in the current checkout.
- The canonical parser is `we:scripts/backlog/id.mjs:46`, backed by numeric/hash `ID_TOKEN_RE` at line 37. The gate currently imports only isHash at `we:scripts/check-standards.mjs:131`. The corpus ratchet is now `we:scripts/__tests__/check-standards.test.mjs:827`, ceiling 187 at line 835; its separate redesign remains a follow-up as in the previous preparation.
- Validation repair: the previous scope assigned all regressions to `we:scripts/__tests__/check-standards.test.mjs` and omitted a matching rules-test scope. Add the existing `we:scripts/__tests__/check-standards-rules-backlog-integrity.test.mjs`, whose imports at lines 12–21 already exercise the rules module and backlog identity guards. Put A1/A3 helper regressions there; retain A2 caller-wiring coverage in the gate test file. The implementation premise and goal are unchanged.
- Retain size 3: approximately 8 changed lines in the gate, 18 in the rules module, 20 in `we:scripts/__tests__/check-standards.test.mjs`, and 45 in `we:scripts/__tests__/check-standards-rules-backlog-integrity.test.mjs` (about 91 total). No estimatedLoc is added to this story. No dependency changes are proposed.

## Design

Add `cardDeferredBlockedByFindings(id, raw, seenNums)` to `we:scripts/check-standards-rules.mjs`, importing idFromName from `we:scripts/backlog/id.mjs`. It extracts the canonical ID from the filename stem and delegates to deferredBlockedByFindings with the unmodified raw frontmatter and known-ID set. Keep the existing rule's string comparisons and diagnostics.

Replace the numeric-only extraction and direct rule call in `we:scripts/check-standards.mjs:1068` with this helper, retaining the existing per-item error emitter and its filename context. Update the import in the gate. Do not switch to loader-normalized frontmatter: the raw-field validation intentionally detects wrong types that the loader would discard.

Fail closed when a card explicitly supplies deferredBlockedBy but its filename stem yields no canonical ID: return an actionable finding that the self ID cannot be derived and the filename must be corrected. Absent deferredBlockedBy remains optional and silent. No new setting or default is introduced; numeric and hash filenames now share the same validation path. Keep the lower-level rule available to its existing direct test callers.

## MVP

1. Implement the canonical-ID wrapper and invalid-ID finding in `we:scripts/check-standards-rules.mjs`.
2. Route raw-card validation through it in `we:scripts/check-standards.mjs`, eliminating the local numeric-only regex.
3. Extend `we:scripts/__tests__/check-standards-rules-backlog-integrity.test.mjs` with hash and numeric fixtures, raw-field checks, and invalid-ID handling. Extend `we:scripts/__tests__/check-standards.test.mjs` with the production-wiring assertion and supporting lower-level hash assertion. Do not add a new test file or change the corpus ceiling.

## Acceptance

- [A1] Executable — named test `card deferred edges reject hash self references` in `we:scripts/__tests__/check-standards-rules-backlog-integrity.test.mjs` asserts a self-edge diagnostic for stem xabc123-example with deferredBlockedBy [xabc123] and that hash in the known-ID set. The numeric-only implementation returns no diagnostic; the corrected wrapper passes. Include a numeric twin and a valid non-self hash edge in the same regression matrix.
- [A2] Executable — named test `raw deferred edge gate delegates canonical identity validation` in `we:scripts/__tests__/check-standards.test.mjs` asserts that the production raw-frontmatter loop calls the wrapper and forwards its findings to the existing error emitter, with no numeric-only selfNum extraction. It fails on current wiring and passes after replacement. This protects the changed caller, not just an unused helper.
- [A3] Executable — named test `card deferred edges reject unparseable self identity` in `we:scripts/__tests__/check-standards-rules-backlog-integrity.test.mjs` supplies an invalid filename stem, an explicit deferredBlockedBy array, and a known target. It requires an actionable identity error instead of silently skipping self validation; the current numeric derivation yields no finding. Include absent-field silence, malformed-array rejection and unresolved-target rejection in this matrix to preserve optional defaults and raw-field validation.

## Test plan

Add A1 and A3 to `we:scripts/__tests__/check-standards-rules-backlog-integrity.test.mjs` and A2 to `we:scripts/__tests__/check-standards.test.mjs`. Use the actual canonical parser through the proposed wrapper, not a copied regex. Add a direct hash-self-edge assertion to the existing deferredBlockedByFindings tests at `we:scripts/__tests__/check-standards.test.mjs:638`; this lower-level assertion already passes and is supporting coverage, not the red regression.

Run both focused files through the host heavy-run queue using the run subcommand of `we:scripts/readiness/heavy-admission.mjs` with `--wait-ms=60000`, forwarding `npm run test:unit --` and the repo-relative test-file arguments corresponding to `we:scripts/__tests__/check-standards.test.mjs` and `we:scripts/__tests__/check-standards-rules-backlog-integrity.test.mjs`. If admission remains busy after that one wait, stop and report. Do not run the full suite. Record pre-build failures and post-build passes for A1–A3; a missing wrapper export alone is insufficient evidence of the old behavioral defect, so also record the current derivation's output for the hash fixture.

## Proof plan

During implementation, use an isolated disposable checkout under the task's TMPDIR for the live-gate probe, keeping fixture files out of the acquired lane. Add a valid hash-named story fixture at checkout-relative `we:backlog/xzzzzz1-probe.md` with matching bornAs, valid dateOpened/status/size, and deferredBlockedBy [xzzzzz1]. Verify the fixture token does not collide with existing cards first.

Run `npm run check:standards` through the host heavy-run queue from that checkout, before and after the implementation. Capture the diagnostic for the exact fixture: before, the self-edge diagnostic is absent; after, the gate emits `deferredBlockedBy "xzzzzz1" is a self-edge` with the fixture filename. Do not interpret unrelated gate failures as proof of the regression. Remove the fixture, then run the queued standards gate on the actual implementation checkout and report unrelated failures separately. All scratch output belongs under the task's TMPDIR. This is a future builder proof, not a probe performed during this card-only preparation.

## Follow-ups

- Original item 2: independently redesign the corpus ratchet at `we:scripts/__tests__/check-standards.test.mjs:827` around a committed baseline or touched-card diff. The current ceiling is 187; do not weaken it in this fix.
- Original item 1 tail: consider a class-wide lint banning ad-hoc numeric-only filename parsing in `we:scripts/check-standards.mjs`. This fix removes the specific defective extraction without expanding to unrelated parsers.
