---
kind: story
size: 3
status: open
scope: ["we:scripts/lane-resume.mjs", "we:scripts/lib/remote-manifest.mjs", "we:scripts/merge-ai-prs.mjs"]
dateOpened: "2026-11-07"
tags: []
---

# /finish discover reads only the tree manifest, but manifests ride the PR body since xnsk54v, so item, blocked…

Flow-sim gap R9c-G2, class K9 (divergent predicates for one state). Failing input: Ready-labelled lane PR created by current producer (we:lane-manifest-write.mjs:122 writes scratch, pr-land embeds it in the PR body; nothing is committed). Its blockedBy names an item not yet landed, its item is closed. 'lane-resume discover (we:scripts/lane-resume.mjs:899) calls readManifest(headRefName). Cited: we:scripts/lane-resume.mjs:557-570, we:scripts/lane-resume.mjs:899, we:scripts/lane-resume.mjs:900, we:scripts/lane-resume.mjs:140, we:scripts/lane-resume.mjs:184-196. Soak-break sketch: Fixture: gh/git stubs where PR 11 has body with manifestBodyBlock({item:50,blockedBy:[49],repos:[we]}) and no tree manifest; item 49 unresolved on main. Action: run lane-resume discover over the stubs. Assert (fails today): PR 11 disposition is 'blocked' (blo…

## Acceptance

- [A1] **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] TODO: what this item deliberately does not do — or `n/a: <why>` when nothing is excluded.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
