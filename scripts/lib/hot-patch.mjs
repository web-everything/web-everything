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
import { forceBlockedReason } from './daemon-force-adopt.mjs';
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
    || (r.overlayIntent !== undefined && !(overlayOK(r.overlayIntent, r) && r.overlayIntent.expectedSha === r.sha))
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
    return args.includes('-z') ? String(r.stdout || '') : String(r.stdout || '').trim();
  };
  const grafts = git(['rev-parse', '--git-path', 'info/grafts']);
  if (existsSync(resolve(root, grafts))) refuse('legacy grafts exist');
  return { git, raw, opts };
}
const ghReader = (root, env) => args => JSON.parse(runGhSync(args,
  { cwd: root, env: cleanEnv(env), encoding: 'utf8', timeout: 20000, maxBuffer: 1024 * 1024 }));
const rebuild = (root, env, now) => rebuildRequest(root, { reason: HOT_PATCH_OVERLAY_REASON,
  nowMs: atMs(now), lockRoot: env.WE_DAEMON_CLONE_LOCK_ROOT });
const ledgerTurns = new Map();
async function locked(root, env, lock, fn) {
  // withWriteLock permits reacquisition by the same process owner. Queue our own callers
  // so a concurrent wake cannot replace the tick's fencing token.
  const key = cloneKeyOf(hotPatchLedgerPath(env));
  const previous = ledgerTurns.get(key) ?? Promise.resolve();
  let release;
  const turn = new Promise(resolve => { release = resolve; });
  ledgerTurns.set(key, turn);
  await previous;
  try {
    return await lockedTurn(root, env, lock, fn);
  } finally {
    release();
    if (ledgerTurns.get(key) === turn) ledgerTurns.delete(key);
  }
}
async function lockedTurn(root, env, lock, fn) {
  // Serialize the fleet ledger as well as the target clone. Always take the global lock first.
  const options = { lockRoot: env.WE_DAEMON_CLONE_LOCK_ROOT, waitMs: 15000 };
  const result = await withWriteLock(hotPatchLedgerPath(env), async globalHeld => {
    let entered = false;
    const local = await lock(root, async stillHeld => {
      entered = true;
      const checkHeld = () => {
        if (!globalHeld() || typeof stillHeld !== 'function' || !stillHeld())
          throw Error('hot-patch write lock lost; retry next tick');
      };
      checkHeld();
      return fn(checkHeld);
    }, options);
    if (!entered || local?.ok === false) throw Error('hot-patch clone write lock unavailable or lost');
    return local?.value ?? local;
  }, options);
  if (result?.ok === false) throw Error('hot-patch global write lock unavailable or lost');
  return result.value;
}

