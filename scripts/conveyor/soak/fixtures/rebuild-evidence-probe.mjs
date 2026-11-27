/** Replay persisted writer output and legacy metadata through real rebuild admission. */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { createJobStore, enqueueJob } from '../../../lib/daemon-jobs-runtime.mjs';
import { markSucceeded } from '../../../lib/daemon-jobs.mjs';
import { rebuildCloneAsJob, buildRebuildJobResult, REBUILD_JOB_KIND, RESULT_SUFFIX } from '../../../lib/daemon-rebuild/rebuild-job.mjs';
import { createRebuildReaders } from '../../../lib/daemon-rebuild/evidence-readers.mjs';
import { overlayFilePath, appendOverlayEvent } from '../../../lib/daemon-overlays.mjs';
import { writeRebuildState, readRebuildState } from '../../../lib/daemon-rebuild/state.mjs';
import { envTimeoutAppliesToPlan } from '../../../lib/daemon-rebuild/recovery.mjs';
import { spawnSync } from 'node:child_process';
import { addOverlay } from '../../../lib/daemon-overlays.mjs';
import { readReadyCandidate, readyCandidatePath } from '../../../lib/daemon-rebuild/state.mjs';
import { matchReadyCandidate } from '../../../lib/daemon-rebuild/adopt.mjs';
import { rebuildClone } from '../../../lib/daemon-rebuild/rebuild.mjs';
import { acquireRead, releaseRead } from '../../../lib/daemon-clone-lock.mjs';
import { claimBuildLease, releaseBuildLease } from '../../../lib/daemon-rebuild/lease.mjs';
import { watchPath, readForceWatch } from '../../../lib/daemon-force-adopt.mjs';

