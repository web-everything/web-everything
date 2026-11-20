---
kind: story
status: open
size: 5
dateOpened: "2026-11-20"
scope: ['we:scripts/lib/agy-confined-build.mjs', 'we:scripts/lib/agy-fix-admission.mjs', 'we:scripts/verify-lane.mjs', 'we:scripts/lib/__tests__/agy-confined-build.test.mjs', 'we:scripts/__tests__/verify-lane.test.mjs', 'we:scripts/__tests__/check-standards-rules-backlog-integrity.test.mjs', 'we:scripts/check-standards-rules.mjs']
tags: [security, agent-infrastructure]
---

# Hold agy-produced executable tests before host execution

PR #7134's 2026-11-20 security advisory found that allowlisted test code can cross the sandbox through the diff and later run with host credentials. Require review before any host test execution of agy-produced code, or run all such gates inside equivalent confinement. The production unavailable guard stays closed while this ordering boundary is unresolved.

## Acceptance

- [A1] Planned `holds agy test patch before host gate execution` in `we:scripts/__tests__/verify-lane.test.mjs`: a fake worker adds an admissible test that would write a dummy host marker. Assert the unreviewed patch never starts a host runner and the marker is absent, including explicit test selection, default related selection, retries and resumed verification. A reviewed exact patch may proceed; a changed patch invalidates review. Cover CI as well as local gates before declaring the boundary complete.
- [A2] Planned `preserves agy patch provenance through apply` in `we:scripts/lib/__tests__/agy-confined-build.test.mjs`: assert test additions, modifications and renames retain launcher-authored provenance tied to exact patch bytes; missing, stale or worker-forged provenance refuses host execution. If confinement replaces a review hold, assert the dummy marker cannot be written from any gate path instead.
- [A3] Planned `rejects agy test-subject widening without execution gate` in `we:scripts/__tests__/check-standards-rules-backlog-integrity.test.mjs`: widen `AGY_TEST_SUBJECT_PREFIXES` in a fixture and assert a named standards failure unless independently validated execution protection covers the new subjects. A worker-authored boolean or comment is not gate evidence.

Run `npm run test:unit -- <test-files>` using the A1–A3 files' repository-relative paths after the `we:` prefix. Cases are planned. No broader test allowlist or production enablement is authorized. Include concurrent verification, stale review, crash recovery and CI selection in the implementation sweep; a local-only hold does not meet A1.
