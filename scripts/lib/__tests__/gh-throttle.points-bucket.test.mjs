import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import * as gh from '../gh-throttle.mjs';
import { reserve } from '../../readiness/file-locks.mjs';

let root, clock;
const bucketFile = () => join(root, 'points-bucket-state.json');
const legacyFile = () => join(root, 'points-budget-state.json');
const save = (file, state) => writeFileSync(file, JSON.stringify(state));
const load = file => JSON.parse(readFileSync(file, 'utf8'));
const state = (extra = {}) => ({ tokens: 60, lastRefillMs: clock, batchLog: [], tickets: [], mode: 'compat', legacyWindowStartMs: clock, legacyChargedByNew: 0, ...extra });
const env = () => ({ WE_PLATFORM_PREFERENCES_FILE: join(root, 'absent'), WE_GH_THROTTLE_COST_HEADERS: '0', WE_GH_THROTTLE_NO_BUDGET_PROBE: '1' });
const options = (extra = {}) => ({ lockRoot: root, owner: 'test', now: () => clock, sleep: ms => { clock += ms; }, jitter: () => 0, budgetPerMin: 300, pollMs: 1000, env: env(), ...extra });
const acquire = ({ testOnlyAdoptionCheck, ...extra } = {}) => gh.acquireGhPointsSync(options(extra), { testOnlyAdoptionCheck });
const decide = (extra = {}) => gh.decideGhBucketSpend({ state: state(), points: 1, pointClass: 'standard', nowMs: clock, budgetPerMin: 300, owner: 'test', pid: process.pid, startedAt: clock, isPidAlive: () => true, ...extra });
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'gh-points-bucket-')); clock = 1_000_000; });
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