/** Only the operator CLI calls admission. No GitHub mutations or no-PR override exist here. */
export async function requestHotPatch({ root, pr, sha, branch, env = process.env, run = spawnSync,
  ghJson = ghReader(root, env), now = Date.now, lock = withWriteLock, startTimeOf = processStartMs,
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
  const origin = git(['remote', 'get-url', 'origin']);
  if (!/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)web-everything\/web-everything(?:\.git)?$/.test(origin))
    refuse('canonical web-everything/web-everything origin required');
  let evidence;
  try { evidence = await ghJson(['pr', 'view', String(pr), '--json', 'state,headRefOid,headRefName,baseRefName']); }
  catch { refuse('PR evidence unreadable'); }
  sha ??= evidence?.headRefOid; branch ??= evidence?.headRefName;
  if (!shaOK(sha) || !isSafeBranchName(branch) || evidence?.state !== 'OPEN' || evidence.baseRefName !== 'main'
    || evidence.headRefOid !== sha || evidence.headRefName !== branch) refuse('open PR at exact branch and SHA required');
  git(['fetch', 'origin', sha]);
  if (git(['rev-parse', '--verify', `${sha}^{commit}`]) !== sha) refuse('fetched SHA mismatch');
  const parents = git(['rev-list', '--parents', '-n', '1', sha]).split(/\s+/);
  if (parents.length !== 2 || parents[0] !== sha || !shaOK(parents[1])) refuse('one non-merge commit required');
  if (raw(['merge-base', '--is-ancestor', parents[1], 'refs/remotes/origin/main']).status !== 0)
    refuse('parent is not reachable from target origin/main');
  const paths = git(['diff', '--no-renames', '--name-only', '-z', `${sha}^..${sha}`]).split('\0');
  while (paths.at(-1) === '') paths.pop();
  if (!paths.length || paths.some(p => !HOT_PATCH_ALLOWLIST.includes(p))) refuse('diff outside exact allowlist');
  let own = null, entry = null, accepted = false;
  try {
    return await locked(root, env, lock, async checkHeld => {
      try {
        if (readHotPatch(env)) refuse('ledger already open');
        const blocked = forceBlockedReason(root, env);
        if (blocked !== null) refuse(`force-watch blocked: ${blocked}`);
        const adopted = readRebuildState(root, env)?.adopted;
        if (!goodOK(adopted)) refuse('complete adopted preGood required');
        const { head, inputsKey, mainSha, applied } = adopted;
        const preGood = { head, inputsKey, mainSha, applied };
        const prior = readOverlayState(root, { env });
        if (prior.corrupt || prior.overlays.some(o => o.ref === branch)) refuse('overlay state unreadable or branch already registered');
        const contains = raw(['merge-base', '--is-ancestor', sha, preGood.head]);
        if (contains.status !== 1 || preGood.applied.some(a => a.sha === sha)) refuse('preGood contains patch or ancestry unreadable');
        const requestStart = startTimeOf(process.pid);
        if (!Number.isFinite(requestStart)) refuse('request process start unavailable');
        const record = { sha, pr, branch, root, requestPid: process.pid, requestStart,
          loadedAt: new Date(atMs(now)).toISOString(), preGood, overlay: null };
        record.overlayIntent = { ref: branch, pr, pinned: true, reason: HOT_PATCH_OVERLAY_REASON,
          addedAt: record.loadedAt, addedBy: null, expectedSha: sha };
        mkdirSync(stateDir(env), { recursive: true });
        checkHeld();
        try { writeFileSync(hotPatchLedgerPath(env), JSON.stringify(record), { flag: 'wx' }); }
        catch (e) { refuse(`cannot reserve global ledger (${e.code || 'write failed'})`); }
        own = record;
        const unchanged = () => { if (!equal(readHotPatch(env), own)) refuse('ledger changed during registration'); };
        unchanged();
        checkHeld();
        entry = await addOverlay(root, { ref: branch, pr, pinned: true, reason: HOT_PATCH_OVERLAY_REASON,
          now: record.loadedAt, expectedSha: sha }, { env });
        unchanged();
        if (!overlayOK(entry, record)) refuse('exact registered overlay unavailable');
        checkHeld();
        write(env, { ...record, overlay: entry }); own = { ...record, overlay: entry };
        unchanged();
        const afterBlocked = forceBlockedReason(root, env);
        // unchanged() verified this request's own ledger under the fleet lock.
        // Force-watch/rollback refusals still apply; our reservation is expected here.
        if (afterBlocked !== null && afterBlocked !== 'hot-patch-open')
          refuse(`force-watch blocked during registration: ${afterBlocked}`);
        checkHeld();
        await writeRebuildRequest(root, { env, reason: HOT_PATCH_OVERLAY_REASON, ref: branch,
          nowMs: atMs(now), lockRoot: env.WE_DAEMON_CLONE_LOCK_ROOT });
        accepted = true;
        return { ok: true, record: own };
      } finally {
        if (own && !accepted) {
          // Cleanup is fenced too: losing the lock leaves the intent for the next tick.
          checkHeld();
          const state = readOverlayState(root, { env });
          const current = state.overlays.find(o => o.ref === branch);
          if (state.corrupt) throw Error('hot-patch refused: overlay cleanup unreadable; repair ledger and overlay');
          if (current && entry && equal(current, entry)) {
            checkHeld();
            dropOverlay(root, branch, { env, expectedOverlay: entry });
          }
          let persisted;
          try { persisted = readHotPatch(env); } catch { /* Keep unreadable recovery evidence. */ }
          if ((!current || (entry && equal(current, entry))) && equal(persisted, own)) {
            checkHeld();
            rmSync(hotPatchLedgerPath(env), { force: true });
          }
        }
      }
    });
  } catch (e) {
    if (e.message.startsWith('hot-patch refused:')) throw e;
    refuse(e.message);
  }
}

export function hotPatchWakeDue({ root, env = process.env, plan, lastFinishedMs, now = Date.now() } = {}) {
  try {
    const r = readHotPatch(env), at = atMs(now);
    return !!r && typeof root === 'string' && cloneKeyOf(root) === cloneKeyOf(r.root)
      && r.overlay !== null && !r.wokeAt && !r.rollbackPending && Number.isFinite(lastFinishedMs)
      && Number.isFinite(at) && at - lastFinishedMs >= WAKE_FLOOR_MS
      && !!plan?.applied?.some(a => a.ref === r.branch && a.sha === r.sha);
  } catch { return false; }
}
export async function markHotPatchWoke(env, sha, now = Date.now, lock = withWriteLock) {
  const initial = readHotPatch(env);
  if (!initial) return false;
  return locked(initial.root, env, lock, checkHeld => {
    const r = readHotPatch(env);
    if (!r || !equal(r, initial) || r.sha !== sha || r.wokeAt || r.rollbackPending || r.overlay === null) return false;
    checkHeld();
    write(env, { ...r, wokeAt: new Date(atMs(now)).toISOString() });
    return true;
  });
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
  if (pr.state === 'MERGED' && ci?.state === 'green') return 'close';
  return null;
}

