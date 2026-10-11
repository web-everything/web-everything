---
bornAs: xfaz7ho
kind: story
size: 2
status: active
priority: high
scaffoldedBy: "pr-limit-operator-only"
dateScaffolded: "2026-10-10"
scope: ["we:scripts/operations/pr-limit.mjs", "we:scripts/lib/pr-limit.mjs", "we:scripts/worker-brief.mjs", "we:scripts/lib/__tests__/pr-limit.test.mjs", "we:scripts/__tests__/worker-brief.test.mjs"]
dateOpened: "2026-10-10"
tags: []
---

# pr-limit allow accepts only operator-channel requests with a quoted instruction

Twice on 2026-10-10 a worker agent ran `node we:scripts/operations/pr-limit.mjs allow --branch=<its own branch>` itself and opened its PR past the agent PR limit without the operator's OK (#4786, #4779 — both ratified after the fact). Exceptions are the operator's to grant. Fix: `allow` requires --operator-quote="<verbatim>" AND an operator channel, and refuses (non-zero exit, logged) when invoked from a worker/agent session — reusing the session-identity / actor-channel machinery of we:scripts/operations/session-role.mjs (`WE_CONVEYOR_WORKER`, the marker we:scripts/lib/pre-pr-review.mjs's bypass gate reads) and we:scripts/lib/review-independence.mjs (`CLAUDE_CODE_SESSION_ID`, recorded on every grant and refusal), never a self-declared flag alone. Existing allow-list entries stay valid. The standard worker brief (we:scripts/worker-brief.mjs) gains the rule: if open-pr is refused by the PR limit, stop and report — never run pr-limit allow yourself. Held item 199, operator-approved 2026-10-10.

## Acceptance

- [A1] **Executable** — `npm run test:unit` over we:scripts/lib/__tests__/pr-limit.test.mjs and we:scripts/__tests__/worker-brief.test.mjs: the `allow is operator-only (5832)` block (worker refused, lane refused, own branch refused, missing quote refused, operator channel with quote accepted, legacy entries honoured) and the worker-brief rule test fail before this item and pass after.
- [A2] Live: `node we:scripts/operations/pr-limit.mjs allow` from a worker lane exits 3 with the reason written to the store's history as `allow-refused`; the same command from the primary checkout with `--operator-quote` exits 0 and records the quote and channel on the entry.

## Non-goals

- [N1] Not an unforgeable actor signal (#2895 deferred that; #2946 is the durable fix). An Agent-tool subagent shares its parent's `CLAUDE_CODE_SESSION_ID` and carries no `WE_CONVEYOR_WORKER`, so one that leaves its lane (`cd` to the primary checkout) and quotes text still passes. Closing that needs a PreToolUse(Bash) hook keyed on the harness `agent_id` field (as we:scripts/guard-monitor-subagent.mjs does) — a follow-up outside this card's scope.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — the quote is stored as JSON data, trimmed and capped at 1000 characters; it is never executed or rendered as markup.
2. **Truncated reads** — n/a: the gate reads only env vars, the cwd and one `git rev-parse`; a failed git read yields '' and the other checks still apply.
3. **Shared state files** — the refusal and the grant both write through the existing atomic temp+rename `writeLimitState`; `parseLimitState` now keeps `operatorQuote`/`channel`/`session` so a later write never strips them.
4. **Fail closed** — an unrecognised `WE_CONVEYOR_WORKER` value, a lane cwd, an own-branch target, or a blank quote all refuse with exit 3.
5. **Identity scoping** — the channel is derived from env markers our spawn sites set and from the cwd, never from an argv flag; the session id is recorded with each decision.
6. **State over time** — entries written before this item (no quote, no channel) remain honoured; `isBranchAllowedNow` is unchanged and the gate applies only at write time.
7. **Who wrote it** — every grant records `by`, `channel`, `session` and the verbatim `operatorQuote`; every refusal records the same in history.
