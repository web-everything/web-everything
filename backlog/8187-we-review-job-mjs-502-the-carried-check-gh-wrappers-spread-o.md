---
bornAs: x954v11
kind: story
size: 2
status: open
scope: ["we:scripts/operations/review-job.mjs"]
dateOpened: "2026-11-13"
tags: []
---

# we:review-job.mjs:502 The carried-check `gh` wrappers spread `options` first and `env` last, so the WE-App write (web-everything#6606)

1. `we:scripts/operations/review-job.mjs:502` — The carried-check `gh` wrappers spread `options` first and `env` last, so the WE-App writer env that `postRedTeamCheckRun` and `postRedTeamPublicationHold` pass as `options.env` (`redTeamWriterEnv`) is overwritten by the caller's ambient env.

Operator card follow-up for web-everything/web-everything#6606 (head b38af75f3a0e4a44cc5add06d63bc49bc35cab24).

Not worse than main (R903): The carried-check publisher is new code; main has no carried-check publication at all, and a check written under the wrong identity is not trusted by readers (fail-closed), so main's behavior is unchanged (R903).

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
