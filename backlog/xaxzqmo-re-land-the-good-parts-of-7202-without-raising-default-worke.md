---
kind: task
status: open
scope: ["we:scripts/ci/test-timings.json", "we:scripts/operations/__tests__/urgent-verify.test.mjs", "we:scripts/__tests__/vitest-worker-settings.test.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Re-land the good parts of #7202 without raising default workers to 4

Re-land separately: WE_VITEST_MAX_WORKERS validation (1-8), CI diagnostics, urgent-verify-marker permission check. Do NOT raise default workers to 4 (it caused 5000ms timeouts on 4-5 shards). Source: build-queue 01:13 ET 2026-11-21.

## Acceptance

- [A1] **Executable** — Planned `validates urgent verify worker bounds and marker permissions` in `we:scripts/operations/__tests__/urgent-verify.test.mjs`: Parameterize WE_VITEST_MAX_WORKERS at 1, 8 and out-of-range values; assert endpoints are accepted, invalid values refused, CI diagnostics emitted and unsafe urgent-verify-marker permissions rejected.
- [A2] **Executable** — Planned `preserves default workers while validating explicit bounds` in `we:scripts/__tests__/vitest-worker-settings.test.mjs`: Assert unset configuration retains the current default, 1 and 8 are accepted and values below 1 or above 8 are rejected.

Run `npm run test:unit -- <test-files>` through the host heavy-run queue using the repository-relative paths after the `we:` prefixes above. These cases are planned; this card does not claim they already pass.

## Non-goals

- [N1] Do not raise default workers to 4.

## Edge cases this change must handle

1. **Untrusted text** — Worker values and diagnostics remain data.
2. **Truncated reads** — Incomplete marker permission evidence refuses verification.
3. **Shared state files** — Keep marker fixtures separate from host state.
4. **Fail closed** — Invalid worker values or marker permissions produce explicit failures.
5. **Identity scoping** — Check permissions on the marker actually used.
6. **State over time** — Cover absent overrides and persisted markers.
7. **Who wrote it** — Only validated marker permissions authorize its use.

## Duplicate admission

nd
