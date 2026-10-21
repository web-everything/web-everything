---
bornAs: xfeln67
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lane-pool.mjs", "we:scripts/lib/lane-transcript-attribution.mjs", "we:scripts/__tests__/lane-whois-cap.test.mjs", "we:scripts/__tests__/host-overload-guard.test.mjs", "we:scripts/lib/host-load.mjs", "we:scripts/lib/host-overload-settings.mjs", "we:scripts/lib/lane-transcript-backfill.mjs", "we:scripts/readiness/heavy-admission.mjs", "we:scripts/__tests__/lane-pool.test.mjs", "we:scripts/lib/__tests__/lane-transcript-attribution.test.mjs", "we:scripts/lib/__tests__/host-load.test.mjs", "we:scripts/lib/__tests__/host-overload-settings.test.mjs", "we:scripts/lib/__tests__/lane-transcript-backfill.test.mjs", "we:scripts/readiness/__tests__/heavy-admission.test.mjs"]
dateOpened: "2026-10-18"
tags: []
---

# Prevention — Add a refreshLane test with a lane whose .git/HEAD is corrupt, asserting refresh heals or skips i… (from web-everything/web-everything#5624 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lane-pool.mjs:1188` — Add a refreshLane test with a lane whose .git/HEAD is corrupt, asserting refresh heals or skips it. Use tryGit for best-effort config writes.
2. `we:scripts/lib/lane-transcript-attribution.mjs:163` — Add a test of recentTranscriptFiles in strict mode with more files than the default cap and a real directory. Decide whether the cap should be lifted or chunked for explicit scans.
3. `we:scripts/__tests__/lane-whois-cap.test.mjs:1` — Add a test in we:scripts/__tests__/lane-whois-cap.test.mjs with admission returning {admitted:false} expecting a throw that never calls scan. Add a test with explicitScan=false. Add a cmdGc spawn test.
4. `we:scripts/__tests__/host-overload-guard.test.mjs:1` — Add a test that provisions, then refreshes and runs a sibling clone, and asserts gc.auto=0 on each. Add an acquireSlotBlocking test with interactive:true and an overloaded injected load that expects an immediate slot.
5. `we:scripts/__tests__/lane-whois-cap.test.mjs:18` — Add a check:standards rule that fails when scanLaneTranscripts is imported outside we:scripts/lib/lane-transcript-backfill.mjs and the explicit whois path.
6. `we:scripts/__tests__/host-overload-guard.test.mjs:14` — Add a refresh-path and sibling-clone test asserting gc.auto, or centralise the setting in one helper that all three sites call.
7. `we:scripts/lib/host-load.mjs:51` — Add a test with a throwing exec on lane 1 that asserts lane 2 is still attempted, and wrap the per-lane git call in its own try/catch.
8. `we:scripts/lib/host-overload-settings.mjs:10` — Add a deterministic read-range assertion for an oversized input and require that test in the verification gate.
9. `we:scripts/lib/host-overload-settings.mjs:23` — Require a deterministic defaults test resolving empty platform, tool, and environment layers and asserting both values.
10. `we:scripts/lib/lane-transcript-backfill.mjs:14` — Gate verification on a test setting WE_LANE_TRANSCRIPT_EXPLICIT_SCAN=false and asserting refusal plus zero scanner calls.
11. `we:scripts/lib/host-load.mjs:59` — Require a deterministic test asserting gc.autoDetach=false and --no-detach on every GC invocation.
12. `we:scripts/readiness/heavy-admission.mjs:1109` — Require deterministic clock-driven tests asserting no admission while a slot remains occupied and eventual normal slot admission after the default fallback wait under invalid policy.
13. `we:scripts/lane-pool.mjs:4440` — Add a deterministic subprocess test asserting exit 75 and the logged overload reason for deferred GC.
14. `we:scripts/lib/host-overload-settings.mjs:10` — Add a deterministic boundedText test using an instrumented reader to assert the read budget, overflow rejection, and descriptor closure.
15. `we:scripts/lib/host-overload-settings.mjs:23` — Add deterministic tests for standard policy values and both boolean scan-policy branches, including scanner noninvocation when disabled.
16. `we:scripts/readiness/heavy-admission.mjs:1203` — Add deterministic fake-clock integration tests combining host timeout with an occupied slot and malformed policy.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5624@2b893754ccf3ed784ba432d7dbc0ee0809622963

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
