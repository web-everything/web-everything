---
name: prototype-load
description: Load a green+audited daemon fix onto a daemon's prototype (overlay) through the one declared operation. Use when a fix or debug branch is tests-green and Codex-audited NOT WEAKENED and must go live on a daemon (review, fix, build, verify, health-watch, drain, lease-reaper) before its PR lands. Never hand-build combined tops, never remove registrations first.
---

# prototype-load

When a fix is green + audited, run this. Never hand-build or re-test a combined top.

```bash
node scripts/operations/run.mjs prototype-load --branch=lane/<x> --sha=<tip sha> --daemon=<name> --dry-run --json   # look first
node scripts/operations/run.mjs prototype-load --branch=lane/<x> --sha=<tip sha> --daemon=<name> --why="<reason>" --json
```

If there is no ready record for the sha (`~/workspace/.operations/coordination/fix-ready.jsonl`), pass `--tests-run=<id> --audit="NOT WEAKENED"` instead.

What it does, in order, stopping at the first failure (`stopReason`):
1. Resolves the daemon to its clone from `scripts/settings/prototype-load.json` (plist WorkingDirectory, with an override for drain's code clone). The source is printed.
2. Gate: ready record for that exact sha, else refuses `no-ready`.
3. Keeps main intact: a branch behind main is merged onto main and pushed as `<branch>-m<N>`. Conflicts stop as `behind-main-conflict`; a diff that touches more than the branch's own files stops as `reverts-main`.
4. Checks against the clone's current registrations with the loader's `add --check`. A registration that conflicts with main is reported as `stale-registration: <name>`; the cure is a rebuilt replacement that contains it (swap), never a removal alone.
5. Registers the new overlay through `scripts/daemon-overlay.mjs` only. Never `--allow-conflict`, never an operator credential.
6. Waits (bounded) for the daemon clone to adopt the sha, and reads the rebuild alerts for refusals.
7. Swap: removes the registrations the new overlay contains only after the daemon adopted it. A refused, timed-out or unverifiable adoption keeps them, and the result names them.
8. Appends one line to `~/workspace/.operations/coordination/prototype-loads.jsonl` and prints `{ok, daemon, clone, registered, adopted, stopReason}`.

On `behind-main-conflict`: have Codex resolve the conflict, re-run only the touched test files, write a fresh ready record, then run again. Do not re-test anything else.

See [prototype-based-dev.md](../../docs/agent/prototype-based-dev.md#loading-a-fix-on-a-daemon-prototype-prototype-load).
