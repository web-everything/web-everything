---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/__tests__/main-staleness.test.mjs", "we:scripts/lib/main-staleness.mjs"]
dateOpened: "2026-10-04"
tags: []
---

# Prevention — Add a real-git case to the behindFiles test: a missing merge whose conflict resolution differs fr… (from web-everything/web-everything#3929 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/__tests__/main-staleness.test.mjs:317` — Add a real-git case to the `behindFiles` test: a missing merge whose conflict resolution differs from both parents must list that file. Longer term, a review lens that pairs every 'still counts' or 'never' claim in a comment with a named test.
2. `we:scripts/lib/__tests__/main-staleness.test.mjs:311` — Add a conflict-resolved-merge case to `makeOverlayClone`. A review-lens checklist item could also require a test for each flag that the comment justifies. No deterministic gate exists for this.
3. `we:scripts/lib/main-staleness.mjs:183` — Use one shared git-output path parser, with `-z` or `core.quotePath=false`, for every `--name-only` or `--porcelain` consumer, and add a unit test with a non-ASCII filename.
4. `we:scripts/lib/main-staleness.mjs:182` — Add a deterministic real-git regression test with identical reachable parents but differing clone and upstream merge resolutions, followed by an off-path commit; require stale dispatch refusal.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#3929@78e238ebbce602cac2cf6cbe9ee669f24126d90b

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
