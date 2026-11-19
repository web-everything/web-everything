---
bornAs: xkecc48
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/probation-launcher.mjs", "we:scripts/lib/__tests__/probation-launcher.test.mjs", "we:scripts/operations/probation-heal-run.mjs", "we:scripts/operations/__tests__/probation-heal-run.test.mjs"]
dateOpened: "2026-09-30"
preparedDate: "2026-11-19"
preparedAgainstSha: "3400e7fffef866bfa14d61645db1550b53a43da5"
tags: []
---

# File the prevention guard(s) owed by chalbert/web-everything#3069's independent review

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. When a heal has a non-empty declared scope that names no WE path, log instead of silently treating it as unscoped. The filtering and permissive fallback currently live in `we:scripts/lib/probation-launcher.mjs:395-420`; emit the diagnostic from `we:scripts/operations/probation-heal-run.mjs` using its existing contextual logger. Preserve the current path-gate decisions and explicitly empty-scope behavior.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#3069@c6242481e154f15781db807ca3526b74ba6c4981

## Progress

- Original premise/scope: the prior preparation located filtering at `we:scripts/lib/probation-launcher.mjs:325-329`, fallback at `we:scripts/lib/probation-launcher.mjs:346-351`, and the runner logger/path gate at lines 88/175. It proposed a pure helper and runner warning across the four files already in scope.
- Corrected premise: filtering is now at `we:scripts/lib/probation-launcher.mjs:395-399`, with permissive zero-WE-entry fallback at `we:scripts/lib/probation-launcher.mjs:416-421`. The contextual logger is inside `runHealArc` at `we:scripts/operations/probation-heal-run.mjs:318-320`, behind the outer validation/ownership wrapper at `we:scripts/operations/probation-heal-run.mjs:297-302`; acquisition is at line 343 and the path gate at line 415 of that same repository-prefixed source. The warning must be wired inside this arc, not before ownership validation.
- Source evidence: `we:scripts/lib/__tests__/probation-launcher.test.mjs:224-230` still explicitly accepts omitted, empty and foreign-only scopes, while rejecting a mixed scope's out-of-WE-scope path. Inspection of the current normalization and runner arc shows no scope-mismatch diagnostic. This guard remains undelivered; the prior preparation's direct-import probe is historical evidence, not a probe repeated by this preparation.
- Corrected scope: retain all four existing source/test entries. `we:scripts/operations/__tests__/probation-heal-run.test.mjs:145-182` supplies fake I/O with a currently silent logger and acquisition stub; record both for ordering assertions. Existing path refusals and successful healing are covered at `we:scripts/operations/__tests__/probation-heal-run.test.mjs:340-357`.
- Caller/default audit: the detached provider in `we:scripts/operations/dispatch-providers/probation-worker.mjs` forwards scope as a CLI argument; `we:scripts/operations/probation-heal-run.mjs:285` parses it to an array, defaulting to empty. The only production caller of `healDiffPathsAllowed` found by repository search is `we:scripts/operations/probation-heal-run.mjs:415`. No default, persisted state, provider protocol or rejection policy changes are needed.
- Size stays **3**: estimate roughly 20 helper lines beside `we:scripts/lib/probation-launcher.mjs:395`, 5 wiring lines beside `we:scripts/operations/probation-heal-run.mjs:320`, 35 helper-test lines beside `we:scripts/lib/__tests__/probation-launcher.test.mjs:210`, and 65 runner-test lines using `we:scripts/operations/__tests__/probation-heal-run.test.mjs:145` (about 125 changed lines across four files). This is a story; no `estimatedLoc` is added. Stamping and delivery checks remain runner-owned.

## Design

Add an exported pure `healScopeDiagnostic(scope = [])` helper in `we:scripts/lib/probation-launcher.mjs` beside `weScopeEntries`. Reuse that normalization exactly: emit a warning string only for a non-empty declared array with zero WE entries; otherwise return null. Bare local entries and explicit `we:` entries count as WE entries, including in mixed arrays. Do not add aliases or tighten the existing scope interpretation.

The warning says the declared scope contains no WE paths and therefore supplies no WE path restriction. Include the declared entries as JSON-encoded strings so embedded newline/control characters are escaped rather than injected into terminal output. Keep the helper free of I/O and preserve the path gate's return contract.

Import the helper in `we:scripts/operations/probation-heal-run.mjs` and invoke it once immediately after `runHealArc` creates its contextual logger. Log a non-null result through that logger, before acquisition and before the worker-needed branch. This covers worker repair, mechanical healing, and no-change runs while preserving the outer argument/ownership refusals. Existing PR and worker context comes from the logger.

