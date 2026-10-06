#!/usr/bin/env node
/**
 * guard-lane.mjs — PreToolUse(Edit|Write) gate enforcing the #2123 lane-isolation rule.
 *
 * RULED (#2123): every edit-action runs in an isolated lane CLONE (`~/workspace/.lanes/<repo>/lane-N`),
 * NOT the shared primary checkout of a constellation repo (web-everything / frontierui / plateau-app).
 * That rule was previously judgment-only — nothing stopped an agent from editing the primary tree, and
 * it silently happened. "Is this file in a primary checkout instead of a lane?" is fully script-decidable
 * (a path test), so per the hookable-vs-judgment rule (#51) it belongs in a deterministic hook, here.
 *
 * DECISION: deny the Edit/Write when the target file resolves under a constellation PRIMARY checkout and
 * NOT under a `.lanes/` clone. Everything else is allowed — lane clones, other repos, the scratchpad,
 * genuinely-personal `~/.claude/*` config that does NOT resolve into a repo, untracked scratch.
 *
 * SECOND DECISION (#2997 Gap 1): deny the Edit/Write when the target sits inside a LANE CLONE whose LIVE lease
 * names a DECLARED OCCUPANT that is not this caller. Until #2997 this guard read no lease, no session and no
 * owner at all — its whole decision was the primary-vs-lane path test above — so an `Edit` to a tracked file
 * inside a lane another session was actively working in succeeded silently. That is strictly WORSE than the
 * Bash case #2367 already covers: `git reset --hard` at least leaves a reflog entry, whereas `Edit` overwrites
 * with nothing to recover from. The ownership decision is `isForeignOccupancy` (`lib/lane-lease.mjs`) and the
 * lease location + read are `laneRootFromCwd` + `readLaneLease` imported from `guard-bash.mjs` — deliberately
 * the SAME implementations the Bash guard uses, so the two guards can never drift on what "your lane" means.
 *
 * WHY THE OCCUPANT FIELD AND NOT `ownerSession` (#2997 r2, the F1 correction). `acquire` stamps `ownerSession`
 * from the env of whoever RUNS it. In the dispatched topology that is the DISPATCHER, not the agent then sent
 * to work in the lane — so an `ownerSession !== mySessionId` test reads FOREIGN for the lane's own legitimate
 * occupant, by construction. The first cut of this arm did exactly that, and would have made every dispatched
 * lane read-only for the agent working in it (the lease's own `purpose` naming that very agent). Occupancy is
 * therefore its own lease field, `workerSession`, written ONLY by a session claiming the lane for itself
 * (`lane-pool.mjs acquire --adopt`, or `lane-pool.mjs adopt --lane=N` at hand-off). See `isForeignOccupancy`.
 *
 * RULED (#2997): a lane holding NO live lease stays fully writable. The lease IS the ownership signal; with no
 * lease there is no holder to protect, and the pool's own maintenance flows (provision, refresh, an operator
 * inspecting a free lane) all operate on unleased clones. A stale lease reads as no lease, same as everywhere
 * else. So this arm fires ONLY against a live foreign hold, never against an empty or expired one.
 *
 * KNOWN RESIDUALS (#2997, both deliberate and both fail-OPEN):
 *   1. A lane whose occupant was never DECLARED is not protected — an undeclared lease cannot be told from a
 *      dispatcher-acquired one, and denying on the ambiguity locks agents out of their own lanes (above).
 *      Protection is opt-in per lane, via `--adopt`/`adopt`; without it this guard behaves exactly as before.
 *
 *      #3168 INVESTIGATED making this immediate-on-acquire (stamp `workerSession` from whoever RUNS `acquire`,
 *      by default, instead of only under `--adopt`) and RULED IT OUT: `docs/agent/delivery-loop.md`'s
 *      review-dispatch flow, live and in use today, runs a bare `acquire` (no `--adopt`) BY DESIGN, because the
 *      driver process is not the session that will edit — a headless reviewer, spawned after, self-adopts under
 *      its own freshly-derived id in step 3. Defaulting occupancy to the acquiring session would arm this
 *      guard against that reviewer's own first edit and refuse it as foreign — the EXACT #3107 bounce that
 *      `we:scripts/lib/lane-lease.mjs`'s own `workerSession` docblock (r2) already records fixing once. A
 *      second concrete case (`deliver-item-wrapper.mjs`'s `acquireLane`) shows the SAFE version of "claim
 *      immediately" already exists and is used where it applies: when the future worker's session id IS known
 *      before `acquire` runs, the caller mints it first and passes `--adopt` with that id overridden into the
 *      subprocess env — never a bare default-on flip. So the residual stands, unchanged, BY DESIGN.
 *
 *      What #3168 DID change: the fail-open window this residual describes is no longer silent. Of the six
 *      kinds `we:scripts/operations/dispatch-lane.mjs` can dispatch, four (`prepare`, `prepare-decision`,
 *      `fix`, `ci-heal`) never self-adopt at all — their briefs have no dispatcher→worker split to defer
 *      adoption FOR, they simply never claim occupancy — and that operation now names the fail-open state
 *      loud on every such dispatch: on the `read` finding, on the `plan` verdict (so it rides the run record
 *      and the CLI's own printed `verdict:` dump), on the effect payload, and as a `console.error` from the
 *      dispatch sink itself at the moment the agent is actually spawned. See
 *      `KIND_DECLARES_OCCUPANCY_ON_DISPATCH` / `occupancyFailOpenWarning` in `dispatch-lane.mjs`. `build` and
 *      `investigate` self-adopt already and never carry the warning.
 *   2. Even with a declared occupant, this arm separates SESSIONS, not sibling agents of one session. #2413's
 *      ratified statute is that no ambient env or process property tells siblings apart, so the sibling case is
 *      closed by an asserted minted slug — a per-operation channel the Bash guard has (the command string) and
 *      a file tool structurally does not. An `Edit` into a sibling's lane therefore still passes; the Bash-side
 *      #2997 arm and `lane-pool release` cover the sibling topology where a channel exists.
 *
 * AGENT MEMORY IS NOT EXEMPT (2026-07-09, superseding a conflicting 2026-07-03 "memory is low-collision,
 * edit-in-place" note). The repo memory store is git-TRACKED project content: its SoT is `<repo>/
 * agent-memory-src/`, reachable via the `<repo>/.claude/agent-memory` symlink AND via the user-level
 * `~/.claude/projects/<slug>/memory` symlink — BOTH realpath under the primary. Editing it in the primary
 * collides with concurrent sessions and a lane-refresh `reset --hard` can wipe it, exactly like any other
 * tracked file. So memory rides a lane → PR like everything else (the close flow's red-team→lane→PR path
 * already does; this only closes the interactive hole). The gate keys on REALPATH, so all three aliases
 * resolve to `agent-memory-src/…` under the primary and are denied — edit memory in a lane instead. This
 * is uniform with the no-carve-out rule; the `~/.claude/*` bypass survives ONLY for paths that do NOT
 * realpath into a repo (e.g. `~/.claude/settings.json`).
 *
 * ESCAPE HATCH: set `LANE_GUARD_OFF=1` for the rare sanctioned primary-tree edit (e.g. bootstrapping this
 * very guard, or an emergency hotfix the user directs). The escape is loud by being explicit.
 *
 * Protocol: reads the PreToolUse event JSON on stdin, denies via exit code 2 + a stderr message (mirrors
 * scripts/backlog-guard.mjs). Fail-OPEN on any internal error — a guard bug must never wedge the agent.
 */
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isForeignOccupancy, laneWorkerSession, isLeaseStale, describeLease } from './lib/lane-lease.mjs';
// #2997 — the SAME lease-location + lease-read pair `guard-bash.mjs` uses for its #2367 arm. Imported rather
// than re-implemented so the Edit/Write gate and the Bash gate can never disagree about which lane a path
// belongs to or what its lease says. Importing guard-bash does NOT run its CLI (that block is gated on
// `process.argv[1]` being guard-bash itself).
import { laneRootFromCwd, readLaneLease } from './guard-bash.mjs';
// #xpt9fvd — the shared daemon-clone registry `guard-bash.mjs`'s Bash-side arm also reads, so the two guards
// can never disagree about which paths are a resident daemon's OWN clone (same reuse discipline as the
// lease pair above).
import { daemonCloneRoots, isDaemonCloneRealpath } from './lib/daemon-clone-registry.mjs';

