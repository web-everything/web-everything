---
kind: story
size: 3
status: open
scope: ["we:scripts/check-standards-rules.mjs", "we:scripts/check-standards.mjs", "we:scripts/__tests__/check-standards-rules.test.mjs", "we:scripts/__tests__/check-standards.test.mjs", "we:skills-src/review/review-agent-brief.md"]
dateOpened: "2026-10-13"
tags: [backlog, prevention, security, review]
---

# Prevention — dependency, test-scope and trust evidence in backlog plans

Track the prevention owed by the advisory review of PR #5245: dependency wiring and named test paths must agree with card metadata, and plans that relax a merge refusal must retain a human gate until approval is linked. Ledger security assertions need concrete tests before implementation acceptance.

Source: [PR #5245 advisory review](https://github.com/web-everything/web-everything/pull/5245),
posted 2026-10-14T01:14:28Z. This files outstanding prevention; it records no approval or review verdict.
Idempotency key: advisory-prevention-key:web-everything/web-everything#5245@9e8bf369373155a1c9213a0e9e43e063af7b5228.

## Design

- Add a backlog-integrity rule for prerequisite references: a body that relies on another card's wiring
  must list that card in `blockedBy`. Resolve letter references such as "slice (b) wiring" through the
  parent epic's slice table. Do not treat every contextual mention of another slice as a dependency;
  ambiguous prose gets a review warning requiring human/agent inspection rather than a guessed edge.
  Add a review-lens line confirming every prerequisite wiring reference has a matching dependency.
- Add a rule requiring every concrete test file named in Acceptance or Test plan to be covered by `scope`
  (exact file or declared directory prefix). Resolve repo prefixes consistently. Globs must have declared
  coverage; an unresolved glob gets a diagnostic, not an invented filename.
- Add a rule/review check: cards relaxing a merge-gate refusal retain `humanGate` until a source URL records
  approval of that exact relaxation. A claim of operator confirmation without a source link errors;
  a URL alone does not establish approval. The human process must verify its content before gate removal.
- Add required spec-review checks for append-only ledger plans: per-row introducing-commit authentication,
  authenticated signing identity rather than author-name strings, an untrusted row followed by a trusted
  tip fixture, and identical trust behavior in every reader (including CJS mirrors).
- Require paired unreadable-ledger tests inside/outside merge_group, duplicate identity tests across
  main-plus-PR including `bornAs` aliases and valid renames, and same-identity seed/materialization collision
  tests that pass while different identities fail.
- Require bounded-read guarantees to name a test asserting the actual read bound and zero allocation,
  append/push on overflow, including retry reads. A test checking only the returned error is insufficient.

The direct ledger prevention tests are already required by x5qtv82, xy5r0uf and xbpjdsd; this card adds the
reusable authoring guard so those omissions do not recur. It does not depend on their implementation.

## MVP

Dependency and test-scope rules, plus the approval-source check and the security review-lens checklist.

## Test plan

In `we:scripts/__tests__/check-standards-rules.test.mjs`, use synthetic cards/epic tables: missing versus
present wiring dependency; a contextual slice mention; unknown slice letter; missing versus covered test
file scope; directory and repo-prefix coverage; confirmation without source; retained gate with approval
pending. In `we:scripts/__tests__/check-standards.test.mjs`, exercise the real backlog scanner so these
checks cannot pass in isolation while remaining unwired. Review fixtures cover all ledger checklist items.

## Proof plan

Run the scoped standards gate against fixture cards: each omission must produce its named diagnostic;
correct the fixture metadata/evidence and show that diagnostic disappears. Review the ledger epic using
the new lens and record its per-row trust, context, identity and read-bound evidence.

## Done when

- The backlog scanner enforces dependency/test-scope consistency and flags unlinked confirmation claims.
- The review brief requires all security evidence above before accepting a ledger or merge-gate plan.

## Acceptance

- [A1] **Executable** — `npm run test:unit -- we:scripts/__tests__/check-standards-rules.test.mjs
  we:scripts/__tests__/check-standards.test.mjs` exercises red-before/green-after integrity fixtures.
- [A2] The review checklist explicitly requires the trusted-tip forgery, paired contexts, duplicate identity,
  matching/different collision and actual byte-bound tests, not generic "edge cases covered" prose.

## Non-goals

- [N1] Implementing the ledger, changing numbering mode, or clearing any human review gate.

## Edge cases this change must handle

1. **Untrusted text** — parse Markdown/YAML as data; never execute card text or follow approval URLs in lint.
2. **Truncated reads** — malformed/unreadable metadata errors rather than producing a clean integrity verdict.
3. **Shared state files** — read-only rules; no backlog writes by the checker.
4. **Fail closed** — missing scope or approval evidence is reported; ambiguous dependency prose warns for review.
5. **Identity scoping** — resolve dependencies by card identity within the parent epic and tests by repo-qualified path.
6. **State over time** — recognize valid rename/`bornAs` identity; compare current metadata, not cached slice tables.
7. **Who wrote it** — a claimed approval is untrusted until the human verifies the linked source and scope.
