---
kind: story
size: 3
status: open
scope: ["we:scripts/operations/needs-you-feed.mjs", "we:scripts/operations/operator-queue.mjs"]
dateOpened: "2026-10-18"
tags: []
---

# needs-you feed does not flap

Live 2026-10-18 02:00-11:00Z: PR #5549, #5480, #5472 and #5510 were cleared and re-raised in the needs-you feed every ~2 min, sometimes with an empty head. Fix: debounce clear/re-raise plus a stable head key (never an empty head), in we:scripts/operations/needs-you-feed.mjs. [A1] Executable: a test that a flapping input yields one raise and no clear/re-raise cycle, and that an empty head keeps the prior key.

## Acceptance

- [A1] **Executable** — `npx vitest run we:scripts/operations/__tests__/needs-you-feed.test.mjs` fails before the fix (flapping input produces clear + re-raise) and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] Does not change which PRs need a person; only how the feed reports them.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: no free text is parsed beyond existing validated fields.
2. **Truncated reads** — The change reads bounded inputs only; a truncated read counts as unknown, never as clear.
3. **Shared state files** — State files are written atomically through the existing helpers; no new shared file.
4. **Fail closed** — On any error the guard refuses or keeps the prior state, never silently proceeds.
5. **Identity scoping** — n/a: keyed by repo + PR number + head sha, as today.
6. **State over time** — Debounce or cursor state expires on its own and survives a restart.
7. **Who wrote it** — n/a: operator-facing tooling; authorship is not trusted for decisions.
