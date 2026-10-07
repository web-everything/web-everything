---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/daemon-self-sync.mjs", "we:scripts/lib/daemon-load-overlay.mjs", "we:scripts/lib/daemon-version-runtime.mjs", "we:scripts/lib/__tests__/daemon-self-sync.test.mjs", "we:scripts/lib/__tests__/daemon-load-overlay.test.mjs", "we:scripts/lib/__tests__/daemon-version-runtime.test.mjs"]
dateOpened: "2026-10-07"
tags: []
---

# Prevention — Add a unit test for versionedTick with a pin stub returning {status:'busy'}. Lint/standards rule:… (from web-everything/web-everything#4222 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this PR's latest advisory review named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/daemon-self-sync.mjs:590` — Add a unit test for versionedTick with a pin stub returning {status:'busy'}. Lint/standards rule: callers of daemon-version-switch's locked-returning APIs must inspect .status.
2. `we:scripts/lib/daemon-load-overlay.mjs:175` — Add a test table of versioned result reasons to exit codes for the CLI. Define a shared failure-reason set exported from daemon-version-runtime and used by both the rebuild result and the CLI exit mapping.
3. `we:scripts/lib/daemon-version-runtime.mjs:134` — Add a check:standards rule: each reason string a versioned-runtime function can return must be asserted in at least one test. Also validate any id read from state files with the shared ID regex before path-join.
4. `we:scripts/lib/daemon-load-overlay.mjs:175` — Derive the CLI's success and exit code from the result's `overlaysApplied` field. Failing that, add a test that fails when a versioned wait result with `overlaysApplied: false` is reported as merged.
5. `we:scripts/lib/daemon-version-runtime.mjs:128` — Add a deterministic regression test with a held SHA, asserting that neither build nor switch runs, followed by an advanced main SHA that permits adoption; verify that removing the hold condition makes this test fail.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4222@9ad92629c6aa092ffe79d984e6f27306823f9a5c

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.
