---
kind: story
size: 3
status: open
blockedBy: ["x8d6s6j"]
humanGate: { kind: setup, short: "Operator schedules the org move window.", what: "The operator picks the date and quiet window for moving web-everything to the everstandards org (and creating longshoreai for delivery). Until then this runbook stays held; clear the gate by setting the date on this card." }
scope: ["we:docs/agent/org-rename-runbook.md", "we:scripts/operations/rewrite-remotes.mjs", "we:scripts/operations/__tests__/rewrite-remotes.test.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# Org rename runbook: move Web Everything to everstandards and delivery to longshoreai without breaking the daemons

Write and later run the step-by-step runbook for the org move: quiet window, App install on the new org, registry one-line edit, remote rewrite for lanes and daemon clones, pr-events re-bootstrap, daemon smoke re-runs, and rollback. Stays held until the operator schedules the move.

## What GitHub redirects cover, and what they do not

- Covered: git fetch/push and REST calls by the old `owner/name` (after a rename or transfer).
- Not covered: GraphQL lookups by name (already bit us 2026-10-03), App installations (a transfer to a new org needs the App installed there: new installation id), org-level webhooks (stay with the old org), Actions secrets and variables at org level, and the old name once someone re-creates it (redirect then silently stops).
- Lanes and daemon clones today still use `chalbert/*` remotes (127 lanes + daemon clones), so a second move makes a two-hop redirect. Rewrite remotes, do not rely on it.

## Runbook outline (to be written in full)

1. Pre-flight (day before): registry + migration landed (#xdjrqkz, #x8d6s6j); guard green; install the GitHub App on `everstandards` and record its installation id; create org-level variables and secrets there.
2. Quiet window (about 1 hour, ET evening): stop dispatch intake (stand-down), let in-flight PRs settle, unload the `com.we.*` and `com.plateau.*` launchd jobs.
3. Move: transfer `web-everything/web-everything` to `everstandards`. Keep the old org and never create a repo under the old name: doing so silently ends GitHub's redirect.
4. One-line edit: the registry entry's `owner` (old slug goes into `previous`), plus the installation id in the owner map. Land via PR. Check before moving on: the minter now yields an App token for the new owner, and refuses (does not fall back to personal auth) if the installation id is missing, as #xdjrqkz requires.
5. Rewrite remotes: one script sets `origin` on every lane, daemon clone and primary checkout from the registry.
6. Re-point webhooks to the pr-events worker and re-bootstrap its projection for the new slug.
7. Smoke re-runs: load each daemon, run one pass of review, fix-dispatch, build-dispatch, drain, parked-pr-conflict-watch and lane-pool-health-watch; check each logs the new slug and an App token for the new owner; open and land one trivial PR end to end.
8. Rollback: transfer the repo back, then make a forward registry edit, never a revert of step 4's PR: set `owner` back to the old value and add the new slug to `previous` (`previous` only grows, so rows written under either name still resolve). Restore remotes with the same script, reload daemons. Check: `currentSlug` resolves both the old and the new slug to the restored slug.

## Acceptance

- [A1] **Executable** — a dry-run mode of the remote-rewrite step (`we:scripts/operations/rewrite-remotes.mjs`, in scope above) lists every clone it would change and exits non-zero if any clone's remote is not a registry slug or alias.
- [A2] The runbook names every step above with the command to run and the check that proves it worked.
- [A3] The smoke list covers every launchd label under `com.we.*` and `com.plateau.*`.
- [A4] **Manual rehearsal, recorded in the runbook** (not automated; it needs a real GitHub transfer) — rollback is tested once on a throwaway repo transfer before the real move. The test writes a record under the new slug before rolling back and, after the forward-edit rollback, reads records written under both the old and new slugs.
- [A5] **Executable** — the registry half of rollback is pinned by the test `rollbackPreservesBothSlugAliases`, which #xdjrqkz [A7] owns in its registry test file; this card edits no code for it and does not ship until that test is green on main.
- [A6] **Executable** — the remote-rewrite step is `we:scripts/operations/rewrite-remotes.mjs` with its test `we:scripts/operations/__tests__/rewrite-remotes.test.mjs`; the dry run of [A1] is the test's main case.
- [A7] The minter-refusal rule is owned and tested by #xdjrqkz [A6] (`registeredOwnerWithoutInstallationIsRefused`); the step 4 check and the step 7 smoke check that an App token for the new owner was used rely on it, and this card adds no code for it.

## Non-goals

- [N1] Not run until the operator schedules it (human gate).
- [N2] No change to internal repo keys, launchd labels, or directory names; only owners and slugs move.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: operator-run steps.
2. **Truncated reads** — the remote-rewrite dry run fails if it cannot read a clone's config.
3. **Shared state files** — daemons are unloaded before remotes change, so no daemon writes mid-rewrite.
4. **Fail closed** — the token minter refuses a registry owner without an installation instead of using the old one or personal auth; this is #xdjrqkz's rule, tested there by [A6] (see [A7] here). An owner outside the registry keeps today's personal-auth fallback and is not part of the move.
5. **Identity scoping** — each repo moves on its own; the runbook can move one repo at a time.
6. **State over time** — pr-events rows under the old slug are left readable; new rows use the new slug. After a rollback both slugs stay readable, because rollback is a forward edit that keeps the new slug in `previous` (step 8, [A4], [A5]).
7. **Who wrote it** — n/a.
