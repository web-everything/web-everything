Fixes red main. First red commit: 06c8c0b6383f252d9a30ed9bb15383688fc06b01 (last green 12858ff9e).

**Cause.** `scripts/lib/__tests__/identical-net-patch.test.mjs` > "explicit trust carries an offset-only contribution with the net-patch alternative disabled" failed in `test-shard (6)` (so `coverage-merge` and `test` failed too): `restampAfterNumbering` returned `null`. The restamp memo `settledRestamps` in `numbering-carry.mjs` is module-level and keyed `repo#pr@head`. The fixture's commits are deterministic within one clock second, so two fixtures can mint the same head SHA; the later one hits the earlier one's settled memo. The merged range (#6651) only touched a backlog card, so this is a latent timing-dependent test race, not a product regression.

**Fix.** `offsetRebaseFixture` now calls `_resetNumberingRestampMemo()` first, so every fixture starts from a clean memo. No test, guard or production code was loosened.

**Proof.** `npm run test:unit -- scripts/lib/__tests__/identical-net-patch.test.mjs scripts/lib/__tests__/numbering-carry.test.mjs`: 2 files, 203 tests pass (was 1 failed in identical-net-patch).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
