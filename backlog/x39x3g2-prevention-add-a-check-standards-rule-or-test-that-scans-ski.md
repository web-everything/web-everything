---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:skills-src/review/SKILL.md", "we:scripts/review-set-label.mjs", "we:scripts/__tests__/review-set-label-clear-human-expect-head.test.mjs", "we:scripts/conveyor/pr-label-mirror.mjs", "we:scripts/__tests__/review-set-label.test.mjs", "we:scripts/conveyor/__tests__/pr-label-mirror.test.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Prevention — Add a check:standards rule or test that scans skills-src/**/*.md and docs for we:scripts/review-s… (from web-everything/web-everything#7274 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:skills-src/review/SKILL.md:339` — Add a check:standards rule or test that scans skills-src/**/*.md and docs for `we:scripts/review-set-label.mjs ... --to=clear-human` and requires `--expect-head` on the same command. Do the same for `record-verdict-cli ... clear-human` and `--expectedHead`.
2. `we:scripts/review-set-label.mjs:2160` — Hoist the head assertion out of the ledger try block, or tag the error so the catch maps it to exit 2. Add `expect(exitCode).toBe(2)` to the two mid-append tests.
3. `we:scripts/__tests__/review-set-label-clear-human-expect-head.test.mjs:1` — Record the live proof (PR link) in the PR body or the card as an explicit checklist item the land step reads.
4. `we:scripts/conveyor/pr-label-mirror.mjs:173` — Give approvalValid a distinct sentinel for "legacy caller, skip head check", and make the mirror pass `headSha ?? null`. Add a test for the unknown-head case.
5. `we:scripts/__tests__/review-set-label-clear-human-expect-head.test.mjs:62` — Have the card record the live-proof evidence (PR link or log) in the PR body, or add a gate that requires each Acceptance line to map to a test name or an evidence link.
6. `(no file cited)` — Add a deterministic acceptance check requiring every guarantee to reference a repository-qualified named test, with a recorded result or evidence artifact for live tests.
7. `(no file cited)` — Add an acceptance-evidence gate requiring each live-proof requirement to reference a named scenario, its assertions, and a recorded result.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7274@927b39a399a452254e58023dcbd063ccb06985a4

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
