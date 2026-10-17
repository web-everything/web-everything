---
bornAs: x2rmin4
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/4697-live-course-correction-a-user-or-supervisor-can-redirect-or.md", "we:agent-memory-src/redirect-daemon-sessions-in-emergencies.md"]
dateOpened: "2026-10-01"
tags: []
---

# Prevention — A check:standards rule that fails a backlog card whose Done-when still contains the literal "TODO" whil… (from chalbert/web-everything#3356 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:backlog/4697-live-course-correction-a-user-or-supervisor-can-redirect-or.md:16` — A check:standards rule that fails a backlog card whose Done-when still contains the literal "TODO" while its body makes a "never" or "must not" guarantee. Better still, require the card to carry a Must line naming the refusal test.
2. `we:agent-memory-src/redirect-daemon-sessions-in-emergencies.md:11` — Add one line to the rule: a redirect may only narrow or stop work, must quote the operator decision verbatim, and must never relax gates or scope. A deterministic memory-lint is not feasible, so this is a doc note.
3. `we:agent-memory-src/redirect-daemon-sessions-in-emergencies.md:8` — Add a deterministic concurrency test to the supervisor implementation that delays pause acknowledgment and verifies the redirected worker cannot proceed while the competing job remains active.
4. `we:backlog/4697-live-course-correction-a-user-or-supervisor-can-redirect-or.md:16` — A pre-commit hook or CI check that rejects `TODO:` placeholders in the `Done when` section of newly created backlog cards.
5. `we:agent-memory-src/redirect-daemon-sessions-in-emergencies.md:12` — A markdown lint rule (e.g. markdownlint) that bans `[\[...]\]` wiki links in favor of standard markdown links across the repository.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#3356@1b492cd21ecb47a8f9d72675d30cb249dea7afaf

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

## Also raised by

- Also raised by web-everything/web-everything#5513 (finding 1: `we:backlog/xfrggva-red-team-setting-redteam-holdcapminutes-45-enforced-red-team.md:14` — Add a check:standards rule that refuses a card moving from filed to queued while any [A1] or edge-case line still contains 'TODO:'. Add a lint that requires a card with 'Test:' prose to carry a Test plan entry naming the file and case.) · key `approval-prevention-key:web-everything/web-everything#5513@8acbabd07164bef09f8f1f3ca93ab1f485547673`
