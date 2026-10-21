---
bornAs: xnornk1
kind: task
status: open
scope: ["we:scripts/lib/build-self-review.mjs", "we:scripts/lib/__tests__/build-self-review.test.mjs"]
dateOpened: "2026-10-20"
tags: []
---

# build self-review: test failed/timeout rejection; reject conflicting fenced/unfenced verdicts

Add production-adapter regression tests for failed/timed-out review processes and mixed fenced/unfenced verdicts. Reuse the parser hardening already visible on the PR #5485 branch: do not replace it with a fence-first parser that ignores conflicting outside text. This checkout lacks the module, so the remaining work is to integrate the reviewed implementation and pin its refusal behavior with adapter-level tests once its landing source is confirmed.

## Done when

Commands use the Bash helper `we() { command "${@#we:}"; }` to strip repository prefixes from arguments.

- [A1] **Executable** — `we node we:scripts/readiness/heavy-admission.mjs run -- npx vitest run we:scripts/lib/__tests__/build-self-review.test.mjs` — add the missing suite and invoke real reviewBuildDiff with a mocked codexDirectTask transport returning valid empty findings but (a) nonzero exit, (b) timedOut true with exit zero, and (c) both. Each rejects; an exit-zero non-timeout control succeeds. Before integration the import fails; after integration, removing the process-result guard must make these tests fail.
- [A2] Run the same command with mixed-format responses: fenced empty findings plus unfenced nonempty findings, reverse order and inverse contents, including spaced/escaped findings keys. All reject. Keep bare JSON, a single fenced JSON object and harmless surrounding prose accepted. Removing outside-verdict validation must make the regression fail.
- [A3] Exercise runBuildSelfReview using the production adapter on failure/timeout/invalid verdict: it reports unavailable and never returns a clean result or invokes repair/gate callbacks based on partial output. Do not substitute a mock review callback for these adapter cases.

## Non-goals

- [N1] No model/routing changes, broader self-review policy, extra repair rounds or publication changes.
- [N2] No live model request: mock only the transport result while retaining the production adapter and parser.

## Edge cases this change must handle

1. **Untrusted text** — Model output is untrusted data; reject multiple/duplicate findings verdicts instead of choosing the convenient empty one.
2. **Truncated reads** — Malformed/truncated JSON or incomplete process output is unavailable, never an empty finding list.
3. **Shared state files** — n/a: parser and mocked-transport tests add no shared receipt store.
4. **Fail closed** — Failed, timed-out or malformed responses reject even when the last message looks successful.
5. **Identity scoping** — Keep the adapter bound to the supplied checkout/diff; do not reuse another invocation’s last message.
6. **State over time** — A late message from a timed-out process cannot overturn its failed run; isolate mocked responses between tests.
7. **Who wrote it** — Only a successful transport result plus a valid unique verdict counts; quoted model prose is not a clearance.

## Grounding

- At commit `c3a5e7705b`, we:scripts/lib/build-self-review.mjs:71 parses one verdict; line 80 rejects findings outside it.
- At that commit, we:scripts/lib/build-self-review.mjs:95 rejects nonzero exitCode or timedOut before parsing; line 116 converts adapter failures to self-review unavailable.
- History `6b2c83b1a6` records mixed-verdict hardening and `c3a5e7705b` records spaced-key hardening on origin/lane/fewer-rounds; neither is evidence of landing on this checkout.
- we:backlog/6405-prevention-add-an-adapter-test-that-feeds-fenced-and-prose-w.md:16 identifies the related PR #5485 adapter referral. Both the implementation and proposed unit-test file are absent here.
- Size 3 is the adapter/parser regression slice across two files after the underlying implementation is available; it does not include landing the whole builder feature.

## Open questions

Should this regression land with PR #5485 or wait for its implementation to reach the target branch? Options: include it in that feature branch, or wait and apply it after landing. **Pick: include the regressions with the existing implementation**, avoiding a separate recreation of the missing module. Confirm the delivery target before scheduling; no verified unresolved implementation card was found to use as blockedBy.
