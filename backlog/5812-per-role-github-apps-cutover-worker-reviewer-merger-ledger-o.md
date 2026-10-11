---
bornAs: x16g3q5
kind: story
size: 5
status: open
humanGate: { kind: setup, what: "operator creates + installs the 5 Apps (DONE 2026-10-10, IDs below), then confirms each App's private-key keychain item name, applies the main and ops/** rulesets, and uninstalls the old Web Everything App" }
scope: ["we:scripts/settings/delivery-identity.json", "we:scripts/lib/github-app-identity.mjs", "we:scripts/lib/github-app-auth-env.mjs", "we:scripts/lib/gh-app-shim.mjs"]
dateOpened: "2026-10-10"
tags: [github-app, identity, ruleset, cutover]
---

# Per-role GitHub Apps cutover: worker, reviewer, merger, ledger, observer

Operator decision 2026-10-10 ~5:55 PM ET: five new GitHub Apps replace today's shared Web Everything App (an App slug and bot login cannot be renamed). The code is prepared so each role switch is a setting: delivery.identity.<role> in we:scripts/settings/delivery-identity.json, resolved by we:scripts/lib/github-app-identity.mjs, used by we:scripts/lib/github-app-auth-env.mjs and the gh shim we:scripts/lib/gh-app-shim.mjs, with loud fallback role -> worker -> today's App reported by the github-app-config smell. Merges and replaces #5773 (merger App) and #5774 (reviewer App).

## The five roles and who plays them

Role = explicit argument > env `WE_GITHUB_APP_ROLE` > caller map (`DEFAULT_CALLER_ROLES` in we:scripts/lib/github-app-identity.mjs, overridable as `delivery.identity.callerRoles`) > worker.

