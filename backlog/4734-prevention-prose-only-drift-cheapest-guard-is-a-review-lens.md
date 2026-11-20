---
bornAs: x6hepxj
kind: story
size: 5
parent: "4075"
status: open
scope: ["we:backlog/3372-verify-lane-runs-the-full-suite-instead-of-the-diff-driven-s.md", "we:scripts/lib/verify-lane-gate.mjs", "we:scripts/conveyor/verify-dispatch.mjs", "we:scripts/verify-lane.mjs", "we:scripts/lib/verify-marker-update.mjs", "we:scripts/lib/__tests__/verify-lane-gate.test.mjs", "we:scripts/conveyor/__tests__/verify-dispatch.test.mjs", "we:scripts/__tests__/verify-lane.test.mjs", "we:scripts/lib/__tests__/verify-marker-update.test.mjs"]
dateOpened: "2026-10-01"
preparedDate: "2026-11-20"
preparedAgainstSha: "2b361c583a09326864a819321d456c4aa19bdc4f"
tags: []
---

# Prevention — Prose-only drift. Cheapest guard is a review lens that compares card claims with the brief test asserti… (from chalbert/web-everything#3414 review)

Filed mechanically on approval of chalbert/web-everything#3414. The original prevention combined a prose/test review lens, shell-equivalent forbidden-flag rejection, and coordination between verification marker writers. The flag findings are one guard, not two implementations.

Current source locations: explicit override validation is at `we:scripts/lib/verify-lane-gate.mjs:806-827`; killed-run settlement is at `we:scripts/conveyor/verify-dispatch.mjs:375-393`; request and normal completion writes share `we:scripts/verify-lane.mjs:190-197`. The historical prose is in the Follow-ups section of `we:backlog/3372-verify-lane-runs-the-full-suite-instead-of-the-diff-driven-s.md`, not a stable line-80 contract.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#3414@097e398e8df1458a20ce412163545e288fccb4c5

## Design

Preserve the goal: prevent verification claims from outrunning the actual tests, prevent shell spellings from bypassing forbidden-flag checks, and prevent an old verifier from overwriting a newer request.

The review-lens part already exists in `we:scripts/lib/review-core.mjs:224-244` (`GUARANTEE_NEEDS_A_TEST_RULE`), with mandate coverage in `we:scripts/lib/__tests__/review-core.test.mjs:785`. Reuse it; do not add another reviewer or pretend deterministic prose correctness is practical. Update the historical follow-up in `we:backlog/3372-verify-lane-runs-the-full-suite-instead-of-the-diff-driven-s.md` to distinguish historical selection limits from current behavior and link the concrete regression cases delivered here.

For explicit overrides, use the original card's conservative charset alternative: accept only whitespace-separated literal tokens from `[A-Za-z0-9_./@=:,-]`, with `&&` permitted only as the existing segment separator. Reject quotes, escapes, expansions, globbing, tilde, control characters and malformed/empty segments before flag classification; apply this to standards segments too. The colon permits the existing `check:standards` command token; charset acceptance does not bypass the existing command/flag allowlist. Keep the existing allowed command/flag policy. This deliberately changes the currently accepted quoted-target explicit override fixture; tell the operator to use literal safe target paths or the generated default gate/CI for paths requiring quoting. Do not impose this grammar on internally generated default commands, which quote changed paths and may carry additional trusted flags.

Keep current admission boundaries: request and dispatched-child validation for known blocked selections; recognized generated gates and configured full-policy gates remain exempt. This story does not broaden or loosen the policy for docs-only overrides or unknown diffs. Persisted explicit overrides reaching the existing dispatched-child guard must receive the same refusal as fresh requests. Preserve no-marker request refusal and terminal child refusal, conditional on still owning that request.

