/**
 * @file hot-patch.mjs - R1100 hot-patch ledger and smoke-passed adoption guard.
 * Pure classification/deadlines are separate from IO. The existing watch lock serializes
 * ledger changes too; transitionWatch remains the only watch writer. No merge permissions change.
 * Unknown evidence refuses adoption; repair the record or use ordinary verified delivery.
 */
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { dirname, join } from 'node:path';
import { stateDir } from './daemon-rebuild/state.mjs';
import { cloneKeyOf } from './daemon-last-good.mjs';
import { transitionWatch, watchPath } from './daemon-force-adopt.mjs';
import { appendDaemonEvent } from './daemon-events.mjs';
import { addOverlay, removeOverlay as dropOverlay, readOverlayState, appendOverlayEvent } from './daemon-overlays.mjs';
import { writeRebuildRequest } from './daemon-clone-lock.mjs';
import { classifyTouchSet, STANDARD_DELIVERY_FLOW } from './delivery-flow.mjs';
import { resolveHotPatchSettings, hotPatchDefaults } from './hot-patch-settings.mjs';
import { readMergeQueueMembership } from './enqueue-on-event.mjs';
import { repoSlugFromRemote } from './lane-verify.mjs';
import { isSafeBranchName } from './daemon-self-sync.mjs';
import { ciVerdict } from './hot-patch-verify-marker.mjs';

const validSha = s => typeof s === 'string' && /^[a-f0-9]{40}$/.test(s);
export const hotPatchPath = (root, env = process.env) => join(stateDir(env), `${cloneKeyOf(root)}.hot-patch.json`);
const pendingPath = (root, env) => `${hotPatchPath(root, env)}.pending`;
const cloneHead = root => {
  const r = spawnSync('git', ['--no-replace-objects', 'rev-parse', '--verify', 'HEAD'],
    { cwd: root, encoding: 'utf8', timeout: 5000, maxBuffer: 4096 });
  return r.status === 0 && validSha(r.stdout.trim()) ? r.stdout.trim() : null;
};
const write = (root, env, record) => {
  const path = hotPatchPath(root, env), tmp = `${path}.${process.pid}.tmp`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(tmp, JSON.stringify(record)); renameSync(tmp, path);
};

