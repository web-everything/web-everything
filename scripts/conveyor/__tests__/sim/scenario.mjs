/**
 * @file scenario.mjs — epic #3383 part 4 (Runner + DSL + snapshot + isolation check).
 *
 * `scenario(name, def)` just tags a definition object; `runScenario(def, {timeoutMs, budgetMs})` builds a `World`
 * (`./world.mjs`), runs `def.setup(w)`, steps through `def.play`, takes a SNAPSHOT, runs `def.expect(snapshot,
 * ctx)`, then — always, on the throwing path too — tears every daemon host down, runs the ISOLATION CHECK
 * against the real `$HOME` state this simulator must never touch, and cleans up the world.
 * `timeoutMs` bounds each daemon tick (default 60_000ms); optional `budgetMs` bounds the entire play list,
 * including world/setup time (default Infinity, no whole-scenario budget). Step timings are always recorded.
 *
 * Play steps:
 *   - `'tick <daemon>'`      — lazily boot that daemon's host if it isn't already running, send it one
 *                              `{type:'tick'}`, and wait for its reply.
 *   - `'advance <dur>'`      — jump the sim clock (`clock.mjs#parseDurationMs` grammar, e.g. `'31m'`).
 *   - `'agents'`             — one `agent-actions.mjs#stepSessions` round.
 *   - `'restart <daemon>'`   — kill that daemon's host right now (an operator-initiated restart / a crash);
 *                              the next `'tick <daemon>'` step lazily reboots it.
 *   - `(w) => ...`           — an arbitrary mid-scenario world mutation (a human pushing to main, etc).
 */

import { fork } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createWorld } from './world.mjs';
import { stepSessions } from './agent-actions.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DAEMON_HOST_PATH = resolve(HERE, 'daemon-host.mjs');

/** Tag a scenario definition with its name — no other behaviour; `runScenario` reads `def` directly, so a
 *  scenario file can also just export a plain `{repos, daemons, lanes, setup, play, expect}` object. */
export function scenario(name, def) {
  if (!name || typeof name !== 'string') throw new Error('scenario: a name is required');
  return { name, ...def };
}

/** The same `*`-only glob semantics `fake-claude.mjs`/`agent-actions.mjs` already use — duplicated in
 *  miniature (3 lines) rather than exported from either, since neither file's own surface promises it. */
function matchGlob(pattern, value) {
  const escaped = String(pattern).split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${escaped}$`).test(String(value ?? ''));
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────────────
// isolation check — real state this simulator must NEVER touch, whatever the scenario does.
// ──────────────────────────────────────────────────────────────────────────────────────────────────────────

const REAL_HOME = homedir();
/** `depth`: how many path levels deep this check looks for a genuinely NEW entry — see the long comment
 *  below on why this is shallow rather than a full recursive tree diff. */
const WATCHED_REAL_DIRS = Object.freeze([
  { dir: join(REAL_HOME, '.claude', 'conveyor-runner-locks'), depth: 1 },
  { dir: join(REAL_HOME, '.claude', 'drain-locks'), depth: 1 },
  { dir: join(REAL_HOME, '.claude', 'daemon-self-sync-state'), depth: 1 },
  { dir: join(REAL_HOME, 'workspace', '.lanes'), depth: 2 },
]);

/**
 * SHALLOW, NEW-ENTRIES-ONLY, not a full recursive mtime diff — a deliberate narrowing, found necessary by
 * running this exact check on a real development machine (live-observed 2026-09-24, this task's own build):
 * this repo's OWN epic #3383 daemons (`review-daemon.mjs`, `reconcile-fix-dispatch-daemon.mjs`, several
 * `pass-daemon.mjs --pass=...` watchers) are ACTIVELY RUNNING IN PRODUCTION on the very machine this simulator
 * runs on, ticking on their own real ~30–120s cadence against the REAL `~/.claude/conveyor-runner-locks` and
 * the REAL `~/workspace/.lanes` — plus other real lanes' agents committing real work, running real tests, and
 * writing real scratch files inside their own already-existing `lane-N` directories, all the while. A full
 * recursive "did any mtime change anywhere under these roots" diff is permanently red on a machine like this
 * one, REGARDLESS of the simulator's own correctness — it is indistinguishable from real, wanted, ambient
 * production activity that has nothing to do with this test.
 *
 * What a REAL leak from this simulator would actually look like, by construction, is different and much
 * narrower: our sandboxed world only ever hands its own child processes an OVERRIDDEN `HOME`/`LANE_POOL_ROOT`
 * (`world.mjs`'s merged `env`), so nothing this simulator spawns can address the real
 * `conveyor-runner-locks`/`drain-locks`/`daemon-self-sync-state` paths AT ALL — no code path here ever calls
 * `acquireRunnerLease`/`heartbeatRunnerLease` for real, so those three directories should NEVER gain a
 * genuinely NEW top-level entry (a new lease-key hash directory) because of anything this simulator does,
 * even though their EXISTING entries churn constantly and legitimately. Likewise a leak into the real lane
 * pool would show up as a brand-new POOL NAME or a brand-new `lane-N` INDEX under one of the three
 * constellation pools — not as a file changing inside a lane that already existed before this scenario ran.
 * So the check below looks ONLY for a path that did not exist at all before, at a SHALLOW depth (one level
 * for the `.claude/*` roots — a new lease-key directory; two levels for the lane pool root — a new pool name,
 * or a new lane-N/other entry within an existing pool), and ignores deeper churn entirely.
 *
 * The one further narrowing: `lane-pool.mjs`'s own `list --acquirable` machinery (used by EVERY real caller
 * on this machine, several of them observed running concurrently) creates a transient `.list-acquirable.lock`
 * directory and a `.list-acquirable-cache.json` file directly under each pool — real, shared concurrency
 * primitives this simulator's sandboxed `LANE_POOL_ROOT` never touches, so a `before`/`after` pair straddling
 * a real concurrent scan can otherwise read as a false "NEW" lock. Ignored by name for the same reason the
 * paragraph above ignores deeper churn: it cannot be this simulator, by construction.
 */
const IGNORED_LANE_POOL_NAMES = /^\.list-acquirable/;

function listShallow(root, depth) {
  const out = new Set();
  if (!existsSync(root)) return out;
  const walk = (dir, prefix, remaining) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      out.add(rel);
      if (e.isDirectory() && remaining > 1) walk(join(dir, e.name), rel, remaining - 1);
    }
  };
  walk(root, '', depth);
  return out;
}

