# Prototype-based dev: proving new mechanical infrastructure before it replaces production

This is for a different kind of work than the normal delivery loop ([delivery-loop.md](delivery-loop.md)):
building a **new piece of dispatch/mechanical infrastructure** — a new provider, a new wrapper, a new
dispatch kind — that is meant to eventually replace or extend a production path. Passing tests and a clean
code review are not evidence this works. `we:scripts/operations/deliver-item-wrapper.mjs`'s (#3627) first
live exercise found **fourteen real bugs** across six attempts, with 43–106 passing unit tests the entire
time, because the tests mocked the CLI spawn — the exact seam where every one of those bugs actually lived
(argument-format validation, a hardcoded timeout, a missing working directory, cross-checkout path
resolution, a stale gate marker). None of that is reachable by mocking. This doc is how that prototype got
proven, so the next one doesn't have to re-derive the method.

## The one rule: park until genuinely exercised

**A prototype PR stays `review:human`, unmerged, regardless of test count or review cleanliness, until it
has run for real, end to end, against a real item.** Not a synthetic fixture — a real backlog item, through
the real code path, spawning a real paid session. "It has good test coverage" is not the bar; "it has
actually run" is.

## The live-test pattern: a driver and an observer, both dispatched, both real

Two agents, dispatched together, each with one job:

**The driver** acquires real resources (a real lane, a real claim) and invokes the real code path — not a
harness around it. It **blocks to completion**, no polling (the same no-polling discipline the
infrastructure itself is usually built to have). If real work lands but the attempt still fails afterward,
the driver **protects that work before reporting**: push the lane's HEAD to
`lane/<item>-attemptN-backup-<sha>` on origin. A lane sitting unleased with real, uncommitted-to-origin work
is one `acquire --force` away from being silently reset out of existence — this happened twice in one night
(attempts 4 and 5) before it became standard practice to push a backup the moment a real commit exists and
the overall attempt still fails.

**The observer** watches the spawned agent's own transcript **live**, not a postmortem, via a bounded tail
read (`we:skills-src/inspect-agent-health/agent-health.mjs`'s technique — never a raw full-file read). It
scores against a **fixed checklist**, not a narrative verdict:

- Zero gate/standards violations — **including ones the agent catches and fixes itself.** Self-correction
  does not un-fail this item.
- Zero mechanical/wrapper friction — any tool/hook/lease/permission error the agent had to work around,
  regardless of how gracefully. Graceful recovery does not un-fail this item either.
- Zero redundant or wasted tool calls.
- A correct, complete final report (or reports, if resumed).
- End-to-end pipeline success — the wrapper's own downstream steps (gate, PR, whatever "done" means for
  this pipeline) actually completed, not just the agent's own portion.

Score each **PASS / FAIL / JUDGMENT-CALL** with one line of evidence, and give a plain tally
("2/5 clear PASS"). A soft adjective ("smooth," "went well") can bury a real defect inside a positive-sounding
summary — this happened once tonight: an observer's own "smooth, self-recovered well" verdict folded two
real, countable defects into a narrative that read as a pass. The checklist format is what forces them back
out.

