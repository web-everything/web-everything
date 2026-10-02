---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/wip-postdeploy-smoke-build.ts", "we:scripts/deploy-config.test.mjs", "we:.github/workflows/deploy.yml", "we:scripts/__tests__/wip-postdeploy-smoke-build.test.mjs"]
dateOpened: "2026-10-02"
tags: []
---

# Prevention — Add a check:standards rule that resolves each we:-prefixed path against the web-everything checkout and fai… (from chalbert/plateau-app#196 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/wip-postdeploy-smoke-build.ts:44` — Add a check:standards rule that resolves each `we:`-prefixed path against the web-everything checkout and fails when the path does not exist there. Otherwise, drop the prefix on local paths.
2. `we:scripts/deploy-config.test.mjs:103` — Make the build step's env an allowlist test, since it should contain only known non-secret keys. Alternatively, reject any `secrets` reference in the build step at all. Add this as a check:standards rule on we:.github/workflows/deploy.yml, not as a per-name regex.
3. `we:.github/workflows/deploy.yml:43` — Add a CI step or pre-merge check that runs `gh api repos/<repo>/compare/<default-branch>...<sha>` and asserts the SHA is an ancestor of main whenever the pin lines change in we:.github/workflows/deploy.yml.

Idempotency key (do not edit): approval-prevention-key:chalbert/plateau-app#196@7d63b8996cd0aa60a47d399528468f915e4e9563

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
