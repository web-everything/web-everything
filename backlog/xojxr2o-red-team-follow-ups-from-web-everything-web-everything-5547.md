---
kind: story
size: 2
status: open
scope: ["we:backlog/x28khww-the-verify-operation-prints-a-plain-pass-fail-verdict.md", "we:backlog/xzukm4y-drain-pass-summary-counts-each-merged-pr-once.md"]
dateOpened: "2026-10-17"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5547 (head 093130d41)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5547 (reviewed head `093130d419ad0d7b8b8e1a05f07a860d141803ef`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:backlog/x28khww-the-verify-operation-prints-a-plain-pass-fail-verdict.md:12` — (failing-input, degraded) The top-priority marking has no effect on queue ordering.
   - Scenario: Clear x28khww and an otherwise equivalent ordinary card dated 2026-10-16 for build, with priority enforcement enabled and no external priority override. Calling the actual orderQueueDetailed function places the ordinary card first; x28khww receives P3, reason 'normal', and no buildPriorityIndex. The new 'Priority: top' text exists only in prose, which buildQueuePriorityFacts never reads. The other top-priority markings use the same pattern. Record the operator priority through the supported structured priority mechanism so these cards receive the claimed ordering.
   - Claude's re-check: demonstrated break
2. `we:backlog/xzukm4y-drain-pass-summary-counts-each-merged-pr-once.md:12` — (edge-case, degraded) Deduplicating by PR number collapses distinct PRs from different repositories.
   - Scenario: In one pass, record WE#42 twice and FrontierUI#42 once. The prescribed fix, 'count distinct PR numbers', produces 1; the correct merged count is 2. A read-only probe confirms these counts. This is a supported input: resolveRepos defaults to the constellation, and merged entries carry both repo and num. Require deduplication by canonical repository plus PR number, with a cross-repository collision test.
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
