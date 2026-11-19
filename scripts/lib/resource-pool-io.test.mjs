// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readPoolSource, SOURCES, collectResourcePool, loadPoolSettings, appendShadowRows, poolSourcePaths, readPoolSettingsChecked } from './resource-pool-io.mjs';
import { liveReviewRoundBudget } from '../../skills-src/conveyor/review-daemon.mjs';
import { reviewJobsDir } from '../operations/review-job-store.mjs';
import { assessResourceStatus } from '../operations/resource-status.mjs';
import { lockIdFor } from '../readiness/file-locks.mjs';
let root, paths;
const nowMs = Date.now();
const snapshot = { sampledAt: new Date(nowMs - 1000).toISOString(), freshUntil: new Date(nowMs + 10000).toISOString(),
  memory: { availableMb: 40000, floorMb: 4096, swapUsedPct: 10, swapGrowthMb: 0, pressureLevel: 1 }, cpu: { idlePct: 90 }, errors: [] };
const put = (path, data) => writeFileSync(path, typeof data === 'string' ? data : JSON.stringify(data));
const lock = (dir, meta = {}, path = 'slot-0') => {
  const sub = join(dir, lockIdFor(path)); mkdirSync(sub, { recursive: true });
  put(join(sub, 'lock.json'), { owner: 'fixture', path, heartbeatAt: new Date(nowMs).toISOString(), meta });
};
const read = (source, extra = {}) => readPoolSource(source, { paths, coord: root, nowMs, caps: { heavy: 2, forge: 14 },
  isAlive: () => true, jobDescribe: r => ({ ...r, status: 'running' }), ...extra });