it('classify-writes-critical-reserved-priority', () => {
  for (const input of [{ args: ['pr', 'edit', '1'] }, { caller: 'review-daemon.mjs' }, { reserved: true }])
    expect(gh.classifyGhPoints({ caller: 'rebuild-smoke', ...input })).toBe('priority');
});
it('classify-rebuild-smoke-suffix-batch', () => expect(gh.classifyGhPoints({ caller: 'we:scripts/rebuild-smoke.mjs:we' })).toBe('batch'));
it('classify-default-standard', () => expect(gh.classifyGhPoints({ caller: 'unknown' })).toBe('standard'));
it('malformed-batch-pattern-is-skipped', () => expect(gh.classifyGhPoints({ caller: 'custom', settings: { pointsClasses: { batch: ['[', '^custom'] } } })).toBe('batch'));
it('invalid-algorithm-falls-back', () => expect(gh.resolveGhPointsSettings(env(), { tool: { pointsAlgorithm: 'bad' } }).pointsAlgorithm).toBe('bucket'));
it('settings-cascade-and-provenance', () => {
  const platform = join(root, 'platform.json');
  save(platform, { ghThrottle: { pointsAlgorithm: 'window' } });
  const e = { ...env(), WE_PLATFORM_PREFERENCES_FILE: platform };
  expect(gh.resolveGhPointsSettings(e, { tool: {} })).toMatchObject({ pointsAlgorithm: 'window', source: { pointsAlgorithm: 'platform' } });
  expect(gh.resolveGhPointsSettings(e, { tool: { pointsAlgorithm: 'bucket' } }).source.pointsAlgorithm).toBe('tool');
  expect(gh.resolveGhPointsSettings({ ...e, WE_GH_THROTTLE_POINTS_ALGORITHM: 'window' }, { tool: { pointsAlgorithm: 'bucket' } }).source.pointsAlgorithm).toBe('env');
});
describe.each(['standard', 'platform', 'tool'])('batch-patterns-from-%s-settings-only', layer => {
  it.each(['[]', '["^other"]', '', 'garbage', 'null', '{}'])('environment-%j-cannot-empty-or-reclassify-batch', value => {
    const patterns = layer === 'standard' ? ['^rebuild-smoke'] : ['^custom'];
    const platform = join(root, 'platform.json');
    save(platform, { ghThrottle: layer === 'platform' ? { pointsClasses: { batch: patterns } } : {} });
    const toolFile = join(root, 'settings.json');
    save(toolFile, { ghThrottle: layer === 'tool' ? { pointsClasses: { batch: patterns } } : {} });
    const settings = gh.resolveGhPointsSettings({ ...env(), WE_PLATFORM_PREFERENCES_FILE: platform, WE_GH_THROTTLE_POINTS_BATCH: value }, { toolFile });
    expect(settings.pointsClasses.batch).toEqual(patterns);
    expect(settings.source['pointsClasses.batch']).toBe(layer);
    expect(gh.classifyGhPoints({ caller: layer === 'standard' ? 'rebuild-smoke' : 'custom', settings })).toBe('batch');
    expect(gh.classifyGhPoints({ caller: 'other', settings })).toBe('standard');
  });
});
it('refill-and-cap', () => {
  expect(decide({ state: state({ tokens: 0, lastRefillMs: clock - 1000 }), pointClass: 'priority' }).nextState.tokens).toBe(4);
  expect(decide({ state: state({ tokens: 59, lastRefillMs: clock - 1000 }) }).nextState.tokens).toBe(59);
});
it('standard-floor-keeps-10-for-priority', () => {
  expect(decide({ state: state({ tokens: 10 }) }).allowed).toBe(false);
  expect(decide({ state: state({ tokens: 10 }), pointClass: 'priority' }).nextState.tokens).toBe(9);
});
it('batch-fixed-cap-60-blocks-then-expires-at-exact-boundary', () => {
  const s = state({ batchLog: [{ ms: clock - 59999, p: 60 }] });
  expect(decide({ state: s, pointClass: 'batch' })).toMatchObject({ allowed: false, waitMs: 1 });
  expect(decide({ state: s, pointClass: 'batch', nowMs: clock + 1 }).allowed).toBe(true);
});
it('clock-rollback-does-not-refill-or-expire-batch-spend', () => {
  const s = state({ tokens: -20, lastRefillMs: clock + 10000, batchLog: [{ ms: clock + 10000, p: 60 }] });
  const r = decide({ state: s, pointClass: 'batch' });
  expect(r.allowed).toBe(false); expect(r.nextState.tokens).toBe(-20); expect(r.nextState.lastRefillMs).toBe(clock + 10000);
});
it.each([0, -1, 61, 1.5, NaN, Infinity, '1'])('invalid-or-oversized-cost-%s-refuses-without-changing-ledger', points => {
  save(bucketFile(), state());
  expect(acquire({ points })).toMatchObject({ ok: false, closed: true, reason: 'invalid-cost' });
  expect(load(bucketFile()).tokens).toBe(60);
});
it('the-oldest-ticket-is-admitted-before-younger-ones', () => {
  const tickets = [{ owner: 'old', pid: process.pid, since: clock - 22000, p: 1 }, { owner: 'young', pid: process.pid, since: clock - 21000, p: 1 }];
  const s = state({ tickets });
  expect(decide({ state: s, owner: 'young', startedAt: clock - 21000, pointClass: 'batch' }).allowed).toBe(false);
  const old = decide({ state: s, owner: 'old', startedAt: clock - 22000, pointClass: 'batch' });
  expect(old.allowed).toBe(true); expect(old.nextState.tickets.map(t => t.owner)).toEqual(['young']);
  expect(decide({ state: state({ tokens: 11, tickets }) }).allowed).toBe(false);
});
it('dead-pid-ticket-dropped', () => {
  const r = decide({ state: state({ tickets: [{ owner: 'dead', pid: 999999, since: clock - 21000, p: 1 }] }), isPidAlive: () => false });
  expect(r.nextState.tickets).toEqual([]);
});
it('corrupt-state-means-negative-60-and-full-batch-cap-for-60s', () => {
  writeFileSync(bucketFile(), '{');
  expect(acquire({ pointClass: 'batch', timeoutMs: 0 }).ok).toBe(false);
  expect(load(bucketFile())).toMatchObject({ tokens: -60, batchLog: [{ ms: clock, p: 60 }] });
  expect(decide({ state: load(bucketFile()), pointClass: 'batch', nowMs: clock + 59999 }).allowed).toBe(false);
  expect(decide({ state: load(bucketFile()), pointClass: 'batch', nowMs: clock + 60000 }).allowed).toBe(true);
});
it('null-or-non-object-log-entries-take-the-conservative-reset-not-a-throw', () => {
  const bad = [null, 7, 'x', [], undefined];
  for (const entry of bad) {
    for (const extra of [{ batchLog: [entry] }, { tickets: [entry] },
      { batchLog: [{ ms: clock, p: 1 }, entry] }, { tickets: [{ owner: 'a', pid: process.pid, since: clock, p: 1 }, entry] }]) {
      const r = decide({ state: state(extra), pointClass: 'batch' });
      expect(r.allowed, JSON.stringify(extra)).toBe(false);
      expect(r.nextState).toMatchObject({ tokens: -60, mode: 'compat' });
    }
    save(bucketFile(), state({ batchLog: [entry] }));
    expect(acquire({ pointClass: 'batch', timeoutMs: 0 }).ok).toBe(false);
    expect(load(bucketFile())).toMatchObject({ tokens: -60, batchLog: [{ ms: clock, p: 60 }] });
  }
});
it('unreadable-state-never-adds-capacity', () => {
  mkdirSync(bucketFile());
  expect(() => acquire({ pointClass: 'batch', timeoutMs: 0 })).toThrow();
});
it('never-written-state-is-a-full-first-start-bucket', () => {
  expect(acquire({ pointClass: 'batch', timeoutMs: 0 }).ok).toBe(true);
  expect(load(bucketFile()).tokens).toBe(60 - 1);
});
it('existing-corrupt-state-is-conservative-not-a-first-start', () => {
  writeFileSync(bucketFile(), '{not json');
  expect(acquire({ pointClass: 'batch', timeoutMs: 0 }).ok).toBe(false);
  expect(load(bucketFile()).tokens).toBe(-60);
});
it('standard-timeout-runs-and-charges-bypass', () => {
  save(bucketFile(), state({ tokens: 0 }));
  expect(acquire({ timeoutMs: 0 })).toMatchObject({ ok: true, bypass: 'charged' });
  expect(load(bucketFile()).tokens).toBe(-1);
  expect(load(legacyFile()).spent).toBe(1);
});
it('timeout-at-the-floor-runs-is-logged-as-overflow-and-stays-at-negative-60', () => {
  save(bucketFile(), state({ tokens: -60 }));
  for (let i = 0; i < 3; i++) expect(acquire({ timeoutMs: 0 })).toMatchObject({ ok: true, bypass: 'overflow' });
  expect(load(bucketFile()).tokens).toBe(-60);
  expect(readFileSync(gh.ghThrottleLogPath(root), 'utf8').match(/points_bypass_overflow/g)).toHaveLength(3);
});
it('batch-saturating-priority-fails-closed-and-removes-ticket', () => {
  save(bucketFile(), state({ tokens: 0 }));
  const r = acquire({ pointClass: 'batch', sleep: ms => { clock += ms; const s = load(bucketFile()); save(bucketFile(), { ...s, tokens: 0, lastRefillMs: clock }); } });
  expect(r).toMatchObject({ ok: false, closed: true, waitedMs: 60000 });
  expect(load(bucketFile()).tickets).toEqual([]);
});
it('ticket-removal-after-success', () => {
  save(bucketFile(), state({ tokens: 11, tickets: [{ owner: 'test', pid: process.pid, since: clock - 21000, p: 1 }] }));
  expect(acquire({ pointClass: 'batch' }).ok).toBe(true);
  expect(load(bucketFile()).tickets).toEqual([]);
});
it('sleep-deficit-ms-and-clipped-timeout', () => {
  save(bucketFile(), state({ tokens: 10 }));
  const sleeps = []; expect(acquire({ sleep: ms => { sleeps.push(ms); clock += ms; } }).ok).toBe(true);
  expect(sleeps).toEqual([200]);
  save(bucketFile(), state({ tokens: -60 }));
  const bounded = []; acquire({ pointClass: 'batch', timeoutMs: 7, jitter: () => 0.99, sleep: ms => { bounded.push(ms); clock += ms; } });
  expect(bounded).toEqual([7]);
});
it('sleep-cap-expiry-and-aging-boundary', () => {
  save(bucketFile(), state({ batchLog: [{ ms: clock - 59995, p: 60 }] }));
  const sleeps = []; acquire({ pointClass: 'batch', sleep: ms => { sleeps.push(ms); clock += ms; } });
  expect(sleeps[0]).toBe(5);
  const r = decide({ state: state({ tokens: 0 }), pointClass: 'batch', startedAt: clock - 19999 });
  expect(r.waitMs).toBe(1);
});
it('charged-spend-never-exceeds-2B-plus-RT-seeded-10000-arrivals-with-jitter', () => {
  let seed = 7291, s = state(), total = 0, elapsed = 0, envelope = 0;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
  for (let i = 0; i < 10000; i++) {
    const dt = Math.floor(random() * 150); elapsed += dt;
    const points = 1 + Math.floor(random() * 9);
    const r = decide({ state: s, points, nowMs: clock + elapsed, pointClass: ['priority', 'standard', 'batch'][Math.floor(random() * 3)], bypass: random() < 0.3 });
    s = r.nextState; if (r.charged) total += points;
    expect(s.tokens).toBeGreaterThanOrEqual(-60);
    expect(s.batchLog.reduce((sum, e) => sum + e.p, 0)).toBeLessThanOrEqual(60);
    expect(total - 0.005 * elapsed - envelope).toBeLessThanOrEqual(120 + 1e-7);
    envelope = Math.min(envelope, total - 0.005 * elapsed);
  }
  save(bucketFile(), state({ tokens: 0 }));
  const sleeps = []; acquire({ jitter: random, sleep: ms => { sleeps.push(ms); clock += ms; } });
  expect(sleeps.some(ms => ms > 1000)).toBe(true);
});
it('sixty-clean-windows-stays-compat-without-adoption-signal', () => {
  save(bucketFile(), state());
  for (let i = 0; i < 61; i++) { clock += 60000; acquire(); }
  expect(load(bucketFile()).mode).toBe('compat');
});
it('one-daemon-on-old-code-keeps-compat-mode', () => {
  const adoption = { requiredHead: 'a'.repeat(40), daemons: ['new', 'old'] };
  expect(gh.ghPointsBucketAdopted(adoption, { readAdopted: name => ({ head: (name === 'new' ? 'a' : 'b').repeat(40) }), isAncestor: (a, b) => a === b })).toBe(false);
  expect(gh.ghPointsBucketAdopted({ ...adoption, daemons: ['new'] }, { readAdopted: () => ({ head: 'a'.repeat(40) }), isAncestor: (a, b) => a === b })).toBe(true);
  expect(gh.ghPointsBucketAdopted({ requiredHead: 'a'.repeat(40), daemons: [] })).toBe(false);
});
it.each([undefined, null, {}, 42, '', ' ', ['daemon']])('malformed-roster-entry-%j-prevents-adoption-even-with-positive-evidence', entry => {
  expect(gh.ghPointsBucketAdopted({ requiredHead: 'a'.repeat(40), daemons: ['known', entry] }, {
    readAdopted: () => ({ head: 'b'.repeat(40) }), isAncestor: () => true,
  })).toBe(false);
});
it('sparse-roster-entry-prevents-adoption', () => {
  const daemons = ['known']; daemons.length = 2;
  expect(gh.ghPointsBucketAdopted({ requiredHead: 'a'.repeat(40), daemons }, {
    readAdopted: () => ({ head: 'b'.repeat(40) }), isAncestor: () => true,
  })).toBe(false);
});
it.each(['unknown', 'missing', 'unreadable', 'malformed', 'not-descendant'])('every-roster-daemon-needs-readable-descendant-evidence-%s', failure => {
  const requiredHead = 'a'.repeat(40), head = 'b'.repeat(40);
  const readAdopted = name => {
    if (name === 'known') return { head };
    if (failure === 'unreadable') throw Error('unreadable');
    return failure === 'unknown' ? undefined : failure === 'missing' ? null : failure === 'malformed' ? { head: '?' } : { head };
  };
  expect(gh.ghPointsBucketAdopted({ requiredHead, daemons: ['known', 'other'] }, {
    readAdopted, isAncestor: (_required, _head, name) => name === 'known',
  })).toBe(false);
});
it.each([
  ['empty-roster', { requiredHead: 'a'.repeat(40), daemons: [] }],
  ['missing-roster', { requiredHead: 'a'.repeat(40) }],
  ['missing-required-head', { daemons: ['known'] }],
  ['coerced-required-head', { requiredHead: ['a'.repeat(40)], daemons: ['known'] }],
])('incomplete-adoption-%s-stays-closed', (_label, settings) => {
  expect(gh.ghPointsBucketAdopted(settings, { readAdopted: () => ({ head: 'b'.repeat(40) }), isAncestor: () => true })).toBe(false);
});
it('non-string-adopted-head-cannot-coerce-to-valid-evidence', () => {
  expect(gh.ghPointsBucketAdopted({ requiredHead: 'a'.repeat(40), daemons: ['known'] }, {
    readAdopted: () => ({ head: ['b'.repeat(40)] }), isAncestor: () => true,
  })).toBe(false);
});
it('every-daemon-descendant-is-required-and-sufficient-for-adoption', () => {
  const requiredHead = 'a'.repeat(40), head = 'b'.repeat(40);
  const isAncestor = vi.fn(() => true);
  expect(gh.ghPointsBucketAdopted({ requiredHead, daemons: ['one', 'two'] }, { readAdopted: () => ({ head }), isAncestor })).toBe(true);
  expect(isAncestor.mock.calls).toEqual([[requiredHead, head, 'one'], [requiredHead, head, 'two']]);
});
it.each(['no-injection', 'old-override', 'env-and-settings'])('production-adoption-%s-without-evidence-stays-compat', source => {
  const toolFile = join(root, 'settings.json');
  save(toolFile, { ghThrottle: { pointsBucketAdoption: { requiredHead: '', daemons: [] }, adoptionCheck: true, pointsAdoptionCheck: true } });
  save(bucketFile(), state());
  const e = { ...env(), WE_DAEMON_STATE_DIR: join(root, 'missing-evidence') };
  if (source === 'env-and-settings') e.WE_GH_THROTTLE_POINTS_ADOPTION_CHECK = 'true';
  expect(acquire({ toolFile, env: e, ...(source === 'old-override' ? { adoptionCheck: () => true } : {}) }).ok).toBe(true);
  expect(load(bucketFile()).mode).toBe('compat');
});
it('switches-to-bucket-only-with-adoption-and-old-spend-reverts-to-compat', () => {
  save(bucketFile(), state()); acquire({ testOnlyAdoptionCheck: () => true }); expect(load(bucketFile()).mode).toBe('bucket');
  save(legacyFile(), { windowStartMs: clock, spent: 300 });
  expect(acquire({ pointClass: 'batch', timeoutMs: 0, testOnlyAdoptionCheck: () => true }).ok).toBe(false);
  expect(load(bucketFile()).mode).toBe('compat');
});
it('running-process-observes-window-rollback', () => {
  const toolFile = join(root, 'settings.json'); save(toolFile, { ghThrottle: { pointsAlgorithm: 'bucket' } });
  save(bucketFile(), state({ tokens: -60 })); let switched = false;
  const r = acquire({ toolFile, sleep: ms => { clock += ms; switched = true; save(toolFile, { ghThrottle: { pointsAlgorithm: 'window' } }); } });
  expect(switched).toBe(true); expect(r.ok).toBe(true); expect(load(bucketFile()).tokens).toBe(-60); expect(load(legacyFile()).spent).toBe(1);
});
it('crash-between-ledger-writes-does-not-open-admission-or-double-charge', () => {
  save(bucketFile(), state());
  expect(() => acquire({ afterBucketWrite: () => { throw new Error('crash'); } })).toThrow('crash');
  expect(load(bucketFile()).tokens).toBe(59);
  expect(acquire().ok).toBe(true);
  expect(load(bucketFile()).tokens).toBe(58); expect(load(legacyFile()).spent).toBe(2);
  expect(readdirSync(root).filter(n => n.includes('.tmp-'))).toEqual([]);
});
it('crash-after-legacy-rename-repair-is-idempotent', () => {
  save(bucketFile(), state({ tokens: 59, legacyChargedByNew: 1, pendingLegacy: { windowStartMs: clock, spent: 1 } }));
  save(legacyFile(), { windowStartMs: clock, spent: 1 });
  expect(acquire().ok).toBe(true);
  expect(load(bucketFile()).tokens).toBe(58); expect(load(legacyFile()).spent).toBe(2);
  expect(load(bucketFile()).pendingLegacy).toBeUndefined();
});
describe.each([0, 60000])('pending-charge-repair-with-%ims-old-journal', age => {
  it.each([
    ['NaN', 'NaN'], ['infinite', '1e999'], ['non-numeric', '"garbage"'], ['numeric-string', '"1"'],
    ['negative', '-1'], ['null', 'null'], ['boolean', 'true'], ['object', '{}'], ['array', '[]'], ['missing', undefined],
  ])('corrupt-legacy-spent-%s-means-full-and-never-serializes-null', (_label, raw) => {
    save(bucketFile(), state({ pendingLegacy: { windowStartMs: clock - age, spent: 1 } }));
    writeFileSync(legacyFile(), `{"windowStartMs":${clock - age}${raw === undefined ? '' : `,"spent":${raw}`}}`);
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(acquire({ pointClass: 'batch', timeoutMs: 0, testOnlyAdoptionCheck: () => true }).ok).toBe(false);
      expect(load(legacyFile())).toEqual({ windowStartMs: clock, spent: 300 });
      expect(readFileSync(legacyFile(), 'utf8')).not.toContain('null');
      expect(load(bucketFile()).mode).toBe('compat');
      expect(load(bucketFile()).pendingLegacy).toBeUndefined();
    }
  });
});
it('corrupt-legacy-refuses-batch-and-restores-compat', () => {
  save(bucketFile(), state({ mode: 'bucket' })); writeFileSync(legacyFile(), '{');
  expect(acquire({ pointClass: 'batch', timeoutMs: 0, testOnlyAdoptionCheck: () => true }).ok).toBe(false);
  expect(load(bucketFile())).toMatchObject({ mode: 'compat', tokens: 60 });
});
describe.each(['{', 'null', '{"windowStartMs":1000000,"spent":null}'])('legacy-recovery-from-%s', raw => {
  it('persists-one-conservative-window-across-callers-and-idle-retry', () => {
    const recoveryStart = clock;
    save(bucketFile(), state({ mode: 'bucket' }));
    writeFileSync(legacyFile(), raw);
    expect(acquire({ pointClass: 'batch', timeoutMs: 0, testOnlyAdoptionCheck: () => true }).ok).toBe(false);
    clock += 1000;
    expect(acquire({ pointClass: 'priority', reserved: true, timeoutMs: 0, owner: 'reserved' }).ok).toBe(false);
    expect(load(legacyFile())).toEqual({ windowStartMs: recoveryStart, spent: 300 });
    clock = recoveryStart + 120000;
    expect(acquire({ pointClass: 'batch' })).toMatchObject({ ok: true, waitedMs: 0 });
    expect(load(legacyFile())).toEqual({ windowStartMs: clock, spent: 1 });
  });
  it('default-batch-timeout-does-not-restart-recovery-on-the-next-attempt', () => {
    save(bucketFile(), state());
    writeFileSync(legacyFile(), raw);
    expect(acquire({ pointClass: 'batch' })).toMatchObject({ ok: false, closed: true, waitedMs: 60000 });
    clock += 60000;
    expect(acquire({ pointClass: 'batch' })).toMatchObject({ ok: true, waitedMs: 0 });
  });
});
it.each(['no-journal', 'corrupt-ledger-with-journal', 'mismatched-window-with-journal'])('legacy-recovery-%s-clears-attribution-before-adoption-can-reopen-admission', scenario => {
  const recoveryStart = clock;
  save(bucketFile(), state({ mode: 'bucket', legacyChargedByNew: 300,
    ...(scenario === 'no-journal' ? {} : { pendingLegacy: { windowStartMs: clock, spent: 300 } }) }));
  if (scenario === 'mismatched-window-with-journal') save(legacyFile(), { windowStartMs: clock - 1, spent: 1 });
  else writeFileSync(legacyFile(), '{');
  expect(acquire({ pointClass: 'batch', timeoutMs: 0, testOnlyAdoptionCheck: () => true }).ok).toBe(false);
  expect(load(legacyFile())).toEqual({ windowStartMs: recoveryStart, spent: 300 });
  expect(load(bucketFile()).legacyChargedByNew).toBe(0);
  clock += 1000;
  expect(acquire({ pointClass: 'batch', timeoutMs: 0, testOnlyAdoptionCheck: () => true }).ok).toBe(false);
  expect(load(legacyFile())).toEqual({ windowStartMs: recoveryStart, spent: 300 });
  clock = recoveryStart + 60000;
  expect(acquire({ pointClass: 'batch', timeoutMs: 0, testOnlyAdoptionCheck: () => true }).ok).toBe(true);
});
it.each([50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60])('batch-cost-%i-eventually-fits-on-an-idle-host', points => {
  save(bucketFile(), state());
  save(legacyFile(), { windowStartMs: clock, spent: 0 });
  const result = acquire({ pointClass: 'batch', points });
  expect(result.ok).toBe(true);
  expect(result.waitedMs).toBe(20000);
  expect(load(bucketFile())).toMatchObject({ tokens: 60 - points, batchLog: [{ ms: clock, p: points }], tickets: [] });
  expect(load(legacyFile()).spent).toBe(points);
});
it.each([51, 60])('aged-batch-cost-%i-fits-at-capacity-and-still-obeys-cap-and-ticket-order', points => {
  const ticket = { owner: 'test', pid: process.pid, since: clock - 21000, p: points };
  const args = { points, pointClass: 'batch', startedAt: ticket.since };
  expect(decide({ ...args, state: state({ tickets: [ticket] }) })).toMatchObject({ allowed: true, nextState: { tokens: 60 - points, tickets: [] } });
  expect(decide({ ...args, state: state({ tokens: points - 1, tickets: [ticket] }) }).allowed).toBe(false);
  expect(decide({ ...args, state: state({ batchLog: [{ ms: clock, p: 61 - points }], tickets: [ticket] }) }).allowed).toBe(false);
  expect(decide({ ...args, state: state({ tickets: [{ ...ticket, owner: 'older', since: ticket.since - 1 }, ticket] }) }).allowed).toBe(false);
});
it('deadlines-refuse-batch-even-if-capacity-arrives-at-60s', () => {
  save(bucketFile(), state({ tokens: 0 }));
  expect(acquire({ pointClass: 'batch', sleep: ms => {
    clock += ms; save(bucketFile(), state({ tokens: clock >= 1060000 ? 60 : 0 }));
  } })).toMatchObject({ ok: false, closed: true, waitedMs: 60000 });
});
it('legacy-wait-still-stops-at-the-ticket-aging-boundary', () => {
  save(bucketFile(), state()); save(legacyFile(), { windowStartMs: clock, spent: 300 });
  const sleeps = [];
  acquire({ pointClass: 'batch', pollMs: 19000, timeoutMs: 21000, sleep: ms => { sleeps.push(ms); clock += ms; } });
  expect(sleeps).toEqual([19000, 1000, 1000]);
});
it('settings-provenance-has-a-separate-sidecar', () => {
  save(bucketFile(), state()); acquire();
  const rows = readFileSync(join(root, 'points-admission-settings.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  expect(rows).toContainEqual(expect.objectContaining({ pointsAlgorithm: 'bucket', source: expect.objectContaining({ pointsAlgorithm: 'tool', 'pointsClasses.batch': 'tool' }) }));
});
it.each(['missing', 'unreadable', 'not-ancestor', 'throws'])('adoption-%s-is-unknown-and-keeps-compat', failure => {
  const readAdopted = () => { if (failure === 'throws') throw Error('unreadable'); return failure === 'missing' ? null : { head: failure === 'unreadable' ? '?' : 'b'.repeat(40) }; };
  expect(gh.ghPointsBucketAdopted({ requiredHead: 'a'.repeat(40), daemons: ['daemon'] }, { readAdopted, isAncestor: () => false })).toBe(false);
});

describe.each(['sync', 'cli'])('%s closed execution paths', mode => {
  const invoke = throttle => mode === 'sync'
    ? gh.runGhSync(['api', 'user'], { throttle })
    : gh.runGhCliPassthrough(['api', 'user'], { throttle, spawn: throttle.exec });
  it('production-wrapper-cannot-forward-a-true-adoption-override', () => {
    save(bucketFile(), state());
    const exec = vi.fn(() => ({ status: 0, stdout: Buffer.from('ok') }));
    const pointsAdoptionCheck = vi.fn(() => true);
    invoke(options({ caller: 'ordinary', exec, pointsAdoptionCheck, warn: vi.fn() }));
    expect(exec).toHaveBeenCalledTimes(1);
    expect(pointsAdoptionCheck).not.toHaveBeenCalled();
    expect(load(bucketFile()).mode).toBe('compat');
  });
  it('full-bucket-batch-cost-60-executes-after-ticket-aging-and-charges-both-ledgers', () => {
    save(bucketFile(), state());
    const started = clock;
    const exec = vi.fn(() => ({ status: 0, stdout: Buffer.from('ok') }));
    invoke(options({ caller: 'rebuild-smoke.mjs:we', points: 60, exec, warn: vi.fn() }));
    expect(exec).toHaveBeenCalledTimes(1);
    expect(clock - started).toBe(20000);
    expect(load(bucketFile())).toMatchObject({ tokens: 0, tickets: [], batchLog: [{ ms: clock, p: 60 }] });
    expect(load(legacyFile()).spent).toBe(60);
  });
  it.each(['lock-root-failure', 'gate-exception', 'legacy-gate-exception', 'held-lock-timeout', 'slot-ungated-override'])('batch-%s-never-executes', failure => {
    const exec = vi.fn(() => ({ status: 0, stdout: Buffer.from('ok') }));
    const throttle = options({ caller: 'rebuild-smoke.mjs:we', exec, cap: 1, warn: vi.fn(), acquireTimeoutMs: 5, env: { ...env(), WE_GH_THROTTLE_ON_SLOT_TIMEOUT: 'ungated' } });
    save(bucketFile(), state());
    if (failure === 'lock-root-failure') { throttle.lockRoot = join(root, 'file'); writeFileSync(throttle.lockRoot, 'blocked'); }
    if (failure === 'gate-exception') { rmSync(bucketFile()); mkdirSync(bucketFile()); }
    if (failure === 'legacy-gate-exception') mkdirSync(legacyFile());
    if (failure === 'held-lock-timeout') reserve(root, 'points-budget', 'holder', clock, new Date(clock).toISOString(), process.pid);
    if (failure === 'slot-ungated-override') gh.acquireGhSlotSync({ lockRoot: root, cap: 1, owner: 'holder', now: () => clock, timeoutMs: 0 });
    if (mode === 'sync') expect(() => invoke(throttle)).toThrow(/throttled/); else expect(invoke(throttle)).toMatchObject({ status: 1, throttled: true });
    expect(exec).not.toHaveBeenCalled();
  });
  it('reserved-read-points-timeout-never-executes', () => {
    save(bucketFile(), state({ tokens: -60 })); const exec = vi.fn();
    const throttle = options({ caller: 'red-main-freeze-read', reservedSlot: true, reservedTimeoutMs: 5, exec, acquireTimeoutMs: 5, warn: vi.fn() });
    const args = ['api', '-i', 'repos/o/r/git/ref/heads/main'];
    if (mode === 'sync') expect(() => gh.runGhSync(args, { timeout: 5, throttle })).toThrow(/throttled/);
    else expect(gh.runGhCliPassthrough(args, { throttle, spawn: exec }).throttled).toBe(true);
    expect(exec).not.toHaveBeenCalled();
  });
  it('gate-exception-logs-uncharged-bypass-for-ordinary-calls', () => {
    mkdirSync(bucketFile()); const exec = vi.fn(() => ({ status: 0, stdout: Buffer.from('ok') }));
    invoke(options({ exec, caller: 'ordinary', warn: vi.fn() }));
    expect(exec).toHaveBeenCalledTimes(1);
    expect(readFileSync(gh.ghThrottleLogPath(root), 'utf8')).toContain('points_bypass_uncharged');
  });
  it('ordinary-timeout-executes-with-charged-bypass', () => {
    save(bucketFile(), state({ tokens: 0 }));
    const exec = vi.fn(() => ({ status: 0, stdout: Buffer.from('ok') }));
    invoke(options({ exec, acquireTimeoutMs: 0, caller: 'ordinary' }));
    expect(exec).toHaveBeenCalledTimes(1); expect(load(bucketFile()).tokens).toBe(-1);
    expect(readFileSync(gh.ghThrottleLogPath(root), 'utf8')).toContain('points_bypass');
  });
  it('held-lock-timeout-is-an-uncharged-ordinary-bypass', () => {
    save(bucketFile(), state()); reserve(root, 'points-budget', 'holder', clock, new Date(clock).toISOString(), process.pid);
    const exec = vi.fn(() => ({ status: 0, stdout: Buffer.from('ok') }));
    invoke(options({ exec, acquireTimeoutMs: 5, caller: 'ordinary' }));
    expect(exec).toHaveBeenCalledTimes(1); expect(load(bucketFile()).tokens).toBe(60);
    expect(readFileSync(gh.ghThrottleLogPath(root), 'utf8')).toContain('points_bypass_uncharged');
  });
  it.each([0, -1, 61, NaN])('invalid-cost-%s-never-executes-even-with-ungated-override', points => {
    const exec = vi.fn();
    const throttle = options({ points, exec, env: { ...env(), WE_GH_THROTTLE_ON_SLOT_TIMEOUT: 'ungated' }, warn: vi.fn() });
    if (mode === 'sync') expect(() => invoke(throttle)).toThrow(/throttled/); else expect(invoke(throttle).throttled).toBe(true);
    expect(exec).not.toHaveBeenCalled();
  });
});

// These children use the real shared mutex. The old writer deliberately knows only the legacy ledger.
const moduleUrl = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '../gh-throttle.mjs')).href;
const lockUrl = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '../../readiness/file-locks.mjs')).href;
function child(old, extra = {}) {
  const code = `import { acquireGhPointsSync } from ${JSON.stringify(moduleUrl)};
    import { reserve, releaseLockDir } from ${JSON.stringify(lockUrl)};
    import { readFileSync, writeFileSync } from 'node:fs';
    const root = process.argv[1], ms = Number(process.argv[2]);
    let r;
    if (${old}) {
      r = reserve(root, 'points-budget', String(process.pid), ms, new Date(ms).toISOString(), process.pid);
      if (r.ok) { try { let s = JSON.parse(readFileSync(root + '/points-budget-state.json'));
        if (ms - s.windowStartMs >= 60000) s = { windowStartMs: ms, spent: 0 };
        r = { ok: s.spent < 300 }; if (r.ok) writeFileSync(root + '/points-budget-state.json', JSON.stringify({ ...s, spent: s.spent + 1 }));
      } finally { releaseLockDir(root, 'points-budget'); } }
    } else r = acquireGhPointsSync({ lockRoot: root, owner: String(process.pid), now: () => ms, timeoutMs: 0,
      budgetPerMin: 300, pointClass: 'batch', env: { WE_PLATFORM_PREFERENCES_FILE: root + '/absent' }, ...${JSON.stringify(extra)} });
    if (${old}) r.executed = true; // Old callers ignore a points timeout and execute without charging.
    process.stdout.write(JSON.stringify(r));`;
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--input-type=module', '--eval', code, root, String(clock)], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = ''; p.stdout.on('data', b => { out += b; if (out.length > 65536) p.kill(); }); p.stderr.on('data', b => { err += b; if (err.length > 65536) p.kill(); });
    p.on('error', reject); p.on('exit', code => code === 0 ? resolve(JSON.parse(out)) : reject(new Error(err)));
  });
}
it('interleaved-old-new-processes-compat-respects-legacy', async () => {
  save(bucketFile(), state()); save(legacyFile(), { windowStartMs: clock, spent: 299 });
  expect((await child(true)).ok).toBe(true); expect((await child(false)).ok).toBe(false);
  expect(load(legacyFile()).spent).toBe(300); expect(load(bucketFile()).mode).toBe('compat');
});
it('two-processes-never-double-spend', async () => {
  save(bucketFile(), state({ tokens: 31 })); save(legacyFile(), { windowStartMs: clock, spent: 0 });
  const results = await Promise.all([child(false), child(false)]);
  expect(results.filter(r => r.ok)).toHaveLength(1); expect(load(bucketFile()).tokens).toBe(30);
});
it('old-timeout-execution-is-not-detectable-from-ledger', async () => {
  save(bucketFile(), state()); save(legacyFile(), { windowStartMs: clock, spent: 300 });
  const before = readFileSync(legacyFile(), 'utf8'); expect(await child(true)).toMatchObject({ ok: false, executed: true });
  expect(readFileSync(legacyFile(), 'utf8')).toBe(before); // Old runGhSync executes anyway; no ledger evidence exists.
});
it('old-child-spend-reverts-bucket-mode-at-the-next-decision', async () => {
  save(bucketFile(), state({ mode: 'bucket' })); save(legacyFile(), { windowStartMs: clock, spent: 0 });
  expect((await child(true)).ok).toBe(true);
  acquire({ testOnlyAdoptionCheck: () => true });
  expect(load(bucketFile()).mode).toBe('compat'); expect(load(legacyFile()).spent).toBe(2);
});
