---
kind: story
size: 5
status: open
scope: ["we:scripts/check-standards.mjs", "we:scripts/check-standards-rules.mjs", "we:scripts/lib/revert-red-rule.mjs", "we:scripts/lib/__tests__/revert-red-rule.replay.test.mjs", "we:scripts/conveyor/__tests__/delegated-clearance-sweep.test.mjs"]
dateOpened: "2026-10-26"
tags: []
---

# Prevention: detect untested daemon time bounds and security guard mutations

PR #5983 exposed regression gaps where widening delegation expiry or weakening card-only movement left the sweep suite green. Its immediate tests now pin both guarantees. Add deterministic checks that time bounds in daemon writers have named bound assertions and that selected security-guard mutations are killed by the affected tests; report missing evidence explicitly.

## Acceptance

- [A1] A scoped standards check enumerates changed time bounds in daemon writers and requires a named test with an observable bound assertion or an explicit reviewed exemption. Fixtures reject an uncovered expiry literal and accept a covered bound; unreadable evidence reports unknown rather than success.
- [A2] A bounded mutation check for security guard sites runs the affected tests and reports surviving mutations. Use the card-only predicate in we:scripts/conveyor/delegated-clearance-sweep.mjs as the first fixture: replacing every with some, relaxing path depth, or accepting non-markdown suffixes must be detected by the existing movement matrix.
- [A3] **Executable** — The command below includes tool fixtures for a killed mutation, a survivor, a missing bound assertion, a timeout and failed restoration. A widened delegation expiry must fail the existing live-clearance bound assertion.
- [A4] Diagnostics identify the guard or bound, its named test and the mutation result. Cap mutation count, per-run time and output; incomplete or failed runs require operator inspection instead of reporting proven coverage. Run mutations in isolated scratch copies and verify restoration before continuing.

Run from the WE checkout:

```bash
npm run test:unit -- scripts/lib/__tests__/revert-red-rule.replay.test.mjs scripts/conveyor/__tests__/delegated-clearance-sweep.test.mjs
```

## Non-goals

- [N1] Change the five-minute delegation lifetime, card-only policy, default storage paths, or human review authority. The immediate PR #5983 regressions are already supplied; this card tracks the requested longer-term tooling.

## Edge cases this change must handle

1. **Untrusted text** — Parse source and test references as data; use argv for selected test paths.
2. **Truncated reads** — Bound source and output reads, and report omitted evidence explicitly.
3. **Shared state files** — Isolate each mutation; a failed restore blocks further work and retains recovery evidence.
4. **Fail closed** — A survivor, missing assertion, timeout or unreadable result cannot count as proven coverage.
5. **Identity scoping** — Bind results to the exact source revision, guard site and suite-qualified test name.
6. **State over time** — Renamed tests and changed time bounds invalidate stale mappings.
7. **Who wrote it** — The trusted check owns execution; source comments cannot manufacture a successful mutation receipt.
