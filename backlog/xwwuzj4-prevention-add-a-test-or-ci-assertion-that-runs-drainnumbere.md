---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/queue-branch-numbering.mjs", "we:scripts/lib/__tests__/queue-branch-numbering.test.mjs"]
dateOpened: "2026-10-12"
tags: []
---

# Prevention — Add a test or CI assertion that runs drainNumberedPairs against a real merge_group-shaped history… (from web-everything/web-everything#5057 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/queue-branch-numbering.mjs:33` — Add a test or CI assertion that runs `drainNumberedPairs` against a real merge_group-shaped history. Alternatively, stamp the pairing in a tracked file or card frontmatter rather than in commit subjects.
2. `we:scripts/lib/__tests__/queue-branch-numbering.test.mjs:211` — Extract the post-pass probe/repair decision into an exported pure function with injected exec and log, and test it behaviourally. Alternatively, add a lint that rejects source-text assertions on production files.
3. `we:scripts/lib/queue-branch-numbering.mjs:28` — Require the commit's author or committer to match the drain identity, as `isDrainBookkeepingCommit` does, and add a test where a non-drain author forges the subject. Alternatively, have `check:standards` verify that the pair's commit renamed `backlog/<hash>-*` to `backlog/<nnn>-*`.
4. `we:scripts/lib/queue-branch-numbering.mjs` — Add a deterministic regression test that supplies an older complete listing, prepares two newly queued PRs sequentially, and asserts distinct allocated numbers; require fresh closure evidence before retiring an absent PR's reservation.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5057@5088f2bc61863d65cebe334801b62879f755fa83

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
