---
bornAs: x6v3lgx
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/codex-job.mjs", "we:scripts/operations/__tests__/codex-job.test.mjs"]
dateOpened: "2026-10-25"
tags: []
---

# Prevention — Use a separate, larger timeout for clone and push, and add a test asserting the clone call's time… (from web-everything/web-everything#5839 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/codex-job.mjs:362` — Use a separate, larger timeout for clone and push, and add a test asserting the clone call's timeout exceeds the local-command bound.
2. `we:scripts/operations/codex-job.mjs:405` — Fall back to the purpose slug when the derived title is empty, plus a test with an empty or `# Task:`-only brief. Alternatively, have `parseArgs` or `runJob` validate the brief heading before any lane work.
3. `we:scripts/operations/codex-job.mjs:455` — Redact `user:pass@` from any URL before it enters `result.plan` or `result.detail`. A shared `redactUrl` helper with a test asserting redaction in the dry-run output would cover this class.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5839@44e41a4671283872b1822da31bd30242ccf629b6

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
