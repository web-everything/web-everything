---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/claude-jobs-archive.mjs", "we:scripts/conveyor/health-watch.mjs", "we:scripts/conveyor/__tests__/health-watch.test.mjs", "we:scripts/conveyor/__tests__/claude-jobs-archive.test.mjs"]
dateOpened: "2026-10-05"
tags: []
---

# Prevention — Add a missing-root case to the archive test table. For all sweep-style passes, treat ENOENT on th… (from web-everything/web-everything#4008 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/claude-jobs-archive.mjs:62` — Add a missing-root case to the archive test table. For all sweep-style passes, treat ENOENT on the listed root as an empty listing.
2. `we:scripts/conveyor/health-watch.mjs:855` — Require both roots to be set together whenever either is explicit (in archiveAllowed or in archiveOptions). Add a tick test that passes only jobs-root.
3. `we:scripts/conveyor/__tests__/health-watch.test.mjs:1202` — Add a tick case with no state-root and dry-run true, with HOME pointed at a temp dir, asserting claudeJobsArchive is null.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4008@7fa81b46f952752f1d79fe4d990bc112d81345c1

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
