---
bornAs: xjcdwes
kind: story
size: 3
status: open
scope: ["we:scripts/operations/open-pr-io.mjs", "we:scripts/operations/__tests__/open-pr-io-org-shim.test.mjs"]
dateOpened: "2026-10-21"
tags: []
---

# resolveGhCredentialEnv must not swallow a daemon's gh-shim refusal and fall back to an unguarded shim

PR #5729 made we:scripts/lib/gh-app-shim.mjs#buildGhShimSettingsEnv throw for a daemon caller when no real gh exists or the guarded shim cannot be written, so a daemon never runs gh without the personal-auth refusal. we:scripts/operations/open-pr-io.mjs#resolveGhCredentialEnv wraps that call in catch {} and falls through to the org-aware shim or the legacy shared shim (no refusal guard), and adds the legacy shim only behind a PATH includes() check, so a dir listed later on PATH leaves the real gh first. Delivery sessions carry WE_GH_DAEMON_CALLER and reach it via we:scripts/operations/run.mjs -> createOpenPrSinks -> createPrLandRunner. Fix: rethrow when isDaemonCaller(env); use the first-entry check like we:scripts/lib/github-app-auth-env.mjs#defaultInstallOwnerShim. Edge cases: interactive callers keep the best-effort fallback; XPC-only daemon parents; shim dir already first; dir later on PATH. Needs an integration test through createPrLandRunner, not only the unit.

## Acceptance

- [A1] **Executable** — Add `createPrLandRunner refuses daemon shim installation errors before invoking gh`, driving a daemon-marked environment through the land runner with a failed guarded-shim write; assert rejection and zero legacy-shim or real-gh calls. The test must fail against the current swallowed-error path. Run `npm run test:unit -- <suite>` from the WE checkout, using the repository-relative path for suite `we:scripts/operations/__tests__/open-pr-io-org-shim.test.mjs`.
- [A2] **Executable** — In the same test file, parameterize explicit and XPC-only daemon markers and absent/later/first shim PATH entries; daemon failures refuse, interactive failures preserve best-effort fallback, and successful installation places the guarded shim first without duplicating it.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] Changing the shim builder's own refusal, the org-aware/legacy shim contents, or the dispatch-path consumers (fixed separately in PR #5729's dispatch round).

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: only PATH entries and daemon markers are compared; nothing is parsed or executed.
2. **Truncated reads** — n/a: no file or command output is read.
3. **Shared state files** — The shared shim dir is written through `ensureGhShim` as before, once per open-pr run.
4. **Fail closed** — A daemon builder throw or empty result refuses (`gh-auth-guard-unavailable`) before pre-PR review, dup scan or pr-land spawn.
5. **Identity scoping** — Explicit `WE_GH_DAEMON_CALLER` and XPC-only `com.we.*`/`com.plateau.*` markers both count as daemon; interactive callers keep the fallback.
6. **State over time** — Shim dir absent, later, or already first on PATH all end with the guard first, exactly once; an org-aware shim already first stays first.
7. **Who wrote it** — The test drives the real land runner wiring (`createPrLandRunner`), not only the isolated helper.
