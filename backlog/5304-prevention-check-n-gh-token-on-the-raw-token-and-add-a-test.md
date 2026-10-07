---
bornAs: xp8jzwa
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:.github/workflows/apply-review-request.yml"]
dateOpened: "2026-10-07"
tags: []
---

# Prevention — Check [ -n "GH_TOKEN" ] on the raw token, and add a test that executes the extracted shell snippe… (from web-everything/web-everything#4318 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:.github/workflows/apply-review-request.yml:131` — Check `[ -n "$GH_TOKEN" ]` on the raw token, and add a test that executes the extracted shell snippet with an empty token and asserts a non-zero exit.
2. `we:.github/workflows/apply-review-request.yml:131` — Test the snippet behaviourally: extract the step's shell, run it with GH_TOKEN='' and assert exit 1. As a lint, flag `[ -n "$x" ]` where x is computed from a literal prefix plus a secret.
3. `we:.github/workflows/apply-review-request.yml:136` — Have `buildEnv` delete GIT_CONFIG_COUNT/KEY_*/VALUE_* (and ideally keep only an allowlist of env vars) for the child, with a unit test. As a gate, add a `check:standards` rule for spawnSync/execFile calls that inherit process.env in scripts that hold a write credential.
4. `we:.github/workflows/apply-review-request.yml:134` — Check GH_TOKEN itself before encoding and add a deterministic shell test that supplies an empty token and asserts failure before exporting the authentication header.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4318@fe1846b0e77dd2b4ee77064fb99fda7b63425f45

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
