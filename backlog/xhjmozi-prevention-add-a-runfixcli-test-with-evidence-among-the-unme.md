---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/fix-run.mjs", "we:scripts/operations/__tests__/fix-run.test.mjs"]
dateOpened: "2026-11-23"
tags: []
---

# Prevention — Add a runFixCli test with evidence among the unmerged paths. For a wider guard, add a check:stand… (from web-everything/web-everything#7410 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/fix-run.mjs:1144` — Add a runFixCli test with evidence among the unmerged paths. For a wider guard, add a check:standards rule that every call site of a staging-filter predicate has a test naming it.
2. `we:scripts/operations/fix-run.mjs:1144` — Write the Acceptance line 'the conflict-merge staging list is filtered' as a named test where `unmerged` contains `we:.fix-evidence.md`. Review lens: every filter site named in a guarantee needs its own failing-without-it test.
3. `we:scripts/operations/fix-run.mjs:1144` — Add the named runFixCli regression test to the automated suite, exercising unmerged root evidence alongside an ordinary resolved file and asserting the resulting staging commands.
4. `we:scripts/operations/fix-run.mjs:1144` — Add we:web-everything/scripts/operations/__tests__/fix-run.test.mjs test 'excludes unmerged root evidence from conflict staging', asserting evidence receives neither staging nor index removal while another resolved file stages; deleting the unmerged.filter predicate should make this named test fail.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7410@8d58d8a6f0b551c6cdd5c6f3f73baf0b3f169c79

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
