---
bornAs: x9v3p6n
kind: story
size: 3
status: open
dateOpened: "2026-11-16"
scope: ["we:scripts/check-standards.mjs", "we:scripts/check-standards-rules.mjs", "we:scripts/operations/__tests__/", "we:scripts/lib/__tests__/"]
tags: []
---

# Enforce refusal, default-IO, and disclosed-card review contracts

PR #6919's review found untested launch-time adoption refusal, untested default cursor IO and restart wiring, and disclosed follow-up cards with placeholder acceptance criteria. The repair adds the concrete yield, cursor, host, and ledger tests and fills both cards. This follow-up tracks the broader prevention checks requested by the panel without extending the dispatch repair into the standards engine.

## Acceptance

- [A1] **Executable** — Add a standards rule and negative fixtures for PR-referenced or audit-disclosed backlog cards whose Acceptance section contains a literal `TODO`. Include both #8410 and #8412 as completed-card positive fixtures. Resolve references from supplied PR metadata; unavailable metadata reports incomplete evidence rather than claiming success.
- [A2] **Executable** — Add a contract test enumerating CI-heal refusal kinds and their named assertion coverage. For refusal kinds meaning “not attempted”, including `adoption-yield`, require deferred/cursor assertions. A mutation that removes the Phase B yield check or its deferred update must fail the test.
- [A3] **Executable** — Add a coverage check for newly exported persistence helpers' default IO branches and lifecycle callers. Demonstrate that breaking default write/rename, startup loading, or post-tick persistence fails the selected regression tests.
- [A4] **Executable** — Run `npm run check:standards` and the new rule/contract test files through `npm run test:unit -- <files>`. Negative fixtures must fail for the named missing evidence, not parsing or environment errors.

## Risks and test plan

Avoid false positives from historical prose, literal examples, unrelated cards, or refusals that represent completed attempts. Parse the Acceptance section and scope enforcement to supplied references. Test malformed references, missing cards, missing metadata, nested headings, repeated references, and an empty reference list. Pin at least one deliberate non-regression test separately from mutation-sensitive tests. Do not execute text from PR metadata. Bound metadata size and reference count, reporting incomplete evidence at the bound.

## Non-goals

- [N1] Do not resolve the reserve accounting or slow-plan defects themselves; their existing cards own implementation.
- [N2] Do not require every historical export or card to be rewritten in one pass.

## Edge cases this change must handle

1. **Untrusted text** — Treat PR references and excerpts as data, using shared parsers and no shell interpolation.
2. **Truncated reads** — Missing or bounded metadata yields incomplete evidence, never a clear pass.
3. **Shared state files** — Contract tests use temporary paths and preserve the atomic-write failure checks.
4. **Fail closed** — Missing required test evidence or placeholder acceptance refuses the affected write gate.
5. **Identity scoping** — Resolve cards in the declared repository; do not merge equal IDs across repos.
6. **State over time** — Cover renamed references, post-tick cursor changes, and a fresh daemon module loading saved state.
7. **Who wrote it** — Use trusted review metadata; a card's own claim of coverage is not proof.