function snapshotRealState() {
  return WATCHED_REAL_DIRS.map(({ dir, depth }) => ({ dir, depth, entries: listShallow(dir, depth) }));
}

/** @returns {string[]} human-readable problems, empty when clean. */
function diffRealState(before, after) {
  const problems = [];
  for (let i = 0; i < WATCHED_REAL_DIRS.length; i += 1) {
    const { dir } = WATCHED_REAL_DIRS[i];
    const b = before[i]?.entries ?? new Set();
    const a = after[i]?.entries ?? new Set();
    for (const rel of a) {
      if (b.has(rel)) continue;
      if (IGNORED_LANE_POOL_NAMES.test(rel.split('/').pop())) continue;
      problems.push(`${dir}/${rel} is NEW`);
    }
  }
  return problems;
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────────────
// the runner
// ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** timeoutMs bounds each daemon tick; budgetMs optionally bounds the play list including world/setup time. */
export async function runScenario(def, { timeoutMs = 60_000, budgetMs = Infinity } = {}) {
  const deadline = Date.now() + budgetMs;
  const isolationBefore = snapshotRealState();
  const w = createWorld({ repos: def.repos, lanes: def.lanes ?? 3, clockStartOffsetMs: def.clockStartOffsetMs ?? 0 });

  const hosts = new Map(); // daemon name -> child process
  const hostTails = new Map(); // daemon name -> recent stdout/stderr (debugging only)
  const bootCounts = new Map(); // daemon name -> {boots, restarts}
  const trace = [];
  const stepTimings = [];

  function bump(name, field) {
    const c = bootCounts.get(name) ?? { boots: 0, restarts: 0 };
    c[field] += 1;
    bootCounts.set(name, c);
  }

  function tailFor(name) {
    if (!hostTails.has(name)) hostTails.set(name, []);
    return hostTails.get(name);
  }

  async function bootHost(name) {
    const child = fork(DAEMON_HOST_PATH, [], {
      cwd: w.simCloneRoot,
      env: { ...w.env, SIM_DAEMON_KIND: name, SIM_CLONE_ROOT: w.simCloneRoot },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    w.registerHost(child);
    const tail = tailFor(name);
    const capture = (chunk) => {
      tail.push(String(chunk));
      if (tail.length > 200) tail.shift();
    };
    child.stdout?.on('data', capture);
    child.stderr?.on('data', capture);

    await new Promise((res, rej) => {
      const onMsg = (msg) => {
        if (msg?.type === 'ready') { cleanupListeners(); res(); }
      };
      const onExit = (code) => { cleanupListeners(); rej(new Error(`daemon host "${name}" exited before ready (code ${code}) — recent output:\n${tail.join('')}`)); };
      const onErr = (e) => { cleanupListeners(); rej(e); };
      const timer = setTimeout(() => { cleanupListeners(); rej(new Error(`daemon host "${name}" did not become ready in time`)); }, 30_000);
      function cleanupListeners() {
        clearTimeout(timer);
        child.off('message', onMsg);
        child.off('exit', onExit);
        child.off('error', onErr);
      }
      child.on('message', onMsg);
      child.on('exit', onExit);
      child.on('error', onErr);
    });

    hosts.set(name, child);
    bump(name, 'boots');
    return child;
  }

  async function ensureHost(name) {
    return hosts.get(name) ?? bootHost(name);
  }

  async function tickDaemon(name) {
    const startedAt = Date.now();
    const child = await ensureHost(name);
    const tail = tailFor(name);
    const msg = await new Promise((res, rej) => {
      const onMsg = (m) => {
        if (!m || (m.type !== 'result' && m.type !== 'restart')) return;
        cleanupListeners();
        res(m);
      };
      const onExit = (code) => { cleanupListeners(); rej(new Error(`daemon host "${name}" exited mid-tick (code ${code}) — recent output:\n${tail.join('')}`)); };
      const timer = setTimeout(() => { cleanupListeners(); rej(new Error(`daemon "${name}" tick timed out after ${timeoutMs}ms`)); }, timeoutMs);
      timer.unref?.();
      function cleanupListeners() {
        clearTimeout(timer);
        child.off('message', onMsg);
        child.off('exit', onExit);
      }
      child.on('message', onMsg);
      child.on('exit', onExit);
      child.send({ type: 'tick' });
    });

    if (msg.type === 'restart') {
      hosts.delete(name);
      bump(name, 'restarts');
      trace.push({ daemon: name, restart: true, info: msg.info ?? null, logs: msg.logs ?? [], ms: Date.now() - startedAt });
      return;
    }
    trace.push({ daemon: name, result: msg.result ?? null, error: msg.error ?? null, onTickError: msg.onTickError ?? null, logs: msg.logs ?? [], ms: Date.now() - startedAt });
  }

  function buildAgentsCtx() {
    return {
      claude: w.claude,
      gh: w.gh.raw,
      repoFor: (session) => {
        const prompt = String(session?.prompt ?? '');
        for (const r of Object.values(w.repos)) if (prompt.includes(r.slug)) return r;
        return w.repos.we;
      },
      simClone: w.simCloneRoot,
      env: w.env,
      completionsDir: w.completionsDir,
      clock: w.clock,
    };
  }

  async function runStep(step) {
    // #4075 soak harness (x0zg44l) — a function step also gets a read-only view of the run so far, so a caller
    // (the soak runner, `we:scripts/conveyor/soak/soak.mjs`) can check invariants after EVERY tick instead of
    // only once at the end. Existing one-arg steps ignore the second argument.
    if (typeof step === 'function') { await step(w, { trace, snapshot: buildSnapshot }); return; }
    const s = String(step).trim();
    const mTick = /^tick\s+(\S+)$/.exec(s);
    if (mTick) { await tickDaemon(mTick[1]); return; }
    const mAdvance = /^advance\s+(\S+)$/.exec(s);
    if (mAdvance) { w.clock.advance(mAdvance[1]); return; }
    if (s === 'agents') {
      const stepped = await stepSessions(buildAgentsCtx());
      trace.push({ step: 'agents', stepped });
      return;
    }
    const mRestart = /^restart\s+(\S+)$/.exec(s);
    if (mRestart) {
      const name = mRestart[1];
      const child = hosts.get(name);
      if (child) { try { child.kill('SIGKILL'); } catch { /* already gone */ } hosts.delete(name); }
      trace.push({ daemon: name, killed: true });
      return;
    }
    throw new Error(`scenario: unrecognised play step ${JSON.stringify(step)}`);
  }

  // ── snapshot helpers ─────────────────────────────────────────────────────────────────────────────────
  function readLease(laneDir) {
    try { return JSON.parse(readFileSync(join(laneDir, '.git', '.lane-lease'), 'utf8')); } catch { return null; }
  }

  function listLanes() {
    const out = [];
    if (!existsSync(w.lanePoolRoot)) return out;
    for (const pool of readdirSync(w.lanePoolRoot)) {
      const poolDir = join(w.lanePoolRoot, pool);
      let entries;
      try { entries = readdirSync(poolDir); } catch { continue; }
      for (const e of entries) {
        if (!/^lane-\d+$/.test(e)) continue;
        const dir = join(poolDir, e);
        out.push({ pool, name: e, dir, lease: readLease(dir) });
      }
    }
    return out;
  }

  function listCompletions() {
    if (!existsSync(w.completionsDir)) return [];
    const out = [];
    for (const f of readdirSync(w.completionsDir)) {
      if (!f.endsWith('.json')) continue;
      try { out.push(JSON.parse(readFileSync(join(w.completionsDir, f), 'utf8'))); } catch { /* skip unreadable */ }
    }
    return out;
  }

  function buildSnapshot() {
    const prs = [];
    for (const repo of Object.values(w.repos)) {
      let list = [];
      try { list = w.gh.raw.prs(repo.slug); } catch { list = []; }
      for (const pr of list) {
        prs.push({
          repo: repo.key,
          number: pr.number,
          state: pr.state,
          labels: pr.labels.map((l) => l.name),
          merged: pr.state === 'MERGED',
          headRefOid: pr.headRefOid,
          comments: pr.comments.map((c) => String(c.body ?? '').split('\n')[0]),
        });
      }
    }
    const allSessions = w.claude.sessions();
    const lanes = listLanes();

    return {
      prs,
      leases: lanes,
      lanes: lanes.map((l) => l.dir),
      completions: listCompletions(),
      hosts: Object.fromEntries([...bootCounts.entries()]),
      trace: [...trace],
      ghCalls: w.gh.calls(),
      claudeCalls: w.claude.calls(),
      /** One PR, by number (and repo key, default `'we'`). */
      pr(number, repoKey = 'we') {
        return prs.find((p) => p.number === Number(number) && p.repo === repoKey) ?? null;
      },
      /** Every session whose name matches a `*`-glob (default `'*'` — everything). */
      sessions(glob = '*') {
        return allSessions.filter((sess) => matchGlob(glob, sess.name));
      },
      /** Every non-restart, non-kill tick trace entry for one daemon, in order. */
      ticks(daemon) {
        return trace.filter((t) => t.daemon === daemon && !t.killed && !t.restart);
      },
    };
  }

  let thrown = null;
  let snapshot = null;
  try {
    const ctx = def.setup ? (def.setup(w) ?? {}) : {};
    for (const [index, step] of (def.play ?? []).entries()) {
      const startedAt = Date.now();
      const label = `${typeof step === 'function' && step.name ? `fn ${step.name}: ` : ''}${String(step)}`
        .replace(/\s+/g, ' ').trim();
      const text = label.length > 100 ? `${label.slice(0, 99)}…` : label;
      const remaining = deadline - startedAt;
      const timeoutError = () => {
        const timings = [...stepTimings, { index, text, ms: Date.now() - startedAt }];
        const tail = [...hostTails].map(([name, chunks]) => `${name}:\n${chunks.join('')}`).join('\n');
        return new Error(`scenario "${def.name ?? '(unnamed)'}" timed out (budget ${budgetMs}ms) at step ${index}: ${text}\n`
          + `step timings (zero-based):\n${timings.map((t) => `${t.index}: ${t.text} → ${t.ms}ms`).join('\n')}\n`
          + `recent host output:\n${tail || '(none)'}`);
      };
      let timer;
      try {
        if (budgetMs === Infinity) {
          // eslint-disable-next-line no-await-in-loop -- scenario steps run in the author's declared order
          await runStep(step);
          continue;
        }
        if (remaining <= 0) throw timeoutError();
        // eslint-disable-next-line no-await-in-loop -- scenario steps run in the author's declared order
        await Promise.race([
          runStep(step),
          new Promise((_, reject) => { timer = setTimeout(() => reject(timeoutError()), remaining); }),
        ]);
        // Synchronous mutations can block the timer; still report an exhausted budget at this step.
        if (Date.now() >= deadline) throw timeoutError();
      } finally {
        clearTimeout(timer);
        stepTimings.push({ index, text, ms: Date.now() - startedAt });
      }
    }
    snapshot = buildSnapshot();
    if (def.expect) def.expect(snapshot, ctx);
  } catch (e) {
    thrown = e;
  }

  for (const child of hosts.values()) {
    // #3383 harness gap — same fix as `world.mjs#cleanup`'s own `.connected` guard: a host that exited on its
    // own (crashed) between its last tick and this teardown is still in `hosts` (nothing here tracks that),
    // and `.send()` on its already-closed IPC channel throws asynchronously, past a plain try/catch.
    try { if (child.connected) child.send({ type: 'shutdown' }, () => {}); } catch { /* best effort */ }
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
  hosts.clear();

  let isolationError = null;
  try {
    const problems = diffRealState(isolationBefore, snapshotRealState());
    if (problems.length) {
      isolationError = new Error(`scenario "${def.name ?? '(unnamed)'}" ISOLATION CHECK FAILED — real state was touched:\n${problems.join('\n')}`);
    }
  } catch (e) {
    isolationError = e;
  }

  w.cleanup();

  if (thrown) throw thrown;
  if (isolationError) throw isolationError;
  return snapshot;
}
