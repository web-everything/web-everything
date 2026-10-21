# Orchestrator operations

Run these from the checkout with `node scripts/operations/<command>`.
The handoff commands resolve their destination independently of cwd; use an absolute script path from elsewhere.
Companion commands run-fresh/referral-findings, lane-test, and overlay-status arrive in separate slices.

| Operation | Command | When to use | Replaces |
|---|---|---|---|
| Record referral ruling | `run-fresh.mjs record-referral-ruling --pr=N --repo=OWNER/REPO --finding=all-open --ruling=block --actor=LOGIN --channel=CHANNEL --reason='WORDS'` | Record the operator's ruling (PR “ops: run-fresh + referral-findings”) | Hand-posted ruling comments |
| Referral findings | `referral-findings-cli.mjs --pr=N` | Inspect findings before recording a ruling (same PR) | Grepping referral JSON/comments |
| Lane test | `lane-test-cli.mjs` | Run a lane's targeted checks through admission | Hand-typed lane/test setup |
| Overlay status | `overlay-status-cli.mjs --retire-contained --actor=LOGIN --reason='WORDS'` | Inspect overlays; retire those contained in main | Editing overlay state by hand |
| Alerts | `alerts-cli.mjs --follow --exclude-pr=5716,5717` | **Monitor command**; omit follow for `--since-min=30 [--json]` | `tail -F … \| grep … \| awk …` with fixed paths/dates and buffering traps |
| Handoff note | `handoff-note-cli.mjs --text='WORDS' [--at=ISO]` | Append one ET timestamped line; existing file required; never commits or pushes | `cd SCRATCH && echo '- HH:MM ET: …' >> HANDOFF` |
| Why | `run.mjs why --pr=N` | Diagnose a stuck PR | Reconstructing gates from comments and logs |
| Health snapshot | `run.mjs live-state` / `run.mjs daemon-status` / `run.mjs heavy-queue` | Inspect current queue, daemon health, and heavy admission | Hand-joined process/log/queue probes |
| Free scope | `run.mjs free-scope --files=PATHS` | Check whether proposed work overlaps | Hand-scanning active PR file lists |

Alerts follow mode starts at EOF and polls every **2 seconds**, so idle delivery can take up to
2 seconds. Every appended occurrence is emitted; file identity, byte offset and the rotator's
`.rot` counter prevent rereading and reset the cursor after rotation. One-shot mode groups
identical `(kind, text)` results into one line with a `×N` count (`count` in JSON).
Discovery uses the canonical needs-you `feedPath` resolver (including `WE_NEEDS_YOU_FEED`
and settings), and rebuild `alertsFilePath` resolver for timestamped `.alerts.jsonl` records.
Separate stderr paths are read directly from the plist: `extractDaemonSpec` exposes only a
single preferred log path, and there is no exported stderr-path resolver to reuse.

## Still manual (judgment)

Deciding rulings, granting rounds, approving, and choosing which overlay to load remain the operator's decisions.
The operator's words are always passed verbatim via `--actor`/`--reason` where those flags apply.
`extend-rounds` and `review-set-label` are not yet runnable through run-fresh:
they can start a detached prevention-card job.
