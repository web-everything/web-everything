---
bornAs: x3vn7kd
kind: story
size: 2
parent: "4075"
status: open
scope: ["we:backlog/5360-prevention-add-a-check-standards-rule-that-fails-a-card-movi.md", "we:backlog/6926-prevention-cache-persistent-overlay-pin-retry-outcomes-by-co.md", "we:backlog/6927-prevention-authenticate-conflict-overrides-through-a-trusted.md", "we:backlog/6928-prevention-map-overlay-audit-guards-to-named-regression-test.md", "we:scripts/lib/__tests__/daemon-rebuild-overlay-pin.test.mjs", "we:scripts/lib/__tests__/daemon-rebuild-retry-pass.test.mjs", "we:scripts/lib/__tests__/overlay-review-test-mappings.test.mjs"]
dateOpened: "2026-10-22"
tags: []
---

# Follow-up: map overlay review guarantees to named planned tests

File the seven later-round advisory suggestions from PR #5809's 2026-10-22 review as follow-up work, as the reviewer requested. The simplicity and codex-correctness observations about cards 6926, 6927 and 6928 overlap; the fourth distinct gap is the conflicting-adopted-head pin guarantee in `we:scripts/lib/daemon-rebuild/plan.mjs`. These advisory items are separate from the current admission repair.

## Acceptance

- [A1] **Executable** — Amend card 6926 A1–A3 to map each guarantee to concrete planned test names in `we:scripts/lib/__tests__/daemon-rebuild-retry-pass.test.mjs`: cache reuse, input invalidation, exhaustive-search and budget parity, corrupt/incompatible-state recovery, size bounds and writer lifecycle. Add a check that rejects a fixture card missing one required mapping and accepts the fully mapped fixture.
- [A2] Amend card 6927 A1–A3 with concrete planned names and repository-qualified test files for attacker allowlist/PATH, trusted-reader isolation, shared operator sessions, add/load refusal, extend-rounds reuse, unreadable credentials and recorded verified identity. Exercise both incomplete and complete mapping fixtures in that check.
- [A3] Amend card 6928 A1–A3 with repository-qualified named tests for the coverage check itself: missing mappings, valid mappings, deleted/renamed test references, fallback enumeration, per-conjunct coverage, unreadable/incomplete inputs, reference scoping and behavioral-versus-revert-red evidence classification. Exercise incomplete and complete mapping fixtures. Card 6928 now specifies the direct behavioral cases and gate-wiring case; implementing those cases remains work for card 6928, distinct from this card's mapping-presence checks.

### Planned acceptance tests for A1–A3

These are planned checker tests, not claims of existing passing coverage. Implement them in `we:scripts/lib/__tests__/overlay-review-test-mappings.test.mjs` as part of this follow-up:

| Acceptance | Named cases | Explicit assertions |
| --- | --- | --- |
| A1 | `rejects each missing cache guarantee mapping in card 6926`; `accepts the complete cache guarantee mapping in card 6926` | Parameterize removal of cache reuse, input invalidation, exhaustive-search parity, budget parity, corrupt-state recovery, incompatible-state recovery, size bounds and writer lifecycle mappings. Each incomplete fixture fails with the omitted guarantee identified; the complete fixture passes with no missing mappings. |
| A2 | `rejects each missing credential guarantee mapping in card 6927`; `accepts the complete credential guarantee mapping in card 6927` | Remove attacker allowlist, attacker PATH, trusted-reader isolation, shared operator sessions, add refusal, load refusal, extend-rounds reuse, unreadable credentials and recorded verified identity mappings one at a time. Each incomplete fixture fails with the omitted guarantee identified; the complete fixture passes. A mapping without a repository-qualified test file or concrete case name fails. |
| A3 | `rejects each missing coverage-check guarantee mapping in card 6928`; `accepts the complete coverage-check guarantee mapping in card 6928` | Remove missing-mapping rejection, valid-mapping acceptance, deleted references, renamed references, fallback enumeration, per-conjunct coverage, unreadable/incomplete inputs, reference scoping, behavioral-versus-revert-red classification and diff-selected gate wiring mappings one at a time. Each incomplete fixture fails with the omitted guarantee identified; the complete fixture passes with no diagnostics. Each mapping must identify the promised operation, fixture input and observable checker result; a mapping-presence assertion alone is insufficient. These fixtures validate the plan, not the coverage checker's implementation. |

Apply the acceptance mapping gate tracked by `we:backlog/5360-prevention-add-a-check-standards-rule-that-fails-a-card-movi.md` to newly filed follow-up cards too, including this one. Until that gate exists, review each refusal conjunct and ask which named test would fail if it were removed (coverage rule tracked by card 6928).

The four later-round suggestions in PR #5809's 2026-10-22T20:25:03Z review repeat the cache and credential mapping gaps already filed here as A1 and A2. Both lens reports remain owed under those entries; this round does not implement caching or trusted credentials.

### Adopted-head regression

- [A4] `refuses to pin when the adopted head also conflicts` is now implemented in `we:scripts/lib/__tests__/daemon-rebuild-overlay-pin.test.mjs`: it establishes an adopted overlay, makes both its moving tip and adopted head conflict with the new stack, and asserts no pin alert, no smoke, unchanged HEAD/registration and an established-overlay hold. Execution and sanctioned mutation evidence remain owed to the launcher; the repair sandbox forbids all `.git` writes, including those needed by the real-git fixtures. Do not weaken guards by hand to obtain proof.

## Non-goals

- [N1] This follow-up specifies and tests coverage; retry caching and trusted credential implementation stay in their existing cards.

## Edge cases

- Duplicate lens suggestions map to the same requirement without losing any A1–A3 guarantee.
- Planned tests must be explicitly distinguished from existing passing tests.
- Missing, renamed and stale test references must not count as coverage.
- A clean adopted head may still be pinned; a conflicting adopted head must retain the hold.