const PRIMARY_REPOS = ['webeverything', 'web-everything', 'frontierui', 'plateau-app'];
const SEP = path.sep;

/**
 * The WORKSPACE root — the shared parent every primary checkout and the `.lanes/` pool sit under. Pure.
 *
 * WHY IT IS NOT JUST `dirname(weRoot)`, and this was a live hole rather than a hypothetical. The hook is
 * configured as `node scripts/guard-lane.mjs`, resolved against the CURRENT DIRECTORY — so when a session's cwd
 * is a lane, the LANE'S copy of this script runs. `dirname` then made `workspace` the lane pool
 * (`<workspace>/.lanes/web-everything`), the primary list became paths that do not exist
 * (`…/.lanes/web-everything/webeverything/`), nothing matched, and an edit to the real shared checkout was
 * ALLOWED. The guard protected only the checkout it happened to be launched from — which, when launched from a
 * lane, is the one tree that never needed protecting.
 *
 * Demonstrated on 2026-08-11: with cwd in a lane, a Write to `webeverything/conformance-vectors/intl.vectors.ts`
 * went through with no deny.
 *
 * A lane always lives at `<workspace>/.lanes/<pool>/lane-N`, so splitting on the `.lanes` segment recovers the
 * true root wherever the script is running from.
 *
 * KNOWN, ACCEPTED RESIDUAL (#2305): a lane directory that is ITSELF a symlink resolving outside `.lanes/`
 * reopens this exact hole one layer up. `weRoot` is derived from `fileURLToPath(import.meta.url)`, and Node
 * realpaths an ES module's main entry when it loads it — so if `<workspace>/.lanes/<pool>/lane-N` were a
 * symlink to, say, `/elsewhere/lane-N`, the script would load as `/elsewhere/lane-N/scripts/guard-lane.mjs`,
 * the `.lanes` segment is gone before this function ever sees the string, and the `dirname` fallback picks
 * `/elsewhere` as the workspace — the wrong primaries, same failure shape as the bug this function fixes.
 * NOT REACHABLE TODAY: every lane this guard can run inside is produced by `lane-pool.mjs`'s `cloneLane`
 * (`git clone --reference … dest`), which always materializes `dest` as a real directory — `git clone` has no
 * code path that leaves a symlink in its place, and no other producer of a `.lanes/<pool>/lane-N` path exists.
 * So the gap is real in this pure function but has no live trigger under the current lane-provisioning story.
 * Revisit if that ever changes (a lane provisioner that symlinks, or a hand-made symlinked lane) — the fix
 * would be resolving each PATH SEGMENT up to (not including) the file, rather than the whole module URL, so a
 * symlinked leaf cannot erase an interior `.lanes` segment.
 */