export async function runHotPatchTick({ env = process.env, root, now = Date.now, ciVerdict,
  prState = r => ghReader(r.root, env)(['pr', 'view', String(r.pr), '--json', 'state,headRefOid']),
  rollbackToGood, removeOverlay = dropOverlay,
  readOverlays = r => { const s = readOverlayState(r, { env }); if (s.corrupt) throw Error('overlay state unreadable'); return s.overlays; },
  headContains, readHead, readRebuildState = rebuildState, startTimeOf = processStartMs, emit = e => appendDaemonEvent(e, { env }), lock = withWriteLock } = {}) {
  let record;
  try { record = readHotPatch(env); }
  catch {
    await locked(root, env, lock, async checkHeld => {
      try { if (readHotPatch(env)) return; } catch { /* Still unreadable: remove only orphans. */ }
      for (const o of await readOverlays(root)) if (o.reason === HOT_PATCH_OVERLAY_REASON) {
        checkHeld();
        await removeOverlay(root, o.ref, { env, expectedOverlay: o });
        checkHeld();
        rebuild(root, env, now);
        await emit({ kind: 'hot-patch-needs-you', detail: 'Unreadable ledger; orphan overlay removed; repair ledger' });
      }
    });
    return;
  }
  if (!record) return;
  // The global ledger addresses its target; a sibling clone must never revert to this preGood.
  if (cloneKeyOf(root) !== cloneKeyOf(record.root)) return;
  try {
    process.kill(record.requestPid, 0);
    const start = startTimeOf(record.requestPid);
    if (start === null || start === record.requestStart) return;
  } catch (e) { if (e.code !== 'ESRCH') return; }
  const ci = await ciVerdict(record);
  const at = atMs(now);
  let decision = unconditionalRollback(record, ci, at)
    ?? decideHotPatch({ record, ci, pr: await prState(record), now: at });
  await locked(root, env, lock, async checkHeld => {
    if (!equal(readHotPatch(env), record)) throw Error('hot-patch ledger changed; retry tick');
    const overlays = await readOverlays(root);
    const current = overlays.find(o => o.ref === record.branch);
    const applied = readRebuildState(root, env)?.adopted?.applied?.find(a => a.ref === record.branch);
    // Older registrations have no SHA field: resolve the local branch evidence as well.
    let overlaySha = current?.expectedSha ?? applied?.sha;
    if (current && overlaySha === undefined) {
      const tip = gitReader(root, env).raw(['rev-parse', '--verify', `refs/remotes/origin/${record.branch}^{commit}`]);
      overlaySha = !tip.error && tip.status === 0 ? String(tip.stdout).trim() : null;
    }
    if (!unconditionalRollback(record, ci, at)
      && ((current && overlaySha !== record.sha) || (applied && applied.sha !== record.sha)))
      decision = 'overlay-sha-moved';
    const intentMatches = current && record.overlayIntent && current.ref === record.overlayIntent.ref
      && current.pr === record.overlayIntent.pr && current.reason === HOT_PATCH_OVERLAY_REASON
      && current.pinned === true && overlaySha === record.overlayIntent.expectedSha;
    const ours = current && (equal(current, record.overlay) || (record.overlay === null && intentMatches));
    // An incomplete registration must recover rather than remain indefinitely armed.
    if (record.overlay === null && !decision) decision = 'registration-incomplete';
    if (!decision) return;
    if (decision === 'close') {
      if (current && !ours) return;
      if (current) {
        checkHeld();
        await removeOverlay(root, record.branch, { env, expectedOverlay: current });
      }
      if ((await readOverlays(root)).some(o => o.ref === record.branch)) return;
      checkHeld();
      rmSync(hotPatchLedgerPath(env));
      return;
    }
    record = { ...record, rollbackPending: decision };
    checkHeld();
    write(env, record);
    if (!equal(readHotPatch(env), record)) throw Error('hot-patch rollback intent changed');
    if (current && !ours) {
      await emit({ kind: 'hot-patch-needs-you', detail: 'Overlay replacement mismatch; repair registration before rollback' });
    } else if (current) {
      checkHeld();
      await removeOverlay(root, record.branch, { env, expectedOverlay: current });
    }
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
    if (await contains() || (['pr-head-moved', 'overlay-sha-moved'].includes(decision) && head !== record.preGood.head)) {
      if (typeof rollbackToGood !== 'function') throw Error('hot-patch rollback finalizer required');
      checkHeld();
      await rollbackToGood(record.preGood, { root, env, expectHead: head });
    }
    if (!(await contains()) && !(await readOverlays(root)).some(o => o.ref === record.branch)) {
      if (!equal(readHotPatch(env), record)) throw Error('hot-patch ledger changed before retirement');
      checkHeld();
      rmSync(hotPatchLedgerPath(env));
    }
  });
}
