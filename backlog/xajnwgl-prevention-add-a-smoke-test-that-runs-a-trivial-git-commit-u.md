---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/load-flake-reverify.mjs", "we:scripts/conveyor/__tests__/load-flake-reverify.test.mjs"]
dateOpened: "2026-10-05"
tags: []
---

# Prevention — Add a smoke test that runs a trivial git-commit-using fixture (or verify-lane --dry) through defa… (from web-everything/web-everything#3983 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this PR's latest advisory review named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/load-flake-reverify.mjs:210` — Add a smoke test that runs a trivial git-commit-using fixture (or `verify-lane --dry`) through `defaultReverifyIo().verify` with a hostile real HOME, asserting ok:true. Alternatively seed the scratch HOME with a minimal .gitconfig (user.name, user.email, safe.directory).
2. `we:scripts/conveyor/load-flake-reverify.mjs:28` — Broaden the value check to any `://[^/\s@]+@` userinfo and add a test row for the token-only form in the existing 'drops any allowed value' it.each.
3. `we:scripts/conveyor/load-flake-reverify.mjs:173` — Add GIT_ASKPASS, GH_FOO and GITHUB_FOO rows to the extension tests, and make reverifyConfig reject the same names the scrub drops, so there is one shared predicate.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#3983@aadec6c868a7d7effdfa73a5e1bee89b4b3887df

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
