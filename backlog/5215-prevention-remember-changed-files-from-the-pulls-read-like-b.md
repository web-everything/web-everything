---
bornAs: xvxxbcp
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/fix-facts.mjs", "we:scripts/lib/__tests__/fix-facts.test.mjs"]
dateOpened: "2026-10-06"
tags: []
---

# Prevention — Remember changed_files from the pulls read (like baseSha) and write the files cache only when bat… (from web-everything/web-everything#4120 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/fix-facts.mjs:103` — Remember `changed_files` from the pulls read (like `baseSha`) and write the files cache only when `batch.length === changed_files`. Add a test where the list is shorter than `changed_files` and assert the next tick re-reads it.
2. `we:scripts/lib/fix-facts.mjs:56` — Use a distinct reason such as 'stale-closed' for the state check. A cheap guard against the lag case is to compare the row's `updatedAt` with the pass snapshot time before trusting a mismatch.
3. `we:scripts/lib/__tests__/fix-facts.test.mjs:87` — Add two cases. First, a fake whose `pulls/5` base sha changes between ticks, asserting the files path is read twice. Second, two `api('repos/o/r/actions/runs/100')` calls on a completed run, asserting 2 gh calls (or 1 core call plus a 304). A cheap general guard is a review lens that requires every prose guarantee to name a test that moves the guarded input.
4. `we:scripts/lib/__tests__/fix-facts.test.mjs` — Add a deterministic changed-base test, with different file responses, that fails when the base-SHA cache comparison is removed.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4120@d2152161909c6aa81b9fed06aa419541f7730607

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
