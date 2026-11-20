---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/merge-gate-ci.mjs", "we:scripts/merge-ai-prs.mjs", "we:scripts/__tests__/merge-ai-prs-net-diff-computation.test.mjs", "we:scripts/lib/__tests__/merge-gate-ci.test.mjs", "we:scripts/__tests__/merge-ai-prs.test.mjs"]
dateOpened: "2026-11-20"
tags: []
---

# Prevention — Add a wiring test in we:merge-gate-ci.test.mjs: a full-length SHA that differs from pinnedHead.sh… (from web-everything/web-everything#7222 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/merge-gate-ci.mjs:230` — Add a wiring test in we:merge-gate-ci.test.mjs: a full-length SHA that differs from `pinnedHead.sha` must hold.
2. `we:scripts/merge-ai-prs.mjs:6683` — Add a CLI-level negative test for the drain: unresolved diff, mismatched head, and the explicit no-clone exception. Ideally also add a check that new gate branches in we:scripts/merge-ai-prs.mjs are exercised by an entrypoint test rather than only source-regex tests.
3. `we:scripts/__tests__/merge-ai-prs-net-diff-computation.test.mjs:994` — Add one hermetic drain CLI test that, using the pinned-diff fixture helper, makes git return a head differing from the listed head and asserts the PR is skipped and parked human. Add a second CLI case for the cross-repo no-clone path, which must stay unheld.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7222@62adc191021be240e3abfff03b262785875ba830

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