export function readHotPatch(root, env = process.env) {
  let text;
  try { text = readFileSync(hotPatchPath(root, env), 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  const r = JSON.parse(text);
  if (!r || !validSha(r.sha) || typeof r.daemon !== 'string' || !r.daemon || !isSafeBranchName(r.branch)
    || typeof r.root !== 'string' || cloneKeyOf(r.root) !== cloneKeyOf(root) || !Number.isFinite(Date.parse(r.loadedAt))
    || !Number.isFinite(Date.parse(r.owed?.prBy)) || !Number.isFinite(Date.parse(r.owed?.mergeBy))
    || !(r.owed.pr === null || (Number.isSafeInteger(r.owed.pr) && r.owed.pr > 0))
    || !['pending', 'green', 'red'].includes(r.owed.verify)
    || (r.lastGood !== undefined && (!validSha(r.lastGood?.head) || !validSha(r.adoptedSha))))
    throw new Error('hot-patch state unreadable; repair ledger before retrying');
  return r;
}
export function hasHotPatch(root, env) {
  try { return readHotPatch(root, env) !== null; } catch { return true; }
}
export function listHotPatches(env = process.env) {
  let names;
  try { names = readdirSync(stateDir(env)); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  return names.filter(n => n.endsWith('.hot-patch.json')).map(n => {
    const r = JSON.parse(readFileSync(join(stateDir(env), n), 'utf8'));
    if (typeof r?.root !== 'string' || hotPatchPath(r.root, env) !== join(stateDir(env), n)) throw new Error('hot-patch state unreadable; repair ledger');
    return readHotPatch(r.root, env);
  });
}

/** PURE. Reuse the delivery touch classifier, including its unsupported-scope closed path. */
export function classifyHotPatch(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, reason: 'malformed-classifier-input; use ordinary delivery' };
  const { files, kind, settings = hotPatchDefaults } = input;
  const refuse = reason => ({ ok: false, reason });
  if (!settings || !Array.isArray(settings.eligibleKinds) || !Array.isArray(settings.neverPatchPaths)
    || !settings.neverPatchPaths.every(p => typeof p === 'string')
    || !Number.isFinite(settings.maxFiles) || settings.maxFiles <= 0
    || !Number.isFinite(settings.maxPathChars) || settings.maxPathChars <= 0) return refuse('malformed-classifier-settings; repair settings or use ordinary delivery');
  if (!settings.eligibleKinds.includes(kind)) return refuse('ineligible-kind');
  if (!Array.isArray(files) || !files.length || files.length > settings.maxFiles
    || files.some(f => typeof f !== 'string' || !f || f.length > settings.maxPathChars || /[:*?]/.test(f)))
    return refuse('unknown-or-oversized-files; supply a bounded concrete diff or use ordinary delivery');
  const policy = { classOrder: ['guard', 'merge', 'ordinary'], classes: {
    guard: [...STANDARD_DELIVERY_FLOW.classes.guard,
      ...new Set([...hotPatchDefaults.neverPatchPaths, ...settings.neverPatchPaths])].map(p => p.startsWith('we:') ? p.toLowerCase() : `we:${p.toLowerCase()}`),
    merge: STANDARD_DELIVERY_FLOW.classes.merge, ordinary: [],
  } };
  const c = classifyTouchSet(files.map(f => `we:${f.toLowerCase()}`), policy);
  return c.class === 'ordinary' ? { ok: true } : refuse(`never-patch-touch-set: ${c.reason}`);
}

/** PURE. Queue membership exempts only the merge deadline, never the PR/verify obligation. */
export function evaluateOwed({ record, now = Date.now(), settings = hotPatchDefaults, queueVerified = null }) {
  const at = typeof now === 'function' ? now() : Number(now);
  if (!Number.isFinite(at) || !Number.isFinite(Date.parse(record?.owed?.mergeBy))
    || !Number.isFinite(Date.parse(record?.owed?.prBy))) return 'block-new';
  const queuedAt = Date.parse(record.inMergeQueueAt);
  const queued = record.inMergeQueue === true && (queueVerified === true
    || (queueVerified === null && Number.isFinite(queuedAt) && queuedAt <= at
      && at - queuedAt < settings.queueExemptionMinutes * 60_000));
  if (at >= Date.parse(record.owed.mergeBy) && !record.merged && !queued) return 'rollback';
  if (at >= Date.parse(record.owed.prBy) && (!record.owed.pr || record.owed.verify !== 'green')) return 'block-new';
  return 'ok';
}

/** PURE. Only the exact registered patch earns a bounded cooldown exception. */
export function hotPatchWakeDue({ record, plan, now, settings = hotPatchDefaults }) {
  return !!record && validSha(record.sha) && Number.isFinite(now) && settings.wake === true
    && record.owed?.verify !== 'red' && !record.rollbackPending
    && (plan?.finalSha === record?.sha || plan?.applied?.some(a => a.ref === record?.branch && a.sha === record?.sha))
    && (record.lastWakeAt === undefined || (Number.isFinite(Date.parse(record.lastWakeAt))
      && now - Date.parse(record.lastWakeAt) >= settings.wakeMinIntervalMs));
}

export function claimHotPatchWake({ root, env = process.env, plan, now = Date.now() }) {
  try { if (!readHotPatch(root, env)) return false; } catch { return false; }
  const settings = resolveHotPatchSettings({ env });
  const out = mutate(root, env, record => {
    if (!record || !hotPatchWakeDue({ record, plan, now, settings })) return { result: { ok: false } };
    write(root, env, { ...record, lastWakeAt: new Date(now).toISOString() });
    return { result: { ok: true } };
  });
  return out.ok;
}

// Reuse the watch's short metadata mutex instead of introducing another lock implementation.
function mutate(root, env, decide) {
  const t = transitionWatch(root, env, (watch, state) => decide(readHotPatch(root, env), watch, state));
  return t.ok ? t.out.result : { ok: false, reason: t.reason, fallback: 'repair hot-patch/watch state or use ordinary delivery' };
}

export async function requestHotPatch({ root, env = process.env, daemon, branch, sha, files, kind,
  now = Date.now, dryRun = false,
  registerOverlay = () => addOverlay(root, { ref: branch, pinned: true, reason: 'R1100 hot-patch' }, { env }), emit = e => appendDaemonEvent(e, { env }) } = {}) {
  if (typeof sha === 'string') sha = sha.toLowerCase();
  const settings = resolveHotPatchSettings({ env });
  const c = classifyHotPatch({ files, kind, settings });
  if (!c.ok) return c;
  if (typeof root !== 'string' || !root || !validSha(sha) || typeof daemon !== 'string' || !daemon || /[\x00-\x1f\x7f]/.test(daemon)
    || !isSafeBranchName(branch)) return { ok: false, reason: 'invalid-root-sha-daemon-or-branch' };
  const at = typeof now === 'function' ? now() : Number(now);
  const reservation = { root, daemon, branch, sha, kind, loadedAt: new Date(at).toISOString(),
    owed: { prBy: new Date(at + settings.owedPrMinutes * 60_000).toISOString(),
      mergeBy: new Date(at + settings.owedMergeHours * 3_600_000).toISOString(), pr: null, verify: 'pending' } };
  const check = (record, watch, state) => {
    if (record) return { ok: false, reason: evaluateOwed({ record, now: at }) === 'ok' ? 'hot-patch-already-open' : 'owed-deadline-missed' };
    if (watch || state === 'unreadable') return { ok: false, reason: 'watch-open-or-unreadable' };
    return { ok: true, record: reservation };
  };
  const result = mutate(root, env, (record, watch, state) => {
    const result = check(record, watch, state);
    if (result.ok && !dryRun) writeFileSync(pendingPath(root, env), JSON.stringify({ ...reservation, pid: process.pid }), { flag: 'wx' });
    return { result };
  });
  if (!result.ok || dryRun) return result;
  let entry, accepted = false;
  const head = cloneHead(root);
  const assertRegistration = () => {
    if (!head || cloneHead(root) !== head || !isDeepStrictEqual(readHotPatch(root, env), reservation))
      throw new Error('head-or-record-changed; repair state or use ordinary delivery');
  };
  try {
    const published = mutate(root, env, (record, watch, state) => {
      const result = check(record, watch, state);
      if (result.ok) { write(root, env, reservation); assertRegistration(); }
      return { result };
    });
    if (!published.ok) return published;
    assertRegistration();
    await registerOverlay(assertRegistration);
    assertRegistration();
    const overlays = readOverlayState(root, { env });
    entry = overlays.overlays.find(o => o.ref === branch);
    if (overlays.corrupt || !entry) throw new Error('overlay registration unavailable');
    if (await emit({ kind: 'hot-patch-loaded', daemon, detail: { root, sha, branch } }) === false) throw new Error('wake event failed');
    const committed = mutate(root, env, (record, watch, state) => {
      assertRegistration();
      if (watch || state === 'unreadable') throw new Error('watch changed during registration');
      const result = { ok: true, record: reservation };
      const fresh = readOverlayState(root, { env });
      if (fresh.corrupt || !isDeepStrictEqual(entry, fresh.overlays.find(o => o.ref === branch))) throw new Error('overlay changed');
      write(root, env, reservation);
      if (!isDeepStrictEqual(readHotPatch(root, env), reservation)) throw new Error('ledger changed after write');
      // Re-read the watch after the ledger write, even for writers outside our mutex.
      let appeared = false;
      try { readFileSync(watchPath(root, env), 'utf8'); appeared = true; }
      catch (e) { if (e.code !== 'ENOENT') { rmSync(hotPatchPath(root, env), { force: true }); throw e; } }
      if (appeared) { rmSync(hotPatchPath(root, env), { force: true }); throw new Error('watch changed after write'); }
      return { result };
    });
    accepted = committed.ok;
    return committed;
  } catch (e) {
    return { ok: false, reason: `hot-patch refused: ${e.message}`, fallback: 'repair state or use ordinary delivery' };
  } finally {
    // A refused request must neither suppress retries nor leave an untracked overlay.
    const persisted = readHotPatch(root, env);
    if (!accepted) {
      if (isDeepStrictEqual(persisted, reservation)) rmSync(hotPatchPath(root, env), { force: true });
      const current = readOverlayState(root, { env });
      const added = current.overlays.find(o => o.ref === branch);
      if (added && (!entry || isDeepStrictEqual(entry, added))) dropOverlay(root, branch, { env, expectedOverlay: added });
    }
    rmSync(pendingPath(root, env), { force: true });
  }
}

/** Called only for a smoke-passed candidate and again under the ready-adoption lock. */
export function openHotPatchWatch({ root, env = process.env, plan, lastGood, smokePassed, now = Date.now }) {
  const settings = resolveHotPatchSettings({ env });
  try {
    readFileSync(pendingPath(root, env), 'utf8');
    return { ok: false, reason: 'hot-patch-registration-pending' };
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  return mutate(root, env, (record, watch, state) => {
    const matching = record && (record.sha === plan.finalSha
      || plan.applied?.some(a => a.ref === record.branch && a.sha === record.sha));
    if (!matching) {
      const overlays = readOverlayState(root, { env });
      const orphan = overlays.corrupt || overlays.overlays.some(o => o.reason === 'R1100 hot-patch');
      return { result: { ok: !record && !orphan, reason: 'missing-or-mismatched-hot-patch-record' } };
    }
    if (!validSha(plan.finalSha)) return { result: { ok: false, reason: 'invalid-plan-sha' } };
    const good = record.lastGood ?? lastGood;
    const head = cloneHead(root);
    if (!head || (head !== good?.head && head !== plan.finalSha)) return { result: { ok: false, reason: 'clone-head-moved' } };
    const validWatch = !watch || (watch.sha === plan.finalSha && validSha(watch.sha) && validSha(watch.lastGood?.head)
      && watch.lastGood.head === good?.head && Number.isSafeInteger(watch.ticksLeft) && watch.ticksLeft >= 0
      && Number.isFinite(Date.parse(watch.startedAt)) && Number.isFinite(Date.parse(watch.minUntil)));
    if (!smokePassed || record.owed.verify === 'red' || record.rollbackPending || state === 'unreadable'
      || !validSha(good?.head) || good.head === plan.finalSha || (watch && watch.hotPatchSha !== record.sha)
      || !validWatch || watch?.rollbackPending) return { result: { ok: false, reason: 'hot-patch-adoption-refused; passing smoke, known lastGood and readable watch required' } };
    const at = typeof now === 'function' ? now() : Number(now);
    if (watch) return { ...(watch.adoptedSeen ? {} : { next: { ...watch, startedAt: new Date(at).toISOString(),
      minUntil: new Date(at + settings.minMinutes * 60_000).toISOString() } }), result: { ok: true } };
    const adopted = { ...record, lastGood: good, adoptedSha: plan.finalSha };
    write(root, env, adopted);
    if (cloneHead(root) !== head || !isDeepStrictEqual(readHotPatch(root, env), adopted))
      return { result: { ok: false, reason: 'head-or-record-changed; repair state before adoption' } };
    return { next: { daemon: record.daemon, ruling: 'R1100', sha: plan.finalSha, hotPatchSha: record.sha,
      lastGood: good, ticksLeft: settings.ticks, minUntil: new Date(at + settings.minMinutes * 60_000).toISOString(),
      ciState: 'pending', bad: 0, startedAt: new Date(at).toISOString() }, result: { ok: true } };
  });
}

/** Compare-guard the registration and publish the same durable rebuild request as overlay removal. */
export function removeHotPatchOverlay({ root, env, record }) {
  const state = readOverlayState(root, { env });
  if (state.corrupt) throw new Error('overlay state unreadable');
  const entry = state.overlays.find(o => o.ref === record.branch);
  if (entry) {
    dropOverlay(root, record.branch, { env, expectedOverlay: entry });
    appendOverlayEvent(root, { kind: 'removed', ref: record.branch, reason: 'hot-patch-rollback' }, { env });
  }
  writeRebuildRequest(root, { reason: 'hot-patch-rollback', ref: record.branch, lockRoot: env.WE_DAEMON_CLONE_LOCK_ROOT });
}

function updateResult({ root, env, sha, result, reason, ciState, ciUnknownMaxTicks }) {
  if (typeof sha === 'string') sha = sha.toLowerCase();
  return mutate(root, env, (record, watch, state) => {
    if (!record || record.sha !== sha) return { result: { ok: false, reason: 'hot-patch-sha-mismatch' } };
    // Count under the metadata mutex. Legacy records start at zero; corrupt counters fail closed.
    let ciUnknownTicks = record.ciUnknownTicks;
    if (ciState !== undefined) {
      const previous = ciUnknownTicks === undefined ? 0 : ciUnknownTicks;
      ciUnknownTicks = ciState === 'unknown'
        ? (Number.isSafeInteger(previous) && previous >= 0 ? previous + 1 : ciUnknownMaxTicks + 1) : 0;
      if (ciUnknownTicks > ciUnknownMaxTicks) reason ??= 'ci-unknown-limit';
      result = ciState === 'unknown' ? 'pending' : ciState;
    }
    // A red result is sticky: a later green run cannot cancel an owed rollback.
    const red = result === 'red' || record.owed.verify === 'red';
    reason = record.rollbackPending ?? reason ?? (red ? 'verify-red' : null);
    const next = { ...record, ...(ciState !== undefined ? { ciUnknownTicks } : {}), owed: { ...record.owed, verify: red ? 'red' : result ?? record.owed.verify },
      ...(reason ? { rollbackPending: reason } : {}) };
    write(root, env, next);
    if (!reason) return {
      ...(watch?.hotPatchSha === sha && (ciState ?? result) ? { next: { ...watch, ciState: ciState ?? result } } : {}),
      result: { ok: true } };

    if (state === 'unreadable' || (watch && watch.hotPatchSha !== sha)) return { result: {
      ok: false, reason: 'watch-unreadable-or-unrelated; repair state and retry verify-result', record: next } };
    const w = watch ?? (record.lastGood ? { daemon: record.daemon, ruling: 'R1100', sha: record.adoptedSha,
      hotPatchSha: sha, lastGood: record.lastGood, ticksLeft: 0, startedAt: record.loadedAt, adoptedSeen: true } : null);
    return { ...(w ? { next: { ...w, rollbackPending: reason } } : {}),
      result: { ok: true, record: next, changed: !record.rollbackPending } };
  });
}

// Caller/local results are explicitly ignored; GitHub alone supplies the verdict.
export async function recordVerifyResult({ root, env = process.env, sha, runGh, result: _ignoredLocalResult,
  emit = e => appendDaemonEvent(e, { env }), removeOverlay = removeHotPatchOverlay }) {
  const evidence = ciVerdict({ sha, root, env, runGh });
  if (evidence.state === 'unknown') return { ok: false, ...evidence };
  const result = evidence.state;
  const out = updateResult({ root, env, sha, result });
  if (out.record) {
    await removeOverlay({ root, env, record: out.record });
    if (out.changed) await emit({ kind: 'hot-patch-rolled-back', daemon: out.record.daemon, detail: { sha, reason: out.record.rollbackPending, rollbackPending: true } });
  }
  return out;
}

export function recordHotPatchPr({ root, env = process.env, sha, pr, inMergeQueue = false, now = Date.now, run = spawnSync }) {
  if (typeof sha === 'string') sha = sha.toLowerCase();
  if (!Number.isSafeInteger(pr) || pr <= 0) return { ok: false, reason: 'invalid-pr' };
  return mutate(root, env, record => {
    if (!record || record.sha !== sha) return { result: { ok: false, reason: 'hot-patch-sha-mismatch' } };
    const refuse = () => ({ result: { ok: false,
      reason: 'pr-verification-failed; retry linkage with readable PR evidence matching this branch and SHA' } });
    try {
      const response = run('gh', ['pr', 'view', String(pr), '--json', 'headRefName,headRefOid,state'],
        { cwd: root, env, encoding: 'utf8', timeout: 15000, maxBuffer: 65536 });
      if (response?.status !== 0 || response.error || typeof response.stdout !== 'string'
        || Buffer.byteLength(response.stdout, 'utf8') > 65536) return refuse();
      const evidence = JSON.parse(response.stdout);
      if (evidence?.headRefName !== record.branch || typeof evidence.headRefOid !== 'string'
        || !/^[a-f0-9]{40}$/i.test(evidence.headRefOid) || evidence.headRefOid.toLowerCase() !== record.sha
        || !['OPEN', 'CLOSED', 'MERGED'].includes(evidence.state)) return refuse();
    } catch { return refuse(); }
    const state = readOverlayState(root, { env });
    if (state.corrupt) throw new Error('overlay state unreadable');
    const entry = state.overlays.find(o => o.ref === record.branch);
    if (entry) addOverlay(root, { ...entry, pr }, { env, expectedOverlay: entry });
    write(root, env, { ...record, owed: { ...record.owed, pr }, prVerifiedSha: record.sha, inMergeQueue: inMergeQueue === true,
      inMergeQueueAt: inMergeQueue === true ? new Date(typeof now === 'function' ? now() : now).toISOString() : null });
    return { result: { ok: true } };
  });
}

export async function closeHotPatch({ root, env = process.env, sha, reason = 'merged', emit = e => appendDaemonEvent(e, { env }) }) {
  const result = mutate(root, env, record => {
    if (!record || (sha && record.sha !== sha)) return { result: { ok: false, reason: 'hot-patch-sha-mismatch' } };
    if (reason === 'rolled-back') {
      // Withdrawal failure must remain owed even after the force watch has retired.
      write(root, env, { ...record, rollbackPending: record.rollbackPending ?? 'health-rollback' });
      removeHotPatchOverlay({ root, env, record });
    }
    rmSync(hotPatchPath(root, env));
    return { result: { ok: true, record } };
  });
  if (result.ok) await emit({ kind: 'hot-patch-closed', daemon: result.record.daemon, detail: { sha: result.record.sha, reason } });
  return result;
}

// One shared, throttled queue read per owed tick; unknown origin/membership grants no exemption.
async function readHotPatchQueue({ root, env, num }) {
  const remote = spawnSync('git', ['remote', 'get-url', 'origin'],
    { cwd: root, encoding: 'utf8', timeout: 5000, maxBuffer: 4096 });
  const repo = remote.status === 0 ? repoSlugFromRemote(remote.stdout) : null;
  return repo ? readMergeQueueMembership({ repo, num, env }) : { ok: false };
}

export async function runOwedTick({ root, env = process.env, now = Date.now, readQueue = readHotPatchQueue, runGh,
  emit = e => appendDaemonEvent(e, { env }), removeOverlay = removeHotPatchOverlay }) {
  try {
    const pending = JSON.parse(readFileSync(pendingPath(root, env), 'utf8'));
    if (pending.pid > 0) {
      try { process.kill(pending.pid, 0); return 'block-new'; }
      catch (e) { if (e.code !== 'ESRCH') throw e; }
    }
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  rmSync(pendingPath(root, env), { force: true });
  let record = readHotPatch(root, env);
  if (!record) {
    // Only registrations explicitly owned by this path may be reconciled.
    const state = readOverlayState(root, { env });
    if (state.corrupt) throw new Error('overlay state unreadable; repair before adoption');
    for (const entry of state.overlays.filter(o => o.reason === 'R1100 hot-patch'))
      removeHotPatchOverlay({ root, env, record: { branch: entry.ref } });
    rmSync(pendingPath(root, env), { force: true });
    return 'ok';
  }
  const settings = resolveHotPatchSettings({ env });
  const at = typeof now === 'function' ? now() : Number(now);
  const evidence = ciVerdict({ sha: record.sha, root, env, runGh, settings });
  // Invalid overrides fall back to the finite standard grace period.
  const ciUnknownMaxTicks = Number.isSafeInteger(settings.ciUnknownMaxTicks) && settings.ciUnknownMaxTicks >= 0
    ? settings.ciUnknownMaxTicks : hotPatchDefaults.ciUnknownMaxTicks;
  const ciUpdate = updateResult({ root, env, sha: record.sha, ciState: evidence.state, ciUnknownMaxTicks });
  if (!ciUpdate.ok) throw new Error(ciUpdate.reason);
  record = readHotPatch(root, env);
  let queueVerified = false;
  if (record.inMergeQueue === true && record.owed.pr) {
    try {
      const membership = await readQueue({ root, env, num: record.owed.pr });
      queueVerified = membership?.ok === true && membership.inQueue === true;
    } catch { /* Unreadable membership owes ordinary rollback. */ }
  }
  const verdict = record.rollbackPending ? 'rollback' : evaluateOwed({ record, now: at, settings, queueVerified });
  if (verdict === 'rollback' || record.rollbackPending) {
    // Keep the ledger until the watch actually reverts the running build. A failed rollback remains owed.
    const marked = updateResult({ root, env, sha: record.sha, reason: record.rollbackPending ?? 'owed-merge-deadline' });
    await removeOverlay({ root, env, record });
    if (!marked.ok) throw new Error(marked.reason);
    if (marked.changed || ciUpdate.changed) await emit({ kind: 'hot-patch-rolled-back', daemon: record.daemon, detail: { sha: record.sha, reason: marked.record.rollbackPending, rollbackPending: true } });
  }
  return verdict;
}