/** Pre-upgrade JSON through strict job admission and the production adoption matcher; no Git writes. */
export async function probeLegacyReadyAdmission(kind = 'candidate') {
  const root = mkdtempSync(join(tmpdir(), 'legacy-ready-'));
  const env = { WE_DAEMON_REBUILD_STRICT_EVIDENCE: '1', WE_DAEMON_STATE_DIR: join(root, 'state'),
    WE_DAEMON_OVERLAY_DIR: join(root, 'overlays') };
  try {
    const file = readyCandidatePath(root, env);
    const ready = { kind, prevHead: 'head', tree: 'tree', passedAt: new Date(1000).toISOString(),
      adopt: { finalSha: 'target', inputsKey: 'inputs', mainSha: 'main', applied: [] },
      ...(kind === 'fallback' ? { forInputsKey: 'inputs', dropRefs: [], failed: '' } : {}) };
    const bytes = JSON.stringify(ready);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, bytes);
    const store = createJobStore(join(root, 'jobs'));
    const readers = createRebuildReaders({ strict: true });
    let match, forced, reattachments = 0;
    const result = await rebuildCloneAsJob({ root, env, store, launchedBy: 'tick-start', now: () => 1001,
      adopt: async () => {
        readers.validate(root, env);
        const record = readers.ready(root, env);
        forced = record.forced;
        const matched = matchReadyCandidate({ ready: record, plan: ready.adopt, prevHead: ready.prevHead,
          treeOf: () => ready.tree, stillWanted: () => true, verifyBuilt: () => true,
          nowMs: 1001, maxAgeMs: 60_000 });
        match = matched.match;
        return { adopted: Boolean(matched.adopt), reason: matched.reason };
      },
      reattach: async () => { reattachments += 1; }, evict() {}, log: { error() {} } });
    return { adopted: result.adopted === true, reason: result.reason, match, forced, reattachments,
      jobs: store.list().records.length, preserved: readFileSync(file, 'utf8') === bytes };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

/** Real watch/finalization and disk reads; Git is injected so no checkout is moved. */
export async function probeNullableRollback(planKeys = { inputsKey: null, mainSha: null }) {
  const root = mkdtempSync(join(tmpdir(), 'nullable-rollback-'));
  const previousLockRoot = process.env.WE_DAEMON_CLONE_LOCK_ROOT;
  process.env.WE_DAEMON_CLONE_LOCK_ROOT = join(root, 'locks');
  const env = { WE_DAEMON_REBUILD_STRICT_EVIDENCE: '1', WE_DAEMON_STATE_DIR: join(root, 'state'),
    WE_DAEMON_OVERLAY_DIR: join(root, 'overlays'), WE_FORCE_ADOPT_HANDOFF: join(root, 'handoff.md'),
    WE_FORCE_ADOPT_CORONER: join(root, 'coroner.jsonl') };
  const good = 'a'.repeat(40), bad = 'b'.repeat(40);
  let head = bad;
  const resets = [], snapshots = [], errors = [], events = [];
  const readers = createRebuildReaders({ strict: true });
  const run = args => {
    if (args[0] === 'rev-parse' && args.at(-1) === 'HEAD') return { status: 0, stdout: head };
    if (args[0] === 'rev-parse' && args.at(-1) === 'MERGE_HEAD') return { status: 1, stdout: '' };
    if (['status', 'ls-files', 'cat-file', 'rev-list'].includes(args[0])) return { status: 0, stdout: '' };
    if (args[0] === 'reset' && args[1] === '--hard') {
      head = args[2]; resets.push(head);
      // Observe the persisted intermediate record without changing control flow.
      try { snapshots.push(readers.state(root, env).inProgress); }
      catch (error) { errors.push(error.cause?.message ?? error.message); }
      return { status: 0, stdout: '' };
    }
    const error = `Unexpected rollback Git call: ${args.join(' ')}`;
    errors.push(error);
    throw new Error(error);
  };
  try {
    writeRebuildState(root, { adopted: { head: bad, inputsKey: 'bad', mainSha: bad,
      applied: [], at: new Date(0).toISOString() } }, env);
    writeFileSync(watchPath(root, env), JSON.stringify({ daemon: 'health-watch', ruling: 'R1035',
      sha: bad, startedAt: new Date(0).toISOString(), ticksLeft: 3, bad: 0,
      lastGood: { head: good, applied: [], ...planKeys } }));
    const result = await rebuildClone({ root, env, asJob: false, versions: null, run,
      forceWatchProbe: async () => ({ healthy: false }), emitEvent: event => events.push(event),
      log: { error: message => errors.push(message) } });
    let state;
    try { state = readers.state(root, env); } catch (error) { errors.push(error.cause?.message ?? error.message); }
    return { result, head, good, resets, snapshots, errors, events, state, watch: readForceWatch(root, env) };
  } finally {
    if (previousLockRoot === undefined) delete process.env.WE_DAEMON_CLONE_LOCK_ROOT;
    else process.env.WE_DAEMON_CLONE_LOCK_ROOT = previousLockRoot;
    rmSync(root, { recursive: true, force: true });
  }
}

/** Torn job sidecars cannot wedge default ticks; unattended children retain abandoned worktrees for cleanup. */
export async function probeTickCompatibility() {
  const root = mkdtempSync(join(tmpdir(), 'rebuild-tick-compatibility-'));
  const env = { WE_DAEMON_STATE_DIR: join(root, 'state') };
  const run = (args) => {
    const result = spawnSync('git', ['-c', 'user.name=soak', '-c', 'user.email=soak@example.invalid', ...args],
      { cwd: root, encoding: 'utf8', timeout: 10_000, maxBuffer: 65536 });
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  };
  const git = args => { const r = run(args); if (r.status !== 0) throw new Error(r.stderr); return r.stdout; };
  const violations = [];
  try {
    for (const fault of ['job', 'consumed', 'result']) {
      const store = createJobStore(join(root, fault)); mkdirSync(store.dir);
      const old = enqueueJob({ store, kindDef: REBUILD_JOB_KIND, codeSha: 'a'.repeat(40), input: { root }, now: 1000 });
      store.update(old.id, r => markSucceeded(r, { at: new Date(1000).toISOString() }));
      const file = join(store.dir, fault === 'job' ? old.id + '.json' : fault === 'consumed' ? 'consumed.json' : old.id + RESULT_SUFFIX);
      writeFileSync(file, '{torn');
      const result = await rebuildCloneAsJob({ root, env, store, now: () => 2000, log: { error() {} },
        adopt: async () => ({ moved: true, adopted: true }), reattach: async () => {}, evict() {} });
      if (!result.adopted) violations.push(`torn ${fault} blocked tick adoption`);
    }
    git(['init', '-q', '-b', 'main']);
    git(['commit', '--allow-empty', '-qm', 'fixture']);
    const path = join(root, 'abandoned');
    git(['worktree', 'add', '--detach', path, 'HEAD']);
    const state = { building: { token: 'abandoned', pid: process.pid, host: hostname(),
      startedAt: new Date(0).toISOString(), path } };
    const options = { root, env, run, state, nowMs: 1000, plan: { finalSha: git(['rev-parse', 'HEAD']).trim(), inputsKey: 'next' } };
    const early = claimBuildLease({ ...options, cleanupAbandoned: false });
    if (early || state.building?.path !== path) violations.push('early claim forgot abandoned worktree');
    if (early) releaseBuildLease(state, early);
    const tick = claimBuildLease(options);
    if (existsSync(path) || git(['worktree', 'list', '--porcelain']).includes(path)) violations.push('tick left abandoned worktree registered');
    if (tick) releaseBuildLease(state, tick);
    return { violations };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

/** Real Git: publish a smoke-passed pinned candidate, move its tip, then run tick-start. */
export async function probeStalePinnedReady({ auditedOnly = false, fastForward = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'stale-ready-soak-'));
  const root = join(dir, 'clone'), author = join(dir, 'author'), origin = join(dir, 'origin.git');
  const env = { ...process.env, HOME: dir, WE_DAEMON_STATE_DIR: join(dir, 'state'),
    WE_DAEMON_SMOKE_STATE_DIR: join(dir, 'smoke-slots'),
    WE_DAEMON_OVERLAY_DIR: join(dir, 'overlays'), WE_DAEMON_CLONE_LOCK_ROOT: join(dir, 'locks'),
    WE_DAEMON_OVERLAY_FOLLOW_TIP: 'follow', WE_DAEMON_REBUILD_SKIP_UNRELATED: '0',
    WE_DAEMON_OVERLAY_EDGE_RESOLVE: '0', WE_DAEMON_AUTO_REBASE: '0', WE_DAEMON_REBUILD_STRICT_EVIDENCE: '1' };
  const git = (cwd, args) => {
    const r = spawnSync('git', ['-c', 'user.name=soak', '-c', 'user.email=soak@example.invalid', ...args],
      { cwd, encoding: 'utf8', timeout: 20_000, maxBuffer: 65536, env: { ...env, GIT_OPTIONAL_LOCKS: '0' } });
    if (r.status !== 0) throw new Error(`fixture git ${args[0]}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const pass = { verdict: 'pass', attempts: 1, smoke: { results: [] } };
  const lock = { lockRoot: env.WE_DAEMON_CLONE_LOCK_ROOT, owner: 'soak-sibling' };
  try {
    mkdirSync(author);
    git(dir, ['init', '--bare', '-q', '-b', 'main', origin]);
    git(author, ['init', '-q', '-b', 'main']);
    git(author, ['remote', 'add', 'origin', origin]);
    const push = (ref, file, content, base, force = false) => {
      if (base) git(author, ['checkout', '-q', '-B', ref, base]);
      writeFileSync(join(author, file), content);
      git(author, ['add', '.']); git(author, ['commit', '-qm', `change ${ref}`]);
      git(author, ['push', '-q', ...(force ? ['--force'] : []), 'origin', `HEAD:refs/heads/${ref}`]);
      return git(author, ['rev-parse', 'HEAD']);
    };
    push('main', 'shared.txt', 'base\n');
    const applied = push('lane/moving', 'moving.txt', 'old\n', 'main');
    push('lane/blocker', 'shared.txt', 'blocker\n', 'main');
    git(dir, ['clone', '-q', origin, root]);
    addOverlay(root, { ref: 'lane/moving' }, { env });
    addOverlay(root, { ref: 'lane/blocker' }, { env });
    const rebuild = extra => rebuildClone({ root, env, asJob: false, versions: null,
      lockOpts: { waitMs: 30, pollMs: 5 }, log: { error() {} }, emitEvent() {},
      runSmoke: async () => pass, ...extra });
    if (!(await rebuild()).adopted) throw new Error('fixture could not adopt initial overlays');
    if (auditedOnly) {
      env.WE_DAEMON_OVERLAY_FOLLOW_TIP = 'audited-only';
      env.WE_FIX_READY_PATH = join(dir, 'fix-ready.jsonl');
      env.WE_PLATFORM_PREFERENCES_FILE = join(dir, 'platform.json');
      writeFileSync(env.WE_PLATFORM_PREFERENCES_FILE, '{}');
      writeFileSync(env.WE_FIX_READY_PATH, ['lane/moving', 'lane/blocker'].map(ref => JSON.stringify({
        ref, sha: git(root, ['rev-parse', `origin/${ref}`]), tests: 'green', audit: 'NOT WEAKENED',
      })).join('\n'));
    }
    const pin = push('lane/moving', auditedOnly ? 'moving.txt' : 'shared.txt', 'moving\n', 'lane/moving');
    push('main', 'candidate.txt', 'candidate\n', 'main');
    const blocked = await rebuild({ runSmoke: async () => {
      if (!acquireRead(root, lock).ok) throw new Error('fixture could not start sibling tick');
      return pass;
    } });
    releaseRead(root, lock);
    const ready = readReadyCandidate(root, env);
    if (blocked.reason !== 'tick-in-progress' || ready?.adopt.applied.find(a => a.ref === 'lane/moving')?.pinnedFrom !== pin) {
      throw new Error('fixture did not publish a pinned ready candidate');
    }
    if (!auditedOnly) {
      // A stale pin must lose the held tip, even if it still descends from the
      // applied SHA. A fast-forward deliberately retains the ready smoke proof.
      push('lane/moving', 'new-tip.txt', 'new\n', fastForward ? 'lane/moving' : applied, !fastForward);
      push('main', 'later.txt', 'later\n', 'main');
    }
    git(root, ['fetch', '-q', 'origin']);
    const heldTipAncestor = spawnSync('git', ['merge-base', '--is-ancestor', pin, 'origin/lane/moving'],
      { cwd: root, encoding: 'utf8', env, timeout: 20_000, maxBuffer: 65536 }).status;
    if (heldTipAncestor !== ((!auditedOnly && !fastForward) ? 1 : 0)) {
      throw new Error('fixture did not establish the expected held-tip ancestry');
    }
    let smokes = 0;
    const result = await rebuild({ launchedBy: 'tick-start', runSmoke: async () => { smokes += 1; return pass; } });
    return { adopted: result.adopted === true, reason: result.reason, smokes,
      discarded: result.alerts?.some(a => a.kind === 'ready-candidate-discarded') === true,
      readyCleared: readReadyCandidate(root, env) === null,
      freshHead: git(root, ['rev-parse', 'HEAD']) !== ready.adopt.finalSha,
      heldTipExcluded: readFileSync(join(root, 'moving.txt'), 'utf8') === 'old\n' };
  } finally { releaseRead(root, lock); rmSync(dir, { recursive: true, force: true }); }
}

export async function probeRebuildEvidence() {
  const root = mkdtempSync(join(tmpdir(), 'rebuild-evidence-soak-'));
  const env = { WE_DAEMON_STATE_DIR: join(root, 'state'), WE_DAEMON_OVERLAY_DIR: join(root, 'overlays') };
  try {
    const store = createJobStore(join(root, 'jobs'));
    mkdirSync(store.dir);
    const old = enqueueJob({ store, kindDef: REBUILD_JOB_KIND, codeSha: 'a'.repeat(40), input: { root }, now: 1000 });
    store.update(old.id, r => markSucceeded(r, { at: new Date(1000).toISOString() }));
    writeFileSync(join(store.dir, old.id + RESULT_SUFFIX), JSON.stringify(buildRebuildJobResult({}, {}, null, 1000)));
    const registry = overlayFilePath(root, env);
    mkdirSync(dirname(registry), { recursive: true });
    writeFileSync(registry, JSON.stringify({ overlays: [{ ref: 'lane/legacy' }] }));
    appendOverlayEvent(root, { kind: 'auto-rebase-swapped', old: 'lane/old', new: 'lane/new', newSha: 'b'.repeat(40) }, { env });
    const registryBefore = readFileSync(registry, 'utf8');
    const events = registry.replace(/\.json$/, '.events.jsonl');
    const eventsBefore = readFileSync(events, 'utf8');
    const held = { reason: 'smoke-env-timeout', since: new Date(1000).toISOString(), updatedAt: new Date(1000).toISOString(),
      inputsKey: 'old-inputs', target: 'a'.repeat(40), attempts: 3, retryAt: new Date(2_400_000).toISOString() };
    writeRebuildState(root, { held }, env);
    const readers = createRebuildReaders({ strict: true });
    readers.validate(root, env);
    const oldPlan = { inputsKey: held.inputsKey, finalSha: held.target };
    const changedPlan = { inputsKey: 'new-inputs', finalSha: 'b'.repeat(40) };
    // Admission uses the same identity policy as prepareRebuild; Git/planning IO
    // is represented by two main revisions. Unit coverage also reaches real prepare.
    let plan = oldPlan;
    const invoke = () => rebuildCloneAsJob({ root, env, store, launchOnly: true, launchedBy: 'early',
      now: () => 1001, codeSha: 'a'.repeat(40), settings: { minIntervalMs: 0, minIntervalJitterPct: 0 },
      adopt: async () => ({ reason: envTimeoutAppliesToPlan(readRebuildState(root, env).held, plan)
        ? 'smoke-env-timeout-backoff' : 'needs-build', plan }),
      reattach: async () => {}, evict() {}, log: { error() {} } });
    const before = await invoke();
    plan = changedPlan;
    const changed = await invoke();
    const again = await invoke();
    return { before: before.reason, consumedReason: before.finishedJobs?.[0]?.reason,
      changed: changed.reason, again: again.reason, jobs: store.list().records.length,
      preserved: readFileSync(registry, 'utf8') === registryBefore && readFileSync(events, 'utf8') === eventsBefore };
  } finally { rmSync(root, { recursive: true, force: true }); }
}
