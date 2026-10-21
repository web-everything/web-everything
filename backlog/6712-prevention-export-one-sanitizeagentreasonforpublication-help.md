---
bornAs: xdeuquh
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/probation-build-run.mjs", "we:scripts/operations/deliver-item-wrapper.mjs", "we:scripts/operations/__tests__/probation-build-run.test.mjs", "we:scripts/operations/__tests__/deliver-item-wrapper.test.mjs"]
dateOpened: "2026-10-14"
tags: []
---

# Prevention — Export one sanitizeAgentReasonForPublication helper and use it for every agent-authored string th… (from web-everything/web-everything#5187 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/probation-build-run.mjs:1100` — Export one `sanitizeAgentReasonForPublication` helper and use it for every agent-authored string that reaches a PR body or commit message. Add a lint or standards check that `writePrBody` templates take only helper-sanitized fields, plus a table test that feeds `@x`, `[l](u)` and a backtick through both paths.
2. `we:scripts/operations/deliver-item-wrapper.mjs:775` — Read agent-authored marker files through a shared helper that lstat-checks for a regular file inside the lane and size-caps it, and make error messages carry only the line number or a fixed string. Add a symlink-marker case to the processGroupDrops tests.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5187@8031184cdb8c7536017c931cffe769fac6f6b3da

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
