---
bornAs: xhejpp4
kind: story
size: 2
status: open
scope: ["we:scripts/lib/pr-size-admission.mjs"]
dateOpened: "2026-11-07"
tags: []
---

# Split card identity keyed to (repo, head sha); a fix push on an over-cap PR files a second split card and the…

Flow-sim gap R5a-G2, class K12 (identity keyed by location, not content). Failing input: Open over-cap PR #N at head H1 with split card C1 filed (key = sha256([repo,H1]), we:pr-size-admission.mjs:289-291). Reviewer sends it back; the fixer pushes H2 and re-runs pr-land; diff still over cap.' 'pr-land re-run at H2 -> admission request with a new head. Cited: we:scripts/lib/pr-size-admission.mjs:289-291, we:scripts/lib/pr-size-admission.mjs:323, we:scripts/lib/pr-size-admission.mjs:326-329. Soak-break sketch: Fixture: over-cap PR #7, head H1 with C1 filed; push H2 (still over cap); run the size admission runner again with the real lookup. Assert: exactly one open card whose digest names PR #7. Fails today: two (keys differ by head).

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