This diagnostic adds no fail-closed policy or new setting. Foreign-only scope remains unrestricted by declared WE scope, but statute-tier, dispatch-machinery, envelope and mixed-scope rejection gates remain active. No mutation, dispatch, public comment or persisted-state change is required for the warning.

## MVP

1. Implement the pure helper with JSDoc and classification/escaping tests in `we:scripts/lib/probation-launcher.mjs` and `we:scripts/lib/__tests__/probation-launcher.test.mjs`.
2. Wire it into the existing arc logger in `we:scripts/operations/probation-heal-run.mjs` without changing scope parsing, provider defaults, acquisition arguments or enforcement.
3. Extend the fake-I/O harness in `we:scripts/operations/__tests__/probation-heal-run.test.mjs` to record warning/acquisition order. Add the named acceptance tests below in the same delivery.

## Acceptance

- [A1] Executable — proposed `scope diagnostic classifies and safely renders declared entries` in `we:scripts/lib/__tests__/probation-launcher.test.mjs`: table-test one/multiple foreign entries, omitted/empty, bare local, explicit WE and mixed scopes. Assert actionable text and declared entries only for foreign-only scope, with newline/ESC escaped. Fails before implementation because the helper is absent; passes after it is added.
- [A2] Executable — proposed `foreign-only scope warns once before acquisition on every heal branch` in `we:scripts/operations/__tests__/probation-heal-run.test.mjs`: worker repair, rebase-only heal and no-change fixtures each assert one warning containing PR/worker context and entries, before recorded acquisition; preserve each outcome. Fails before because the runner emits no warning; passes after wiring.
- [A3] Executable — proposed `scope warning preserves CLI defaults and caller scope` in `we:scripts/operations/__tests__/probation-heal-run.test.mjs`: exercise `parseArgs` for absent/empty scope and provider-style foreign/mixed arguments, then run the arc and assert the identical scope reaches acquisition. Omitted/empty/local/explicit WE/mixed cases stay quiet; a foreign-only positive control warns. The positive control makes this combined contract fail before wiring and pass after; defaults do not change.
- [A4] Executable — proposed `scope warning does not bypass existing refusal gates` in `we:scripts/operations/__tests__/probation-heal-run.test.mjs`: foreign-only scope warns but statute-tier, dispatch-machinery and oversized diffs still refuse without commit/push; mixed out-of-scope diffs still refuse without warning, and valid in-scope diffs still heal. Also assert invalid arguments and ownership-binding refusal never acquire or dispatch. The foreign-only warning assertion fails before wiring; the full contract passes after. Retain existing rejection regressions unchanged.

## Test plan

Add A1 to `we:scripts/lib/__tests__/probation-launcher.test.mjs` and A2–A4 to `we:scripts/operations/__tests__/probation-heal-run.test.mjs`. Record log and acquire events in a shared trace; match only the scope diagnostic, not unrelated logs. Use existing injected I/O for all runner cases, including a throwing ownership binder; no real lane, provider or GitHub call is needed.

Run the two focused suites through the host queue: invoke `node` with `we:scripts/readiness/heavy-admission.mjs`, arguments `run --wait-ms=60000 -- npx vitest run`, then `we:scripts/lib/__tests__/probation-launcher.test.mjs` and `we:scripts/operations/__tests__/probation-heal-run.test.mjs`. Resolve the `we:` references relative to the WE checkout and remove only that prefix when constructing executable argv. Do not run bare Vitest. The consistency command uses the same queue entry with `run --wait-ms=60000 -- npm run check:standards`. If capacity remains unavailable after that one bounded wait, stop and report it; do not poll or retry in a loop.

## Proof plan

Add the named regressions first. Capture A1 failing for the missing helper and A2–A4 failing on their absent-warning assertions against the old implementation; run runner regressions independently if the missing helper export prevents helper-suite collection. After implementation, capture both focused suites passing, including warning-before-acquisition traces, negative scope cases and unchanged refusal outcomes. The runner fixture executes the actual arc and pure classification code; it proves logger wiring and decisions, not a live provider dispatch. Capture the queued standards-check result separately. This preparation inspected source and tests; it does not claim the proposed regressions have been implemented or run.

## Follow-ups

None required for the review's logging remedy. Mandatory non-empty scope, additional prefix aliases, malformed-input validation, or refusing foreign-only scope would change policy and require separate justification. No blockedBy change is proposed.
