---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:.github/workflows/ci.yml"]
dateOpened: "2026-10-24"
tags: []
---

# Prevention — Add a note to the CI authoring doc that expressions reading github.event.pull_request.* are froze… (from web-everything/web-everything#5886 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:.github/workflows/ci.yml:167` — Add a note to the CI authoring doc that expressions reading `github.event.pull_request.*` are frozen at trigger time. A script-decidable gate is not practical here.
2. `we:.github/workflows/ci.yml:168` — Add a CI regression using representative original-run and re-run event payloads that asserts the selected runner after a label change; align the comment with the demonstrated behavior.
3. `we:.github/workflows/ci.yml:168` — Add a deterministic event-payload replay test covering label changes followed by reruns, and align the documented instructions with the observed behavior.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5886@155b32b9d466744ec1719e39f13ae946128445c8

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
