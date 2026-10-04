---
bornAs: xkq9t2n
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs", "we:scripts/lib/review-ci-gate-io.mjs", "we:skills-src/conveyor/__tests__/reconcile-fix-dispatch-daemon.test.mjs", "we:scripts/lib/__tests__/review-ci-gate-io.test.mjs"]
dateOpened: "2026-10-04"
tags: []
---

# Prevention — Add a check:standards rule or test that greps for direct env.GH_TOKEN and GITHUB_TOKEN readers re… (from web-everything/web-everything#3909 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs:915` — Add a check:standards rule or test that greps for direct `env.GH_TOKEN` and `GITHUB_TOKEN` readers reachable from perOwner daemons. Each reader must either route through a per-owner resolver or declare an explicit credential policy.
2. `we:scripts/lib/review-ci-gate-io.mjs:66` — Extract one shared `scrubSecrets` helper, such as the one in gh-app-shim, with a table-driven test of credential shapes (Basic, Bearer, JWT, `x-access-token:...@`). Make every error-logging path use it.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#3909@4b9b968762cef4c442eed6814cd2c654d55e7f94

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
