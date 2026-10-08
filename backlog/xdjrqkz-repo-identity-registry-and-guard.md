---
kind: story
size: 5
status: open
scope: ["we:scripts/lib/constellation-repos.mjs", "we:scripts/lib/github-app-installations.mjs", "we:scripts/check-standards-rules.mjs", "we:scripts/lib/__tests__/constellation-repos.test.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# Repo identity registry: one declared setting for every constellation org/repo slug, plus a guard against new hardcoded slugs

Operator decision 2026-10-08: orgs will become everstandards (standards), frontier-ui, longshoreai (delivery open core), plateauapp. Nothing moves now. Make a later org or repo rename a one-line change: extend CONSTELLATION_REPOS into a role-keyed registry with owner, name and previous names, fold the scattered chalbert alias maps into it, and add a check:standards rule refusing new hardcoded slugs outside it. Full inventory is in the operator handoff note plan-repo-slug-setting.

## Why

The registry half-exists already: `we:scripts/lib/constellation-repos.mjs` (`CONSTELLATION_REPOS`, `canonicalizeSlug`, `ghRepoSlug`) is the one key-to-slug map most code uses. But the last move (chalbert to orgs, 2026-10-03) was handled with at least six separate "old name to new name" copies: `canonicalizeSlug`, `MOVED_REPO_OWNERS` + `canonicalOwner` in `we:scripts/lib/github-app-installations.mjs`, `we:scripts/lib/poc-branches.mjs`, `we:scripts/operations/land-advance.mjs`, `we:scripts/operations/record-verdict-io.mjs`, `we:scripts/conveyor/session-verdicts-io.mjs`, `we:scripts/broadcast-inject.mjs`. Each hardcodes `chalbert` and the current owner. A second move would need every one of them edited, and `canonicalOwner` would keep mapping old remotes to the now-wrong owner, which picks the wrong App installation token.

## Design

- Each repo entry gains `role` (`standard-web`, `web-impl`, `product`, later `delivery-core`), `owner`, `name`, and `previous: ['owner/name', ...]`. `slug` becomes derived (`owner/name`). Internal keys (`we`, `frontierui`, `plateau-app`) never change; ledgers already key on them.
- One alias function `currentSlug(anySlugOrKey)` answers for every old name in `previous`. Read both, write new: readers accept old slugs; nothing writes an old slug.
- `OWNER_INSTALLATIONS` stays keyed by owner, but the owner list is derived from the registry so adding an org is the same edit.
- Guard: a `check:standards` rule scans `scripts/`, `skills-src/`, `.github/`, `config/` for literal `<known-owner>/<known-repo>` slugs and known owners, outside the registry file and tests. It starts with an allowlist of the current hits (owned by the migration card) and refuses any NEW one.

## Acceptance

- [A1] **Executable** — `npm run check:standards` fails on a scratch file that adds a literal `web-everything/web-everything` under `scripts/`, and passes once the literal is replaced by a registry call.
- [A2] Changing one entry's `owner` in the registry changes every derived slug, the alias table, and the owner list used for App installations; a unit test proves it with a fake `everstandards` owner.
- [A3] `currentSlug('chalbert/web-everything')` and `currentSlug('web-everything/web-everything')` both return the current slug after a simulated move; an unknown slug returns `null` (fail closed, never a guess).
- [A4] The six alias copies listed in Why delegate to the registry; no `chalbert` literal remains in live code outside the registry's `previous` lists.
- [A5] The guard's allowlist is a checked-in list with a count; the count can only go down.

## Non-goals

- [N1] No call-site migration beyond the alias copies (that is #x8d6s6j).
- [N2] No rename, no org creation, no plist or remote edits (that is #xmkjis9).
- [N3] plateau-app's own `plateau-app:scripts/lib/repo-slugs.mjs` and frontierui are out of scope here; the migration card files their follow-ups.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — PR bodies and remotes are parsed as data; a slug that is not in the registry is returned unchanged by `ghRepoSlug` validation, never mapped.
2. **Truncated reads** — n/a: the registry is a static in-repo module.
3. **Shared state files** — n/a: no state written; ledgers keep internal keys.
4. **Fail closed** — unknown owner or slug returns `null`; the token minter then falls back to personal auth with a warning (today's behaviour).
5. **Identity scoping** — `previous` entries are per repo, so two repos that once shared an owner never collide.
6. **State over time** — `previous` only grows; old names stay readable forever because old ledger rows and transcripts carry them.
7. **Who wrote it** — n/a: no authored records.
