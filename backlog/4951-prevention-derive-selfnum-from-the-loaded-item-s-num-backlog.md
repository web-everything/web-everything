---
bornAs: xwx7fbq
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/check-standards.mjs", "we:scripts/__tests__/check-standards.test.mjs"]
dateOpened: "2026-10-01"
preparedDate: "2026-11-20"
preparedAgainstSha: "fbeca8e4d4d485e39aded3226c60f4b4941e9a04"
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

Preparation research against checkout `fbeca8e4d4d485e39aded3226c60f4b4941e9a04`; no implementation or stamp performed.

- Old premise: the numeric-only caller was at line 996, the rules helper at line 3886, and the corpus ceiling was 190. Corrected evidence: `we:scripts/check-standards.mjs:1068` still derives `selfNum` with `^(\d+)-`; `we:scripts/check-standards-rules.mjs:4159` accepts string self IDs but skips self comparison when the caller supplies undefined. Known IDs come from loaded item numbers at `we:scripts/check-standards.mjs:841`, so a known hash can evade both self-edge and unresolved-edge findings. The corpus ceiling is now 187 at `we:scripts/__tests__/check-standards.test.mjs:836`. Historical review citations above now point to the current locations.
- Old scope declared two files but proposed a third-file helper extraction. Corrected scope keeps the two declared files: import and call the canonical parser directly in `we:scripts/check-standards.mjs`, and exercise the actual CLI in `we:scripts/__tests__/check-standards.test.mjs`. No rules-module edit is needed. `idFromName` already exists at `we:scripts/backlog/id.mjs:46`; its numeric/hash grammar is at `we:scripts/backlog/id.mjs:37`.
- Size remains 3: approximately 3–6 changed production lines plus 70–110 fixture/assertion lines in the existing test file. The isolated CLI fixture pattern already exists at `we:scripts/__tests__/check-standards.test.mjs:680`, including dependency linking, working-tree script overlays and bounded subprocess output/time. This is a story, so no estimatedLoc is added.
- No new default or policy choice is needed. Raw field validation remains in the same caller before the optional scope early return. Existing numeric, non-array, unresolved and duplicate-edge cases are at `we:scripts/__tests__/check-standards.test.mjs:638`. Diff-scoped scope errors already exist at `we:scripts/check-standards.mjs:1140`; the independent corpus-ratchet redesign remains a follow-up, as in the prior preparation.

## Design

Extend the existing canonical-ID import at `we:scripts/check-standards.mjs:131` with `idFromName`. Replace the numeric-only extraction at `we:scripts/check-standards.mjs:1068` with `idFromName(id)` and pass that value to the existing rule. Continue reading RAW frontmatter: using normalized loader fields would hide malformed deferredBlockedBy values. Keep validation before the scope guard, so cards without scope receive the same check.

Use the actual production CLI for the regression, following the private-checkout pattern in `we:scripts/__tests__/check-standards.test.mjs:680`. Overlay the modified gate, link dependencies, and provide a local baseline ref. Create a valid hash card with matching bornAs and a self-referencing deferredBlockedBy array. Parse JSON diagnostics and require the exact self-edge message for that card plus exit status 1. Do not count an unrelated nonzero exit as proof. Clean up in finally; use the task TMPDIR and bounded child timeout/output.

## MVP

1. Change the canonical parser import and self-ID derivation in `we:scripts/check-standards.mjs`.
2. Add the production CLI regression and hash rule cases to `we:scripts/__tests__/check-standards.test.mjs`.
3. Cover both a scoped hash card and a hash card with scope absent; retain numeric behavior and raw malformed-field rejection. No new helper, baseline file, global parsing lint, settings or public API.

## Acceptance

[A1] Executable — proposed test `deferred self-edge CLI rejects hash IDs with and without scope` in `we:scripts/__tests__/check-standards.test.mjs` must fail before the parser change and pass afterward. It runs the production caller against both hash fixtures, asserts status 1 and the exact self-edge diagnostic, and includes numeric-self, clean-external, absent-field, non-array and unresolved-reference controls. This guarantees the changed hash handling reaches the CLI, including the no-scope path, while retaining current defaults and fail-closed raw validation. Run the queued focused command described in Test plan.

## Test plan

Run `node` with the repository-relative spelling of `we:scripts/readiness/heavy-admission.mjs`, followed by `run -- npx vitest run`, the repository-relative spelling of `we:scripts/__tests__/check-standards.test.mjs`, and `-t 'deferred self-edge CLI'`. Locus prefixes identify repositories; remove them only when supplying file arguments to the shell.

The A1 test uses a bounded sequence of fixtures in one private checkout. Assert diagnostics by exact card ID and message, independently of unrelated corpus findings. For clean external/absent-field controls, assert no deferredBlockedBy diagnostic for the fixture rather than requiring the entire legacy corpus to be clean. Non-array and unresolved cases must produce their respective errors. The hash fixtures must be present in the loaded known-ID set, reproducing the silent acceptance rather than accidentally testing unresolved references.

Also extend the existing pure-rule cases with a hash self-edge and a valid external hash edge. These controls already pass at rule level and are not the red/green proof. After the focused red/green experiment, run the affected test file through the same queue without the name filter. If admission is busy, use its supported bounded wait once and report inability to run if still busy; do not poll.

## Proof plan

The builder first adds the A1 test while retaining the old production derivation and records the queued failure: the expected hash self-edge message is absent. Then change the import/derivation and rerun the same test, recording the exact diagnostic and passing result. The fixture invokes the shipped CLI, not a copy of its regex or a new helper disconnected from the caller. Check both hash variants, numeric compatibility and malformed raw fields in that same test.

The runner owns preparation stamping and checks. For build completion, run `npm run check:standards` through `node` and the repository-relative spelling of `we:scripts/readiness/heavy-admission.mjs` with `run --`; distinguish unrelated baseline errors from the targeted fixture proof. Preparation itself makes no claim of a live-gate red/green result and creates no probe card in the acquired lane.

## Follow-ups

- Review item 2: design a committed corpus baseline or diff-scoped test ratchet for `we:scripts/__tests__/check-standards.test.mjs:827`. Current production scope errors are already diff-scoped; do not conflate that with the still-global test ceiling of 187. This independent baseline policy is outside the self-ID fix.
- Review item 1 tail: a lint against ad-hoc numeric filename parsing in `we:scripts/check-standards.mjs`. Define legitimate numeric-only exceptions separately before introducing a broad ban.