Introduce `we:scripts/lib/verify-marker-update.mjs` as the shared synchronous marker transaction helper. Reuse `withLedgerAppendLock` from `we:scripts/lib/ledger-append-lock.mjs:34` with a marker-specific key and explicit lock directory under the resolved git directory (not process-dependent temporary roots). Hold the lock across read, ownership predicate, construction and atomic rename. Route request/start, cached result, refusal, normal finish and killed-run settlement through it. Completion predicates must reject superseded identity; a start/request may supersede according to existing policy but must acquire the same lock. Preserve legacy identity comparisons and worktree git-directory resolution.

Bound lock acquisition to 5 seconds. On contention timeout, unreadable ownership or write failure, do not perform an unlocked write or publish green; report the marker update failure and require diagnosis/retry. Release on callback failure; use unique temporary siblings and clean them up. Do not hold the lock during gate execution or admission waits. Existing read-only consumers and green-ledger storage need no format change.

## MVP

1. Tighten the literal grammar in `we:scripts/lib/verify-lane-gate.mjs` and replace the quoted-target acceptance fixture explicitly; add the adversarial spelling matrix.
2. Implement and test the transaction helper, then migrate both production marker writers in `we:scripts/verify-lane.mjs` and `we:scripts/conveyor/verify-dispatch.mjs`. Audit every writeMarker caller, including early cached/refusal paths, for transaction-local ownership checks.
3. Add deterministic writer interleavings and CLI refusal cases. Update the historical card's follow-up against those assertions; retain its historical incident evidence.

## Acceptance

- [A1] Executable — planned `explicit overrides reject shell-equivalent forbidden flags` in `we:scripts/lib/__tests__/verify-lane-gate.test.mjs`: each currently forbidden flag, including short aliases, is refused in single/double-quoted, backslash, ANSI-C-quoted, variable and brace/glob forms. Cover unsafe standards-segment tokens and malformed input; safe literal targets remain accepted. Add the named table-driven compatibility test `safe explicit overrides preserve allowed command spellings` in `we:scripts/lib/__tests__/verify-lane-gate.test.mjs`, covering every currently allowed literal command spelling, including a targeted Vitest segment joined with `npm run check:standards` and its existing safe arguments. Assert acceptance with the new grammar; this compatibility case passes before and after, while the adversarial matrix supplies the red-before proof. The newly refused quoted-target fixture pins the changed default grammar. This matrix fails against today's raw-token validator and passes after tightening it.
- [A2] Executable — planned `encoded override refusal reaches request and resumed child` in `we:scripts/__tests__/verify-lane.test.mjs`: blocked config/data/source selections reject encoded overrides before execution; a docs-only accepted request subsequently changed to a blocked dependency/config diff is rechecked by the child. Fresh refusal creates no marker; owned child refusal is terminal, and superseded refusal preserves the successor. Include generated quoted-path gates, explicit full-policy gates and unchanged docs-only behavior as compatibility assertions. The encoded refusal and superseded refusal assertions must fail before implementation.
- [A3] Executable — planned `new request arriving after settlement read survives` in `we:scripts/conveyor/__tests__/verify-dispatch.test.mjs` and `normal finish cannot replace successor` in `we:scripts/__tests__/verify-lane.test.mjs`: coordinate separate writers with barriers, not sleeps. Pause old settlement after its ownership read, attempt the new request, release settlement, and assert the final bytes are the newer running request. Also install the successor before completion acquires the lock and assert no write. Cover runId and legacy timestamp identities, queue and gate kills. The after-read case fails with today's unlocked read/rename.
- [A4] Executable — planned `marker transaction fails closed and releases ownership` in `we:scripts/lib/__tests__/verify-marker-update.test.mjs`, plus caller cases in `we:scripts/__tests__/verify-lane.test.mjs` and `we:scripts/conveyor/__tests__/verify-dispatch.test.mjs`: inject lock timeout, unreadable/corrupt marker, callback throw and rename failure. Assert bounded acquisition, no unlocked mutation/green, visible retry guidance, and release/temporary cleanup. Both callers must use the same resolved-git-dir lock despite differing temporary environments. Tests fail with the helper absent and fail if either caller bypasses it.

