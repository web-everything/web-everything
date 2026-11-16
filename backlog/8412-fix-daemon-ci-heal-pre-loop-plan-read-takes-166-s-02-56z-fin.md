---
bornAs: xdp3u4s
kind: task
status: open
dateOpened: "2026-11-15"
tags: []
---

# fix-daemon ci-heal pre-loop plan read takes ~166 s (02:56Z): find and cut it

The live CI-heal pass spent about 166 seconds reading a plan and 192 seconds in its pre-loop work, exceeding the old 180-second phase budget before admission. PR #6919 gives admission its own slice; this follow-up identifies the slow reader and bounds or reuses its work while preserving owed-write flushing and complete PR evidence.

## Acceptance

- [A1] **Executable** — From WE, run the command below. The tests must include `bounds the pre-loop plan read without losing owed PRs`, using an injected slow reader and clock. Assert the configured read deadline or cached-read bound, and prove a deferred read is reported as unknown work rather than an empty plan.

```bash
npm run test:unit -- scripts/operations/__tests__/ci-heal-starvation.test.mjs
```

- [A2] **Must** — Record timings for poll, owed flush, timeout flush, and plan read separately. Pin read-call counts across a multi-repo pass and confirm the observed 166-second source with a before/after trace.
- [A3] **Must** — Preserve the forced-flush retry and cursor after deadline, adoption yield, and restart. Keep `ci-heal-starved-by-slow-prelude` green with six owed PRs.

## Risks and test plan

Reusing stale plans can admit already-owned PRs; timing out a read can hide owed work or suppress a durable flush. Test complete, deferred, rejected, and stale reads; claim/head changes between reads; and a timeout followed by recovery on the next tick. Use deterministic clock and IO seams plus the existing slow-prelude soak scenario. No HTTP endpoint is added, so request-size, CSRF, and origin controls do not apply.

## Non-goals

- [N1] Do not raise the phase/admission budgets or weaken admission, host, ownership, or adoption gates.

## Edge cases this change must handle

1. **Untrusted text** — Bound and sanitize timing labels; treat PR fields as data.
2. **Truncated reads** — Partial or timed-out reads report deferred/unknown work, never an empty success.
3. **Shared state files** — Preserve atomic cursor writes and fresh claim fingerprints when reusing plans.
4. **Fail closed** — Unreadable ownership or plan evidence defers dispatch; the next tick retries.
5. **Identity scoping** — Cache by repository and head/claim fingerprint, never PR number alone.
6. **State over time** — Test timeout, cache invalidation, forced flush, adoption, and restart.
7. **Who wrote it** — Keep existing authenticated readers and validated claim sources.