export function workspaceRootOf(weRoot) {
  const s = String(weRoot || '');
  const i = s.indexOf(`${SEP}.lanes${SEP}`);
  return i >= 0 ? s.slice(0, i) : path.dirname(s);
}

/**
 * PURE decision — no I/O. Given an already-resolved REAL path and the guard's own repo root, return a deny
 * message when the edit targets a constellation PRIMARY checkout outside any lane clone, else null (allow).
 * Kept separate from the stdin/exit-code wrapper so it is unit-testable (mirrors guard-git-push.mjs).
 * @param {string} real  the target's resolved real path (symlinks already followed by the caller)
 * @param {string} weRoot  this guard's repo root (`<workspace>/<repo>`); `<workspace>` is its parent
 * @param {{lease?: object|null, mySessionId?: string|null, daemonCloneRoots?: string[]}} [ctx]  #2997 — the LIVE
 *   lease of the lane clone `real` sits in (null when the target is not in a lane, or the lane holds no live
 *   lease), plus this caller's durable session id. Liveness needs a clock and the lease needs an fs read, so
 *   BOTH are collected by the CLI wrapper and injected here — keeping this function pure and unit-testable,
 *   exactly as `guard-bash.mjs#reason` takes `foreignLiveLease` rather than reading the marker itself.
 *   `daemonCloneRoots` (#xpt9fvd) is the same shape: `daemon-clone-registry.mjs#daemonCloneRoots`'s output,
 *   collected once by the CLI wrapper (it does its own fs reads) and injected here as plain strings.
 * @returns {string|null}
 */