function present(source) {
  if (source === 'fix') lock(paths.fix, { repo: 'we', pr: 1, kind: 'fix' });
  if (source === 'builds') lock(paths.builds, { repo: 'we', num: 1, kind: 'build' });
  if (source === 'heavy' || source === 'forge') lock(paths[source]);
  if (source === 'reviews') put(join(paths.reviews, 'review-1.json'), { slug: 'review-1', pid: 42 });
  if (source === 'redTeam') put(join(paths.redTeam, 'slot.json'), { status: 'running', repo: 'we', pr: 1, head: 'abc', pid: 42 });
  if (source === 'buildJobs') put(join(paths.buildJobs, '1.json'), { id: 1, handle: 'pid:42' });
  if (source === 'lanes') {
    const git = join(paths.lanes, 'we', 'lane-1', '.git'); mkdirSync(git, { recursive: true });
    put(join(git, '.lane-lease'), { session: 'build-1', purpose: 'build', acquiredAt: new Date(nowMs).toISOString() });
  }
  if (source === 'snapshot') put(paths.snapshot, snapshot);
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'resource-pool-'));
  paths = Object.fromEntries(Object.keys(SOURCES).map(s => [s, join(root, s)]));
  for (const [s, p] of Object.entries(paths)) if (s !== 'snapshot') mkdirSync(p, { recursive: true });
  mkdirSync(join(root, 'resource'));
  paths.snapshot = join(root, 'resource', 'snapshot.json');
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });
describe.each(Object.keys(SOURCES).filter(s => s !== 'rounds'))('%s source is fail closed', source => {
  it('reads present holder/budget evidence without mutating it', () => {
    present(source);
    const r = read(source);
    expect(r.ok, r.error).toBe(true);
    if (source === 'snapshot') expect(r.budget.studio.units).toBe(30);
    else expect(r.holders).toHaveLength(1);
  });
  it('distinguishes empty evidence from a missing root', () => {
    const empty = read(source);
    expect(empty.ok).toBe(source !== 'snapshot');
    rmSync(paths[source], { recursive: true, force: true });
    expect(read(source)).toMatchObject({ ok: false, unknown: true });
  });
  it('marks malformed files unknown, never a complete zero', () => {
    present(source);
    const corrupt = source === 'snapshot' ? paths.snapshot
      : ['fix', 'builds', 'heavy', 'forge'].includes(source) ? join(paths[source], lockIdFor('slot-0'), 'lock.json')
      : source === 'lanes' ? join(paths.lanes, 'we', 'lane-1', '.git', '.lane-lease')
      : join(paths[source], { reviews: 'review-1.json', rounds: 'review-fixture.json', redTeam: 'slot.json', buildJobs: '1.json' }[source]);
    put(corrupt, '{broken');
    expect(read(source)).toMatchObject({ ok: false, unknown: true });
  });
});
it('a free lane has a .git directory and no lease; a missing .git is unknown', () => {
  const git = join(paths.lanes, 'we', 'lane-1', '.git'); mkdirSync(git, { recursive: true });
  expect(read('lanes')).toMatchObject({ ok: true, holders: [] });
  rmSync(git, { recursive: true });
  expect(read('lanes').unknown).toBe(true);
});
it('unknown review liveness and oversized source files fail closed', () => {
  present('reviews'); expect(read('reviews', { isAlive: () => null }).unknown).toBe(true);
  put(join(paths.reviews, 'oversized.json'), ' '.repeat(16 * 1024 * 1024 + 1));
  expect(read('reviews').error).toContain('16 MiB');
});
const settings = (mode = 'shadow') => loadPoolSettings({ read: () => ({ value: { mode }, taint: [] }), platform: {}, operatorOverride: {}, env: {}, log: () => {} });
it('appends shadow pairs under env coordination root; off writes no rows; append failure never throws', () => {
  vi.stubEnv('WE_COORDINATION_ROOT', root);
  const rows = [{ ts: 'fixture', host: 'fixture', mode: 'shadow', resource: 'studio.units', class: 3,
    poolDecision: 'unknown', legacyDecision: 'grant', reason: 'fixture', unknown: true }];
  expect(appendShadowRows(rows, { mode: 'off' })).toBe(false);
  const file = join(root, 'resource', 'pool-shadow.jsonl'); expect(existsSync(file)).toBe(false);
  expect(appendShadowRows(rows)).toBe(true);
  expect(JSON.parse(readFileSync(file, 'utf8').trim())).toEqual(rows[0]);
  expect(appendShadowRows(rows, { append: () => { throw Error('unwritable'); } })).toBe(false);
});
it('collects every named source, propagates throws to unknown and keeps all pool decisions closed', () => {
  const seen = [];
  const report = collectResourcePool({ coord: root, paths, settings: settings(), caps: { forge: 14, fix: 6 }, nowMs,
    readSource: source => {
      seen.push(source);
      if (source === 'reviews') throw Error('unreadable');
      return { source, ok: true, holders: [], ...(source === 'snapshot' ? { budget: { studio: { units: 30 } } } : {}) };
    } });
  expect(seen).toEqual(Object.keys(SOURCES)); expect(report.unknown).toBe(true);
  expect(report.rows.every(r => r.poolDecision === 'unknown')).toBe(true);
  expect(report.digest).toContain('studio ?/30u');
  expect(report.sources.find(s => s.source === 'reviews').error).toContain('unreadable');
  expect(report.shadowAppended).toBe(true);
});
it('off collector never calls the append port; enforce is shadow only', () => {
  const append = vi.fn();
  const common = { coord: root, paths, caps: {}, append, readSource: source => ({ source, ok: true, holders: [] }) };
  expect(collectResourcePool({ ...common, settings: settings('off') }).mode).toBe('off'); expect(append).not.toHaveBeenCalled();
  const report = collectResourcePool({ ...common, settings: settings('enforce') });
  expect(report).toMatchObject({ configuredMode: 'enforce', mode: 'shadow' });
  expect(append.mock.calls[0][1].mode).toBe('shadow');
});
it('unreadable/invalid settings force unknown shadow even when environment requests enforce', () => {
  for (const read of [() => { throw Error('bad file'); }, () => ({ value: { mode: 'enforce', builderFloor: 1000 }, taint: [] })]) {
    expect(loadPoolSettings({ read, platform: {}, operatorOverride: {}, env: { WE_RESOURCE_POOL_MODE: 'enforce' }, log: () => {} }))
      .toMatchObject({ unknown: true, value: { mode: 'shadow', builderFloor: 4 } });
  }
});
it('cascade resolves plural classes, instant singular class overrides, and logs provenance', () => {
  const log = vi.fn();
  const p = loadPoolSettings({ read: () => ({ value: { classes: { 2: { max: 10 } } }, taint: [] }),
    platform: { classes: { 2: { max: 9 } } }, operatorOverride: { 'class.2.max': 12 }, env: {}, log });
  expect(p.value.classes[2].max).toBe(12); expect(p.sources['class.2.max']).toBe('operator-db');
  expect(log).toHaveBeenCalled();
});
it('uses existing source path resolvers with explicit private environment roots', () => {
  const env = { WE_COORDINATION_ROOT: root, LANE_POOL_ROOT: join(root, 'lanes'), OPERATION_REVIEW_JOBS_DIR: join(root, 'reviews'),
    OPERATION_RUNS_DIR: join(root, 'runs'), WE_START_BUILD_JOBS_DIR: join(root, 'jobs') };
  expect(poolSourcePaths({ env, repoRoot: root })).toMatchObject({ fix: join(root, 'fix-dispatch-claims'),
    builds: join(root, 'build-dispatch-claims'), reviews: env.OPERATION_REVIEW_JOBS_DIR,
    forge: join(root, 'lanes', '.admission', 'remote'), buildJobs: env.WE_START_BUILD_JOBS_DIR });
});