## Test plan

Run only the four changed suites named in [A1]–[A4] through the host heavy-run queue. The runnable form is `node <queue> run --wait-ms=60000 -- npx vitest run <tests>`, where `<queue>` is `we:scripts/readiness/heavy-admission.mjs` and `<tests>` are the four repository-qualified suite paths above with the `we:` locator removed at execution. If admission cannot acquire within that one wait, stop and report it.

Build the spelling table from the existing disallowed-flag fixtures, including `--passWithNoTests`, config/root/dir/reporter/exclude and test-name filtering. Do not execute malicious shell strings. Use hermetic CLI fixtures and injected IO/barriers for transaction tests, including worktree-style git-dir resolution. No real daemon or model dispatch is needed. Existing policy tests remain assertions, not fixtures to weaken for the new grammar.

## Proof plan

Record red-before/green-after results for each named acceptance case, including exact assertion failures and the queue command used. For the race, record barrier order and final marker identity; an atomic rename alone and a newer request installed before the initial read are insufficient evidence. Mutation checks must show that bypassing grammar validation or removing either writer's transaction makes its regression fail. Inspect the historical card's final wording beside the actual tests using the already-shipped guarantee-to-test review lens. This human comparison is not an automated semantic gate.

The runner owns preparation stamping and checks. Implementation validation additionally runs `npm run check:standards` through `we:scripts/readiness/heavy-admission.mjs` with the same single bounded wait. Do not claim runtime fixes from this preparation-only edit.

## Follow-ups

No new reviewer, shell parser dependency, marker schema, full-suite fallback, or selection-policy redesign is required. Broader unknown-diff admission policy and support for arbitrary quoted explicit paths remain outside this guard. Generated commands retain their existing quoting behavior. If another production marker writer is discovered during implementation, include it in the shared transaction and its regression scope before claiming coordination complete.

## Progress

- Preparation research: the old scope named only the selector and dispatcher plus their two suites and the historical card. The old premise located validation at line 440 and listed the nonexistent shortened test path. Corrected source evidence is `we:scripts/lib/verify-lane-gate.mjs:806-827` and the real tests at `we:scripts/lib/__tests__/verify-lane-gate.test.mjs:762-802`: whitespace splitting allows quoted flags to look like targets, and quoted targets are explicitly accepted today.
- The prose review guard is already present at `we:scripts/lib/review-core.mjs:224-244`; that portion needs no new mechanism. The overall goal is not already delivered: `we:scripts/conveyor/verify-dispatch.mjs:380-393` still separates ownership read from rename without coordination. Its existing newer-request tests at `we:scripts/conveyor/__tests__/verify-dispatch.test.mjs:758-817` install successors before the read, not after it.
- Corrected scope includes the second writer and matching CLI tests: `we:scripts/verify-lane.mjs:190-197`, with write sites at lines 457, 619, 639 and 1220. Existing admission boundary evidence is `we:scripts/verify-lane.mjs:430-452` and `we:scripts/__tests__/verify-lane.test.mjs:1467-1511`. Preserve those policy exceptions while closing lexical bypasses and coordinating all marker writes.
- Size changed from 3 to 5: estimated implementation touch set is selector ~30 lines, dispatcher ~35, CLI ~65, new shared transaction helper ~90, four test files ~220 combined, historical follow-up ~15 (about 455 changed lines across nine files). The expansion is grounded in the multiple writer/caller sites above, not an added product goal. This remains a story; no estimatedLoc field is added. No blockedBy change is proposed and no preparation stamp is authored.

- Pre-review correction: the proposed token charset originally omitted the colon required by `npm run check:standards`. Added colon while retaining command/flag allowlisting, and added a named table-driven compatibility test under [A1]. Scope and size remain unchanged. Existing acceptance evidence is `we:scripts/lib/__tests__/verify-lane-gate.test.mjs:768`.
