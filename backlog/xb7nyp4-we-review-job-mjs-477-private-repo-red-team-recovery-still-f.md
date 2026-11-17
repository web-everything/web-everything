---
kind: story
size: 2
status: open
scope: ["we:scripts/operations/review-job.mjs"]
dateOpened: "2026-11-17"
tags: []
---

# we:review-job.mjs:477 Private-repo red-team recovery still fetches through an HTTPS origin (web-everything#7012)

1. `we:scripts/operations/review-job.mjs:477` — Private-repo red-team recovery still fetches through an HTTPS origin

Operator card follow-up for web-everything/web-everything#7012 (head f2d7fb16db2cb8285799a78ee7c4a7f1097db489).

Not worse than main (R903): fetchRedTeamHead (we:review-job.mjs:442-451) is unchanged by the PR; on main prepareLane already fails earlier over https for private repos, and recovery refuses retryably (red-team-fetch-refused), fail-closed

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
