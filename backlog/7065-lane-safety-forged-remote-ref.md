---
bornAs: xhkw054
kind: task
status: active
scaffoldedBy: "fix-5759"
dateScaffolded: "2026-10-25"
dateOpened: "2026-10-25"
tags: []
---

# Fresh lane safety trusts local remote-tracking refs for the unpushed-work count

PR 5759 self-review: freshLaneSafety in we:scripts/lib/health-watch-lane-scan.mjs counts commits absent from refs/remotes/origin/*, but a lane can run git update-ref refs/remotes/origin/x HEAD and make its unpushed commits read as pushed. Compare against refs read from the real remote or a daemon-owned record, and add a real-Git test.

## Acceptance

- [A1] **Executable** — `q=we:scripts/readiness/heavy-admission.mjs; t=we:scripts/operations/__tests__/health-watch-lane-scan.test.mjs; node "${q#we:}" run -- npx vitest run "${t#we:}" -t 'reporting ignores forged'` runs the real-Git loose/packed-ref regressions: an unrelated origin ref pointing at unpublished HEAD cannot yield ahead zero; removing the expected branch ref yields unknown. These cases fail before the reporting fix and pass after.
- [A2] **Executable** — **Must refuse on error:** `q=we:scripts/readiness/heavy-admission.mjs; t=we:scripts/operations/__tests__/health-watch-lane-scan-boundary.test.mjs; node "${q#we:}" run -- npx vitest run "${t#we:}" -t 'publication'` proves destructive actions refuse missing, malformed, oversized or unreadable trusted publication evidence, without falling back to lane-owned refs.

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
