---
bornAs: xegf4ol
kind: story
size: 2
status: open
scope: ["we:scripts/lib/daemon-live-smoke.mjs"]
dateOpened: "2026-10-13"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5045 (head 11b6d2ef7)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5045 (reviewed head `11b6d2ef79ae40c82185e90173504163a95c6380`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/daemon-live-smoke.mjs:1269` — (failing-input, degraded) An aggregated check can hide a definite code failure behind one GitHub-read signature.
   - Scenario: Reproduced through runLiveSmokeWithRetry with retries=1 and all other checks passing. The dispatch child returns [{kind:'ci-heal-worst-case',ok:false,error:'no value for the brief placeholder {{SCOPE}}'},{kind:'reconcile-fix-pass',ok:false,error:'could not read state: Command failed: gh pr list'}]; the independent probes return HTTP 502. checkDispatchDryRun combines both failures into one detail string. isGithubEnvCandidateSet accepts that entire row because one substring matches, and the final verdict is env-unavailable despite the explicit brief-fill regression. A reconcile row containing a
   - Claude's re-check: isGithubReadFailureRow does an any-signature substring test on a row's whole detail. The diff's own comment says reconcile aggregates child failures into one row. A combined detail holding a code failure and a gh-read failure therefore passes isGithubEnvCandidateSet, and a 502 probe turns it into env-unavailable. The code failure is never classified on its own.
2. `we:scripts/lib/daemon-live-smoke.mjs:1062` — (edge-case, degraded) Successful later probes never clear an earlier outage confirmation.
   - Scenario: Reproduced with retries=1: reconcile persistently fails with 'could not read state: Command failed: gh pr list', while every other check passes. Attempt 1's independent probes return HTTP 502; attempt 2's probes all succeed. The gate returns env-unavailable with githubEnv.confirmed=true even though its final probe records unavailable=false and ok=true. The confirmation is only ever set true. Once the matching probes recover and the tree still fails, the gate should classify the persistent tree failure as code, as it does when probes succeed from the first attempt.
   - Claude's re-check: githubEnv.confirmed is only ever set true ('if (probe.unavailable) githubEnv.confirmed = true') and never reset. With retries=1, attempt 1 confirms, attempt 2's probes succeed, and githubEnv.confirmed is still true. The hold branch then returns env-unavailable with no current evidence of an outage, where the all-probes-succeed path returns code.

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
