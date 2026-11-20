/** Replay persisted writer output and legacy metadata through real rebuild admission. */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
import { readReadyCandidate } from '../../../lib/daemon-rebuild/state.mjs';
import { rebuildClone } from '../../../lib/daemon-rebuild/rebuild.mjs';
import { acquireRead, releaseRead } from '../../../lib/daemon-clone-lock.mjs';

/** Real Git: publish a smoke-passed pinned candidate, move its tip, then run tick-start. */
export async function probeStalePinnedReady() {
  const dir = mkdtempSync(join(tmpdir(), 'stale-ready-soak-'));
  const root = join(dir, 'clone'), author = join(dir, 'author'), origin = join(dir, 'origin.git');
  const env = { ...process.env, WE_DAEMON_STATE_DIR: join(dir, 'state'),
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
    const push = (ref, file, content, base) => {
      if (base) git(author, ['checkout', '-q', '-B', ref, base]);
      writeFileSync(join(author, file), content);
      git(author, ['add', '.']); git(author, ['commit', '-qm', `change ${ref}`]);
      git(author, ['push', '-q', 'origin', `HEAD:refs/heads/${ref}`]);
      return git(author, ['rev-parse', 'HEAD']);
    };
    push('main', 'shared.txt', 'base\n');
    push('lane/moving', 'moving.txt', 'old\n', 'main');
    push('lane/blocker', 'shared.txt', 'blocker\n', 'main');
    git(dir, ['clone', '-q', origin, root]);
    addOverlay(root, { ref: 'lane/moving' }, { env });
    addOverlay(root, { ref: 'lane/blocker' }, { env });
    const rebuild = extra => rebuildClone({ root, env, asJob: false, versions: null,
      lockOpts: { waitMs: 30, pollMs: 5 }, log: { error() {} }, emitEvent() {},
      runSmoke: async () => pass, ...extra });
    if (!(await rebuild()).adopted) throw new Error('fixture could not adopt initial overlays');
    const pin = push('lane/moving', 'shared.txt', 'moving\n', 'lane/moving');
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
    push('lane/moving', 'new-tip.txt', 'new\n', 'lane/moving');
    push('main', 'later.txt', 'later\n', 'main');
    git(root, ['fetch', '-q', 'origin']);
    let smokes = 0;
    const result = await rebuild({ launchedBy: 'tick-start', runSmoke: async () => { smokes += 1; return pass; } });
    return { adopted: result.adopted === true, reason: result.reason, smokes,
      discarded: result.alerts?.some(a => a.kind === 'ready-candidate-discarded') === true,
      readyCleared: readReadyCandidate(root, env) === null,
      freshHead: git(root, ['rev-parse', 'HEAD']) !== ready.adopt.finalSha };
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
