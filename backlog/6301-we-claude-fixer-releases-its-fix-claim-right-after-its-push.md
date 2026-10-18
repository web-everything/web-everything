---
bornAs: xu83d0t
kind: story
size: 3
status: open
scope: ["we:scripts/conveyor/fix-procedure.mjs", "we:scripts/conveyor/await-verify-pass.mjs", "we:scripts/conveyor/await-verify-loop.mjs"]
dateOpened: "2026-10-18"
tags: []
---

# we: Claude fixer releases its fix claim right after its push

Why: in the window (2026-10-17 12:55Z to 2026-10-18 12:55Z) a Claude fixer held the fix claim a median of 39 min per pass (p90 95 min, n=47). The median 24 min of that came after the push (p90 59 min). That is about 1,100 min a day of claim time spent idle after the push, while the verify gate, the self-review hold and session-busy resume polls run. Claude passes also hold the lane and the Claude session for the same time. Change: release the claim (fix-end) at the push, and let verify and self-review run outside it. The Claude session resumes only on red or must-fix findings. Keep the invariant that only the claim holder may push to the PR branch while verify runs, and that fix-end still refuses while a self-review is open. Grep fix-claim and fix-end in we:scripts/conveyor/ for the release points. Edge cases to handle: untrusted text, a push refused for a non-holder, and a verify job superseded by a newer push (it must not be killed without a verdict).

[A1] Executable: npx vitest run we:scripts/conveyor/__tests__/fix-procedure.test.mjs we:scripts/conveyor/__tests__/await-verify-pass.test.mjs

## Acceptance

- [A1] **Executable** — a new test in we:scripts/conveyor/__tests__/fix-procedure.test.mjs asserts the claim is released at the push. It fails before this lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] Does not change the verify gate, the self-review gate, or the push refusal for non-holders. Does not give a second author push rights on the PR branch.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — PR comments and verify output are read as data. They never trigger a claim release.
2. **Truncated reads** — n/a: the release follows the push result, not a partial read of a log.
3. **Shared state files** — the claim file is written under its lock. A release from a non-holder is refused.
4. **Fail closed** — if the push result is unknown, the claim stays held. No early release.
5. **Identity scoping** — only the claim holder can release at push. The push refusal for other sessions still applies.
6. **State over time** — a verify job superseded by a newer push is not killed without a verdict. A re-push after release takes the claim again.
7. **Who wrote it** — the fix-end comment names the fixer session that released the claim.
