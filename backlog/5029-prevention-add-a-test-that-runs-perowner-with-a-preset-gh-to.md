---
bornAs: xbtxodb
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/github-app-auth-env.mjs", "we:scripts/merge-ai-prs.mjs", "we:scripts/__tests__/merge-ai-prs-one-repo-listing-fails.test.mjs", "we:scripts/lib/__tests__/github-app-auth-env.test.mjs", "we:scripts/__tests__/merge-ai-prs.test.mjs"]
dateOpened: "2026-10-03"
tags: []
---

# Prevention — Add a test that runs perOwner with a preset GH_TOKEN and WE_GH_AUTH_* and asserts they are scrubb… (from web-everything/web-everything#3857 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/github-app-auth-env.mjs:368` — Add a test that runs perOwner with a preset GH_TOKEN and WE_GH_AUTH_* and asserts they are scrubbed. A shared env-scrub helper would also work; buildGhShimSettingsEnv-style scrubbing already exists at we:gh-app-shim.mjs:693.
2. `we:scripts/merge-ai-prs.mjs:4297` — Add a test for the couple gate with one failed repo. As a lens rule, require a named test for any 'fails closed' claim.
3. `we:scripts/lib/github-app-auth-env.mjs:368` — Add one test: perOwner with an installation id not in the owner map returns applied:false with reason owner-map-missing.
4. `we:scripts/lib/github-app-auth-env.mjs:373` — Add a deterministic test, or a status field such as `ownersOnPersonalAuth`, that asserts a per-owner mint failure is surfaced in the returned/recorded result. Alternatively make perOwner fail closed per owner.
5. `we:scripts/lib/github-app-auth-env.mjs:373` — Add a test or lint asserting that every credentialed subprocess the drain spawns (gh or git) is covered in perOwner mode. Alternatively, have the drain set a per-push `GH_TOKEN` or credential helper for the repo's owner.
6. `we:scripts/lib/github-app-auth-env.mjs:373` — Add a unit test asserting perOwner mode deletes or neutralises `GH_TOKEN` and `WE_GH_AUTH_*` in the env it is given.
7. `we:scripts/__tests__/merge-ai-prs-one-repo-listing-fails.test.mjs:54` — Add a deterministic CLI regression test with a merge-ready coupled PR, a persistently failing partner repo, and assertions that no merge occurs and the couple is held; verify that bypassing the relevant couple guard makes that named test fail.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#3857@0c244b1492db4fde0fdb0d0168d5cb940fe8aaad

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
