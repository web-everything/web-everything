---
bornAs: x46te7z
kind: task
status: open
scope: ["we:scripts/lib/__tests__/red-team-skip-outcome-regressions.test.mjs"]
dateOpened: "2026-10-25"
tags: []
---

# Coverage: exercise pending skip quarantine removal fallback

PR #5890's later-round advisory identified missing named coverage for the documented unlink fallback when quarantining a poison pending record fails to rename it. Add fault injection around we:scripts/lib/red-team-skip-outcome.mjs's pending retry handling. Keep this advisory separate from the current fail-open gate repair. These hermetic filesystem tests need no network endpoint, rate limit, CSRF control, or shared runtime state.

## Acceptance

- [A1] **Executable** — `npm run test:unit` with only we:scripts/lib/__tests__/red-team-skip-outcome-regressions.test.mjs selected includes a named test making quarantine rename fail, asserting that unlink removes the poison record, a quarantine diagnostic is emitted, and a valid pending record still publishes.
- [A2] **Executable** — A companion test makes both rename and unlink fail, asserting that the failure is diagnosed and current settlement still proceeds without posting a non-policy result comment.
- [A3] **Executable** — A subsequent settlement does not scan the successfully removed poison record again; the valid record is not republished after its marker is written.

## Non-goals

- [N1] Altering settlement policy, retry limits, identity keys or quarantine behavior.

## Edge cases this change must handle

1. **Untrusted text** — Poison record contents remain inert fixture data.
2. **Truncated reads** — Include malformed JSON or invalid record metadata to enter the real quarantine path.
3. **Shared state files** — Each fixture uses an isolated temporary status directory and cleans it up.
4. **Fail closed** — Neither filesystem failure can produce a trusted result comment or clear label.
5. **Identity scoping** — Poison and valid pending records have distinct content identities.
6. **State over time** — Verify behavior on the next settlement as well as the failing quarantine attempt.
7. **Who wrote it** — Inject filesystem failures; do not replace the production settlement with a mock.
