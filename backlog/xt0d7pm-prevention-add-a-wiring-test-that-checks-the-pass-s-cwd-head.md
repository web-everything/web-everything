---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/merge-ai-prs.mjs", "we:scripts/lib/drain-followup-job.mjs", "we:scripts/lib/__tests__/drain-followup-wiring.test.mjs", "we:scripts/__tests__/merge-ai-prs.test.mjs", "we:scripts/lib/__tests__/drain-followup-job.test.mjs"]
dateOpened: "2026-10-10"
tags: []
---

# Prevention — Add a wiring test that checks the pass's cwd HEAD equals origin/main after the job completes in a… (from web-everything/web-everything#4761 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/merge-ai-prs.mjs:6056` — Add a wiring test that checks the pass's cwd HEAD equals origin/main after the job completes in a single-checkout run. Alternatively, drop the passCwd skip when the job runs after the pass has finished.
2. `we:scripts/lib/drain-followup-job.mjs:299` — Add a repo-identity field (origin URL hash) to the job input, and have the launch step refuse a record whose identity differs from the ticking clone's. Add a wiring test for that refusal.
3. `we:scripts/lib/__tests__/drain-followup-wiring.test.mjs:96` — Add a wiring case with `--primary` to the CLI harness and assert the recorded input fields and the absence of the inline primary sync.
4. `we:scripts/merge-ai-prs.mjs:6047` — A lint rule (e.g. `max-len` or an AST complexity check) limiting line length and forcing complex object literals onto multiple lines.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4761@4e0c394238b1e90563261fd4aeceede67981cff9

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