it('reads heavy queued demand without treating corrupt waiting markers as zero', () => {
  const waiting = join(paths.heavy, 'waiting'); mkdirSync(waiting);
  put(join(waiting, 'review.json'), { owner: 'review', kind: 'review' });
  expect(read('heavy').queuedDemand).toEqual({ 2: 1 });
  put(join(waiting, 'broken.json'), '{broken');
  expect(read('heavy')).toMatchObject({ ok: false, unknown: true });
});
it('a throwing append port cannot escape the collector', () => {
  expect(() => collectResourcePool({ coord: root, paths, settings: settings(), caps: {},
    readSource: source => ({ source, ok: true, holders: [] }), append: () => { throw Error('disk'); } })).not.toThrow();
});

it('uses the same job-store helper under the registered dispatcher clone, preserving env precedence', () => {
  const repoRoot = join(root, '.lanes/we/lane-21');
  expect(poolSourcePaths({ env: {}, repoRoot }).reviews).toBe(reviewJobsDir({}, join(root, 'wev-review-daemon')));
  expect(poolSourcePaths({ env: { OPERATION_REVIEW_JOBS_DIR: paths.reviews }, repoRoot }).reviews).toBe(paths.reviews);
});
it('counts live rounds with the dispatch gate despite more than 20000 historical entries', () => {
  for (let i = 0; i < 20001; i++) put(join(paths.rounds, `ended-${i}.json`), { status: 'ended' });
  const job = join(root, 'review-job.mjs'), loop = join(root, 'review-loop-cli.mjs');
  put(job, ''); put(loop, '');
  const roundBudget = () => liveReviewRoundBudget({ listCommands: () => `10 1 node ${job} run --pr=1\n11 10 node ${loop} run --pr=1\n12 1 node ${loop} run --pr=2` });
  const result = read('rounds', { roundBudget });
  expect(result.ok, result.error).toBe(true);
  expect(result.holders).toHaveLength(2);
});
it('fails closed on an unreadable live-round probe with its operator diagnostic', () => {
  const roundBudget = () => liveReviewRoundBudget({ listCommands: () => { throw Error('probe denied; inspect process access'); } });
  expect(read('rounds', { roundBudget })).toMatchObject({ unknown: true, error: expect.stringContaining('probe denied') });
});
it('keeps metadata-free fix claims at default C3 size and excludes expired claims', () => {
  lock(paths.fix);
  expect(read('fix')).toMatchObject({ ok: true, holders: [{ class: 3, size: 2 }] });
  const file = join(paths.fix, lockIdFor('slot-0'), 'lock.json');
  const stale = JSON.parse(readFileSync(file, 'utf8')); stale.heartbeatAt = new Date(nowMs - 11 * 60000).toISOString(); put(file, stale);
  expect(read('fix')).toMatchObject({ ok: true, holders: [] });
});
it('skips finished, unusual terminal and dead red-team slots while retaining unknown liveness', () => {
  for (const status of ['finished', 'provider-ended', 'running', 'queued']) {
    put(join(paths.redTeam, `${status}.json`), { status, repo: 'we', pr: 1, head: status, pid: 42 });
  }
  expect(read('redTeam', { slotAlive: () => false })).toMatchObject({ ok: true, holders: [] });
  expect(read('redTeam', { slotAlive: () => null }).holders).toHaveLength(2);
});
it('uses remote slot index plus owner without requiring a local pid', () => {
  lock(paths.forge, {}, 'slot-7');
  expect(read('forge')).toMatchObject({ ok: true, holders: [{ id: 'slot-7:fixture', resource: 'forge.slots' }] });
});
it('accepts the live sampler shape without optional swap growth and matches resource-status freshness', () => {
  const live = structuredClone(snapshot); delete live.memory.swapGrowthMb;
  put(paths.snapshot, live);
  expect(assessResourceStatus({ snapshot: live, nowMs }).freshness).toBe('fresh');
  expect(read('snapshot')).toMatchObject({ ok: true, budget: { studio: { units: 30 } } });
  live.freshUntil = new Date(nowMs - 1).toISOString(); put(paths.snapshot, live);
  expect(assessResourceStatus({ snapshot: live, nowMs }).freshness).toBe('stale');
  expect(read('snapshot').unknown).toBe(true);
});
it('ignores unrelated dotted filename keys but refuses namespace taint and unreadable settings layers', () => {
  const dir = join(root, 'settings'); mkdirSync(dir);
  const legacyPath = join(root, 'legacy.json');
  put(join(dir, 'resource-pool.json'), { resourcePool: { mode: 'shadow' } });
  put(join(dir, 'baseline.json'), { files: { 'scripts/file.mjs': 1 } });
  const read = () => readPoolSettingsChecked({ dir, legacyPath });
  const load = () => loadPoolSettings({ read, platform: {}, operatorOverride: {}, env: {}, log: () => {} });
  expect(load().unknown).toBe(false);
  put(join(dir, 'baseline.json'), { 'resourcePool.mode': 'enforce' });
  expect(load().unknown).toBe(true);
  put(join(dir, 'baseline.json'), '{broken');
  expect(load().unknown).toBe(true);
});
it.each([['fix-123', 3], ['review-123', 2], ['redteam-123', 2], ['build-123', 4], ['blocker-123', 1], ['lane-46', 4]])('classifies lease session %s as C%s without lane-number guesses', (session, priority) => {
  present('lanes');
  put(join(paths.lanes, 'we/lane-1/.git/.lane-lease'), { session, acquiredAt: new Date(nowMs).toISOString() });
  expect(read('lanes')).toMatchObject({ ok: true, holders: [{ class: priority }] });
});

