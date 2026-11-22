---
bornAs: x9mic7n
kind: story
size: 2
parent: "3383"
status: closed
closedReason: fixed-elsewhere
closedBy: "plan step DZ-RETIRE-WIP"
dateClosed: "2026-11-22"
scope: ["we:.claude/commands/wip.md", "we:scripts/bootstrap-session.mjs", "we:scripts/sync-commands-deploy.mjs"]
dateOpened: "2026-09-20"
tags: []
---

# The deployed /wip command is hand-edited and the source is stale: track it in source, deploy it from the bootstrap, and detect drift

The operator's `/wip` command is deployed by hand and the source does not describe it. Found 2026-09-20.

FOUND, AND WHERE. (1) The source copy, we:.claude/commands/wip.md (93 lines, on main), is the OLD command: a per-session table of Done, Doing, Next built from conversation history and ListAgents. (2) The deployed `wip` command file in the operator's home commands directory (11 lines, modified 2026-09-20 12:11) has been replaced by hand: a prompt that runs one foreground command, which fetches lane/mechanical-dispatcher into the personal clone named wev-wip-report under the workspace directory, and runs we:scripts/operations/wip-report-cli.mjs with `--stamp`, then prints the output verbatim. So the premise "the deployed command was not updated" is half wrong: it was updated in place, and it is the SOURCE that is stale. It contains no remedy vocabulary at all, so the wip-honest owed item "add the new remedy values to the command text" (`auto (runner down)`, `run: session-reaper`, `start: /conveyor`) does not apply to it; the vocabulary lives in the report code. (3) we:scripts/sync-commands-deploy.mjs with `--check` (read only) reports `DRIFT commands: ~1` and `STALE commands: 2 file(s) at the deploy target are not tracked in source — the two files named continue and handoff`, matching the bootstrap report. (4) THE RISK: the bootstrap's `commands` step (we:scripts/bootstrap-session.mjs line 239) runs we:scripts/sync-commands-deploy.mjs with `--all`, whose `update` action copies the source file over the deployed one (`copyFileSync` in we:scripts/sync-skills-deploy.mjs `applyPlan`). The next `npm run bootstrap install` would therefore overwrite the operator's working `/wip` with the 93-line old version. Not run to confirm; read from the code. (5) The report CLI we:scripts/operations/wip-report-cli.mjs is on lane/mechanical-dispatcher only, not on main, and the deployed command hard-codes the path of a personal clone plus a node_modules symlink into another lane (`lane-54`). (6) The command files named continue and handoff are deployed but not tracked in source; they are the two "stale" files. Untracked deployed files are only ever reported; deleting them needs `--prune`.

