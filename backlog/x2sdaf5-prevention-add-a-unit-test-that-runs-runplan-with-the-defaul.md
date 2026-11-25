---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/rewaive-plan.mjs", "we:scripts/conveyor/soak/breaks/rewaive-request-never-admits.mjs", "we:scripts/operations/__tests__/rewaive-plan.test.mjs", "we:scripts/conveyor/soak/breaks/__tests__/rewaive-request-never-admits.test.mjs"]
dateOpened: "2026-11-25"
tags: []
---

# Prevention — Add a unit test that runs runPlan with the default loaders against a temp HOME whose request log… (from web-everything/web-everything#7479 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/rewaive-plan.mjs:87` — Add a unit test that runs runPlan with the default loaders against a temp HOME whose request log has one damaged line for another ref (expect a plan) and one for this ref (expect refuse). Scope the warnings by ref via scopeRef/warnOther.
2. `we:scripts/operations/rewaive-plan.mjs:131` — Add a CLI test asserting that stdout contains the request, the refusal detail and the op's message.
3. `we:scripts/operations/rewaive-plan.mjs:78` — Add temp-HOME tests through defaultLoaders: damaged store, unreadable preferences, and a WITHDRAWN line for the basis sha.
4. `we:scripts/operations/rewaive-plan.mjs:113` — Add a temp-repo test with a pushed origin/main, no injected baseOk, one covered base and one uncovered base.
5. `we:scripts/operations/rewaive-plan.mjs:138` — Add one test per documented exit code and refuse reason, including a stand-in op that exits 1.
6. `we:scripts/conveyor/soak/breaks/rewaive-request-never-admits.mjs:46` — Feed the captured spawn input to the gate's readFile as the waiver-requests.jsonl content, then assert the result is still canonical-audit-weakened.
7. `we:scripts/operations/rewaive-plan.mjs:98` — Set advice.graftFileDeprecated=false through GIT_CONFIG_* in the pinned environment; a CLI test can assert stderr is empty on a successful run.
8. `we:scripts/conveyor/soak/breaks/rewaive-request-never-admits.mjs:44` — In the soak, serve spawned[0].input at /soak-home/workspace/.operations/handoff/waiver-requests.jsonl for both gate runs, and require each never-admits break to have a red proof against a gate that does admit.
9. `we:scripts/operations/rewaive-plan.mjs:107` — Push a main branch in mkRepo and add cases that omit baseOk, one with a covered base and one with an uncovered base; consider a review lens for injectable defaults that every test overrides.
10. `we:scripts/operations/rewaive-plan.mjs:45` — Add one-field-off negative cases (wrong ref; older sha with a valid audit on the basis), each asserting reason basis-not-waived.
11. `we:scripts/operations/rewaive-plan.mjs:81` — Add runPlan tests with no injected loaders against a temp HOME holding a damaged request log, a WITHDRAWN line for the basis, and malformed platform preferences, each expecting refuse.
12. `we:scripts/operations/rewaive-plan.mjs:40` — Add a case with two well-formed audits where only the older one is waived, asserting reason basis-not-waived and the nearer sha as basis; require negative tests to assert the refusal reason.
13. `we:scripts/operations/rewaive-plan.mjs:133` — Add a runCli test in state request without --file-request, with a spy spawn, asserting zero spawns and no waiver-requests.jsonl.
14. `we:scripts/operations/rewaive-plan.mjs:92` — Add table-driven negative tests for a planted grafts file, a mismatched ls-remote ref name and a malformed ref; fold into the REWAIVE-PLAN-HARDEN card.
15. `we:scripts/operations/rewaive-plan.mjs:107` — Add the proposed deterministic integration test using divergent Git histories and the default baseOk implementation; assert refusal for the uncovered base and success for a covered control.
16. `we:scripts/operations/rewaive-plan.mjs:75` — Add the proposed deterministic test through the default loader with otherwise valid evidence and a damaged revocation log; assert refusal and no filing subprocess, alongside a valid-log control.
17. `we:scripts/operations/rewaive-plan.mjs:104` — Add a deterministic integration test with rewritten main, a failed refresh, and stale locally valid ancestry; require refusal.
18. `we:scripts/conveyor/soak/breaks/rewaive-request-never-admits.mjs:35` — Make the soak test execute the real request operation in an isolated fixture and assert that the resulting request leaves admission refusing before adding approval as a positive control.
19. `we:scripts/operations/rewaive-plan.mjs:74` — Add a deterministic fixture test using the default loaders, valid waiver evidence, and damaged revocation data; assert refusal instead of a request.
20. `we:scripts/operations/rewaive-plan.mjs:138` — Add a parameterized CLI test injecting nonzero and null subprocess statuses and asserting code 3.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7479@5168bf9ddc684907ae755c7753a2e3905f4bb02c

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
