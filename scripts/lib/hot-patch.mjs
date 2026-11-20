/**
 * @file hot-patch.mjs — R1100 bounded hot-patch admission and global rollback ledger.
 * Admission arms the fleet singleton before registering a pinned overlay. Unknown evidence
 * refuses; repair the ledger/overlay or use ordinary delivery. Tick IO is injectable, CI
 * is supplied by the caller, and rollback must use the rebuild finalizer (never a raw reset).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual as equal } from 'node:util';
import { stateDir, readRebuildState as rebuildState } from './daemon-rebuild/state.mjs';
import { cloneKeyOf } from './daemon-last-good.mjs';
import { readForceWatch } from './daemon-force-adopt.mjs';
import { processStartMs } from './daemon-rebuild/lease.mjs';
import { isSafeBranchName } from './daemon-self-sync.mjs';
import { removeOverlay as dropOverlay, readOverlayState } from './daemon-overlays.mjs';
import { withWriteLock, writeRebuildRequest as rebuildRequest } from './daemon-clone-lock.mjs';
import { appendDaemonEvent } from './daemon-events.mjs';
import { runGhSync } from './gh-throttle.mjs';

export const HOT_PATCH_ALLOWLIST = Object.freeze([
  'scripts/lib/daemon-rebuild/advisory-merge.mjs', // Leaf advisory-data conflict resolver, outside admission and rollback.
  'scripts/lib/daemon-rebuild/adopt-yield.mjs', // Cooperative tick yield hint; adoption retains its own validation.
  'scripts/lib/daemon-heap-log.mjs', // Per-tick heap telemetry only; never moves a clone.
  'scripts/lib/daemon-job-snapshots.mjs', // Isolated job snapshot helper; does not own hot-patch state or adoption.
]);
export const WAKE_FLOOR_MS = 120000;
export const CI_UNKNOWN_MS = 30 * 60 * 1000;
export const HOT_PATCH_MAX_OPEN_MS = 24 * 60 * 60 * 1000;
export const HOT_PATCH_OVERLAY_REASON = 'R1100 hot-patch';
export const hotPatchLedgerPath = (env = process.env) => join(stateDir(env), 'hot-patch.json');
const shaOK = s => typeof s === 'string' && /^[a-f0-9]{40}$/.test(s);
const isoOK = s => typeof s === 'string' && Number.isFinite(Date.parse(s)) && new Date(s).toISOString() === s;
const positive = n => Number.isSafeInteger(n) && n > 0;
const goodOK = g => g && shaOK(g.head) && shaOK(g.inputsKey) && shaOK(g.mainSha)
  && Array.isArray(g.applied) && g.applied.every(a => a && isSafeBranchName(a.ref) && shaOK(a.sha)
    && (a.pr == null || positive(a.pr)) && (a.pinnedFrom === undefined || shaOK(a.pinnedFrom)));
const overlayOK = (o, r) => o && o.ref === r.branch && o.pr === r.pr && o.pinned === true
  && o.reason === HOT_PATCH_OVERLAY_REASON && isoOK(o.addedAt) && (o.addedBy === null || typeof o.addedBy === 'string');
const cleanEnv = env => ({ ...Object.fromEntries(Object.entries(env).filter(([k]) =>
  !/^(GIT_DIR|GIT_WORK_TREE|GIT_INDEX_FILE|GIT_OBJECT_DIRECTORY)$|^GIT_ALTERNATE_|^GIT_CONFIG_/.test(k))), GIT_NO_REPLACE_OBJECTS: '1' });
const atMs = now => typeof now === 'function' ? now() : now;
const refuse = reason => { throw Error(`hot-patch refused: ${reason}; repair evidence or use ordinary delivery`); };

/** Missing is idle; every other unreadable or incomplete record is an operator repair. */
export function readHotPatch(env = process.env) {
  let text;
  try { text = readFileSync(hotPatchLedgerPath(env), 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  const r = JSON.parse(text);
  if (!r || !shaOK(r.sha) || !positive(r.pr) || !isSafeBranchName(r.branch)
    || typeof r.root !== 'string' || !r.root || /[\x00-\x1f\x7f]/.test(r.root)
    || !positive(r.requestPid) || !Number.isFinite(r.requestStart) || r.requestStart <= 0
    || !isoOK(r.loadedAt) || !goodOK(r.preGood) || r.preGood.head === r.sha
    || r.preGood.applied.some(a => a.sha === r.sha)
    // null is the armed-before-registration crash window, not an absent overlay field.
    || !(r.overlay === null || overlayOK(r.overlay, r))
    || (r.wokeAt !== undefined && !isoOK(r.wokeAt))
    || (r.rollbackPending !== undefined && (typeof r.rollbackPending !== 'string' || !r.rollbackPending)))
    throw Error('hot-patch state unreadable; repair ledger before retrying');
  return r;
}
function write(env, record) {
  const path = hotPatchLedgerPath(env), tmp = `${path}.${process.pid}.tmp`;
  try { writeFileSync(tmp, JSON.stringify(record)); renameSync(tmp, path); }
  finally { rmSync(tmp, { force: true }); }
}
function gitReader(root, env, run = spawnSync) {
  const opts = { cwd: root, env: cleanEnv(env), encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024 };
  const raw = args => run('git', ['--no-replace-objects', ...args], opts);
  const git = args => {
    const r = raw(args);
    if (r.error || r.status !== 0) refuse(`git ${args[0]} evidence unavailable`);
    return String(r.stdout || '').trim();
  };
  const grafts = git(['rev-parse', '--git-path', 'info/grafts']);
  if (existsSync(resolve(root, grafts))) refuse('legacy grafts exist');
  return { git, raw, opts };
}
const ghReader = (root, env) => args => JSON.parse(runGhSync(args,
  { cwd: root, env: cleanEnv(env), encoding: 'utf8', timeout: 20000, maxBuffer: 1024 * 1024 }));
const rebuild = (root, env, now) => rebuildRequest(root, { reason: HOT_PATCH_OVERLAY_REASON,
  nowMs: atMs(now), lockRoot: env.WE_DAEMON_CLONE_LOCK_ROOT });
async function locked(root, env, lock, fn) {
  let entered = false;
  const result = await lock(root, async () => { entered = true; return fn(); },
    { lockRoot: env.WE_DAEMON_CLONE_LOCK_ROOT, waitMs: 15000 });
  if (!entered || result?.ok === false) refuse('clone write lock unavailable');
  return result?.value ?? result;
}

/** Only the operator CLI calls admission. No GitHub mutations or no-PR override exist here. */
export async function requestHotPatch({ root, pr, sha, branch, env = process.env, run = spawnSync,
  ghJson = ghReader(root, env), now = Date.now, lock = withWriteLock,
  readRebuildState = rebuildState, writeRebuildRequest = (r) => rebuild(r, env, now),
  addOverlay = async (r, options) => {
    // The existing guarded CLI checks --expected-sha and uses daemon-overlays.addOverlay.
    const child = run(process.execPath, [fileURLToPath(new URL('../daemon-overlay.mjs', import.meta.url)),
      'add', `--clone=${r}`, `--ref=${options.ref}`, `--pr=${pr}`, '--pinned',
      `--expected-sha=${sha}`, `--reason=${HOT_PATCH_OVERLAY_REASON}`],
    { cwd: r, env: cleanEnv(env), encoding: 'utf8', timeout: 120000, maxBuffer: 1024 * 1024 });
    if (child.error || child.status !== 0) refuse('overlay registration failed');
    const state = readOverlayState(r, { env });
    if (state.corrupt) refuse('overlay state unreadable');
    return state.overlays.find(o => o.ref === branch);
  } } = {}) {
  if (typeof root !== 'string' || !root || !positive(pr)) refuse('target clone and positive PR required');
  const { git, raw } = gitReader(root, env, run);
  let evidence;
  try { evidence = await ghJson(['pr', 'view', String(pr), '--json', 'state,headRefOid,headRefName']); }
  catch { refuse('PR evidence unreadable'); }
  sha ??= evidence?.headRefOid; branch ??= evidence?.headRefName;
  if (!shaOK(sha) || !isSafeBranchName(branch) || evidence?.state !== 'OPEN'
    || evidence.headRefOid !== sha || evidence.headRefName !== branch) refuse('open PR at exact branch and SHA required');
  git(['fetch', 'origin', sha]);
  if (git(['rev-parse', '--verify', `${sha}^{commit}`]) !== sha) refuse('fetched SHA mismatch');
  const parents = git(['rev-list', '--parents', '-n', '1', sha]).split(/\s+/);
  if (parents.length !== 2 || parents[0] !== sha || !shaOK(parents[1])) refuse('one non-merge commit required');
  if (raw(['merge-base', '--is-ancestor', parents[1], 'refs/remotes/origin/main']).status !== 0)
    refuse('parent is not reachable from target origin/main');
  const paths = git(['diff', '--no-renames', '--name-only', '-z', `${sha}^..${sha}`]).split('\0').filter(Boolean);
  if (!paths.length || paths.some(p => !HOT_PATCH_ALLOWLIST.includes(p))) refuse('diff outside exact allowlist');
  let own = null, entry = null, accepted = false;
  try {
    return await locked(root, env, lock, async () => {
      if (readHotPatch(env) || readForceWatch(root, env)) refuse('ledger or force-watch already open');
      const adopted = readRebuildState(root, env)?.adopted;
      if (!goodOK(adopted)) refuse('complete adopted preGood required');
      const { head, inputsKey, mainSha, applied } = adopted;
      const preGood = { head, inputsKey, mainSha, applied };
      const prior = readOverlayState(root, { env });
      if (prior.corrupt || prior.overlays.some(o => o.ref === branch)) refuse('overlay state unreadable or branch already registered');
      const contains = raw(['merge-base', '--is-ancestor', sha, preGood.head]);
      if (contains.status !== 1 || preGood.applied.some(a => a.sha === sha)) refuse('preGood contains patch or ancestry unreadable');
      const requestStart = processStartMs(process.pid);
      if (!Number.isFinite(requestStart)) refuse('request process start unavailable');
      const record = { sha, pr, branch, root, requestPid: process.pid, requestStart,
        loadedAt: new Date(atMs(now)).toISOString(), preGood, overlay: null };
      mkdirSync(stateDir(env), { recursive: true });
      try { writeFileSync(hotPatchLedgerPath(env), JSON.stringify(record), { flag: 'wx' }); }
      catch (e) { refuse(`cannot reserve global ledger (${e.code || 'write failed'})`); }
      own = record;
      const unchanged = () => { if (!equal(readHotPatch(env), own)) refuse('ledger changed during registration'); };
      unchanged();
      entry = await addOverlay(root, { ref: branch, pr, pinned: true, reason: HOT_PATCH_OVERLAY_REASON,
        now: record.loadedAt, expectedSha: sha }, { env });
      unchanged();
      if (!overlayOK(entry, record)) refuse('exact registered overlay unavailable');
      write(env, { ...record, overlay: entry }); own = { ...record, overlay: entry };
      unchanged();
      if (readForceWatch(root, env)) refuse('force-watch appeared during registration');
      await writeRebuildRequest(root, { env, reason: HOT_PATCH_OVERLAY_REASON, ref: branch,
        nowMs: atMs(now), lockRoot: env.WE_DAEMON_CLONE_LOCK_ROOT });
      accepted = true;
      return { ok: true, record: own };
    });
  } catch (e) {
    if (e.message.startsWith('hot-patch refused:')) throw e;
    refuse(e.message);
  } finally {
    if (own && !accepted) {
      // Remove only our exact registration and reservation, preserving concurrent replacements.
      const state = readOverlayState(root, { env });
      const current = state.overlays.find(o => o.ref === branch);
      if (state.corrupt) throw Error('hot-patch refused: overlay cleanup unreadable; repair ledger and overlay');
      if (current && entry && equal(current, entry)) dropOverlay(root, branch, { env, expectedOverlay: entry });
      let persisted;
      try { persisted = readHotPatch(env); } catch { /* Keep unreadable recovery evidence. */ }
      if ((!current || (entry && equal(current, entry))) && equal(persisted, own))
        rmSync(hotPatchLedgerPath(env), { force: true });
    }
  }
}

export function hotPatchWakeDue({ env = process.env, plan, lastFinishedMs, now = Date.now() } = {}) {
  try {
    const r = readHotPatch(env), at = atMs(now);
    return !!r && !r.wokeAt && !r.rollbackPending && Number.isFinite(lastFinishedMs)
      && Number.isFinite(at) && at - lastFinishedMs >= WAKE_FLOOR_MS
      && !!plan?.applied?.some(a => a.ref === r.branch && a.sha === r.sha);
  } catch { return false; }
}
export function markHotPatchWoke(env, sha, now = Date.now) {
  const r = readHotPatch(env);
  if (!r || r.sha !== sha || r.wokeAt) return false;
  write(env, { ...r, wokeAt: new Date(atMs(now)).toISOString() });
  return true;
}

// These rollback obligations need no PR evidence and survive a PR API outage.
function unconditionalRollback(r, ci, now) {
  if (r.rollbackPending) return r.rollbackPending;
  if (ci?.state === 'red') return 'ci-red';
  if ((!ci || !['green', 'pending'].includes(ci.state)) && now - Date.parse(r.loadedAt) > CI_UNKNOWN_MS) return 'ci-unknown';
  if (now - Date.parse(r.loadedAt) >= HOT_PATCH_MAX_OPEN_MS) return 'merge-deadline';
  return null;
}

/** PURE. Rollback wins over merge, and every deadline is anchored to loadedAt. */
export function decideHotPatch({ record: r, ci, pr, now }) {
  const rollback = unconditionalRollback(r, ci, now);
  if (rollback) return rollback;
  if (!pr || !['OPEN', 'CLOSED', 'MERGED'].includes(pr.state) || !shaOK(pr.headRefOid))
    throw Error('hot-patch PR evidence unreadable; repair access and retry');
  if (pr.headRefOid !== r.sha) return 'pr-head-moved';
  if (pr.state === 'CLOSED') return 'pr-closed';
  if (pr.state === 'MERGED') return 'close';
  return null;
}

export async function runHotPatchTick({ env = process.env, root, now = Date.now, ciVerdict,
  prState = r => ghReader(r.root, env)(['pr', 'view', String(r.pr), '--json', 'state,headRefOid']),
  rollbackToGood, removeOverlay = dropOverlay,
  readOverlays = r => { const s = readOverlayState(r, { env }); if (s.corrupt) throw Error('overlay state unreadable'); return s.overlays; },
  headContains, readHead, emit = e => appendDaemonEvent(e, { env }), lock = withWriteLock } = {}) {
  let record;
  try { record = readHotPatch(env); }
  catch {
    for (const o of await readOverlays(root)) if (o.reason === HOT_PATCH_OVERLAY_REASON) {
      await removeOverlay(root, o.ref, { env, expectedOverlay: o });
      rebuild(root, env, now);
      await emit({ kind: 'hot-patch-needs-you', detail: 'Unreadable ledger; orphan overlay removed; repair ledger' });
    }
    return;
  }
  if (!record) return;
  // The global ledger addresses its target; a sibling clone must never revert to this preGood.
  if (cloneKeyOf(root) !== cloneKeyOf(record.root)) return;
  try {
    process.kill(record.requestPid, 0);
    const start = processStartMs(record.requestPid);
    if (start === null || start === record.requestStart) return;
  } catch (e) { if (e.code !== 'ESRCH') return; }
  const ci = await ciVerdict(record);
  const at = atMs(now);
  const decision = unconditionalRollback(record, ci, at)
    ?? decideHotPatch({ record, ci, pr: await prState(record), now: at });
  if (!decision) return;
  await locked(root, env, lock, async () => {
    if (!equal(readHotPatch(env), record)) throw Error('hot-patch ledger changed; retry tick');
    if (decision === 'close') { rmSync(hotPatchLedgerPath(env)); return; }
    record = { ...record, rollbackPending: decision };
    write(env, record);
    if (!equal(readHotPatch(env), record)) throw Error('hot-patch rollback intent changed');
    const overlays = await readOverlays(root);
    const current = overlays.find(o => o.ref === record.branch);
    if (current && !equal(current, record.overlay)) {
      await emit({ kind: 'hot-patch-needs-you', detail: 'Overlay replacement mismatch; repair registration before rollback' });
    } else if (current) await removeOverlay(root, record.branch, { env, expectedOverlay: record.overlay });
    let reader;
    const gitIO = () => (reader ??= gitReader(root, env));
    const head = readHead ? await readHead() : gitIO().git(['rev-parse', '--verify', 'HEAD']);
    if (!shaOK(head)) throw Error('hot-patch HEAD unreadable');
    const contains = async () => {
      if (headContains) return headContains(record.sha);
      const r = gitIO().raw(['merge-base', '--is-ancestor', record.sha, 'HEAD']);
      if (![0, 1].includes(r.status)) throw Error('hot-patch ancestry unreadable');
      return r.status === 0;
    };
    if (await contains()) {
      if (typeof rollbackToGood !== 'function') throw Error('hot-patch rollback finalizer required');
      await rollbackToGood(record.preGood, { root, env, expectHead: head });
    }
    if (!(await contains()) && !(await readOverlays(root)).some(o => o.ref === record.branch)) {
      if (!equal(readHotPatch(env), record)) throw Error('hot-patch ledger changed before retirement');
      rmSync(hotPatchLedgerPath(env));
    }
  });
}
