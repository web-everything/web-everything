---
kind: story
size: 2
parent: "4075"
status: open
scope: ["we:backlog/6926-prevention-cache-persistent-overlay-pin-retry-outcomes-by-co.md", "we:backlog/6927-prevention-authenticate-conflict-overrides-through-a-trusted.md", "we:backlog/6928-prevention-map-overlay-audit-guards-to-named-regression-test.md", "we:scripts/lib/__tests__/daemon-rebuild-overlay-pin.test.mjs", "we:scripts/lib/__tests__/daemon-rebuild-retry-pass.test.mjs"]
dateOpened: "2026-10-22"
tags: []
---

# Follow-up: map overlay review guarantees to named planned tests

File the seven later-round advisory suggestions from PR #5809's 2026-10-22 review as follow-up work, as the reviewer requested. The simplicity and codex-correctness observations about cards 6926, 6927 and 6928 overlap; the fourth distinct gap is the conflicting-adopted-head pin guarantee in `we:scripts/lib/daemon-rebuild/plan.mjs`. These advisory items are separate from the current admission repair.

## Acceptance

- [A1] **Executable** — Amend card 6926 A1–A3 to map each guarantee to concrete planned test names in `we:scripts/lib/__tests__/daemon-rebuild-retry-pass.test.mjs`: cache reuse, input invalidation, exhaustive-search and budget parity, corrupt/incompatible-state recovery, size bounds and writer lifecycle. Add a check that rejects a fixture card missing one required mapping and accepts the fully mapped fixture.
- [A2] Amend card 6927 A1–A3 with concrete planned names and repository-qualified test files for attacker allowlist/PATH, trusted-reader isolation, shared operator sessions, add/load refusal, extend-rounds reuse, unreadable credentials and recorded verified identity. Exercise both incomplete and complete mapping fixtures in that check.
- [A3] Amend card 6928 A1–A3 with repository-qualified named tests for the coverage check itself: missing mappings, valid mappings, stale/renamed test references, fallback enumeration and behavioral-versus-revert-red evidence classification. Exercise incomplete and complete fixtures.
- [A4] Add `refuses to pin when the adopted head also conflicts` to `we:scripts/lib/__tests__/daemon-rebuild-overlay-pin.test.mjs`. Establish an adopted overlay, make both its moving tip and adopted head conflict with the new stack, and assert no pin is applied and the established-overlay hold remains. Record pre-fix/mutation evidence through the sanctioned runner without weakening guards by hand.

## Non-goals

- [N1] This follow-up specifies and tests coverage; retry caching and trusted credential implementation stay in their existing cards.

## Edge cases

- Duplicate lens suggestions map to the same requirement without losing any A1–A3 guarantee.
- Planned tests must be explicitly distinguished from existing passing tests.
- Missing, renamed and stale test references must not count as coverage.
- A clean adopted head may still be pinned; a conflicting adopted head must retain the hold.