it('ignores ancient red-team attempt metadata that the canonical slot reader ages out', () => {
  const file = join(paths.redTeam, 'review.fresh-attempt-0.json');
  put(file, { at: nowMs - 3 * 86400000, pid: 42 });
  const old = new Date(nowMs - 3 * 86400000); utimesSync(file, old, old);
  expect(read('redTeam')).toMatchObject({ ok: true, holders: [] });
});
it('uses explicit lease purpose before session and item kind before falling back to C4', () => {
  present('lanes'); const file = join(paths.lanes, 'we/lane-1/.git/.lane-lease');
  const lease = { session: 'fix-123', purpose: 'build', acquiredAt: new Date(nowMs).toISOString() };
  put(file, lease); expect(read('lanes').holders[0].class).toBe(4);
  put(file, { ...lease, session: 'studio:42', purpose: null, item: { kind: 'review' } });
  expect(read('lanes').holders[0].class).toBe(2);
});

it('excludes aged-out corrupt and oversized red-team history before validating eligible inventory', () => {
  for (const [name, data] of [['corrupt.json', '{broken'], ['oversized.json', ' '.repeat(16 * 1024 * 1024 + 1)]]) {
    const file = join(paths.redTeam, name); put(file, data);
    const old = new Date(nowMs - 3 * 86400000); utimesSync(file, old, old);
  }
  present('redTeam');
  expect(read('redTeam')).toMatchObject({ ok: true, holders: [{ kind: 'redTeam' }] });
});
it('fails closed on oversized recent red-team evidence with an inspect-source diagnostic', () => {
  put(join(paths.redTeam, 'oversized.json'), ' '.repeat(16 * 1024 * 1024 + 1));
  expect(read('redTeam')).toMatchObject({ unknown: true, error: expect.stringContaining('inspect source') });
});
it('keeps red-team records exactly at the canonical age boundary eligible and fails closed on corrupt JSON', () => {
  const file = join(paths.redTeam, 'boundary.json'); put(file, '{broken');
  const boundary = new Date(nowMs - 48 * 60 * 60 * 1000); utimesSync(file, boundary, boundary);
  expect(read('redTeam').unknown).toBe(true);
});
