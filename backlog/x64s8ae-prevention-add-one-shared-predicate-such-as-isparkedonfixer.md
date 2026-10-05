---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/stand-down.mjs", "we:scripts/conveyor/load-flake-reverify.mjs", "we:scripts/conveyor/__tests__/stand-down.test.mjs", "we:scripts/conveyor/__tests__/load-flake-reverify.test.mjs"]
dateOpened: "2026-10-05"
tags: []
---

# Prevention — Add one shared predicate, such as isParkedOnFixer(comments), covering terminal stand-downs and li… (from web-everything/web-everything#3945 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this PR's latest advisory review named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/stand-down.mjs:327` — Add one shared predicate, such as isParkedOnFixer(comments), covering terminal stand-downs and live load-flake holds. Have every 'is this PR parked' reader use it. Add a test that iterates the readers with a held-PR fixture. A standards rule could also flag new REFUSAL_KINDS that have no matching entry in the never-stuck and health-benign lists.
2. `we:scripts/conveyor/load-flake-reverify.mjs:152` — Switch to an allowlist (PATH, HOME, LANG, TERM, TMPDIR, NODE_*, npm_config_cache) and give HOME a fresh temp dir. Add a test that injects ANTHROPIC_API_KEY, SSH_AUTH_SOCK and AWS_ACCESS_KEY_ID and asserts the child env lacks them. A check:standards rule could flag any runBounded/spawn of branch-code verification that does not pass an allowlisted env.
3. `we:scripts/conveyor/load-flake-reverify.mjs:93` — Compare the current hold's identity and saved commit with the selected candidate before publishing any verification outcome; add a deterministic regression test that replaces the hold during both green and final-red verification.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#3945@edc5d47996d82c5eb12d3e9e6eac567b047c19c2

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
