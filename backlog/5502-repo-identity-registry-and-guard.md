---
bornAs: xdjrqkz
kind: story
size: 5
status: open
scope: ["we:scripts/lib/constellation-repos.mjs", "we:scripts/lib/github-app-installations.mjs", "we:scripts/lib/gh-app-shim.mjs", "we:scripts/check-standards-rules.mjs", "we:scripts/lib/repo-slug-allowlist.json", "we:scripts/lib/poc-branches.mjs", "we:scripts/operations/land-advance.mjs", "we:scripts/operations/record-verdict-io.mjs", "we:scripts/conveyor/session-verdicts-io.mjs", "we:scripts/broadcast-inject.mjs", "we:scripts/lib/__tests__/constellation-repos.test.mjs", "we:scripts/lib/__tests__/github-app-installations.test.mjs", "we:scripts/lib/__tests__/gh-app-shim-refusal.test.mjs", "we:scripts/__tests__/check-standards-repo-slug-guard.test.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# Repo identity registry: one declared setting for every constellation org/repo slug, plus a guard against new hardcoded slugs

Operator decision 2026-10-08: orgs will become everstandards (standards), frontier-ui, longshoreai (delivery open core), plateauapp. Nothing moves now. Make a later org or repo rename a one-line change: extend CONSTELLATION_REPOS into a role-keyed registry with owner, name and previous names, fold the scattered chalbert alias maps into it, and add a check:standards rule refusing new hardcoded slugs outside it. Full inventory is in the operator handoff note plan-repo-slug-setting.

## Why

The registry half-exists already: `we:scripts/lib/constellation-repos.mjs` (`CONSTELLATION_REPOS`, `canonicalizeSlug`, `ghRepoSlug`) is the one key-to-slug map most code uses. But the last move (chalbert to orgs, 2026-10-03) was handled with at least seven separate "old name to new name" copies: `canonicalizeSlug`, `MOVED_REPO_OWNERS` + `canonicalOwner` in `we:scripts/lib/github-app-installations.mjs`, `we:scripts/lib/poc-branches.mjs`, `we:scripts/operations/land-advance.mjs`, `we:scripts/operations/record-verdict-io.mjs`, `we:scripts/conveyor/session-verdicts-io.mjs`, `we:scripts/broadcast-inject.mjs`. Each hardcodes `chalbert` and the current owner. A second move would need every one of them edited, and `canonicalOwner` would keep mapping old remotes to the now-wrong owner, which picks the wrong App installation token.

## Design

- Each repo entry gains `role` (`standard-web`, `web-impl`, `product`, later `delivery-core`), `owner`, `name`, and `previous: ['owner/name', ...]`. `slug` becomes derived (`owner/name`). Internal keys (`we`, `frontierui`, `plateau-app`) never change; ledgers already key on them.
- One alias function `currentSlug(anySlugOrKey)` answers for every old name in `previous`. Read both, write new: readers accept old slugs; nothing writes an old slug.
- `OWNER_INSTALLATIONS` stays keyed by owner, but the owner list is derived from the registry so adding an org is the same edit.
- Guard: a `check:standards` rule scans `scripts/`, `skills-src/`, `.github/`, `config/` for literal `<known-owner>/<known-repo>` slugs and known owners, outside the registry file and tests. It starts with an allowlist of the current hits (owned by the migration card) and refuses any NEW one.

## Acceptance

- [A1] **Executable** — `npm run check:standards` fails on a scratch file that adds a literal `web-everything/web-everything` under `scripts/`, and passes once the literal is replaced by a registry call. Test `guardScansAllLiveRoots` in `we:scripts/__tests__/check-standards-repo-slug-guard.test.mjs` runs the same check with a scratch literal under each of `scripts/`, `skills-src/`, `.github/` and `config/` and asserts each one fails, so the scanned roots are pinned (the empty-allowlist check in #5503 [A1] is only meaningful if batches 2 and 3 are scanned).
- [A2] Changing one entry's `owner` in the registry changes every derived slug, the alias table, and the owner list used for App installations; test `changingOwnerRederivesEverything` in `we:scripts/lib/__tests__/constellation-repos.test.mjs` proves it with a fake `everstandards` owner.
- [A3] `currentSlug('chalbert/web-everything')` and `currentSlug('web-everything/web-everything')` both return the current slug after a simulated move; an unknown slug returns `null` (fail closed, never a guess).
- [A4] The seven alias copies listed in Why delegate to the registry; no `chalbert` repo-owner literal remains in live code outside the registry's `previous` lists. The operator-login default `chalbert` in the marker-authorship module (a read-only reference, not edited here) is an account name, not a repo owner, so it is not an alias copy and the guard does not flag it (it stays, and #5503 does not need to change it). This card owns those alias-copy files (see scope); #5503 does not touch them.
- [A5] **Executable** — the guard's allowlist is the checked-in `we:scripts/lib/repo-slug-allowlist.json` with a `count` field equal to its entry count. Test `allowlistCountOnlyGoesDown` in `we:scripts/__tests__/check-standards-repo-slug-guard.test.mjs` fails when `count` differs from the entry count, and when `count` is higher than the value on the PR base (read with `git show <base>:<path>`).
- [A6] **Executable** — fail closed on a missing installation. Test `registeredOwnerWithoutInstallationIsRefused` in `we:scripts/lib/__tests__/gh-app-shim-refusal.test.mjs` registers a fake owner in the registry with no entry in the installation map and asserts the shim exits non-zero, writes the refusal to stderr, and never calls `gh` with a personal token. Test `unregisteredOwnerStillFallsBack` asserts an owner outside the registry keeps today's personal-auth fallback with its warning.
- [A7] **Executable** — rollback keeps both names readable. Test `rollbackPreservesBothSlugAliases` in `we:scripts/lib/__tests__/constellation-repos.test.mjs` simulates a move (owner A to owner B, A goes into `previous`) and then a rollback done as a forward edit (owner back to A, B added to `previous`), and asserts `currentSlug` resolves both slugs to A's slug after the rollback. The test accepts a slug that is both the current `owner`-derived slug and in `previous` (the state after a rollback). A second test, `previousOnlyGrows`, reads the registry file at the PR base with `git show <base>:<repo-relative path of we:scripts/lib/constellation-repos.mjs>` (same base lookup as A5) and fails if any slug in a base `previous` list is missing from the working tree's.

## Non-goals

- [N1] No call-site migration beyond the alias copies (that is #5503).
- [N2] No rename, no org creation, no plist or remote edits (that is #5504).
- [N3] plateau-app's own `plateau-app:scripts/lib/repo-slugs.mjs` and frontierui are out of scope here; the migration card files their follow-ups.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — PR bodies and remotes are parsed as data; a slug that is not in the registry is returned unchanged by `ghRepoSlug` validation, never mapped.
2. **Truncated reads** — n/a: the registry is a static in-repo module.
3. **Shared state files** — n/a: no state written; ledgers keep internal keys.
4. **Fail closed** — an unknown owner or slug returns `null` from `currentSlug` (see A3). For token minting, an owner that is declared in the registry but has no App installation is refused: the shim in `we:scripts/lib/gh-app-shim.mjs` exits non-zero instead of using the operator's personal credential (A6). Only an owner outside the registry keeps today's personal-auth fallback with a warning. This is the one rule #5504 relies on; both cards state it the same way.
5. **Identity scoping** — `previous` entries are per repo, so two repos that once shared an owner never collide.
6. **State over time** — `previous` only grows; old names stay readable forever because old ledger rows and transcripts carry them. A rollback is a forward registry edit, never a revert of the registry change (A7).
7. **Who wrote it** — n/a: no authored records.
