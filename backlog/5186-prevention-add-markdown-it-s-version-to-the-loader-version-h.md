---
bornAs: x65pazc
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:src/_data/backlog.js", "we:scripts/lib/backlog-index.cjs", "we:src/_data/__tests__/backlog.test.mjs", "we:scripts/lib/__tests__/backlog-index.test.mjs"]
dateOpened: "2026-10-06"
tags: []
---

# Prevention — Add markdown-it's version to the LOADER_VERSION hash. Add a test that the hash changes when each… (from web-everything/web-everything#4072 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:src/_data/backlog.js:26` — Add markdown-it's version to the LOADER_VERSION hash. Add a test that the hash changes when each third-party input version changes. A more durable guard is to derive the version from the we:package.json versions of every module `derive()` touches.
2. `we:scripts/lib/backlog-index.cjs:22` — Add a `check:standards` lint that flags `deserialize(`/`v8.deserialize` or `JSON.parse` of files under `os.tmpdir()`. Require creating the directory with `mode: 0o700`, then an `lstat` check that it is owned by `getuid()` and is not group- or world-writable before reading. Add a test for that ownership/mode check.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4072@53d6ace90c26db5b434f487eef890db992bb7996

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