**The observer has no visibility into the driver's own process** — it watches only the spawned agent's
transcript. If it doesn't see a downstream result (a PR, say) by the time the transcript goes quiet, it must
report exactly that — "no PR visible from what I can see" — and never invent a reason ("expected, no wrapper
wired") for something outside its own view. Give the observer the driver's agent ID (`agent-health.mjs`
takes any agent's transcript) so it can check the wrapper's real state directly instead of guessing.

## The fix loop: one precisely-diagnosed, narrowly-scoped fix per real failure

Repeated rounds of "found a real bug → fixed it → retried" is the **expected shape** of proving a prototype,
not a sign it is broken or taking too long. Tonight took six live attempts and fourteen fix rounds to reach
one fully successful run. Each fix round:

- Diagnoses from source, not from a plausible guess. Twice tonight a first-pass diagnosis was wrong and got
  corrected on re-check (a "self-inflicted dirty-guard" theory that turned out to be an unrelated crash; a
  claim that a security hook didn't exist, when it existed and the checking agent's own grep had simply
  missed it). State the mechanism precisely, with the actual source read, or say the diagnosis is
  unconfirmed — never report a guess as a finding.
- Is scoped to exactly the bug found, in an **isolated scratch clone**, never a pooled lane. A fix agent that
  edits a lane directly leaves it dirty/ahead-of-origin for whoever tries to use that lane next — this
  happened once and cost a later live-test driver a real diagnostic detour.
- Ends with real evidence: the full test suite run to completion in the foreground (never backgrounded and
  assumed-resumed — a dispatched agent's own backgrounded shell command does not wake it up when it finishes;
  this exact mistake recurred multiple times in one night before it stopped), plus confirmation the fix
  branch's head actually advanced.

## Portability, if this is meant to graduate into product infrastructure

Anything that will eventually replace a production dispatch path has to work for a different user, on a
different machine, with a different personal setup — not just the one machine it was built on. No hardcoded
personal or machine-specific paths; resolve everything relative to the repo root or through the existing
path-resolution helpers (`we:scripts/lib/lane-pool-paths.mjs`, not a hand-rolled relative path — a hand-rolled
one silently breaks the moment the code runs from anywhere but the exact checkout it was written against,
which is exactly what happened when this wrapper had to run from an isolated worktree instead of the primary
checkout). Stripping the *operator's own* `~/.claude/CLAUDE.md` is not the whole job — the repo's own doctrine
chain (this file's own directory included) is also ambient context a dispatched agent should not need,
replaced by one hand-crafted, self-contained brief instead.

## Graduation gate

Replace or wire the production path only after a live run has gone the **full distance** end to end — build
through to a real, mergeable PR (or whatever "done" means for the dispatch kind in question) — not partway,
and not "the agent's own portion worked." A run that produces real, high-quality work but never reaches a PR
is a proven **agent**, not yet a proven **pipeline**.

## Real end-to-end dispatch canary (`we:scripts/conveyor/canary.mjs`, 4241)

The soak harness (`we:scripts/conveyor/soak/`) simulates every session with a FAKE world — it cannot catch a
break in the REAL `claude --bg` path, which is exactly what PR #2701 (dispatched sessions now start in a
scratch cwd outside every trusted checkout, card #4174) broke live: a session's first `Edit` into its own
freshly-acquired lane clone can hang on an unanswerable permission prompt, invisible to any fake-session test.
`canary.mjs` is the one real, live check for exactly this class of break: it dispatches ONE tiny real session
through the SAME production sink (`we:scripts/operations/dispatch-lane-io.mjs#createDispatchSinks` — read-only
import, same scratch cwd, same trust grant, same `--settings` env, same brief-filling machinery), watches it
with bounded timeouts, and reports PASS/FAIL per stage: `spawned · no-permission-prompt · lane-acquired ·
edit-ok · gate-ran · pushed · session-finished · cleaned-up`. Run it as `node scripts/conveyor/canary.mjs
--repo=<owner>/<name>` after loading a daemon-dispatch overlay, before counting the change proven — the
operator's standing rule for this class of change is one real end-to-end run, not unit tests alone.

**A still-alive session's own files are never force-cleaned.** The canary's own first live run caught this
live: its dispatched session stalled on exactly the #2701 permission-prompt shape and was still a real running
process when the canary's bounded watch gave up — an earlier cut of the cleanup step force-deleted that
session's scratch cwd anyway. `canary.mjs` now only releases the lane / deletes the scratch cwd once the
session is CONFIRMED gone (absent from a successful `claude agents --json` read, past the listing-lag grace,
or a listed terminal state) — never on a guess, and never while a listing read is merely failing. A session
still confirmed alive at timeout is left for the resident `we:scripts/conveyor/session-reaper.mjs` to reap in
the ordinary course, exactly as it already does for every other finished dispatch's scratch cwd.

## Loading a fix on a daemon prototype (`prototype-load`)

A green + Codex-audited (NOT WEAKENED) daemon fix goes live through ONE declared operation, never a hand-built combined top:
`node scripts/operations/run.mjs prototype-load --branch=<lane/x> --sha=<sha> --daemon=<name> [--dry-run] [--why=<text>]`.
It resolves the clone from `scripts/settings/prototype-load.json`, gates on the ready record, keeps main intact, checks the clone's current registrations (reporting a `stale-registration` by name), swaps add-before-remove through the sanctioned `daemon-overlay.mjs` loader, waits for adoption, and logs one line to `prototype-loads.jsonl`. Front door: [skills-src/prototype-load/SKILL.md](../../skills-src/prototype-load/SKILL.md). Why it exists: on 2026-10-22 improvised loads cost about 6.5 hours, reverted main fixes three times, and one loader removed old registrations before the new one was accepted.
