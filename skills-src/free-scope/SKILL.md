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
  `2` = unknown (a repo's open PRs could not be read in full; never treat that as free) or bad usage.
- The same check is a declared operation: `node scripts/operations/run.mjs free-scope --files=… [--card=…]`.

## Register and release (every worker)

```bash
node scripts/operations/free-scope-cli.mjs register --agent=<purpose> --owner=<token> --purpose="<what>" --files=<list> [--ttl-hours=4]
node scripts/operations/free-scope-cli.mjs release --agent=<purpose> --owner=<token>
node scripts/operations/free-scope-cli.mjs list
```

- `--owner` is a per-dispatch token (`worker-brief.mjs` mints one). Entries are keyed by agent name, so without it two
  workers sharing a slug would overwrite each other. With it, `register` exits `2` when a LIVE entry of that name belongs
  to a different owner, and `release` only removes an entry whose owner matches (`released 0` otherwise). Omitting
  `--owner` everywhere keeps the old name-only behaviour.

- The registry is `~/workspace/.operations/coordination/agent-scopes.json` (override: `WE_AGENT_SCOPES_PATH`).
  Entries past their TTL are ignored and listed as stale. They are never trusted, and never deleted by the check.
- `register` prints the check first. It still registers, but exits `1` when the scope is occupied, so stop and report.
- Release when done, success or failure. Once the PR is open, its files are covered by (a).

## Pre-push recheck

Right before `open-pr`, re-run the check while excluding yourself:
`check --files=<list> --exclude-agent=<purpose> --exclude-owner=<token>` (the owner narrows the exclusion to your own entry, so a same-named worker still shows as OCCUPIED; and `--exclude-pr=<N>` when re-pushing your own web-everything PR; `--exclude-pr=plateau-app#<N>` for a PR in another repo, since PR numbers repeat across repos).
If a repo has 200 or more open PRs, or any PR lists 100 files (the `gh` cap), the snapshot may be cut off. The verdict is `unknown`, never `free`, and every file not already held reads `UNKNOWN` (`state: "unknown"`, `free: false`) in the rows too.
If something new holds your files, stop and report. Do not push over it.

## Read only

Never close, relabel or edit a PR or registry entry that someone else holds. Report the holder and stop.
The standard worker brief (`node scripts/worker-brief.mjs`, skill `worker-brief`) already includes these steps.
