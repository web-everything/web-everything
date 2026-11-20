---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/merge-ai-prs.mjs", "we:scripts/lib/pr-list-paged.mjs", "we:scripts/lib/__tests__/drain-gh-async.test.mjs", "we:scripts/lib/drain-gh-async.mjs", "we:scripts/__tests__/merge-ai-prs-listing-dedupe.test.mjs", "we:scripts/__tests__/merge-ai-prs.test.mjs", "we:scripts/lib/__tests__/pr-list-paged.test.mjs"]
dateOpened: "2026-11-20"
tags: []
---

# Prevention — Add a CLI-level test that lists a fixture repo with a resolved slug and asserts the heavy pr view… (from web-everything/web-everything#7223 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/merge-ai-prs.mjs:5498` — Add a CLI-level test that lists a fixture repo with a resolved slug and asserts the heavy `pr view` reads go through the async worker, and that a transient list failure is retried. A lint rule that flags `execAsync` omitted at any `listOpenPrsPagedHydrated*` call site would also catch it.
2. `we:scripts/lib/pr-list-paged.mjs:343` — Give `mapWithConcurrency` an abort-on-first-error option that skips unstarted items while still joining those in flight. Add a test asserting that read count after a first failure stays at or below the pool width.
3. `we:scripts/lib/__tests__/drain-gh-async.test.mjs:84` — Add a positive control in the same test: with the memo dir created, first call the unfiltered sync runGhSync twice and assert the second is a hit (count stays 1), then assert the async path still re-executes. Generally, any 'bypasses cache X' test should pair a control that shows X can hit.
4. `we:scripts/lib/drain-gh-async.mjs:18` — Move the worker body into its own entry file with no guard, or exit non-zero in an else branch when invoked with worker arguments but the guard is false.
5. `(no file cited)` — Add a named opt-in ten-drain acceptance check asserting the median, comparative listing timings, and expected enqueue sets; add a deterministic card check requiring each Acceptance criterion to reference a named test or measurement procedure.
6. `(no file cited)` — Add a named benchmark with machine-checked acceptance thresholds and require an attached result for performance acceptance claims.
7. `we:scripts/__tests__/merge-ai-prs-listing-dedupe.test.mjs:163` — Add a deterministic CLI integration test covering successful candidate and freshness listings and asserting exact enqueue decisions.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7223@113c7ad558c989f3aace4c020835b9ff63e035dd

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
