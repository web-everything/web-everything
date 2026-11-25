---
kind: story
size: 2
status: open
scope: ["we:scripts/operations/__tests__/registry-import-timeout.test.mjs"]
dateOpened: "2026-11-25"
tags: []
---

# Red-team follow-ups [coverage-or-style] from web-everything/web-everything#7483 (head e4e0efc10)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7483 (reviewed head `e4e0efc103a76c9622c230ebe92d9dc377b293c2`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/operations/__tests__/registry-import-timeout.test.mjs:22` — (edge-case, degraded) The guard mistakes timers inside test bodies for the test timeout.
   - Scenario: A registry-import test containing await new Promise(resolve =&gt; setTimeout(() =&gt; { resolve(); }, 10)), followed by the import and a documented outer 60_000 ms timeout, is incorrectly rejected as having a 10 ms timeout. Conversely, setTimeout(() =&gt; {}, 60_000).unref() inside a test with no explicit test timeout makes the guard accept it. The regex should identify the timeout argument belonging to it()/test(), ignoring nested calls.
   - Class: coverage-or-style (basis: Reproduced both results by executing the actual scanner function against in-memory source inputs using Node. The current repository scan passes with four sites; this finding concerns the new guard's accuracy, without demonstrating a current production failure.)
   - Claude's re-check: demonstrated break

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
