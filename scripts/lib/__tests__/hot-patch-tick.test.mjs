/** Tick contract exercised against a real local clone and actual Git ancestry. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { hotPatchLedgerPath, readHotPatch, runHotPatchTick, CI_UNKNOWN_MS,
  HOT_PATCH_MAX_OPEN_MS, HOT_PATCH_OVERLAY_REASON, HOT_PATCH_ALLOWLIST, WAKE_FLOOR_MS } from '../hot-patch.mjs';
import * as hotPatch from '../hot-patch.mjs';
import { overlayFilePath, readOverlays as diskOverlays, removeOverlay as diskRemove } from '../daemon-overlays.mjs';
import { cloneKeyOf } from '../daemon-last-good.mjs';
import { hotPatchCiVerdict } from '../hot-patch-ci.mjs';
import { readRebuildRequest } from '../daemon-clone-lock.mjs';

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
  mkdirSync(dirname(join(origin, HOT_PATCH_ALLOWLIST[0])), { recursive: true });
  writeFileSync(join(origin, HOT_PATCH_ALLOWLIST[0]), '// base\n');
  git(['add', '.'], origin); git(['commit', '-qm', 'base'], origin);
  git(['clone', '-q', origin, root], home);
  const good = git(['rev-parse', 'HEAD']);
  git(['checkout', '-qb', 'lane/repair']);
  writeFileSync(join(root, HOT_PATCH_ALLOWLIST[0]), '// patch\n'); git(['commit', '-qam', 'patch']);
  const sha = git(['rev-parse', 'HEAD']);
  git(['update-ref', 'refs/remotes/origin/lane/repair', sha]);
  const env = { ...gitEnv, HOME: home, WE_DAEMON_STATE_DIR: join(home, 'state'),
    WE_DAEMON_OVERLAY_DIR: join(home, 'overlays'), WE_DAEMON_CLONE_LOCK_ROOT: join(home, 'locks'),
    WE_DAEMON_EVENTS: join(home, 'events.jsonl') };
  mkdirSync(env.WE_DAEMON_STATE_DIR);
  const preGood = { head: good, inputsKey: 'c'.repeat(40), mainSha: good, applied: [] };
  const overlay = { ref: 'lane/repair', pr: 42, pinned: true, reason: HOT_PATCH_OVERLAY_REASON,
    addedAt: new Date(at).toISOString(), addedBy: null, expectedSha: sha };
  // Current pid with a provably different start denotes a completed/reused requester, never a guessed dead pid.
  const start = at;
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
  const tick = overrides => runHotPatchTick({ root, env, now: () => at + 1, startTimeOf: () => start,
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
  await assert.rejects(() => f.tick({ ...red, rollbackToGood: async () => ({ ok: false }) }), /rollback/i);
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
  await f.tick({ ciVerdict: async () => { f.order.push('ci'); return { state: 'green' }; }, prState: async () => {
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
test('R3.10 unreadable ledger preserves reason-only and foreign tags, alerts once', fixture(async f => {
  writeFileSync(hotPatchLedgerPath(f.env), '{bad');
  const reasonOnly = { ...f.overlay };
  const sibling = join(f.root, '..', 'other-clone');
  mkdirSync(sibling);
  const foreign = { ...f.overlay, hotPatch: { sha: f.sha,
    loadedAt: f.record.loadedAt, ledgerKey: cloneKeyOf(hotPatchLedgerPath(f.env)) } };
  mkdirSync(f.env.WE_DAEMON_OVERLAY_DIR, { recursive: true });
  writeFileSync(overlayFilePath(f.root, f.env), JSON.stringify({ clone: f.root, overlays: [reasonOnly] }));
  writeFileSync(overlayFilePath(sibling, f.env), JSON.stringify({ clone: sibling, overlays: [foreign] }));
  const removals = [];
  await f.tick({ readOverlays: target => diskOverlays(target, { env: f.env }),
    removeOverlay: async (...args) => {
      removals.push({ root: args[0], ref: args[1] });
      return diskRemove(...args);
    } });
  assert.deepEqual(removals, []);
  assert.deepEqual(diskOverlays(f.root, { env: f.env }), [reasonOnly]);
  assert.deepEqual(diskOverlays(sibling, { env: f.env }), [foreign]);
  assert.equal(f.events.filter(e => e.kind === 'hot-patch-needs-you').length, 1);
  assert.equal(readRebuildRequest(f.root, { env: f.env, lockRoot: f.env.WE_DAEMON_CLONE_LOCK_ROOT, nowMs: at + 1 }), null);
}));
test('R3.10 correctly tagged orphan is removed and requests rebuild', fixture(async f => {
  f.replaceOverlay({ ...f.overlay, hotPatch: { sha: f.sha, loadedAt: f.record.loadedAt,
    ledgerKey: cloneKeyOf(hotPatchLedgerPath(f.env)) } });
  writeFileSync(hotPatchLedgerPath(f.env), '{bad');
  await f.tick();
  assert.deepEqual(f.overlays(), []);
  assert(readRebuildRequest(f.root, { env: f.env, lockRoot: f.env.WE_DAEMON_CLONE_LOCK_ROOT, nowMs: at + 1 }));
}));
test('claimHotPatchWake refuses sibling, missing root, and incomplete registration', fixture(async f => {
  const plan = { applied: [{ ref: f.record.branch, sha: f.sha }] };
  assert.equal(typeof hotPatch.claimHotPatchWake, 'function');
  assert.equal(await hotPatch.claimHotPatchWake(f.env, join(f.root, 'sibling'), plan, at - WAKE_FLOOR_MS), false);
  assert.equal(await hotPatch.claimHotPatchWake(f.env, undefined, plan, at - WAKE_FLOOR_MS), false);
  f.save({ ...f.record, overlay: null });
  assert.equal(await hotPatch.claimHotPatchWake(f.env, f.root, plan, at - WAKE_FLOOR_MS), false);
}));
test('claimHotPatchWake serializes concurrent claims and persists a single wake', fixture(async f => {
  assert.equal(typeof hotPatch.claimHotPatchWake, 'function');
  const claim = () => hotPatch.claimHotPatchWake(f.env, f.root,
    { applied: [{ ref: f.record.branch, sha: f.sha }] }, at - WAKE_FLOOR_MS);
  const results = await Promise.all([claim(), claim()]);
  assert.deepEqual(results.sort(), [false, true]);
  assert(readHotPatch(f.env).wokeAt);
}));
test('lost tick lock after overlay removal stops rollback and retirement', fixture(async f => {
  let held = true;
  await assert.rejects(() => f.tick({ ...red, lock: async (_root, fn) => fn(() => held),
    removeOverlay: async () => { held = false; },
  }), /write lock lost/);
  assert.equal(f.rollbacks.length, 0);
  assert(readHotPatch(f.env).rollbackPending);
}));
for (const source of ['overlay', 'applied']) test(`tick rolls back when ${source} SHA differs from ledger despite unchanged PR head`, fixture(async f => {
  if (source === 'overlay') {
    const original = { ...f.overlay, expectedSha: f.good };
    f.save({ ...f.record, overlay: original });
    f.replaceOverlay(original);
  }
  await f.tick(source === 'applied' ? { readRebuildState: () => ({ adopted: { applied: [{ ref: f.record.branch, sha: f.good }] } }) } : {});
  assert.deepEqual(f.rollbacks, [f.preGood]);
  assert.equal(readHotPatch(f.env), null);
}));
test('force-pushed replacement excluding original SHA rolls back on exact PR head mismatch', fixture(async f => {
  f.git(['checkout', '-B', f.record.branch, f.good]);
  writeFileSync(join(f.root, 'replacement'), 'replacement');
  f.git(['add', '.']); f.git(['commit', '-qm', 'force replacement']);
  const replacement = f.git(['rev-parse', 'HEAD']);
  assert(!f.contains(f.sha));
  // Keep the registered expected SHA pinned so the PR-head check independently triggers rollback.
  const pinned = { ...f.overlay, expectedSha: f.sha };
  f.save({ ...f.record, overlay: pinned }); f.replaceOverlay(pinned);
  let reason;
  await f.tick({ prState: async () => ({ state: 'OPEN', headRefOid: replacement }),
    removeOverlay: async () => { reason = readHotPatch(f.env).rollbackPending; } });
  assert.equal(reason, 'pr-head-moved');
  assert.deepEqual(f.rollbacks, [f.preGood]);
  assert(readHotPatch(f.env), 'overlay still present must keep ledger even when SHA absent from HEAD');
}));
for (const state of ['pending', 'unknown']) test(`MERGED PR with ${state} CI keeps ledger open`, fixture(async f => {
  await f.tick({ ciVerdict: async () => ({ state }), prState: async () => ({ state: 'MERGED', headRefOid: f.sha }) });
  assert.deepEqual(readHotPatch(f.env), f.record);
  assert.equal(f.overlays().length, 1);
}));
test('MERGED PR with unknown CI beyond 30 minutes still rolls back', fixture(async f => {
  await f.tick({ ...unknown, now: () => at + CI_UNKNOWN_MS + 1,
    prState: async () => ({ state: 'MERGED', headRefOid: f.sha }) });
  assert.deepEqual(f.rollbacks, [f.preGood]);
}));
test('green MERGED ledger never retires while overlay removal fails to clear it', fixture(async f => {
  await f.tick({ ciVerdict: async () => ({ state: 'green' }),
    prState: async () => ({ state: 'MERGED', headRefOid: f.sha }), removeOverlay: async () => {} });
  assert(readHotPatch(f.env)); assert.equal(f.overlays().length, 1);
}));
test('crash after registration before overlay persistence recovers matching overlayIntent', fixture(async f => {
  f.save({ ...f.record, overlay: null, overlayIntent: { ...f.overlay, expectedSha: f.sha } });
  await f.tick(red);
  assert.deepEqual(f.overlays(), []);
  assert.deepEqual(f.rollbacks, [f.preGood]);
  assert.equal(readHotPatch(f.env), null);
}));
test('crash recovery preserves overlay not matching intended PR', fixture(async f => {
  f.save({ ...f.record, overlay: null, overlayIntent: { ...f.overlay, expectedSha: f.sha } });
  f.replaceOverlay({ ...f.overlay, pr: 99 });
  await f.tick(red);
  assert.equal(f.overlays().length, 1);
  assert(readHotPatch(f.env).rollbackPending);
}));

test('pinned expected SHA ignores a moving remote tip while PR evidence still reports original SHA', fixture(async f => {
  f.git(['update-ref', `refs/remotes/origin/${f.record.branch}`, f.good]);
  await f.tick();
  assert.deepEqual(f.rollbacks, []);
  assert.deepEqual(readHotPatch(f.env), f.record);
}));
test('tick uses remote-tracking overlay identity when clone has no local overlay branch', fixture(async f => {
  f.git(['checkout', '--detach']);
  f.git(['branch', '-D', f.record.branch]);
  await f.tick();
  assert.deepEqual(readHotPatch(f.env), f.record);
  assert.deepEqual(f.rollbacks, []);
}));

test('R3.8a/R3.11 failed rollback throws, retains ledger, and raises an operator alert', fixture(async f => {
  await assert.rejects(() => f.tick({ ...red, rollbackToGood: async () => ({ ok: false }) }), /rollback/i);
  assert(readHotPatch(f.env).rollbackPending);
  assert.equal(f.git(['rev-parse', 'HEAD']), f.sha);
  assert(f.events.some(e => e.kind === 'hot-patch-needs-you'));
}));
test('R3.8b squash-equivalent patch on HEAD cannot retire and must roll back', fixture(async f => {
  f.git(['checkout', '-B', 'squashed', f.good]);
  f.git(['cherry-pick', '--no-commit', f.sha]);
  f.git(['commit', '-qm', 'squashed copy with different metadata']);
  assert.notEqual(f.git(['rev-parse', 'HEAD']), f.sha);
  assert.equal(f.contains(f.sha), false);
  f.save({ ...f.record, rollbackPending: 'ci-red' });
  let failure;
  await f.tick({ ...red, rollbackToGood: async good => {
    assert(readHotPatch(f.env), 'must not retire before rollback');
    f.rollbacks.push(good);
    return { ok: false };
  } }).catch(error => { failure = error; });
  assert.deepEqual(f.rollbacks, [f.preGood], 'squash-equivalent patch requires rollback');
  assert(failure, 'unsuccessful rollback must throw');
  assert.match(failure.message, /rollback/i);
  assert(readHotPatch(f.env));
}));
test('R3.9 rollback writes durable rejection before retiring ledger', fixture(async f => {
  await f.tick(red);
  const path = join(f.env.WE_DAEMON_STATE_DIR, 'hot-patch-rejected.json');
  assert(existsSync(path), 'rollback must leave durable rejection evidence');
  const records = JSON.parse(readFileSync(path, 'utf8'));
  const entry = (Array.isArray(records) ? records : [records]).find(r => r.sha === f.sha);
  assert(entry);
  assert.match(entry.patchId, /^[a-f0-9]{40}$/);
  assert.equal(entry.pr, 42);
  assert.equal(entry.reason, 'ci-red');
  assert.equal(new Date(entry.at).toISOString(), entry.at);
  assert.equal(readHotPatch(f.env), null);
}));
test('R3.6 red CI followed by unavailable workflow rolls back on the same tick', fixture(async f => {
  await f.tick({ ciVerdict: () => hotPatchCiVerdict({ repo: 'web-everything/web-everything', sha: f.sha,
    required: ['daemon-soak', 'soak-replay-gate'], fetchJson: async path => {
      if (path.includes('soak-replay-gate.yml')) throw Error('offline');
      if (path.includes('/workflows/')) return { workflow_runs: [{ id: 1, check_suite_id: 1, head_sha: f.sha }] };
      if (path.includes('/check-suites/')) return { id: 1, head_sha: f.sha, app: { id: 15368, slug: 'github-actions' } };
      return { jobs: [{ name: 'daemon-soak', status: 'completed', conclusion: 'failure' }] };
    } }) });
  assert.deepEqual(f.rollbacks, [f.preGood]);
}));
