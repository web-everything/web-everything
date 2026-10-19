---
bornAs: xiurfp4
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/6249-approve-human-only-enqueues-from-chat-with-a-recorded-instru.md", "we:backlog/6254-split-we-scripts-merge-ai-prs-mjs-extract-the-queue-selectio.md", "we:backlog/6255-codex-sandbox-can-write-the-coordination-dir-free-scope-regi.md"]
dateOpened: "2026-10-18"
tags: []
---

# Prevention — Add a card-lint rule requiring each 'same checks as' or 'pinned' claim in a card body to map to a… (from web-everything/web-everything#5547 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:backlog/6249-approve-human-only-enqueues-from-chat-with-a-recorded-instru.md:14` — Add a card-lint rule requiring each 'same checks as' or 'pinned' claim in a card body to map to a named test case in Acceptance. File it as a future backlog item.
2. `we:backlog/6254-split-we-scripts-merge-ai-prs-mjs-extract-the-queue-selectio.md:6` — Add a backlog lint that warns when two open cards share a scope file and neither names the other as a blocker.
3. `we:backlog/6249-approve-human-only-enqueues-from-chat-with-a-recorded-instru.md:16` — Add a check:standards rule: a backlog card whose text loosens a refusal (contains 'default chat', 'sanctioned path', 'bypass') must have no TODO Acceptance lines and at least one test line per stated guarantee before it can be marked ready.
4. `we:backlog/6255-codex-sandbox-can-write-the-coordination-dir-free-scope-regi.md:16` — Add a check:standards rule that a card widening a sandbox or permission allowlist must include a negative-path test line (an adjacent path stays denied) before status can move to ready.
5. `we:backlog/6249-approve-human-only-enqueues-from-chat-with-a-recorded-instru.md:16` — Add a review lens, or a lint over settings JSON, that flags a security-relevant setting whose default is the weaker value and requires a test for the default plus an invalid-value-fails-closed case.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5547@d10d93bc0252692283be4603392d5b949ad1e6d1

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
