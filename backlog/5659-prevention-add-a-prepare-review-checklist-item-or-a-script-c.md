---
bornAs: xg7o8eq
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/4354-survive-a-claude-account-switch-mid-session-without-losing-w.md"]
dateOpened: "2026-10-09"
tags: []
---

# Prevention — Add a prepare-review checklist item (or a script check) that every reuse X reference in a card's… (from web-everything/web-everything#4709 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:backlog/4354-survive-a-claude-account-switch-mid-session-without-losing-w.md:84` — Add a prepare-review checklist item (or a script check) that every `reuse X` reference in a card's Design resolves to an exported symbol importable from the module that will call it.
2. `we:backlog/4354-survive-a-claude-account-switch-mid-session-without-losing-w.md:84` — A review-lens item for Design sections: list every call site of the gated action (grep `laneHoldRefuses(…'release'`) and give each a Test plan entry or an explicit exclusion.
3. `we:backlog/4354-survive-a-claude-account-switch-mid-session-without-losing-w.md:84` — In the build, store only description plus the parsed lane number (drop brief text), write with mode 0600 in a 0700 directory, and add a worker-launch-record test asserting the mode and that no brief substring appears in the file. A review-lens checklist item for 'new on-disk persistence of agent-supplied text' is the cheapest durable guard.
4. `we:backlog/4354-survive-a-claude-account-switch-mid-session-without-losing-w.md:88` — Use a keyed hash (HMAC with a per-machine secret) or a non-derived random per-login token as the comparison key, and add a test that the same inputs yield a different fp under a different key. Add a security-lens note for 'hash of PII used as identifier'.
5. `we:backlog/4354-survive-a-claude-account-switch-mid-session-without-losing-w.md` — Implement the planned re-acquisition regression in we:scripts/operations/__tests__/resume-report.test.mjs, including explicit-lane joins, and require it to reject the replacement lease using a stable acquisition identity.
6. `we:backlog/4354-survive-a-claude-account-switch-mid-session-without-losing-w.md` — Add deterministic identifier-validation cases for '.', '..', and the planned leading '--' rejection, plus an assertion that every resolved output path remains within the records root.
7. `we:backlog/4354-survive-a-claude-account-switch-mid-session-without-losing-w.md` — Require a preparation-review guarantee-to-test matrix identifying a repository-qualified test file, named case, and observable assertion for every behavioral guarantee.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4709@5496d394818df6b38c85277f2893611884ec858e

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