export function laneGuardDecision(real, weRoot, { lease = null, mySessionId = null, daemonCloneRoots: daemonRoots = [] } = {}) {
  if (!real) return null; // no path to judge (never block)
  const workspace = workspaceRootOf(weRoot);
  const primaries = PRIMARY_REPOS.map((r) => path.join(workspace, r) + SEP);

  // #xpt9fvd — a DAEMON CLONE is checked FIRST and UNCONDITIONALLY, before the primary/lane split below. One
  // of them (the WE drain's own clone) sits UNDER `.lanes/`, which the ordinary lane test just below would
  // read as an ordinary pool lane and allow outright — exactly the hole this closes. No tool ever has a
  // legitimate reason to Edit/Write/NotebookEdit a file INSIDE a daemon clone: the daemon itself rebuilds it
  // as a launchd process, entirely outside Claude's hooks, and the one sanctioned way to land a fix there
  // early is the overlay CLI run from a LANE (never a direct file write on the clone's own tree) — so unlike
  // the primary-checkout arm below, there is no escape hatch here.
  if (isDaemonCloneRealpath(real, daemonRoots)) {
    return (
      `edit BLOCKED — "${real}" is inside a DAEMON CLONE (a resident daemon's own dedicated checkout, ` +
      `rebuilt by the daemon itself — never by hand, #xpt9fvd). A hand-edit here goes over the daemon's next ` +
      `rebuild invisibly, and a dirty clone BLOCKS that rebuild (its own live-smoke gate refuses to run over ` +
      `an unexpected local diff) until a person notices and reverts it — caught+reverted 3x on 2026-09-26 ` +
      `before this guard existed. Land the change the sanctioned way instead: work it in a LANE, then push it ` +
      `live early with the overlay CLI (never Edit/Write on the clone's own files — there is no escape hatch):\n` +
      `  node scripts/daemon-overlay.mjs add --clone=<daemon-clone-path> --ref=<your lane branch> [--pr=<n>]\n` +
      `Or use \`node scripts/lib/daemon-rebuild.mjs\` / \`node scripts/lib/daemon-load-overlay.mjs --clone=<path>\` ` +
      `for the other sanctioned rebuild routes — both run from a lane, targeting the daemon clone by \`--clone=\`.`
    );
  }

  // A lane clone lives under `<workspace>/.lanes/…` — never under a primary root — so a primary-root prefix
  // test alone cleanly separates the two. Agent memory is NO LONGER exempt (2026-07-09): its realpath
  // resolves under `<primary>/agent-memory-src/…` (via `.claude/agent-memory` OR the user-level
  // `~/.claude/projects/<slug>/memory` symlink), so a primary memory edit is denied like any tracked file.
  const inLane = real.includes(`${SEP}.lanes${SEP}`);
  const inPrimary = primaries.some((p) => (real + SEP).startsWith(p));

  // #2997 Gap 1 — a lane clone is no longer unconditionally allowed. If its LIVE lease names a DECLARED
  // OCCUPANT that is not me, this Edit/Write would overwrite their in-flight work with nothing to recover from
  // (no reflog for a file write). Deny with the holder named, and a remedy — a bare refusal here would just
  // become the next false-deny footgun (#2986/#2994), so the message says which lane to use instead and how to
  // check. NOTE the test is `isForeignOccupancy`, NOT `isForeignLease`: the latter compares `ownerSession`,
  // which records whoever ran `acquire` (the DISPATCHER for a dispatched lane) and so reads foreign for the
  // lane's own legitimate worker — see this file's header and `isForeignOccupancy`'s doc.
  if (inLane && isForeignOccupancy({ lease, mySessionId })) {
    return (
      `edit BLOCKED — "${path.relative(workspace, real)}" is inside a lane clone that a DIFFERENT session has ` +
      `declared it is working in (${describeLease(lease)}; occupant session ${laneWorkerSession(lease)}). ` +
      `Writing here overwrites their in-flight work, and unlike a Bash \`git reset\` an Edit/Write leaves no ` +
      `reflog entry to recover from (#2997/#2367). Work in the lane YOU acquired instead:\n` +
      `  node scripts/lane-pool.mjs status --json --leased-only     # who holds what right now\n` +
      `  node scripts/lane-pool.mjs acquire --purpose=<why> --adopt   # lease your own lane and edit THERE\n` +
      `If this lane really was handed to you, claim it explicitly (\`adopt --lane=N\`); if its lease is ` +
      `stale/abandoned, release it deliberately (\`release --lane=N --force\`) rather than writing over it.`
    );
  }

  if (!inPrimary || inLane) return null;

  const isMemory = real.includes(`${SEP}agent-memory-src${SEP}`)
                || real.includes(`${SEP}.claude${SEP}agent-memory${SEP}`);
  return (
    `edit BLOCKED — "${path.relative(workspace, real)}" is in the shared PRIMARY checkout. Per #2123 every ` +
    `edit runs in an isolated lane CLONE, not the primary tree (a concurrent session or the user's dev ` +
    `server can collide otherwise)${isMemory ? '. Agent memory is git-tracked project content — it is NOT ' +
    'exempt (2026-07-09); edit it in a lane too, same as any file' : ''}. Provision/pick a lane and edit THERE:\n` +
    `  node scripts/lane-pool.mjs status --json      # find a clean lane\n` +
    `  node scripts/lane-pool.mjs path --lane=N       # its path under ~/workspace/.lanes/\n` +
    `Then edit the file at that lane path.${isMemory ? '' : ' (Sanctioned primary edit? re-run with LANE_GUARD_OFF=1.)'}`
  );
}

