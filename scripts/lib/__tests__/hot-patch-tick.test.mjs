/** Tick contract exercised against a real local clone and actual Git ancestry. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { hotPatchLedgerPath, readHotPatch, runHotPatchTick, CI_UNKNOWN_MS,
  HOT_PATCH_MAX_OPEN_MS, HOT_PATCH_OVERLAY_REASON } from '../hot-patch.mjs';
import { readRebuildRequest } from '../daemon-clone-lock.mjs';
import { processStartMs } from '../daemon-rebuild/lease.mjs';

const at = 1700000000000;
// Real-repository harness ported from origin/lane/hot-patch-s2, without old settings tests.
const fixture = fn => async () => {
  const home = mkdtempSync(join(tmpdir(), 'hot-patch-tick-'));
  const origin = join(home, 'origin'), root = join(home, 'clone');
  const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const git = (args, cwd = root) => {
    const r = spawnSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test',
      '-c', 'commit.gpgsign=false', ...args], { cwd, env: gitEnv, encoding: 'utf8', timeout: 5000, maxBuffer: 65536 });
    assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
  };
  git(['init', '-q', '-b', 'main', origin], home);
  writeFileSync(join(origin, 'README.md'), 'base\n');
  git(['add', '.'], origin); git(['commit', '-qm', 'base'], origin);
  git(['clone', '-q', origin, root], home);
  const good = git(['rev-parse', 'HEAD']);
  git(['checkout', '-qb', 'lane/repair']);
  writeFileSync(join(root, 'README.md'), 'patch\n'); git(['commit', '-qam', 'patch']);
  const sha = git(['rev-parse', 'HEAD']);
  const env = { ...gitEnv, HOME: home, WE_DAEMON_STATE_DIR: join(home, 'state'),
    WE_DAEMON_OVERLAY_DIR: join(home, 'overlays'), WE_DAEMON_CLONE_LOCK_ROOT: join(home, 'locks'),
    WE_DAEMON_EVENTS: join(home, 'events.jsonl') };
  mkdirSync(env.WE_DAEMON_STATE_DIR);
  const preGood = { head: good, inputsKey: 'c'.repeat(40), mainSha: good, applied: [] };
  const overlay = { ref: 'lane/repair', pr: 42, pinned: true, reason: HOT_PATCH_OVERLAY_REASON,
    addedAt: new Date(at).toISOString(), addedBy: null };
  // Current pid with a provably different start denotes a completed/reused requester, never a guessed dead pid.
  const start = processStartMs(process.pid);
  assert(Number.isFinite(start));
  const record = { sha, pr: 42, branch: 'lane/repair', root, requestPid: process.pid,
    requestStart: start - 60000, loadedAt: new Date(at).toISOString(), overlay, preGood };
  const save = value => writeFileSync(hotPatchLedgerPath(env), JSON.stringify(value));
  save(record);
  let overlays = [structuredClone(overlay)];
  const events = [], order = [], rollbacks = [];
  const contains = candidate => {
    const r = spawnSync('git', ['merge-base', '--is-ancestor', candidate, 'HEAD'],
      { cwd: root, env: gitEnv, encoding: 'utf8', timeout: 5000, maxBuffer: 65536 });
    assert([0, 1].includes(r.status), r.stderr); return r.status === 0;
  };
  const tick = overrides => runHotPatchTick({ root, env, now: () => at + 1,
    ciVerdict: async () => { order.push('ci'); return { state: 'pending', reason: 'running' }; },
    prState: async () => { order.push('pr'); return { state: 'OPEN', headRefOid: sha, headRefName: 'lane/repair' }; },
    readOverlays: () => structuredClone(overlays),
    removeOverlay: async () => { order.push('remove'); overlays = []; },
    readHead: () => git(['rev-parse', 'HEAD']), headContains: contains,
    rollbackToGood: async goodState => {
      order.push('rollback'); rollbacks.push(goodState);
      assert.deepEqual(goodState, preGood);
      assert(readHotPatch(env).rollbackPending, 'rollback intent persisted before moving HEAD');
      git(['reset', '--hard', goodState.head]); return { ok: true };
    },
    emit: async event => { events.push(event); return true; },
    ...overrides });
  try { await fn({ root, env, git, sha, good, preGood, overlay, record, save, tick,
    contains, order, rollbacks, events, start,
    overlays: () => structuredClone(overlays), replaceOverlay: entry => { overlays = [entry]; } }); }
  finally { rmSync(home, { recursive: true, force: true }); }
};
const red = { ciVerdict: async () => ({ state: 'red', reason: 'daemon-soak failed' }) };
const unknown = { ciVerdict: async () => ({ state: 'unknown', reason: 'API unreadable' }) };
for (const trigger of ['red CI', 'moved PR head', '24h deadline', 'closed unmerged PR']) {
  test(`${trigger}: removes equal overlay before rollbackToGood(preGood)`, fixture(async f => {
    const overrides = trigger === 'red CI' ? red : trigger === 'moved PR head'
      ? { prState: async () => ({ state: 'OPEN', headRefOid: f.good }) }
      : trigger === '24h deadline' ? { now: () => at + HOT_PATCH_MAX_OPEN_MS }
      : { prState: async () => ({ state: 'CLOSED', headRefOid: f.sha }) };
    await f.tick(overrides);
    assert.deepEqual(f.rollbacks, [f.preGood]);
    assert(f.order.indexOf('remove') < f.order.indexOf('rollback'));
    assert.deepEqual(f.overlays(), []);
    assert.equal(f.git(['rev-parse', 'HEAD']), f.good);
  }));
}
test('replacement overlay is not removed and pages the operator', fixture(async f => {
  const replacement = { ...f.overlay, addedAt: new Date(at + 1).toISOString() };
  f.replaceOverlay(replacement);
  await f.tick(red);
  assert(!f.order.includes('remove'));
  assert.deepEqual(f.overlays(), [replacement]);
  assert(f.events.length > 0, 'replacement mismatch must page, not silently skip');
  assert.match(JSON.stringify(f.events), /mismatch|replacement|needs-you|page|attention/i);
  assert(readHotPatch(f.env), 'replacement keeps unresolved ledger');
}));
test('CI unknown below 30min since loadedAt does nothing', fixture(async f => {
  await f.tick({ ...unknown, now: () => at + CI_UNKNOWN_MS - 1 });
  assert.deepEqual(f.rollbacks, []); assert(!f.order.includes('remove'));
  assert.deepEqual(readHotPatch(f.env), f.record);
}));
test('CI unknown above 30min since loadedAt rolls back', fixture(async f => {
  // A recent wake must not reset the loadedAt deadline.
  f.save({ ...f.record, wokeAt: new Date(at + CI_UNKNOWN_MS).toISOString() });
  await f.tick({ ...unknown, now: () => at + CI_UNKNOWN_MS + 1 });
  assert.deepEqual(f.rollbacks, [f.preGood]);
}));
test('later build containing the patch also rolls back via merge-base --is-ancestor', fixture(async f => {
  writeFileSync(join(f.root, 'later'), 'later'); f.git(['add', '.']); f.git(['commit', '-qm', 'later build']);
  assert.notEqual(f.git(['rev-parse', 'HEAD']), f.sha); assert(f.contains(f.sha));
  await f.tick(red);
  assert.deepEqual(f.rollbacks, [f.preGood]); assert(!f.contains(f.sha));
}));
test('rollback ledger remains while HEAD still contains sha; retires once both HEAD and overlay are clear', fixture(async f => {
  await f.tick({ ...red, rollbackToGood: async () => ({ ok: false }) });
  assert(f.contains(f.sha)); assert.deepEqual(f.overlays(), []);
  assert(readHotPatch(f.env).rollbackPending);
  f.git(['reset', '--hard', f.good]);
  await f.tick();
  assert.equal(readHotPatch(f.env), null);
}));
test('ledger does not retire merely because HEAD is clean when overlay remains', fixture(async f => {
  f.save({ ...f.record, rollbackPending: 'ci-red' });
  f.git(['reset', '--hard', f.good]);
  f.replaceOverlay({ ...f.overlay, addedAt: new Date(at + 2).toISOString() });
  await f.tick(); assert(readHotPatch(f.env)); assert.equal(f.overlays().length, 1);
}));
test('MERGED PR at exact sha closes ledger only after CI is read in the same tick', fixture(async f => {
  await f.tick({ prState: async () => {
    assert(f.order.includes('ci')); assert(readHotPatch(f.env));
    return { state: 'MERGED', headRefOid: f.sha };
  } });
  assert.equal(readHotPatch(f.env), null); assert.deepEqual(f.rollbacks, []);
}));
for (const phase of ['CI', 'PR', 'rollback']) test(`throw during ${phase} keeps the ledger`, fixture(async f => {
  const fail = async () => { throw Error('injected failure'); };
  const overrides = phase === 'CI' ? { ciVerdict: fail } : phase === 'PR' ? { prState: fail }
    : { ...red, rollbackToGood: fail };
  try { await f.tick(overrides); } catch (error) { assert.match(error.message, /injected failure/); }
  assert(readHotPatch(f.env), 'retry evidence must survive a throw');
}));
test('no action while request pid and start are still alive', fixture(async f => {
  f.save({ ...f.record, requestStart: f.start });
  await f.tick({ ciVerdict: async () => { assert.fail('CI must not run during live request'); } });
  assert.deepEqual(f.order, []); assert.deepEqual(f.rollbacks, []);
  assert.equal(readHotPatch(f.env).requestStart, f.start);
}));
test('unreadable ledger plus R1100 hot-patch overlay removes it and requests rebuild', fixture(async f => {
  writeFileSync(hotPatchLedgerPath(f.env), '{bad');
  await f.tick();
  assert(f.order.includes('remove')); assert.deepEqual(f.overlays(), []);
  assert(readRebuildRequest(f.root, { env: f.env, lockRoot: f.env.WE_DAEMON_CLONE_LOCK_ROOT, nowMs: at + 1 }),
    'orphan overlay removal must leave a real rebuild request');
  assert.deepEqual(f.rollbacks, []);
}));
