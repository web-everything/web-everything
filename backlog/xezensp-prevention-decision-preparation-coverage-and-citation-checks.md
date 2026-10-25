---
kind: story
size: 3
parent: "4075"
status: open
dateOpened: "2026-10-25"
tags: []
---

# Prevention: decision preparation coverage and citation checks from PR 5932

Track the six prevention guards requested by the 2026-10-25 review of decision #4010: caller-symbol citations, guarantee-to-test mappings, two-subject isolation, activation persistence, dependency-safe acceptance and corrupt scheduled-job state. Reuse the existing guarantee gate work in #5473 and citation checks in #3528.

## Review provenance

Filed for all ten findings in the 2026-10-25T20:52:09Z changes-requested review of web-everything/web-everything#5932. The repeated isolation and activation findings share guards below. This is tracked prevention work, not a claim that the checks already run. Coordinate guarantee checks with #5473 and symbol resolution with #3528 rather than introducing parallel validators.

## Done when

1. **Caller citations (correctness 1):** a review-lens rule or standards check resolves each path:line cited as a caller to the named imported/called symbol, including aliases. Planned `we:scripts/lib/__tests__/citation-check.test.mjs::caller-citation-matches-imported-symbol` accepts `liveStatusFor as liveProbationStatusFor` and rejects citing that import as `statusFor`; missing files, stale lines and unreadable sources produce visible unresolved findings.
2. **Guarantee manifest (correctness 3, security 1, simplicity 1–2, codex-correctness 1–2):** extend the existing preparation gate in `npm run check:standards` to enumerate every normative never/cannot/must/freeze/fail-closed/refuses sentence and require a structured mapping to repository-qualified test file, exact named case in Done when and observable assertion. Independently persisted event/time, baseline range/digest, revision/commit binding and deadline each need an assertion. Planned `we:scripts/lib/__tests__/prepare-forks.test.mjs::unmapped-normative-guarantee-blocks-readiness` rejects each omitted mapping separately, accepts complete mappings, and reports explicit untested guarantees as not ready rather than silently green. The gate does not equate presence of a test name with semantic adequacy; the review lens checks the observable assertion.
3. **Failure isolation (correctness 2, simplicity 1, codex-correctness 1):** prose promising continue/unrelated/isolated behavior maps to a named test declaring a two-subject fixture and assertions for both failed and completed results. Planned `we:scripts/lib/__tests__/prepare-forks.test.mjs::isolation-guarantee-requires-two-subject-assertions` rejects a test mapping asserting only the bad subject; accepts both outcomes, including reversed subject order.
4. **Dependency-safe acceptance (correctness 4):** a card-lint/review rule refuses a landing Done-when item whose required producer is open or blocked, including a blockedBy cycle. Require an executable independent fixture at the earlier boundary, or keep that acceptance pending with its later owner; never count it as passed. Planned `we:scripts/lib/__tests__/prepare-forks.test.mjs::landing-acceptance-cannot-require-open-dependent-producer` rejects #4010's old real-planner-record gate, accepts its independent watcher fixture plus explicitly pending #4011 integration, and rejects moving the same dependency into prose without declaring it.
5. **Persistent scheduled-job state (security 2):** add a review-lens checklist rule requiring each persistent input to a scheduled job to name a corrupt/missing/stale-state test and failure behavior (refuse, reconcile or rebuild). Require reuse of a shared job-record reader when it already refuses corruption. Planned `we:scripts/lib/__tests__/prepare-forks.test.mjs::persistent-job-input-requires-corruption-behavior` rejects cursor-only, receipt-only and no-corruption-test mappings; accepts independent cursor/receipt cases naming visible refusal or bounded reconciliation, including a valid-looking receipt with no backing card.
6. **Executable gate:** run the affected citation/preparation test files through the command below, then `npm run check:standards`. Use pre-repair #4010 and its repaired form as negative/positive authoring fixtures; each negative test must fail if its individual validation rule is removed. Omit each independently persisted activation field's assertion in a separate negative fixture, so a deadline-only mapping cannot stand in for the baseline or revision/commit binding. With the rule present, report the unmapped guarantee or bad citation rather than a generic parse error; the positive fixture passes.

   ```sh
   npm run test:unit -- scripts/lib/__tests__/citation-check.test.mjs scripts/lib/__tests__/prepare-forks.test.mjs
   ```

## Non-goals

- No probation runtime implementation, enrollment, ratification, watcher installation or policy change. No cryptographic receipt tamper detection; this card covers accidental corruption and inconsistent persisted claims. No replacement for semantic review of the named assertions.

## Edge cases this change must handle

1. **Untrusted text** — parse citations and manifests as data; no executable card text. Covered by Done when 1–2.
2. **Truncated reads** — missing/unreadable cited sources are unresolved rather than accepted. Covered by Done when 1.
3. **Shared state files** — the check reads authoring inputs and does not mutate scheduled-job state. Required state-recovery test mappings are covered by Done when 5.
4. **Fail closed** — omitted mappings and explicit untested normative guarantees prevent ready status. Covered by Done when 2–5.
5. **Identity scoping** — resolve repository, symbol, alias and exact planned case independently. Covered by Done when 1–2.
6. **State over time** — stale citations, independent activation fields and open producer dependencies need separate assertions. Covered by Done when 1–4.
7. **Who wrote it** — n/a: this is a read-only authoring check; it grants no operator authority or trusted authorship.
