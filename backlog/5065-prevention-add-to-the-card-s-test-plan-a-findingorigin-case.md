---
bornAs: xhk3bja
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/5073-arbiter-the-same-independent-judge-settles-fixer-and-reviewe.md", "we:backlog/5074-durable-judge-clearance-ledger-and-one-daily-digest-for-the.md", "we:backlog/5062-judge-clearance-decision-core-protected-list-and-provider-in.md"]
dateOpened: "2026-10-04"
tags: []
---

# Prevention — Add to the card's test plan a findingOrigin case where the finding has no category (rendered thro… (from web-everything/web-everything#3771 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this PR's latest advisory review named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:backlog/5073-arbiter-the-same-independent-judge-settles-fixer-and-reviewe.md:28` — Add to the card's test plan a `findingOrigin` case where the finding has no category (rendered through the real renderer, so it lands under `general`). Treat `general` as unknown in the rule text, so the downgrade is decided by a test and not by the build-time shape check.
2. `we:backlog/5074-durable-judge-clearance-ledger-and-one-daily-digest-for-the.md:21` — State in `5072` that the `swap-failed` row carries the `judge` block with `refusal: 'swap-failed'`. Add an end-to-end test that feeds the label home's actual `swap-failed` row into `judgeRecordsSince` and the digest, rather than a hand-built fixture.
3. `we:backlog/5062-judge-clearance-decision-core-protected-list-and-provider-in.md:58` — Add a gate-invariants case asserting `JUDGE_PROTECTED` matches `we:package.json`, lockfiles, `.github/CODEOWNERS`, jury and mandate modules and the reviewer skill prompts. Alternatively, make the floor default-protected for anything outside an explicit allow-list of ordinary content trees, which fails toward human.
4. `we:backlog/5062-judge-clearance-decision-core-protected-list-and-provider-in.md:58` — Add a leash rule or gate-invariants case that any `__tests__/<name>.test.mjs` whose source `<name>` is protected is itself protected, derived mechanically from the source path.
5. `we:backlog/5062-judge-clearance-decision-core-protected-list-and-provider-in.md` — Add deterministic tests covering edits beneath unchanged ruling markers and deletion of existing rulings; classify affected files using both base and head contents rather than added lines alone.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#3771@c354c2760fdfed0e8b0aa59844d46ead397d76f7

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
