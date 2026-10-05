---
bornAs: xweoi0x
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/guard-bash.mjs", "we:scripts/__tests__/guard-bash.test.mjs"]
dateOpened: "2026-10-05"
tags: []
---

# Prevention — Add a replacement-equivalence case for an out-of-cwd node abswe:/scripts/check-standards.mjs path… (from web-everything/web-everything#3932 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this PR's latest advisory review named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/guard-bash.mjs:2640` — Add a replacement-equivalence case for an out-of-cwd `node <abs>we:/scripts/check-standards.mjs` path. Either `cd <dir> &&` is prepended or the queued form `node we:scripts/readiness/heavy-admission.mjs run -- node <path>` is suggested.
2. `we:scripts/guard-bash.mjs:2540` — Add a table-driven test of wrapper spellings (`exec`, `env -i`, `stdbuf`, `nohup`, `tsx`/`bun` check-standards, `npx -c`) with an explicit allowed-or-denied expectation per row. Longer term, enforce admission at the process level (a vitest config that refuses to start outside heavy-admission, or the existing heavy-run-ungated health-watch detector) rather than by parsing the command line.
3. `we:scripts/guard-bash.mjs` — Add deterministic replacement tests requiring `vitest run we:a.test.mjs` for implicit file runs and `vitest related we:a.mjs --run` for direct and npm-forwarded related commands, including default-mode rows in the admission-slot guarantee test.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#3932@e01e1098d9ab683cef4efb16a713f0cf70f867cd

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
