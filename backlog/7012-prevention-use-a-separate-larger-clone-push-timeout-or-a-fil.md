---
bornAs: xekt3s3
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/codex-job.mjs", "we:scripts/operations/__tests__/codex-job.test.mjs"]
dateOpened: "2026-10-24"
tags: []
---

# Prevention — Use a separate, larger clone/push timeout, or a --filter=blob:none / reference clone. Add a test… (from web-everything/web-everything#5839 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/codex-job.mjs:267` — Use a separate, larger clone/push timeout, or a `--filter=blob:none` / reference clone. Add a test asserting the clone call's timeout is at least the push timeout. Lower priority: a standards rule requiring timeouts on network git calls to be named constants.
2. `we:scripts/operations/codex-job.mjs:297` — Extend the argv-shape assertion for the publication `add` call to require `--literal-pathspecs`, and set `GIT_LITERAL_PATHSPECS=1` in the trusted env so it covers `ls-files` as well.
3. `we:scripts/operations/codex-job.mjs` — Add a deterministic real-Git regression test with a bracket-containing export path and a neighboring matching tracked filename, asserting successful publication of only the requested file.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5839@f83fcf49c51729aecd0adbd559f8e1db145d3113

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
