# Operating the mechanical dispatcher (epic #3383)

The dispatcher is a **headless runner** (`we:skills-src/conveyor/runner.mjs`) that steps the mechanized tick
core with no model context and surfaces dispatch/watch decisions for a judgment layer to act on
(`we:skills-src/conveyor/SKILL.md` §2 is that judgment layer's own operating script — read this file first if
you're operating it cold, not building it). This file is the reference for someone who did **not** build it:
how to tell it's alive, how to stop it safely, how to close out a stuck dispatched agent, what env vars a real
dispatch needs, and where its state and logs live. Sourced from the operational knowledge already recorded
across epic #3383's own session updates — see that card for the full incident-by-incident history.

**Landing-order note.** `we:skills-src/conveyor/supervisor.mjs` — the resident process meant to keep the runner
itself alive across a crash (restart, backoff, its own JSONL log) — exists only on `origin/lane/mechanical-
dispatcher`, not `main`, as of this writing. Nothing installs it to `launchd` yet either. Everything below
covers what's actually landed: the runner itself, and the dispatched delivery agents it spawns. Once the
supervisor graduates to `main` (tracked by #3443), this file needs a section for it (its own liveness check, its
own restart/backoff behavior, its own log) — check #3383 for that graduation's status before assuming the
supervisor exists.

## Is the runner alive?

The runner holds a machine-global singleton lease while it's driving — a second launch checks the SAME lease,
so the same read tells you whether one is running. There's no CLI flag for this yet; read the lease directly:

```bash
node -e "import('./skills-src/conveyor/runner-lock.mjs').then(m => console.log(m.runnerLeaseStatus()))"
```

Returns `{ held, stale, owner, heartbeatAt }`:
- `held: true` — a live runner is driving (heartbeat within the last 15 min — its lease TTL, well past the
  runner's own ~120s tick interval).
- `held: false, stale: true` — a lease exists but its holder crashed; reclaimable by the next launch.
- `held: false, stale: false` — no runner has run recently.

`owner` is `<hostname>:<pid>:conveyor-runner` — cross-check the pid with `ps -p <pid>` if you want OS-level
confirmation, not just the lease record. The lease lives at `~/.claude/conveyor-runner-locks/` (machine-global,
not per-checkout — a runner launched from any clone contends on the same lease).

## Stopping the runner safely

The runner is a plain background Node process, not a `claude` session — `claude agents`/`claude stop` don't see
it (those apply to dispatched delivery **agents**, next section). It has no supervisor yet, so nothing restarts
it after any kind of stop:

- **Preferred: let it idle-stop itself.** The runner stops its own loop (and releases its lease) once the queue
  is empty and there's been no operator feedback for ~15 min. No action needed.
- **To end it now:** stop whatever process is hosting it — `TaskStop` if it was launched as a backgrounded tool
  call from an interactive session, or a plain process signal/Ctrl-C if launched by hand. The runner's lease
  release lives in a `finally` around its drive loop, so a clean exit releases it immediately; a hard kill
  leaves a stale lease that reclaims itself via the 15-minute TTL on the next launch — either way a fresh
  `/conveyor` restart is safe, it just may wait out the TTL first.

## Closing out a stuck `--bg` dispatched agent

This is about a **delivery agent** the runner spawned (`claude --bg`), not the runner itself.

1. **Check it first:** `claude agents --json` — look for the stuck session's row. A row with no live `pid` in
   the listing is stale bookkeeping, not a live process (seen repeatedly during #3383's own testing) — nothing
   to kill.
2. **Never `kill <pid>`.** It ends the OS process but does not deregister the session — something resurrects it
   under a new pid minutes later, which has raced a legitimate second dispatch onto the same lane and produced
   a real double-dispatch (#3383, 2026-08-31 session).
3. **A row with no live `pid` where `claude stop <id>`/`claude rm <id>` also fail or silently no-op is the
   known Claude Code CLI bug GH #77683 — not a transient failure to retry, and not something to fix by hand.**
   Use the mechanized operation instead of chasing it manually or moving `~/.claude/jobs/<id>/` aside yourself:
   ```bash
   node scripts/operations/run.mjs clear-stuck-session --session=<id>
   # or, to resolve whichever session is bound to a PR:
   node scripts/operations/run.mjs clear-stuck-session --pr=<n>
   ```
   It replays `reconcile-core.mjs`'s own `assessLiveness` verdict (never a second liveness check), requires a
   real human `confirm` because the move touches `~/.claude`, not this repo, and quarantines the job directory
   rather than deleting it. Full writeup, including the manual jobs-directory move as the FALLBACK for if this
   operation itself is unavailable or fails: `we:agent-memory-src/stuck-claude-sessions-known-issue-workaround.md`.
4. **`claude stop <id>` still works, and is the right tool, on a session that just needs stopping** — one that
   isn't hitting the #77683 zombie bug above (i.e., `stop`/`rm` actually succeed against it). It deregisters the
   session for real; every stop issued through it in that case has stayed stopped.
5. **Mechanized composition:** `we:scripts/operations/dispatch-abort.mjs` shells the safe sequence —
   ```bash
   node scripts/operations/dispatch-abort.mjs --abort=<runId> --key=<effectKey> [--status=failed] [--note="..."] [--force]
   ```
   Stops the session via `claude stop`, then closes out the run record so `we:scripts/operations/wake.mjs`'s
   liveness check passes on its own merits, without needing `--force`. Use `--force` only when you already know
   by other means the agent is gone (e.g. `claude agents --json` itself is unreadable) — it skips the liveness
   check.
6. **A genuinely fresh scratch clone needs trust before a dispatch into it will work.**
   `we:scripts/bootstrap-session.mjs`'s `trustableDirs()` only ever trusts the primary checkout and lane-pool
   lanes, never an ad-hoc scratch clone — a dispatched agent spawned into an untrusted one stalls on a
   permission-prompt dialog with nobody there to answer it. Grant trust first:
   ```bash
   node scripts/operations/dispatch-abort.mjs --trust=<path-to-scratch-clone>
   ```
7. `dispatch-abort.mjs` deliberately does **not** release a lane the aborted dispatch may have partially
   acquired — that's a separate judgment call (was the tree actually clean?). Release it by hand once you've
   checked: `node scripts/lane-pool.mjs release --lane=<n> --force`.

## The session watchdog — reading what a long session is doing (xegykal)

The health watch runs `we:scripts/conveyor/session-watchdog.mjs` every `intervalMinutes` (default 5). For each live
conveyor session (`fix-`, `ci-heal-`, `review-`, `conveyor-`/`build-`, `prepare-`) past its kind's **standard
duration**, it reads a bounded tail of that session's own transcript and classifies it: `active-progress`,
`waiting-loop` (the same long command repeated with no edit since — fix-3771's eleven `verify-lane --wait` calls),
`stalled`, `finished-but-listed`, or `ghost` (listed working, transcript older than `ghostHours`, no process).

- **Standard duration** = the kind's heavy demand from heavy-admission's rolling medians × `standardFactor`
  (default 2), never below `floorMinutes[kind]`; `fallbackMinutes[kind]` with fewer than `minSamples` samples or
  for a kind with no heavy demand (review, prepare).
- **Settings** live under `sessionWatchdog` in the health dir's `config.json` (the health watch's own config,
  merged over the platform default in `DEFAULT_SESSION_WATCHDOG`; an invalid value is reported as the
  `sessionWatchdogConfig` probe error and ignored). Every threshold, the interval, and `act` are settings.
- **What it raises:** `fixer-stuck` (a fix-claim holder in a waiting-loop or stalled), `fix-claim-held-no-progress`
  (a claim held past standard with the PR head unchanged), `session-stuck` (the same, with no claim) and
  `ghost-session-listed` (a ghost it could not clear). Episodes that need a person carry `escalation.humanOnly`,
  which the Plateau WIP page lists.
- **What it does:** clears a ghost with `claude rm <id>` and re-lists once to confirm (`claude rm` can no-op —
  Claude Code issue #77683; a row still listed goes to `rm-ineffective.json` and is not retried for `ghostHours`),
  and releases any live claim the ghost held. It never stops or kills a live session.
- **One pass by hand:** `node scripts/conveyor/session-watchdog.mjs` (report only) or `--apply`.

**Escalation hand-off contract (v1)** — for the fixer-escalation ladder. Each new stuck-fixer case appends one line
to `<coordination root>/session-watchdog/fixer-escalations.jsonl`:

```json
{ "type": "session-watchdog.fixer-stuck", "v": 1, "key": "we#3771|<sessionId>|waiting-loop|<head>",
  "at": "<iso>", "repo": "we", "pr": 3771, "claimKind": "fixing",
  "session": { "name": "fix-3771", "id": "f29aeb29", "sessionId": "<uuid>" },
  "classification": "waiting-loop", "reason": "same-command-repeated", "headSha": "<claimed head>",
  "evidence": { "repeats": 3, "repeatMinutes": 21, "signature": "node verify-lane.mjs check --wait=540000 --json --repo=.",
                "idleMinutes": 3, "pendingTool": "Bash", "claimAgeMinutes": 87, "standardMinutes": 20 },
  "ask": "escalate-fixer" }
```

A key is written once. The consumer acknowledges by appending `{"key": "<key>", "by": "<who>", "at": "<iso>"}` to
`fixer-escalations.ack.jsonl` in the same directory; the `fixer-stuck` episode then stops being human-only.

## Env vars a real dispatch needs

- **`WE_DISPATCH_AGENT_ARGS`** — a JSON array of extra `claude` flags passed to every dispatched agent (e.g.
  `'["--permission-mode","dontAsk"]'`). Unset ⇒ `[]` (no extra flags, not an error) — but a `--bg` dispatch
  with no permission mode set risks stalling on a prompt nobody can answer, so set it explicitly for a real
  run. A malformed value (not a JSON array of strings) throws rather than silently dispatching without it.
- **The permission mode that actually works for `--bg`, confirmed the hard way (#3383, 2026-08-31 session):
  `dontAsk`.** `acceptEdits` works fine for a foreground (`claude -p`) dispatch but stalls every time under
  `claude --bg` specifically — the two modes are not interchangeable across foreground/background, contrary to
  earlier assumptions. `bypassPermissions` is not viable for `--bg` specifically — confirmed live (2026-09-19):
  `claude --bg --permission-mode bypassPermissions "<task>"` refuses immediately with `--bg with
  bypassPermissions requires accepting the disclaimer first. Run 'claude --dangerously-skip-permissions' once
  interactively.` That is a one-time acceptance gate this machine/account had not cleared for `--bg`
  specifically, not a per-invocation TTY check on the flag itself — see the correction below. So the working
  invocation for `--bg` dispatch stays:
  ```bash
  WE_DISPATCH_AGENT_ARGS='["--permission-mode","dontAsk"]' node skills-src/conveyor/runner.mjs --json
  ```

- **Correction (2026-09-19): the line above used to read "`bypassPermissions` … requires a real TTY … cannot be
  scripted" with no `--bg` qualifier — read that way, it contradicts `we:docs/agent/delivery-loop.md`'s own
  documented, working `claude -p --permission-mode bypassPermissions` pattern, and the two pages were being read
  as disagreeing about the same flag.** They were not: FOREGROUND `claude -p --permission-mode
  bypassPermissions` (equivalently `--dangerously-skip-permissions`) needs no TTY at all and is fully
  scriptable. Confirmed live, piped stdin, `[ -t 0 ]` false (not a TTY), even under a stripped `env -i`
  environment:
  ```bash
  echo "Reply with exactly the single word: PONG" | claude -p --permission-mode bypassPermissions
  # → exit 0, stdout "PONG", no disclaimer prompt, no TTY
  echo "Reply with exactly the single word: PONG2" | env -i HOME="$HOME" PATH="$PATH" claude -p --permission-mode bypassPermissions
  # → exit 0, stdout "PONG2" — reproduces under a stripped environment too
  ```
  So "requires a TTY, cannot be scripted" is real only for `--bg`, and only until the one-time disclaimer has
  been accepted once, interactively, on the dispatching machine — it was never true for the foreground `claude
  -p` shape `we:docs/agent/delivery-loop.md`'s independent-reviewer pattern and `we:scripts/operator/dispatch.mjs`'s
  `runAgent` already use. See `we:agent-memory-src/scoped-approval-beats-global-bypass.md` for the standing
  lesson this whole area keeps re-teaching: a scoped deny-list beats a global bypass, and `we:scripts/operations/
  review-dispatch.mjs`'s `REVIEW_DISPATCH_DISALLOWED_TOOLS` is this repo's own worked example of the safer
  alternative — reach for it before a bare `bypassPermissions` invocation.
- **A fresh scratch clone must be trusted before it's dispatched into** — see step 6 above. This isn't an env
  var, but it's the other precondition that silently stalls a `--bg` dispatch the same way a missing
  permission mode does, so check both together before a real run.

## Where logs and state live

Everything below is machine-local and gitignored — none of it lands on `main`.

| What | Where |
|---|---|
| Runner singleton lease (liveness/ownership) | `~/.claude/conveyor-runner-locks/` |
| Per-dispatch operation run records | `<checkout>/.operations/runs/<id>.json` |
| Learnings drop-box (per-session, pre-harvest) | `~/.claude/conveyor/learnings/<session>.jsonl` (override: `$LEARNINGS_POOL`, or `$LEARNINGS_DROPBOX` for the exact file) |
| Session-local conveyor queue (operator's "clear this for build") | `<checkout>/.conveyor/queue.json` |
| Infra-blocked recovery state | `<checkout>/.conveyor/infra-blocked.json` |
| The runner's own per-tick output | its stdout (`--json` for one line per tick) — no fixed log **file** yet; that's the supervisor's job once it lands (see the landing-order note above) |

`claude agents --json` is the liveness read for dispatched delivery agents (not the runner itself — see
above). It can report stale rows for sessions that no longer exist; a row missing `pid` is exactly that, not a
live process to chase down.

## Resolved conflicts return to review

When `parked-pr-conflict-watch.mjs` sees a previously flagged real merge conflict against `main` clear
(GitHub's own `mergeable: MERGEABLE` confirms it; absence of the watcher's label does not), it removes
`merge-status:conflicting` and hands a PR still carrying `review:changes` to `rearm-review.mjs` for a
**fresh review of the current, post-resolution diff**. The sanctioned hand-back swaps the bounce to
`review:pending` and preserves `review:human`; the PR must never be left stuck on that stale bounce forever.
It never reuses or resurrects a prior `review:accepted`: that verdict predates the conflict-resolution commits
and is void for the new diff. An unknown mergeability result keeps the conflict marker for a later tick.

## Discoverability

Linked from `we:skills-src/conveyor/SKILL.md` §2 ("Start the runner") — that's where an operator running the
dispatcher will naturally land first.