| Role | Plays it | Bot login |
|---|---|---|
| worker | builders, fixers, ci-heal, every unlisted caller, and the write-capable watchers (stuck-pr-watch, parked-pr-*-watch, ci-red-recovery-watch, advisory-label-sweep, duplicate-pr-watch, health-responder) | plateau-worker[bot] |
| reviewer | review-daemon, review-pr, review-set-label, review-prep (and the sessions they dispatch) | plateau-reviewer[bot] |
| merger | the drain (merge-ai-prs) and the merge-orphan-sweep pass | plateau-merger[bot] |
| ledger | every ops/** write (all git calls in we:scripts/lib/git-transport-branch.mjs worktrees), record-verdict, collect-review-requests, stage/produce-pr-view, handoff-home, ledger-backfill-rulings | plateau-ledger[bot] |
| observer | health-watch, coroner, operator-queue, live-state / WIP, review-hold-ledger-shadow, lane-pool-health-watch, ci-queue-watch, pr-movement-sweep, github-app-status | plateau-observer[bot] |

Bot logins are a guess at the slugs; confirm on github.com and set `botLogin` per role (they feed `delivery.botLogins`, the trusted-marker list).

## Permission table (no App has admin)

| Permission | Worker | Reviewer | Merger | Ledger | Observer |
|---|---|---|---|---|---|
| contents | RW | R | RW | RW (ruleset limits writes to ops/**) | R |
| pull requests | RW | RW | RW | R | R |
| issues | RW | RW | RW | – | R |
| checks | R | R | R | – | R |
| statuses | R | R | R | – | R |
| actions | RW | R | R | – | R |
| workflows | W | – | W | – | – |
| merge queues | – | – | RW (only if #4717's strategy is on) | – | R |
| webhooks/events | – | – | – | – | the 8 event-stream events |
| administration | none | none | none | none | none |

The code checks each role's App against `ROLE_REQUIRED_PERMISSIONS` before using it; a missing permission is a loud fallback, never a silent one.

## Rulesets

- **main**: only Merger + the operator (emergency) on the bypass list. Every other App and the operator's SSH key are refused.
- **ops/\*\***: only Ledger + the operator may update.

## Installed Apps (created 2026-10-10 by the operator, verified via the org installations API)

| Role | App ID | web-everything | plateauapp | frontier-ui |
|---|---|---|---|---|
| worker | 5267514 | 170085944 | 170085924 | 170085905 |
| reviewer | 5267537 | 170085874 | 170085861 | 170085845 |
| merger | 5267489 | 170085807 | 170085790 | 170085775 |
| ledger | 5267551 | 170085739 | 170085724 | 170085702 |
| observer | 5267580 | 170085659 | 170085627 | 170085606 |

Setting shape for one role (the key is a REFERENCE, never key material; keychain item names still to be confirmed):

```json
{ "delivery": { "identity": {
  "reviewer": { "appId": "5267537",
    "installations": { "web-everything": "170085874", "plateauapp": "170085861", "frontier-ui": "170085845" },
    "key": { "keychain": { "service": "<keychain item name>" } },
    "botLogin": "plateau-reviewer[bot]" }
} } }
```

## Cutover (4 steps)

1. **Prep (done, this PR).** Per-role setting + cascade, role-aware token minting and gh shim, loud fallback + smell, `delivery.botLogins`, ledger role on ops/** writes, and a dry-run CLI (`node` we:scripts/lib/github-app-identity.mjs `--caller=<name>`).
2. **Operator (HUMAN GATE).** Create + install the 5 Apps (DONE). Confirm each private key's keychain item name (or file path). Never paste a key into a setting or a chat.
3. **Switch one role at a time, reviewer → worker → merger** (then ledger, observer). For each: add the role block to we:scripts/settings/delivery-identity.json; reload that role's daemon (launchctl bootout + bootstrap); prove it: we:scripts/conveyor/github-app-status.mjs shows the caller `applied: true, role: <role>` with no `fallback`; the next comment/label/merge on a real PR is authored by the role's bot (`roleOfBotLogin(author.login)` = the role); the github-app-config smell stays closed. A failure falls back loudly to worker, then today's App, so the fleet keeps working.
4. **Rulesets + retire.** Apply the main ruleset (Merger + operator bypass) and the ops/** ruleset (Ledger + operator). Move the drain's direct main pushes (JIT numbering, resolve-on-land) and the ops/** transport pushes from the operator's SSH key to HTTPS with the Merger / Ledger token, or SSH stays a second writer (the ruleset's operator bypass hides it). Then uninstall the old Web Everything App and drop `web-everything[bot]` from `delivery.botLogins` only after no open PR still carries its markers.

## Acceptance

- [A1] **Executable** — `npm run test:unit --` with we:scripts/lib/__tests__/github-app-identity.test.mjs passes (step 1; it fails before the prep PR because the module does not exist).
- [A2] Per switched role: the dry-run CLI for a caller of that role prints `→ <role> App <appId>` with no `FALLBACK`, and the live proof in step 3 holds.
- [A3] After step 4: a merge to main by any identity other than Merger is refused by GitHub on a test PR; an ops/** push by anything but Ledger is refused.

## Non-goals

- [N1] No live switch in the prep PR: every role stays on today's App until its block is added to the settings file.
- [N2] Webhook/event-stream wiring for the Observer App is its own card.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — a comment body can never claim a role: trust is `author.login` against `delivery.botLogins` only.
2. **Truncated reads** — n/a: the identity setting is a small local JSON file; an unreadable file falls back to today's App.
3. **Shared state files** — each role App has its own token cache (`web-everything.app-<appId>.<installation>.json`), written atomically; the shared status file keeps reporting today's App only.
4. **Fail closed** — an unconfigured, invalid, unreadable-key, failed-mint or under-permissioned role falls back role → worker → today's App with a loud log and a smell breach; an inline key in a setting is refused.
5. **Identity scoping** — each role's App is atomic in the cascade (layers never mix one App's ID with another's key); installations are per owner.
6. **State over time** — a role switch is a settings change plus a daemon reload; reverting the block reverts the role.
7. **Who wrote it** — `roleOfBotLogin` names which role's App posted; reviewer independence still rests on the session id (we:scripts/lib/review-independence.mjs), not on logins.
