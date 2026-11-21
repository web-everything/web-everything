---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/queue-branch-numbering.mjs", "we:scripts/lib/__tests__/queue-branch-numbering.test.mjs"]
dateOpened: "2026-11-20"
tags: []
---

# Prevention — Add a real-git test with two clones where the code clone is behind but its origin/main is unfetch… (from web-everything/web-everything#7262 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/queue-branch-numbering.mjs:397` — Add a real-git test with two clones where the code clone is behind but its `origin/main` is unfetched. Alternatively, fetch `origin/main` inside `codeRoot` before comparing, or derive the code root from `git rev-parse --git-common-dir` to confirm it shares refs with `cwd`.
2. `we:scripts/lib/queue-branch-numbering.mjs:397` — Fetch `origin/main` in `codeRoot` as well, or compare `rev-parse origin/main` across the two roots. Add a test where the two roots return different `origin/main` SHAs. A deterministic write-gate on the preflight would catch it.
3. `we:scripts/lib/__tests__/queue-branch-numbering.test.mjs:437` — Add a deterministic table-driven test matrix varying tracked filenames independently of valid assigned metadata, covering malformed IDs, lower bounds, collisions, and duplicates.
4. `we:scripts/lib/queue-branch-numbering.mjs:400` — Add a deterministic separate-clone regression test named 'refreshes code checkout main before checking freshness', asserting refusal and no push when its remote-tracking reference initially lags.
5. `we:scripts/lib/queue-branch-numbering.mjs:424` — Extend the tracked-filename parameterized test with an unassigned number below mainMax, asserting skip and no push; require this case in the deterministic test suite.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7262@ad7ef39e34645558d346a62356004d4e0ab8b974

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
