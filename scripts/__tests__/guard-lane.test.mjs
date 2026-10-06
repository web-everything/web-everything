/**
 * @file scripts/__tests__/guard-lane.test.mjs
 * @description Proof of the #2123 lane-isolation gate (guard-lane.mjs). The stdin/exit-code plumbing is the
 *   I/O boundary; the pure allow/deny decision is unit-tested here (mirrors guard-git-push.test.mjs).
 *   Regression anchor (2026-07-09): agent memory is NO LONGER exempt — a primary memory edit, INCLUDING one
 *   reached through the user-level `~/.claude/projects/<slug>/memory` symlink (which realpaths into
 *   `<primary>/agent-memory-src/`), must be denied and routed to a lane.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { laneGuardDecision, resolveReal, workspaceRootOf } from '../guard-lane.mjs';
import { daemonCloneRoots } from '../lib/daemon-clone-registry.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

// A fake constellation: <workspace>/{webeverything,frontierui} primaries + a <workspace>/.lanes/ clone.
const WORKSPACE = '/ws';
const WE_ROOT = path.join(WORKSPACE, 'webeverything');
const p = (...seg) => path.join(WORKSPACE, ...seg);

// THE LAUNCH-LOCATION HOLE (2026-08-11), demonstrated before it was fixed. The hook is configured as
// `node scripts/guard-lane.mjs`, resolved against the CURRENT DIRECTORY — so a session whose cwd is a lane runs
// the LANE'S copy, and `weRoot` is that lane. The guard then protected only the tree it was launched from,
// which when launched from a lane is the one tree that never needed protecting. A Write to the real shared
// checkout went through with no deny.
describe('the guard protects the primaries wherever it is launched from', () => {
  const TARGET = p('webeverything', 'conformance-vectors', 'intl.vectors.ts');
  for (const [label, root] of [
    ['the primary itself', WE_ROOT],
    ['a WE lane', p('.lanes', 'web-everything', 'lane-21')],
    ['a plateau lane', p('.lanes', 'plateau-app', 'lane-3')],
    ['a deeply nested lane path', p('.lanes', 'web-everything', 'lane-4', 'nested')],
  ]) {
    it(`DENIES a primary edit when launched from ${label}`, () => {
      expect(laneGuardDecision(TARGET, root), label).toMatch(/BLOCKED/);
    });
  }

  it('and still ALLOWS an edit inside a lane, from either launch point', () => {
    const laneFile = p('.lanes', 'web-everything', 'lane-1', 'scripts', 'x.mjs');
    expect(laneGuardDecision(laneFile, p('.lanes', 'web-everything', 'lane-1'))).toBeNull();
    expect(laneGuardDecision(laneFile, WE_ROOT)).toBeNull();
  });

  it('workspaceRootOf recovers the true root from a lane path', () => {
    expect(workspaceRootOf(p('.lanes', 'web-everything', 'lane-21'))).toBe(WORKSPACE);
    expect(workspaceRootOf(p('.lanes', 'plateau-app', 'lane-3'))).toBe(WORKSPACE);
    // A non-lane root keeps the old meaning: the workspace is its parent.
    expect(workspaceRootOf(WE_ROOT)).toBe(WORKSPACE);
    // A directory merely NAMED `.lanes` at the end is not a lane path — the segment must be interior.
    expect(workspaceRootOf(p('webeverything', '.lanes'))).toBe(p('webeverything'));
  });

  // #2305 — KNOWN, ACCEPTED RESIDUAL, recorded so it is not rediscovered as a surprise. Node realpaths an ES
  // module's main entry on load, so a lane directory that is ITSELF a symlink resolving outside `.lanes/`
  // would erase the `.lanes` segment before `workspaceRootOf` ever sees the string — reopening the exact hole
  // the launch-location fix above closed, one layer up. This test does not exercise the CLI wrapper (it
  // cannot force Node's own module-loading realpath from inside a test); it pins the PURE function's behavior
  // on the string a symlink-following load would hand it, so the mechanism stays documented and testable.
  // NOT REACHABLE TODAY: `lane-pool.mjs`'s `cloneLane` always produces a real `git clone`d directory for
  // `.lanes/<pool>/lane-N`, never a symlink, and no other producer of a lane path exists — see the
  // `workspaceRootOf` doc comment in guard-lane.mjs for the full reachability note.
  it('RESIDUAL (accepted, not reachable today): a symlinked lane leaf erases the `.lanes` segment and workspaceRootOf falls back to the wrong root', () => {
    // What a symlink-following module load hands the function once `.lanes/web-everything/lane-9` has been
    // realpathed away to some other location outside the workspace entirely.
    const asIfSymlinkedLane = path.join('/elsewhere', 'lane-9');
    expect(workspaceRootOf(asIfSymlinkedLane)).toBe('/elsewhere'); // wrong: should be WORKSPACE
    expect(workspaceRootOf(asIfSymlinkedLane)).not.toBe(WORKSPACE);
  });
});

describe('laneGuardDecision (pure)', () => {
  it('DENIES a plain primary-tree edit', () => {
    expect(laneGuardDecision(p('webeverything', 'scripts', 'x.mjs'), WE_ROOT)).toMatch(/BLOCKED/);
  });

  it('DENIES a primary edit in another constellation repo (frontierui)', () => {
    expect(laneGuardDecision(p('frontierui', 'src', 'a.ts'), WE_ROOT)).toMatch(/BLOCKED/);
  });

  it('ALLOWS an edit inside a lane clone (under .lanes/)', () => {
    expect(laneGuardDecision(p('.lanes', 'web-everything', 'lane-3', 'scripts', 'x.mjs'), WE_ROOT)).toBe(null);
  });

  it('ALLOWS a lane edit to agent-memory-src (memory work rides a lane)', () => {
    expect(laneGuardDecision(p('.lanes', 'web-everything', 'lane-3', 'agent-memory-src', 'r.md'), WE_ROOT)).toBe(null);
  });

  it('ALLOWS a genuinely-personal ~/.claude path that does not resolve into a repo', () => {
    expect(laneGuardDecision('/home/u/.claude/settings.json', WE_ROOT)).toBe(null);
  });

  it('DENIES a primary agent-memory-src edit WITH the not-exempt memory notice', () => {
    const msg = laneGuardDecision(p('webeverything', 'agent-memory-src', 'rule.md'), WE_ROOT);
    expect(msg).toMatch(/BLOCKED/);
    expect(msg).toMatch(/Agent memory is git-tracked/);
    expect(msg).not.toMatch(/LANE_GUARD_OFF/); // the bypass is NOT advertised for memory
  });

  it('DENIES via the legacy .claude/agent-memory alias too', () => {
    const msg = laneGuardDecision(p('webeverything', '.claude', 'agent-memory', 'rule.md'), WE_ROOT);
    expect(msg).toMatch(/Agent memory is git-tracked/);
  });

  it('still advertises the LANE_GUARD_OFF bypass for a NON-memory primary file', () => {
    expect(laneGuardDecision(p('webeverything', 'scripts', 'x.mjs'), WE_ROOT)).toMatch(/LANE_GUARD_OFF/);
  });

  it('never blocks on an empty path', () => {
    expect(laneGuardDecision('', WE_ROOT)).toBe(null);
  });
});

// ── #2997 Gap 1 — the Edit/Write path finally has a lease check ──────────────────────────────────────────
//
// Until #2997 this guard's whole decision was the primary-vs-lane path test above: `laneGuardDecision(real,
// weRoot)` took no lease, no session and no owner, so an Edit to a tracked file inside a lane ANOTHER session
// was actively working in succeeded silently. That is strictly worse than the Bash case #2367 already covers —
// `git reset --hard` leaves a reflog entry, an Edit leaves nothing to recover from.
describe('#2997 Gap 1 — laneGuardDecision refuses a write into a lane a DIFFERENT session occupies', () => {
  const LANE_FILE = p('.lanes', 'web-everything', 'lane-3', 'scripts', 'x.mjs');
  // `ownerSession` = who ran `acquire`; `workerSession` = who DECLARED they are working in the lane (`adopt`).
  // The guard keys on the second, and the two are routinely different — see the r2 block below.
  const leaseOf = (ownerSession, extra = {}) => ({
    session: 'Mac:39423', purpose: 'review-1222-r2', acquiredAt: '2026-08-14T12:00:00.000Z',
    ttlMinutes: 240, ownerSession, ...extra,
  });
  const occupiedBy = (workerSession, ownerSession = 'sess-DISPATCHER') => leaseOf(ownerSession, { workerSession });

  it('DENIES an Edit into a lane another session has DECLARED it is working in', () => {
    const msg = laneGuardDecision(LANE_FILE, WE_ROOT, { lease: occupiedBy('sess-OTHER'), mySessionId: 'sess-MINE' });
    expect(msg).toMatch(/BLOCKED/);
    expect(msg).toMatch(/DIFFERENT session has declared it is working in/);
    expect(msg).toMatch(/occupant session sess-OTHER/);
  });

  it('the deny NAMES the holder and the remedy — a bare refusal is the next false-deny footgun (#2986/#2994)', () => {
    const msg = laneGuardDecision(LANE_FILE, WE_ROOT, { lease: occupiedBy('sess-OTHER'), mySessionId: 'sess-MINE' });
    expect(msg).toContain('status --json --leased-only');
    expect(msg).toMatch(/leased by Mac:39423 \(review-1222-r2\)/); // who holds it
    expect(msg).toMatch(/lane-pool\.mjs acquire/);                  // what to do instead
    expect(msg).toMatch(/adopt --lane=N/);                          // …or claim it, if it was handed to you
    expect(msg).toMatch(/release --lane=N --force/);                // and how to reclaim a stale one
  });

  it('MUST-ALLOW: the lane I adopted is untouched — no new friction on the normal flow', () => {
    expect(laneGuardDecision(LANE_FILE, WE_ROOT, { lease: occupiedBy('sess-MINE'), mySessionId: 'sess-MINE' })).toBe(null);
  });

  // ── THE r2 REGRESSION FIXTURE (independent review of PR #1234, F1) ──────────────────────────────────────
  //
  // `acquire` stamps `ownerSession` from the env of the process that RUNS it. When an operator leases lane-N
  // and hands it to a spawned agent, that field holds the DISPATCHER's id and the working agent's id is a
  // THIRD STRING — neither the lease's `ownerSession` nor anything else in the marker. The first cut of this
  // arm compared `ownerSession` against the working session, so it read FOREIGN for the lane's own legitimate
  // occupant and would have made EVERY dispatched lane read-only for the agent sent to work in it (the lease's
  // own `purpose` naming that very agent). No fixture had this shape, which is why the gate stayed green.
  describe('a lease whose ownerSession is a THIRD PARTY to the working session', () => {
    it('MUST-ALLOW: the dispatched worker, in the lane leased FOR it, is not locked out', () => {
      // The live shape: operator session D ran `acquire --purpose=review-1234`; worker session W was then sent
      // to work there. W is neither D nor anyone else on the marker, and W is the lane's rightful occupant.
      const dispatched = leaseOf('sess-DISPATCHER', { purpose: 'review-1234' });
      expect(laneGuardDecision(LANE_FILE, WE_ROOT, { lease: dispatched, mySessionId: 'sess-WORKER' })).toBe(null);
    });

    it('MUST-ALLOW even once the worker has adopted it — the occupant stamp is what the guard reads', () => {
      const adopted = leaseOf('sess-DISPATCHER', { purpose: 'review-1234', workerSession: 'sess-WORKER' });
      expect(laneGuardDecision(LANE_FILE, WE_ROOT, { lease: adopted, mySessionId: 'sess-WORKER' })).toBe(null);
    });

    it('…and only THEN does a third session get refused — the declaration is what arms the deny', () => {
      const adopted = leaseOf('sess-DISPATCHER', { purpose: 'review-1234', workerSession: 'sess-WORKER' });
      expect(laneGuardDecision(LANE_FILE, WE_ROOT, { lease: adopted, mySessionId: 'sess-INTRUDER' })).toMatch(/BLOCKED/);
      // …including the dispatcher itself, which leased the lane but is not the one working in it.
      expect(laneGuardDecision(LANE_FILE, WE_ROOT, { lease: adopted, mySessionId: 'sess-DISPATCHER' })).toMatch(/BLOCKED/);
    });
  });

  it('RULED (#2997): a lane with NO live lease stays writable — the lease IS the ownership signal', () => {
    expect(laneGuardDecision(LANE_FILE, WE_ROOT, { lease: null, mySessionId: 'sess-MINE' })).toBe(null);
    expect(laneGuardDecision(LANE_FILE, WE_ROOT, {})).toBe(null);        // no ctx at all (the 2-arg callers)
    expect(laneGuardDecision(LANE_FILE, WE_ROOT)).toBe(null);
  });

  it('RESIDUAL 1 (deliberate): a lease with NO declared occupant is fail-OPEN, however foreign its ownerSession', () => {
    expect(laneGuardDecision(LANE_FILE, WE_ROOT, { lease: leaseOf('sess-OTHER'), mySessionId: 'sess-MINE' })).toBe(null);
  });

  it('DEGRADED (no session id on this side) stays fail-OPEN, as isForeignOccupancy specifies', () => {
    expect(laneGuardDecision(LANE_FILE, WE_ROOT, { lease: occupiedBy('sess-OTHER'), mySessionId: null })).toBe(null);
    expect(laneGuardDecision(LANE_FILE, WE_ROOT, { lease: occupiedBy(''), mySessionId: 'sess-MINE' })).toBe(null);
  });

  it('the PRIMARY refusal still wins and is unchanged — no existing deny is weakened by the new arm', () => {
    // A primary path is not in a lane, so the lease arm cannot fire; the #2123 message must survive intact.
    const msg = laneGuardDecision(p('webeverything', 'scripts', 'x.mjs'), WE_ROOT, { lease: occupiedBy('sess-OTHER'), mySessionId: 'sess-MINE' });
    expect(msg).toMatch(/shared PRIMARY checkout/);
    expect(msg).not.toMatch(/declared it is working in/);
  });

  it('applies to a lane in ANY pool, not just web-everything', () => {
    const plateauFile = p('.lanes', 'plateau-app', 'lane-2', 'src', 'a.ts');
    expect(laneGuardDecision(plateauFile, WE_ROOT, { lease: occupiedBy('sess-OTHER'), mySessionId: 'sess-MINE' })).toMatch(/BLOCKED/);
  });
});

// The impure half: the CLI wrapper must locate the lease from the TARGET PATH (an Edit names its own file;
// the reported cwd is unreliable, #2335) and treat a STALE lease as no lease.
describe('#2997 Gap 1 — the guard-lane CLI reads the target lane\'s lease off disk', () => {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'guard-lane-lease-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const lane = path.join(root, '.lanes', 'web-everything', 'lane-4');
  const target = path.join(lane, 'scripts', 'x.mjs');
  const runHook = (lease, sessionId) => {
    mkdirSync(path.join(lane, '.git'), { recursive: true });
    mkdirSync(path.join(lane, 'scripts'), { recursive: true });
    writeFileSync(target, '// x\n');
    if (lease) writeFileSync(path.join(lane, '.git', '.lane-lease'), JSON.stringify(lease));
    else rmSync(path.join(lane, '.git', '.lane-lease'), { force: true });
    const guard = path.join(realpathSync(path.join(here, '..')), 'guard-lane.mjs');
    const res = spawnSync(process.execPath, [guard], {
      input: JSON.stringify({ tool_input: { file_path: target } }),
      env: { ...process.env, CLAUDE_CODE_SESSION_ID: sessionId, LANE_GUARD_OFF: '' },
      encoding: 'utf8',
    });
    return { code: res.status, err: res.stderr || '' };
  };
  const liveLease = (workerSession, ownerSession = 'sess-DISPATCHER') => ({
    session: 'Mac:39423', purpose: 'review-1222-r2', acquiredAt: new Date(Date.now() - 60_000).toISOString(),
    ttlMinutes: 240, ownerSession, ...(workerSession ? { workerSession } : {}),
  });

  it('EXITS 2 (deny) for a write into a lane another session has declared it occupies', () => {
    const r = runHook(liveLease('sess-OTHER'), 'sess-MINE');
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/DIFFERENT session has declared it is working in/);
  });

  it('exits 0 (allow) for the SAME write when I am the declared occupant', () => {
    expect(runHook(liveLease('sess-MINE'), 'sess-MINE').code).toBe(0);
  });

  // The r2 regression, end-to-end through the real hook: the lease was minted by a dispatcher and nobody has
  // declared occupancy, so the working agent — whose id matches nothing on the marker — must still be allowed.
  it('exits 0 (allow) for the dispatched worker in a lane leased by a THIRD session (review F1)', () => {
    expect(runHook(liveLease(null, 'sess-DISPATCHER'), 'sess-WORKER').code).toBe(0);
  });

  it('exits 0 (allow) when the foreign occupancy is on a STALE lease — a stale lease is no live hold', () => {
    const stale = { ...liveLease('sess-OTHER'), acquiredAt: '2020-01-01T00:00:00.000Z' };
    expect(runHook(stale, 'sess-MINE').code).toBe(0);
  });

  it('exits 0 (allow) when the lane holds no lease at all (the #2997 ruling)', () => {
    expect(runHook(null, 'sess-MINE').code).toBe(0);
  });
});

// #3107 (PR #1286 bounce) — OWED prevention test: run the delivery-loop.md review-spawn RECIPE's
// acquire→derive→spawn shape for real through the actual `adopt` CLI + the actual `guard-lane.mjs` hook (not
// just the pure decision), and assert the reviewer's own subsequent Edit SUCCEEDS.
//
// The recipe has THREE actors sharing one lane: a DRIVER that leases it, and a headless REVIEWER — spawned
// under a DIFFERENT, later-DERIVED `CLAUDE_CODE_SESSION_ID` — that is the one who actually edits. Before the
// #3107 fix, the doc had the DRIVER pass `--adopt` on its OWN acquire call, which stamps the CALLING
// process (the driver) as `workerSession` — so when the reviewer, running under its derived id, made its
// first Edit, `isForeignOccupancy` read it as a DIFFERENT session occupying the lane and `guard-lane.mjs`
// BLOCKED it (confirmed against `laneGuardDecision` directly in the bounce). The fix: the driver's acquire
// carries NO `--adopt`; the reviewer instead runs `lane-pool.mjs adopt --lane=N` itself, as its first act,
// under its own derived id — the dispatcher→worker hand-off `adopt` was built for (#2997 r2).
//
// Step 1 (the driver's `acquire --purpose=review-1234 --json`, no `--adopt`) is reproduced by writing the
// lease marker with the exact shape `tryClaimLane`'s `bodyFor` mints for an unadopted acquire (`workerSession:
// null`) — acquire's own reap pass shells out to `gh`/`git` against a real remote, which a hermetic unit test
// must not depend on. Steps 3 (`adopt`) and the guard check run through the REAL CLI scripts, unmocked — the
// exact two commands the fixed doc tells the reviewer to run.
describe('#3107 — the delivery-loop.md review-spawn recipe: driver acquires (no --adopt), reviewer self-adopts', () => {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'guard-lane-recipe-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const poolRoot = path.join(root, '.lanes');
  const lane = path.join(poolRoot, 'web-everything', 'lane-9');
  const target = path.join(lane, 'scripts', 'reviewed.mjs');
  const leaseFile = path.join(lane, '.git', '.lane-lease');
  const laneCliDir = realpathSync(path.join(here, '..'));

  const DRIVER = 'sess-DRIVER';
  // Step 2's `deriveSessionId("rv-1234-r1")` output stands in for the reviewer's own, distinct id.
  const REVIEWER = 'sess-REVIEWER-rv-1234-r1-derived';

  const runLanePool = (args, sessionId) =>
    spawnSync(process.execPath, [path.join(laneCliDir, 'lane-pool.mjs'), ...args, `--pool=web-everything`], {
      env: { ...process.env, CLAUDE_CODE_SESSION_ID: sessionId, LANE_POOL_ROOT: poolRoot },
      encoding: 'utf8',
    });
  const runGuard = (sessionId) => {
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, '// x\n');
    const res = spawnSync(process.execPath, [path.join(laneCliDir, 'guard-lane.mjs')], {
      input: JSON.stringify({ tool_input: { file_path: target } }),
      env: { ...process.env, CLAUDE_CODE_SESSION_ID: sessionId, LANE_GUARD_OFF: '' },
      encoding: 'utf8',
    });
    return { code: res.status, err: res.stderr || '' };
  };

  it('step 1 fixture: the DRIVER acquired without --adopt — no occupant declared yet', () => {
    mkdirSync(path.dirname(leaseFile), { recursive: true });
    writeFileSync(leaseFile, JSON.stringify({
      session: 'driver-review-1234', purpose: 'review-1234',
      acquiredAt: new Date().toISOString(), ttlMinutes: 240,
      ownerSession: DRIVER, holder: 'review-1234-lane-9-abcd1234',
      workerSession: null, // the #3107 fix: no --adopt at driver-acquire time
    }));
    expect(runGuard(REVIEWER).code).toBe(0); // fail-open pre-adopt (RESIDUAL 1) — not yet the assertion under test
  });

  it('step 3: the spawned REVIEWER runs `adopt --lane=9` itself, under its OWN derived session id', () => {
    const res = runLanePool(['adopt', '--lane=9', '--json'], REVIEWER);
    expect(res.status, res.stderr).toBe(0);
    expect(JSON.parse(res.stdout).workerSession).toBe(REVIEWER);
  });

  it('OWED prevention: the reviewer\'s own subsequent Edit now SUCCEEDS — the #3107 bounce is closed', () => {
    expect(runGuard(REVIEWER).code).toBe(0);
  });

  it('and the guard still refuses every OTHER session — including the driver that only ran acquire', () => {
    const driver = runGuard(DRIVER);
    expect(driver.code).toBe(2);
    expect(driver.err).toMatch(/DIFFERENT session has declared it is working in/);
    expect(runGuard('sess-INTRUDER').code).toBe(2);
  });
});

// End-to-end path classification through a real symlink chain — the exact shape that let the interactive
// memory hole exist: `~/.claude/projects/<slug>/memory` → `<repo>/.claude/agent-memory` → `agent-memory-src`.
describe('resolveReal + decision through the user-level memory symlink', () => {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'guard-lane-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('a write via the ~/.claude/.../memory symlink is DENIED as a primary memory edit', () => {
    const weRoot = path.join(root, 'webeverything');
    mkdirSync(path.join(weRoot, 'agent-memory-src'), { recursive: true });
    mkdirSync(path.join(weRoot, '.claude'), { recursive: true });
    // <repo>/.claude/agent-memory → ../agent-memory-src
    symlinkSync('../agent-memory-src', path.join(weRoot, '.claude', 'agent-memory'));
    // ~/.claude/projects/<slug>/memory → <repo>/.claude/agent-memory
    const projMem = path.join(root, 'home', '.claude', 'projects', 'slug');
    mkdirSync(projMem, { recursive: true });
    symlinkSync(path.join(weRoot, '.claude', 'agent-memory'), path.join(projMem, 'memory'));
    // an existing sibling memory file so realpath can resolve the dir for a not-yet-existing target
    writeFileSync(path.join(weRoot, 'agent-memory-src', 'existing.md'), '# x\n');

    const target = path.join(projMem, 'memory', 'new-rule.md'); // does not exist yet
    const real = resolveReal(target);
    expect(real).toContain(`${path.sep}webeverything${path.sep}agent-memory-src${path.sep}`);
    expect(laneGuardDecision(real, weRoot)).toMatch(/Agent memory is git-tracked/);
  });
});

// #xpt9fvd — a resident daemon's OWN dedicated clone gets the SAME protection a primary checkout already
// has. Three times on 2026-09-26 a worker hand-edited/copied files INSIDE wev-review-daemon (caught +
// reverted each time); a dirty daemon clone BLOCKS that daemon's own rebuild until a person notices.
describe('laneGuardDecision — DAEMON CLONE protection (#xpt9fvd)', () => {
  const daemonRoots = daemonCloneRoots(WORKSPACE);

  it('DENIES an Edit/Write into a daemon clone (wev-review-daemon)', () => {
    const msg = laneGuardDecision(p('wev-review-daemon', 'notes.md'), WE_ROOT, { daemonCloneRoots: daemonRoots });
    expect(msg).toMatch(/BLOCKED/);
    expect(msg).toMatch(/DAEMON CLONE/);
    expect(msg).toMatch(/daemon-overlay\.mjs add --clone=/);
  });

  it('DENIES into every seeded daemon clone, not just one', () => {
    for (const name of ['wev-merge-daemon', 'wev-health-watch', 'wev-host-sampler', 'plateau-drain-daemon']) {
      expect(laneGuardDecision(p(name, 'x.md'), WE_ROOT, { daemonCloneRoots: daemonRoots }), name).toMatch(/DAEMON CLONE/);
    }
  });

  // THE STRUCTURAL REGRESSION THIS ARM EXISTS TO CLOSE: the WE drain's own dedicated clone sits UNDER
  // `.lanes/`, which the ordinary lane-clone test (`inLane` — a bare `/.lanes/` substring test) would read as
  // an ordinary pool lane and allow outright, exactly like any freshly-acquired lane. The daemon-clone check
  // must win BEFORE that shortcut, since this path also satisfies `inLane`.
  it('DENIES the drain clone under .lanes/ — the ordinary lane-clone allow-shortcut must NOT swallow it', () => {
    const drainFile = p('.lanes', 'we-drain-daemon', 'lane-1', 'scripts', 'x.mjs');
    expect(drainFile).toContain(`${path.sep}.lanes${path.sep}`); // sanity: this path WOULD read as an ordinary lane
    const msg = laneGuardDecision(drainFile, WE_ROOT, { daemonCloneRoots: daemonRoots });
    expect(msg).toMatch(/BLOCKED/);
    expect(msg).toMatch(/DAEMON CLONE/);
  });

  it('ALLOWS an ordinary pool lane one directory over — the daemon-clone test does not over-match', () => {
    const ordinaryLane = p('.lanes', 'web-everything', 'lane-7', 'scripts', 'x.mjs');
    expect(laneGuardDecision(ordinaryLane, WE_ROOT, { daemonCloneRoots: daemonRoots })).toBeNull();
  });

  it('ALLOWS a daemon clone with NO registry roots configured — never blocks on an empty list', () => {
    expect(laneGuardDecision(p('wev-review-daemon', 'notes.md'), WE_ROOT, { daemonCloneRoots: [] })).toBeNull();
    expect(laneGuardDecision(p('wev-review-daemon', 'notes.md'), WE_ROOT)).toBeNull(); // default: []
  });

  it('there is NO LANE_GUARD_OFF-style escape hatch advertised for a daemon clone', () => {
    const msg = laneGuardDecision(p('wev-review-daemon', 'notes.md'), WE_ROOT, { daemonCloneRoots: daemonRoots });
    expect(msg).not.toMatch(/LANE_GUARD_OFF/);
  });
});

// The impure half, through the REAL CLI: a clone registered ONLY via the overlay-state directory (no seed
// entry needed) is protected too — proof that "derive from the registry" actually reaches the hook, not just
// the hard-coded seed list.
describe('#xpt9fvd — the guard-lane CLI protects a clone discovered via the daemon-overlay registry', () => {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'guard-lane-daemon-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const overlayDir = path.join(root, 'overlay-state');
  const fakeClone = path.join(root, 'some-new-daemon-clone'); // deliberately NOT in DAEMON_CLONE_SEED
  mkdirSync(overlayDir, { recursive: true });
  mkdirSync(fakeClone, { recursive: true });
  writeFileSync(path.join(overlayDir, 'abc123.json'), JSON.stringify({ clone: fakeClone, overlays: [] }));

  const runHook = (targetFile) => {
    mkdirSync(path.dirname(targetFile), { recursive: true });
    writeFileSync(targetFile, '// x\n');
    const guard = path.join(realpathSync(path.join(here, '..')), 'guard-lane.mjs');
    const res = spawnSync(process.execPath, [guard], {
      input: JSON.stringify({ tool_input: { file_path: targetFile } }),
      env: { ...process.env, WE_DAEMON_OVERLAY_DIR: overlayDir, LANE_GUARD_OFF: '' },
      encoding: 'utf8',
    });
    return { code: res.status, err: res.stderr || '' };
  };

  it('EXITS 2 (deny) for an Edit into a clone that is registered ONLY in the overlay state dir', () => {
    const r = runHook(path.join(fakeClone, 'notes.md'));
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/DAEMON CLONE/);
  });

  it('exits 0 (allow) for an unrelated file elsewhere', () => {
    expect(runHook(path.join(root, 'unrelated', 'x.md')).code).toBe(0);
  });
});
