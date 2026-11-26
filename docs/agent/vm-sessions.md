# Working from a cloud VM (Claude Code on the web)

A session started from claude.ai/code, the mobile app, or `claude --cloud` runs in an **ephemeral,
Anthropic-managed container**, not on the workstation. The instruction layer travels there unchanged —
`AGENTS.md` is committed, so the rules load — but almost everything the laptop setup assumes about the
*machine* is false. This page is the delta. Read it when `bootstrap-session` reports `host: ephemeral`.

**One command sets the machine up:** `node scripts/bootstrap-session.mjs`. It is idempotent and host-aware.
On an ephemeral VM it applies and registers itself as a `SessionStart` hook, so the next session in the same
container does it unasked; on a workstation it only reports (see *Installing on a workstation*).
`--dry-run` shows the plan, `--check` reports drift without writing.

## What is different, and why

| | Laptop | Cloud VM |
|---|---|---|
| Clones | full history | **`--depth 1` shallow** (`rev-parse --is-shallow-repository` → `true`) |
| Sibling repos | already siblings on disk | arrive via the harness `add_repo` tool, then a clone |
| Lanes | the clone pool is the unit of work | **still the unit of work — provision one; no overrides needed since #3265** |
| Branch guard | installed at user level (#3074) | user-level one not installed; the **committed** `guard-lane.mjs` hook fires regardless |
| `$HOME` vs checkouts | both under `~/workspace` | **`$HOME=/root`, checkouts under `/home/user`** — derived from the checkout, not `$HOME` |
| Skills | `~/.claude/skills` synced, scoped | deployed with `--all` (nothing else lives there) |
| Memory | reserved lane → user-level dir (#2350) | in-repo `.claude/agent-memory` |
| Uncommitted work | survives indefinitely | **lost when the VM is reclaimed** |

## The rules that only apply here

**A fix that lives only on this box is not a fix.** The container is disposable, so anything you change
*about the machine* — a `git config`, an env var, a symlink, an `npm install`, a `~/.claude` edit — is gone
on the next session and every session after it. Doing it and moving on feels like resolution and produces
none: the next agent hits the identical wall, with no trace that anyone met it before.

So a machine-level problem is only handled when its fix is in one of three durable homes:

| the fix is… | it belongs… |
|---|---|
| derivable by the repo's own tooling | in the tooling (`bootstrap-session.mjs`, `lane-pool.mjs`) — computed, not typed |
| a rule an agent must follow | in a **hook** if it is script-decidable, else in the doc a reader actually opens mid-task |
| outside every repo (`~/.claude`, the harness, GitHub settings) | a backlog item naming it as the operator's, since no PR here can reach it |

The box-local change is still fine as the *immediate unblock* — take it, then land the durable half in the
same session. What is never fine is stopping at the unblock and reporting the problem solved.

Observed repeatedly on 2026-08-24: a `webeverything` symlink, a `LANE_POOL_ROOT` export, three `npm ci`s and
a `git config user.email` were all applied by hand and all evaporated; the two that mattered
([#3265](../../backlog/3265-lane-pool-root-and-shallow-reference-deadlock-a-cloud-vm.md), the alias) only
stopped recurring once they moved into `lane-pool.mjs` and `bootstrap-session.mjs`.

**Push early, push often — this is the one that bites.** The container is reclaimed after a period of
inactivity and the filesystem goes with it; only the conversation is restored. Everything the laptop
learned about lanes being wiped mid-work ([[shared-pool-lane-unsafe-for-manual-work]],
[[lane-refresh-wipes-unmapped-lanes]]) applies here with a blunter cause: there is no refresher to blame,
the whole box goes. A WIP commit pushed to a `lane/*` ref is durable; a working tree is not.

**You still work in a lane here — provision one.** This page used to say the opposite ("no guard to dodge,
so a pool buys nothing"), and that was wrong in a way that DEADLOCKS the box: `guard-lane.mjs` is registered
in the **committed** `.claude/settings.json` `PreToolUse` hooks, so it ships with the repo and denies every
`Edit`/`Write` to a primary checkout on a VM exactly as on a laptop. With no pool there is then no writable
surface at all — the primary is guarded and no lane exists. `#primary-read-only-lanes-only` is not relaxed
here; only the *reasons* the laptop provisions a pool are.

One command, no overrides, no environment to export:

```bash
node scripts/lane-pool.mjs provision --count=2
```

Two lanes, not one: `review-pr`'s juror is tool-bearing and `assertLaneCwd` refuses to spawn it into the
lane you are driving from (#3151), so a review needs a second one.

**This block used to prescribe two hand-overrides — `fetch --unshallow` on every checkout, and an
`export LANE_POOL_ROOT=…`. Both are gone; do not do either.** They were the box-local unblocks from the
2026-08-24 session, and #3265 moved them into `lane-pool.mjs` where the table above says they belong:

- the pool root now derives from `git rev-parse --show-toplevel`, not from `$HOME`, so the `/root` vs
  `/home/user` split resolves correctly with nothing set;
- `--reference` is DROPPED when the source clone is shallow, rather than passed and killing the clone with
  `fatal: reference repository '<path>' is shallow`.

Unshallowing still has its own reason to happen — see *Unshallow before any history work* below — but it is
no longer a precondition for provisioning a pool, and paying for it up front on every VM was waste.

The convergence half is unchanged: the transport to `main` is still the PR (`/pr`, `/drain`). What IS
different is that `gh` has no credential here, so `open-pr` and `review-pr` halt at their `submit`/`record`
effects and hand back a plan — submit it through whatever channel does hold one, and re-apply the park label
by hand, per the `/pr` skill's fallback (it is two calls, and the second is not optional).

## Landing work from a VM — the whole arc

The pieces are documented separately (`/pr`, `/review`, [delivery-loop.md](delivery-loop.md)) and each is
correct; what nobody had written down is the ORDER, and which steps behave differently here. Every step below
is the declared operation — never a hand-rolled `gh pr create`, never the connector as a first move.

```bash
# 1. Work in a lane, commit there, publish to a lane/* ref (NEVER a local branch — the #1934 carve-out).
git push origin HEAD:refs/heads/lane/<slug>

# 2. Decide the PR through the operation. It HALTS at `submit` (no gh credential) and returns its plan.
node scripts/operations/run.mjs open-pr --ref=lane/<slug> --title="…" --bodyFile=<path> --json

# 3. Submit that plan's argv, unedited, through the channel that holds a credential. See the losses below.
# 4. Review it. `--cwd` is a lane of the juror's OWN — never the one you are driving from (#3151).
#    The view comes from CI, NOT from this session (#3268): `--fromTransport` pushes a {repo, pr} request to
#    `ops/pr-views`, waits ~1-2 min for the `Stage PR view` workflow to commit the `gh pr view --json` answer
#    back, and reads it out of the fetched ref. `--from=<file>` is REFUSED here — a session that supplies the
#    view supplies the evidence its own juror reads, which is how PR #1542 got a fabricated OWNER comment.
node scripts/operations/run.mjs stage-pr-view --pr=<N> --repo=<owner/name> --fromTransport --dir="$WE_PR_VIEW_DIR"
node scripts/operations/run.mjs review-pr --pr=<N> --repo=<owner/name> --cwd=<the OTHER lane> --json
```

**The `confirm` step is addressed to you.** `review-pr` stops with `"of": "agent"` and three options
(`accept | changes | abstain`); answering it via `--resume=<run-id> --answer=<option>` is the flow working, not
an overreach. What the operation never does is MERGE — `#2290` makes the drain the sole writer to `main` — so
running a review is always in bounds. Whether YOUR accept may release the PR is the separate question below.

### What the credential-less fallback silently drops

`pr-land.mjs` does two things besides calling `gh`, and a connector-created PR gets neither. The first is
documented in the `/pr` skill; the second is not, and it is the one that matters.

1. **The park label.** `--park=review:pending` is in the plan's argv, but a create-PR API call has no label
   parameter. Apply it as a SECOND call and re-read the PR to confirm it stuck, per PR, as each is created.
2. **The `authored-by-actor` stamp** (`pr-land.mjs#withAuthorStamp`, #2844) — and, through it, the whole
   guarded label path. The stamp is the INPUT to the self-clear refusal:
   `we:scripts/lib/review-independence.mjs` compares the clearer's `CLAUDE_CODE_SESSION_ID` against it.

   A stampless PR is **not** merely tolerated: since #3067, `we:scripts/review-set-label.mjs` passes
   `prCreatedAt` / `stampLostMarked` into `decideClearerIndependence`, so a PR opened after the stamp-regime
   start resolves to `STAMP_LOST` and is REFUSED. The guard is armed.

   The problem is that on this host it never runs. `record`'s label swap goes through
   `we:scripts/review-set-label.mjs` — the single home (#2644) that owns the independence check, the
   `reviewed-sha` / `reviewed-diff` / `reviewed-contribution` markers and the #2964 write ordering — and that
   call needs `gh`. Swapping the label through the connector instead does not weaken one guard; it steps
   around **all of them at once**. The refusal that would have fired never gets the chance to.

   So treat a hand-applied label as unguarded by construction, not as a check that happened to pass. Prefer a
   genuinely independent verdict — `review-pr` mints its juror a fresh session id, which is what independence
   means here ([delivery-loop.md](delivery-loop.md#spawning-a-reviewer-that-is-actually-independent) — *a
   subagent is not a second actor; a headless process is*) — and say plainly, when you record it, that the
   swap bypassed the single home. #3267 is the fix.

### When an effect halts with its outcome UNKNOWN

`record`'s `review.label-swap` calls `gh`, so it fails here mid-step. It is not declared idempotent, so the
engine REFUSES to replay it rather than risk a double-apply:

```
effect …#4#1 (review.label-swap) was attempted and its outcome is UNKNOWN — it is not declared
idempotent, so replaying it could double-apply. Refusing. Resolve it by hand … and re-run.
```

After verifying the live PR, reconcile through the sink's read-only evidence check:

```sh
node scripts/operations/review-loop-cli.mjs --resume=<run-id> --settle-applied --actor=<actor> --reason="verified orphan comment"
```

The command refuses incomplete evidence and never re-sends the label effect. Legacy unstamped accepts
require exactly one trusted accept comment on the reviewed head created at or after the saved last attempt.
Successful reconciliation records the actor and reason. If proof fails, inspect the full thread and hold
for operator intervention; do not hand-edit the run status.

**Unshallow before any history work.** `git log`, `blame`, `bisect`, and anything that walks back past
HEAD need `git fetch --unshallow` first. Cheap to do, silently wrong to skip.

**Siblings are attached, not cloned.** `bootstrap-session` reports which of the constellation are missing
but never fetches them: private repos are cloned through a credential proxy that deliberately keeps
credentials out of the sandbox, so the harness's `add_repo` tool is the only route. Attach, clone, then
re-run the bootstrap.

**Nothing repoints the memory symlink.** The reserved memory lane (#2350) is the laptop's arrangement and
its repoint is human-gated. Here, `check-memory.mjs` and `memory-resolve.mjs` both fall back to the
tracked in-repo `.claude/agent-memory`, so `/note` and `[[slug]]` links resolve with no setup — and
memory written in a VM lands in `agent-memory-src`, where a commit makes it durable.

## This is not the final home

The bootstrap lives in WE today because that is where the lane and delivery machinery is dogfooded, not
because WE is the constellation's hub. It is not: WE is a **public peer**, and the machinery is Plateau's
product, so it moves there eventually. Nothing here is written to assume otherwise —
`bootstrap-session.mjs` derives which checkout it is in rather than declaring it, and takes the
constellation from `scripts/lib/constellation-repos.mjs` rather than a local list. Its `locus:` line reports
what it decided. It does NOT look up the skills CLI in siblings — an earlier cut did, and that was a
cross-repo code-execution path a `/converge` panel rejected; the relocation ordering it bought belongs to
the multi-project registry (#2472), not to a search-and-execute.

Two WE-as-hub assumptions do remain, both in that shared table and both flagged there: `we: { path: '' }`
("the WE primary's own cwd") and `DEFAULT_REPO_KEY = 'we'`. They are the seam the move pulls on, and they
belong to `review-runner.mjs`, not to this bootstrap.

## Installing on a workstation

`npm run bootstrap` **reports** on a workstation; `npm run bootstrap:install` applies. That asymmetry is
deliberate and is the one thing to understand here.

The committed project `SessionStart` hook means the bootstrap runs the moment anyone opens this repo — so
a default run must not reach outside the repository. On a durable host it prints what it would do and
stops: nothing under `$HOME/.claude` is touched, no directory is granted, and no user-level hook is
installed. `npm run bootstrap:install` is the explicit opt-in and `npm run bootstrap:uninstall` reverses it. (Both exist as their own scripts because `npm run bootstrap install` does NOT forward the bare argument — npm swallows it without a `--` separator, leaving the reader silently in report-only mode.)

An **ephemeral** cloud VM writes freely, because its `$HOME` belongs to a container reclaimed on idle —
there is no durable state to consent about, and a session that configures itself is the whole point.

This was not the first design. The first one always wrote, which meant opening the repo on a workstation
silently granted a directory and installed a user-level hook that then fired in **every unrelated repo on
that machine**. A `/converge` panel caught it before it landed (2026-08-18).

Two things it deliberately does not own: the lane pool (`lane-pool.mjs provision`) and the branch guard
(`guard-lane-install.mjs install`). Both are laptop-only, both have their own installer with its own
safety rules, and wrapping them here would put a second source of truth in front of them.

**Nothing about the machine is hand-maintained any more.** The one absolute path that used to be typed by
hand — the primary checkout's `.git`, granted so a `--reference`d lane can read the objects it shares — is
now derived from where the checkout actually is and written to `~/.claude/settings.json`. It was a
`/Users/<name>/…` literal in the COMMITTED `.claude/settings.json`, which made it wrong for anyone else and
dead in every cloud VM; the stale one-off `Bash(cd /Users/…)` allow-rule beside it is simply gone. Machine
state lives at machine level, computed — the same conclusion #3074 reached for the guard.
