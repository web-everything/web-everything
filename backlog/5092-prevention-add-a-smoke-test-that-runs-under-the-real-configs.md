---
bornAs: x4hzbho
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/__tests__/test-tmp-root.test.mjs", "we:scripts/lib/test-tmp-root.mjs", "we:scripts/lib/__tests__/test-tmp-root.test.mjs"]
dateOpened: "2026-10-04"
tags: []
---

# Prevention — Add a smoke test that runs under the real configs and asserts os.tmpdir() is inside we-vitest/ppi… (from web-everything/web-everything#3911 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/__tests__/test-tmp-root.test.mjs:1` — Add a smoke test that runs under the real configs and asserts `os.tmpdir()` is inside `we-vitest/<ppid>-*`. Back it with a fail-mode subprocess test that checks the exit code.
2. `we:scripts/lib/test-tmp-root.mjs:78` — In createRunTmpRoot: mkdir the parent with mode 0o700, then lstat it and refuse a non-directory, a symlink, or a foreign uid. Alternatively use a per-uid parent name such as `we-vitest-<uid>`. Add a unit test for the foreign-owner or symlink refusal.
3. `we:scripts/__tests__/test-tmp-root.test.mjs:84` — Add an automated subprocess lifecycle test that asserts worker and child temporary paths fall under the run root, ordinary teardown removes it, and KEEP=1 leaves no shared-setup directories.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#3911@8608608312b65ccd8fb251c4aedf79bb1790bca3

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