/** Resolve a target to its REAL path: follow symlinks; for a not-yet-existing file realpath the nearest
 *  existing ancestor dir so the location still classifies; fall back to the raw resolved path. */
export function resolveReal(file) {
  let real = path.resolve(file);
  try { real = realpathSync(real); } catch {
    try { real = path.join(realpathSync(path.dirname(real)), path.basename(real)); } catch { /* keep raw */ }
  }
  return real + '';
}

// ── CLI wrapper: stdin event → exit code (only when run directly, not when imported by the test) ──────────
if (process.argv[1] && realpathSyncSafe(process.argv[1]) === realpathSyncSafe(fileURLToPath(import.meta.url))) {
  try {
    if (process.env.LANE_GUARD_OFF !== '1') {
      const ev = JSON.parse(readFileSync(0, 'utf8') || '{}');
      const file = ev?.tool_input?.file_path;
      if (file) {
        // Roots derived from this script's own location so the hook is portable:
        //   <workspace>/<repo>/scripts/guard-lane.mjs  →  <workspace> is the shared parent of every checkout.
        const weRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
        const real = resolveReal(file);
        // #2997 — collect the target lane's LIVE lease + this caller's durable session id (the impure half),
        // then hand both to the pure decision. Keyed on `CLAUDE_CODE_SESSION_ID` FIRST, the SAME source
        // `lane-pool.mjs adopt` stamps into `workerSession` and `guard-bash.mjs` reads, so a lane I adopted can
        // never read as foreign through a string-source mismatch. The lease is located from the TARGET PATH,
        // not the cwd — an Edit names its own file, and the reported cwd is unreliable (#2335).
        const mySessionId = process.env.CLAUDE_CODE_SESSION_ID || ev.session_id || null;
        const laneRoot = laneRootFromCwd(real);
        const raw = laneRoot ? readLaneLease(laneRoot) : null;
        const lease = raw && !isLeaseStale(raw, Date.now()) ? raw : null; // stale ⇒ no live hold ⇒ allow
        // #xpt9fvd — the daemon-clone registry (seed ∪ every clone the overlay state dir has recorded).
        // Computed from `weRoot`'s own parent, same as `primaries` above; a fault here fails open (empty
        // list, `isDaemonCloneRealpath` then answers false for everything) rather than wedging the agent.
        let daemonRoots = [];
        try { daemonRoots = daemonCloneRoots(workspaceRootOf(weRoot)); } catch { /* fail-open */ }
        const msg = laneGuardDecision(real, weRoot, { lease, mySessionId, daemonCloneRoots: daemonRoots });
        if (msg) { process.stderr.write('guard-lane: ' + msg + '\n'); process.exit(2); }
      }
    }
  } catch { /* fail-OPEN: a guard fault must never wedge the agent */ }
  process.exit(0);
}

function realpathSyncSafe(p) { try { return realpathSync(p); } catch { return path.resolve(p); } }

/**
 * Is this REALPATH inside a lane clone? PURE — the same locus test `laneGuardDecision` applies, exported
 * so callers that need only the locus (`we:scripts/backlog.mjs`'s `number-stranded` refusal) can share it
 * rather than re-deriving it, and so it is testable without spawning a CLI (#1961 correctness finding 1).
 */
export function isLaneLocus(realPath, sepChar = SEP) {
  const p = String(realPath || '');
  return p !== '' && p.includes(`${sepChar}.lanes${sepChar}`);
}
