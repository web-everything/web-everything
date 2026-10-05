---
name: free-scope
description: Check whether a set of files is FREE to work on — no open PR (web-everything or plateau-app) and no running agent's declared scope touches them — and register or release your own scope in the shared agent-scope registry. Use before dispatching or starting any build ("is this scope free?", "does anything touch these files?", "check scope before I start", "free-scope check for card X"), as the pre-push recheck right before open-pr, and when a worker starts or finishes ("register my scope", "release my scope"). Read-only check plus two small registry writes; it never cancels, edits or closes anything it finds.
---

# Free-scope check (operator handoff rules 21 and 26)

"Free scope" means no overlap with (a) any OPEN PR's files in `web-everything/web-everything` or
`plateauapp/plateau-app`, AND (b) the declared target files of every agent still running without a PR.
The script decides it. Do not eyeball `gh pr list` yourself.

## Check

```bash
node scripts/operations/free-scope-cli.mjs check --files=we:scripts/a.mjs,plateau-app:src/b.ts
node scripts/operations/free-scope-cli.mjs check --card=<NNN or xHASH>     # uses the card's `scope:`
```

- Bare paths are read as `we:`. A trailing `/`, a glob, or an extensionless last segment is a whole subtree.
- Exit `0` = all free, `1` = occupied (each line names the PR number or the agent holding it),
  `2` = unknown (a repo's open PRs could not be read; never treat that as free) or bad usage.
- The same check is a declared operation: `node scripts/operations/run.mjs free-scope --files=… [--card=…]`.

## Register and release (every worker)

```bash
node scripts/operations/free-scope-cli.mjs register --agent=<purpose> --purpose="<what>" --files=<list> [--ttl-hours=4]
node scripts/operations/free-scope-cli.mjs release --agent=<purpose>
node scripts/operations/free-scope-cli.mjs list
```

- The registry is `~/workspace/.operations/coordination/agent-scopes.json` (override: `WE_AGENT_SCOPES_PATH`).
  Entries past their TTL are ignored and listed as stale. They are never trusted, and never deleted by the check.
- `register` prints the check first. It still registers, but exits `1` when the scope is occupied, so stop and report.
- Release when done, success or failure. Once the PR is open, its files are covered by (a).

## Pre-push recheck

Right before `open-pr`, re-run the check while excluding yourself:
`check --files=<list> --exclude-agent=<purpose>` (and `--exclude-pr=<N>` when re-pushing your own PR).
If something new holds your files, stop and report. Do not push over it.

## Read only

Never close, relabel or edit a PR or registry entry that someone else holds. Report the holder and stop.
The standard worker brief (`node scripts/worker-brief.mjs`, skill `worker-brief`) already includes these steps.