DESIGN TO SETTLE.
1. Source of truth: make we:.claude/commands/wip.md the report runner, tracked and deployed by the bootstrap, so the deployed file equals the source. The old session-table wording needs a new home or is dropped: it overlaps `/status` (we:.claude/commands/status.md), so recommendation is to drop it; the operator decides.
2. The command must not hard-code a personal clone. Options: run the CLI from the checkout the session is in (fails while the CLI is branch-only), or wait for the CLI to graduate to main (#3443) and then run it from any current checkout. Decide the interim.
3. Track the continue and handoff commands in source, or delete them from the deploy target with `--prune`, so the bootstrap reports no stale commands.
4. Drift detection: `--check` already exits 1 on drift. Decide whether the bootstrap's report also fails loudly (today it says `drift` and carries on), and whether a hand edit of a deployed command gets a warning before the next deploy overwrites it.
5. Once tracked (point 3), the continue and handoff commands must READ state and not name it. See the added finding below.

ADDED 2026-09-20 (deployed session commands name state that goes stale; folded here instead of filing a sibling card, because point 3 already covers tracking the two files and the fix belongs in the same source edit). Found by reading the deployed files: the /continue command (2349 bytes, modified 2026-09-20 08:35) says "Prototype PR = #1853"; `gh pr view 1853` reads state CLOSED, closedAt 2026-09-19T21:21:10Z, mergedAt null, so it names a pull request that was closed unmerged. It also says "PR #2334 has merged" and names lane-54 as the clone to run the reaper and the operator queue from ("its HEAD must equal origin/main"). The /handoff command (1170 bytes, modified 2026-09-19 20:40) names lane-54 too. The /continue text also lists about eight commands by hand, which the start-of-session state pass card (filed alongside) would replace with one. Design for point 5: each name that changes is read, not written: the prototype pull request and branch from the tracker card or `gh`, the lane from the lane pool (which the clone-sync card filed alongside also covers), the reaper as an explicit operation call. Sequence: this card tracks the two files as they are, which stops the STALE report; #3759 changes their format together with the handoff writer; the state pass card then replaces the command lists. Overlaps #3759 (it brings the same two files into source for the id rule).

## Done when

1. **Executable** — `we:scripts/sync-commands-deploy.mjs` run with `--check` prints no `DRIFT` line and no `STALE` line. Before (2026-09-20): `DRIFT commands: ~1` and `STALE commands: 2 file(s) ... not tracked in source`.
2. **Executable** — the deployed `wip` command file equals `we:.claude/commands/wip.md` byte for byte (`cmp` exits 0).
3. **Executable** — `npm run bootstrap:check` reports the `commands` line as ok, with no stale-commands line. (Not run in this filing; the exact line comes from the bootstrap's own output.)
4. **Executable** — a test with a scratch deploy directory (the `WE_COMMANDS_DEPLOY_DIR` override in `we:scripts/sync-commands-deploy.mjs`) shows that a hand-edited deployed command is reported as drift, and, if the design chooses a warning, that the warning comes before the deploy overwrites it.
5. **Human verify** — typing `/wip` in a session prints the report, from a checkout that is not the personal clone the hand-edited command uses today.
6. **Executable** — a test scans the tracked continue and handoff command files in source and fails on a hard-coded pull request number (`#` followed by digits used as a state claim) or a lane number (`lane-` followed by digits). Before (2026-09-20): the deployed /continue names #1853 and lane-54, and /handoff names lane-54.

## Finding 2026-09-21 — source tracking landed (PR #2360), the card stays open for the rest

PR #2360 (merge commit 2866bdfcc, 2026-09-21) delivered the source-tracking half. Checked against origin/main on 2026-09-21:

- Done-when 1, 2, 3 hold. `node we:scripts/sync-commands-deploy.mjs --check` exits 0 with "in sync — 1 command(s) checked, no drift" and no `STALE` line. `cmp` of we:.claude/commands/wip.md, we:.claude/commands/continue.md and we:.claude/commands/handoff.md against the deployed files exits 0 for all three. `npm run bootstrap:check` prints "ok commands ✓ in sync — 1 command(s) checked, no drift" (its exit 1 that day is the unrelated `gitdir` grant line).
- Done-when 4 holds for the drift half: we:scripts/__tests__/sync-commands-deploy.test.mjs runs the real CLI against a scratch `WE_COMMANDS_DEPLOY_DIR` (13 tests pass) and proves a hand edit exits 1 with `DRIFT` and an untracked command exits 1 with `STALE`. The optional warning before a deploy overwrites a hand edit was not built (the PR body: the deploy cannot tell a hand edit from an older source without a stamp of the last deploy).
- Done-when 5 was verified by the operator on 2026-09-21: typing `/wip` prints the report from a checkout that is not the personal clone (reported to the closeout session in its task brief; the operator's own words are not quoted here).
- Done-when 6 is NOT met. The tracked we:.claude/commands/continue.md still says "Prototype PR = #1853" and "PR #2334 has merged" and names `lane-54`; the tracked we:.claude/commands/handoff.md still names `lane-54`; no test scans them. Those two files were tracked byte for byte, as deployed, with the text unchanged.

Remaining before this card can resolve: the state-naming cleanup and its scan test (Done-when 6), and the choice on the pre-overwrite warning (design point 4). The hard-coded personal clone in we:.claude/commands/wip.md goes away when the report CLI graduates to main (#3443, PR #2360 "Owed").

Superseded 2026-11-22 by plan step DZ-RETIRE-WIP (Fix lives in /wip publisher code that DZ-RETIRE-WIP removes. Reopen only if /wip stays past W12.) [PL-WIP-CLEANUP / plateau rulings].
