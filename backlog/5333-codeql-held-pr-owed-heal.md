---
bornAs: x8cnbii
kind: story
size: 5
status: open
scope: ["we:scripts/conveyor/reconcile-core.mjs", "we:scripts/conveyor/reconcile-pass.mjs", "we:scripts/lib/codeql-gate.mjs", "we:scripts/operations/ci-heal-pr-dispatch.mjs", "we:scripts/merge-ai-prs.mjs"]
dateOpened: "2026-10-07"
tags: []
---

# Fix daemon owns a PR the drain holds for a failed CodeQL check

When the drain refuses to land a PR for a failed CodeQL check (drainBlocksOnCodeQL), nobody owned the repair (live: PR 4370, a high-severity alert). The reconcile plan now owes that PR a ci-heal whose brief names the alert (rule, file, line, message from the check-run annotations), bounded by the ci-heal cap, with the reason logged.

## Done when

1. **Executable** — `npm run test:unit -- we:scripts/conveyor/__tests__/reconcile-core-codeql-owner.test.mjs we:scripts/operations/__tests__/ci-heal-pr-dispatch.test.mjs` is red on the old code (a CodeQL-held PR is `nothing-owed`; the sink payload has no `routing`; hostile annotation text reaches the brief verbatim) and green after.
2. **Must refuse on error** — an unreadable annotations call still owes the heal (the agent is told to read them itself); the drain's own refusal and the `drainBlocksOnCodeQL` knob are unchanged, never loosened.
3. **Must treat every input kind cautiously** — the heal fence is the PR's own scope (source, docs, config or data alike); a CodeQL heal never weakens the gate, its settings or a test.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — annotation rule, path and message come from the PR's own code. `codeqlBriefSection` redacts secrets, collapses every whitespace/line-separator run to one space, neutralises backticks, caps each field (`BRIEF_FIELD_MAX`) and the alert count (`BRIEF_MAX_ALERTS`), and places the alerts in a fenced block labelled untrusted data; the read-error line gets the same treatment. Tests: `codeql brief treats annotation text as untrusted data`.
2. **Truncated reads** — the annotations call reads one page (`per_page=100`); the brief shows at most `BRIEF_MAX_ALERTS` and says how many more it left out, and always names the annotations command so the agent can re-read the full set.
3. **Shared state files** — n/a: no new state file; the cap and escalation reuse the existing ci-heal marker comments on the PR.
4. **Fail closed** — a read failure keeps the heal owed (`readError` on the evidence); the ci-heal cap, head-scoped escalation and a live fix claim still stop a dispatch; a routing refusal still releases the claim without dispatching. `routing` reaches the sink on every heal (test: `passes the routeHeal decision to the sink as routing`).
5. **Identity scoping** — evidence is attached only to PRs the drain actually holds (latest `CodeQL` rollup row FAILURE, knob on), keyed on the PR number and head sha; a superseded failure does not hold.
6. **State over time** — only the LATEST CodeQL run counts; a new head re-reads the annotations; the existing ci-heal round cap bounds repeats.
7. **Who wrote it** — n/a: the heal posts the existing ci-heal marker through `we:scripts/conveyor/ci-heal-mark.mjs`, whose author check is unchanged.
