---
bornAs: xdk9ga2
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/5187-runner-neutral-under-test-marker-replacing-env-vitest-guards.md"]
dateOpened: "2026-10-06"
tags: []
---

# Prevention — A test-utility wrapper or linter rule that requires test suites testing explicit environment bag… (from web-everything/web-everything#4093 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:backlog/5187-runner-neutral-under-test-marker-replacing-env-vitest-guards.md:55` — A test-utility wrapper or linter rule that requires test suites testing explicit environment bag injections to assertively scrub the ambient `process.env` of test markers before execution, ensuring fallback logic fails rather than silently adopting the runner's context.
2. `we:backlog/5187-runner-neutral-under-test-marker-replacing-env-vitest-guards.md:70` — A review checklist or AI gate that parses 'Done when' or 'Must' guarantees in PR descriptions and enforces that every explicitly stated property (like 'every input kind') maps to a named test suite or matrix parameter in the Test Plan section.
3. `we:backlog/5187-runner-neutral-under-test-marker-replacing-env-vitest-guards.md:96` — A rule or reviewer lens that flags 'Must' guarantees in backlog plans lacking corresponding explicit test mappings in the 'Test plan' section.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4093@793dc0f3e5ee06a1bdb9a4edbf606fa6d9737c4d

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
