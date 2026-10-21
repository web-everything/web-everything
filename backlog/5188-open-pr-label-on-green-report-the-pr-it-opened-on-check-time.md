---
bornAs: x8xgcj9
kind: story
size: 2
tier: pinned
status: open
scope: ["we:scripts/operations/open-pr.mjs", "we:scripts/operations/open-pr-io.mjs", "we:scripts/operations/__tests__/open-pr.test.mjs"]
dateOpened: "2026-10-06"
tags: []
---

# open-pr label-on-green: report the PR it opened on check-timeout

The timeout-reporting fix already exists: a check-timeout report carrying a PR is classified as opened with its label step deferred, and the sink preserves known PR identity on post-open errors. Complete composed regression coverage through the real runner, classifier, sink and rendered description so future subprocess changes cannot reintroduce “NOT opened” after a successful create. Keep genuine no-open outcomes distinct.

## Done when

Commands use the Bash helper `we() { command "${@#we:}"; }` to strip repository prefixes from arguments.

- [A1] **Executable** — `we node we:scripts/readiness/heavy-admission.mjs run -- npx vitest run we:scripts/operations/__tests__/open-pr.test.mjs`: add a composed test using the real pr-land runner with an injected subprocess returning the actual post-create check-timeout JSON and exit status 3. Feed its result through the sink and describeSubmit; assert PR number/URL, opened outcome, deferred label step, and no “NOT opened”. It fails against the pre-fix classifier/sink and should pass on current code; existing isolated tests already cover the fix.
- [A2] Cover timeout without PR, genuine pre-create refusal, unknown post-open failure with PR identity, malformed/truncated output and killed child. Preserve the genuine no-open diagnostic where established; incomplete output must not fabricate a PR or claim labeling succeeded.
- [A3] No check-timeout path retries creation or applies the readiness label. The message names the existing drain ci-lifecycle reconcile owner and reports pending/deferred labeling without claiming checks passed.

## Non-goals

- [N1] No timeout increase, CI retry, label policy change or new PR creation behavior.
- [N2] No live forge write needed to verify reporting; use deterministic recorded subprocess results.

## Edge cases this change must handle

1. **Untrusted text** — Treat child diagnostics/PR URLs as display data; no shell commands assembled from them.
2. **Truncated reads** — Partial or unparseable child JSON is unusable evidence; never infer opened or labeled from an output substring.
3. **Shared state files** — n/a: this reporting change owns no shared state file and must not create a new retry ledger.
4. **Fail closed** — A timeout is not green CI; retain unknown/refused distinctions and never label on an ambiguous report.
5. **Identity scoping** — Preserve the exact PR number/URL from the trusted producer result for this invocation; never substitute another repo or head.
6. **State over time** — An already-created PR remains created after the label wait expires; report the pending step without creating another PR.
7. **Who wrote it** — Accept structured results only from the invoked pr-land producer, not PR body text or text resembling JSON in a diagnostic.

## Grounding

- we:scripts/operations/open-pr.mjs:344 already maps check-timeout with PR to opened plus labelStep deferred.
- we:scripts/operations/open-pr-io.mjs:194 preserves a known PR in an unrun diagnostic; line 198 handles the no-PR branch.
- we:scripts/operations/__tests__/open-pr.test.mjs:607 tests classifier/description; line 618 tests the sink with a preclassified injected result. A composed runner test is the remaining acceptance seam.
- Commit `7342164fc9` shipped the truthful timeout outcome and its existing regression tests.

Size 2: the classifier and sink fix already exist; remaining work is a composed timeout regression through the subprocess runner and renderer.
