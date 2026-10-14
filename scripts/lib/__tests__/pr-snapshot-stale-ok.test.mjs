import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, utimesSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSharedOpenPrs, SNAPSHOT_FIELDS, WE_PR_SNAPSHOT_SAMPLE, WE_PR_SNAPSHOT_STALE_OK_MS } from '../pr-snapshot.mjs';
import { snapshotPath, PR_SNAPSHOT_VERSION, snapshotKey } from '../pr-snapshot-store.mjs';

vi.mock('../settings-files.mjs', () => ({ readDeclaredSettings: () => ({ settings: {} }) }));

const clock = Date.parse('2026-10-14T14:00:00Z');
const prs = [
  { number: 9, createdAt: '2026-10-03T00:00:00Z' },
  { number: 4, createdAt: '2026-10-01T00:00:00Z' },
  { number: 2, createdAt: '2026-10-01T00:00:00Z' },
  { number: 1, createdAt: '2026-10-02T00:00:00Z' },
];
let dir;
let repo;
let sequence = 0;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'snapshot-smoke-')); repo = `fixture/repo-${sequence++}`; });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });
const options = (extra = {}) => ({ repo, dir, fields: ['number'], now: () => clock,
  ...extra, env: { WE_UNDER_TEST: '1', ...extra.env } });
function seed(age = 1000, dirty = false, rows = prs) {
  writeFileSync(snapshotPath(dir, repo), JSON.stringify({ v: PR_SNAPSHOT_VERSION, repo,
    fetchedAtMs: clock - age, fields: [...SNAPSHOT_FIELDS], count: rows.length, prs: rows }));
  if (dirty) {
    const path = join(dir, `${snapshotKey(repo)}.dirty`);
    writeFileSync(path, ''); utimesSync(path, clock / 1000, clock / 1000);
  }
}
function emptyExec() {
  return vi.fn(() => JSON.stringify({ data: { repository: { pullRequests: {
    nodes: [], totalCount: 0, pageInfo: { hasNextPage: false, endCursor: null },
  } } } }));
}

describe('smoke snapshot reads', () => {
  it('applies candidate defaults to marked dry-run children and logs them once', () => {
    const rows = Array.from({ length: 16 }, (_, i) => ({ number: 16 - i, createdAt: prs[0].createdAt }));
    seed(600000, true, rows);
    const before = readFileSync(snapshotPath(dir, repo), 'utf8');
    const exec = vi.fn(() => { throw Error('must not fetch'); });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const opts = options({ smokeChild: true, exec, env: { WE_SMOKE_LIVE_CLONE: '1' } });
    const expected = Array.from({ length: 12 }, (_, i) => ({ number: i + 1 }));
    expect(readSharedOpenPrs(opts)).toEqual(expected);
    expect(readSharedOpenPrs(opts)).toEqual(expected);
    expect(exec).not.toHaveBeenCalled();
    expect(readFileSync(snapshotPath(dir, repo), 'utf8')).toBe(before);
    expect(log.mock.calls.filter(([line]) => line.includes('rebuild-smoke candidate defaults')))
      .toEqual([['pr-snapshot: rebuild-smoke candidate defaults — sample 12, staleOk 900000 (source prSample=standard, snapshotStaleOkMs=standard)']]);
  });
  it.each([
    { smokeChild: false, env: { WE_SMOKE_LIVE_CLONE: '1', WE_SMOKE_PR_SAMPLE: '2' } },
    { smokeChild: true, env: { WE_SMOKE_PR_SAMPLE: '2' } },
  ])('keeps normal reads without both marker and child scope: %j', extra => {
    seed();
    expect(readSharedOpenPrs(options(extra))).toEqual(prs.map(({ number }) => ({ number })));
    seed(600000, true);
    const exec = emptyExec();
    expect(readSharedOpenPrs(options({ ...extra, exec }))).toEqual([]);
    expect(exec).toHaveBeenCalledTimes(1);
  });
  it('keeps explicit snapshot knobs ahead of candidate settings, including zero', () => {
    seed(600000, true);
    const env = { WE_SMOKE_LIVE_CLONE: '1', WE_SMOKE_PR_SAMPLE: '2', WE_SMOKE_SNAPSHOT_STALE_OK_MS: '0',
      WE_PR_SNAPSHOT_SAMPLE: '3', WE_PR_SNAPSHOT_STALE_OK_MS: '900000' };
    expect(readSharedOpenPrs(options({ smokeChild: true, env }))).toEqual([{ number: 2 }, { number: 4 }, { number: 1 }]);
    expect(readSharedOpenPrs(options({ smokeChild: true, env: { ...env, WE_PR_SNAPSHOT_SAMPLE: '0' } })))
      .toEqual(prs.map(({ number }) => ({ number })));
    const exec = emptyExec();
    expect(readSharedOpenPrs(options({ smokeChild: true, exec, env: { ...env, WE_PR_SNAPSHOT_STALE_OK_MS: '0' } }))).toEqual([]);
    expect(exec).toHaveBeenCalledTimes(1);
  });
  it.each(['sample', 'stale'])('fills only the unset knob when %s is explicit', knob => {
    seed(600000, true);
    const env = { WE_SMOKE_LIVE_CLONE: '1', WE_SMOKE_PR_SAMPLE: '2',
      ...(knob === 'sample' ? { WE_PR_SNAPSHOT_SAMPLE: '3' } : { WE_PR_SNAPSHOT_STALE_OK_MS: '900000' }) };
    expect(readSharedOpenPrs(options({ smokeChild: true, exec: emptyExec(), env })))
      .toEqual(knob === 'sample' ? [{ number: 2 }, { number: 4 }, { number: 1 }] : [{ number: 2 }, { number: 4 }]);
  });
  it('disables candidate sampling when the smoke setting is zero', () => {
    seed(600000, true);
    expect(readSharedOpenPrs(options({ smokeChild: true, exec: emptyExec(),
      env: { WE_SMOKE_LIVE_CLONE: '1', WE_SMOKE_PR_SAMPLE: '0' } })))
      .toEqual(prs.map(({ number }) => ({ number })));
  });
  it.each([
    ['scripts/conveyor/reconcile-pass.mjs', [], true],
    ['other.mjs', ['-e', ''], true],
    ['other.mjs', ['--eval', ''], true],
    ['scripts/lane-pool.mjs', [], false],
    ['scripts/health-watch-daemon.mjs', [], false],
    ['other.mjs', ['--check'], false],
  ])('detects child scope from entry %s and exec args %j', (entry, execArgs, sampled) => {
    const argv = process.argv; const execArgv = process.execArgv;
    try {
      process.argv = [process.execPath, entry]; process.execArgv = execArgs;
      seed();
      expect(readSharedOpenPrs(options({ env: { WE_SMOKE_LIVE_CLONE: '1', WE_SMOKE_PR_SAMPLE: '2' } })))
        .toEqual(sampled ? [{ number: 2 }, { number: 4 }] : prs.map(({ number }) => ({ number })));
    } finally { process.argv = argv; process.execArgv = execArgv; }
  });
  it('exports the two env names', () => {
    expect(WE_PR_SNAPSHOT_SAMPLE).toBe('WE_PR_SNAPSHOT_SAMPLE');
    expect(WE_PR_SNAPSHOT_STALE_OK_MS).toBe('WE_PR_SNAPSHOT_STALE_OK_MS');
  });
  it('samples oldest first with number ties before projecting fields, without changing the snapshot', () => {
    seed(); const before = readFileSync(snapshotPath(dir, repo), 'utf8');
    expect(readSharedOpenPrs(options({ env: { WE_PR_SNAPSHOT_SAMPLE: '2' } }))).toEqual([{ number: 2 }, { number: 4 }]);
    expect(readFileSync(snapshotPath(dir, repo), 'utf8')).toBe(before);
  });
  it.each([undefined, '0', '-1', '1.5', 'bad'])('unset/invalid sample %s retains all PRs and their order', sample => {
    seed();
    expect(readSharedOpenPrs(options({ env: { WE_PR_SNAPSHOT_SAMPLE: sample } }))).toEqual(prs.map(({ number }) => ({ number })));
  });
  it('serves a ten-minute-old dirty snapshot without exec', () => {
    seed(600000, true); const exec = vi.fn(() => { throw Error('must not fetch'); });
    expect(readSharedOpenPrs(options({ exec, env: { WE_PR_SNAPSHOT_STALE_OK_MS: '900000' } }))).toHaveLength(4);
    expect(exec).not.toHaveBeenCalled();
  });
  it('schedules only one async refresh per repo when stale', () => {
    seed(600000, true); const spawnRefresh = vi.fn();
    const opts = options({ env: { WE_PR_SNAPSHOT_STALE_OK_MS: '900000' }, spawnRefresh });
    readSharedOpenPrs(opts); readSharedOpenPrs(opts);
    expect(spawnRefresh).toHaveBeenCalledTimes(1);
    expect(spawnRefresh).toHaveBeenCalledWith(expect.objectContaining({ repo, fields: ['number'] }));
  });
  it('does not schedule a refresh inside the normal TTL, even if dirty', () => {
    seed(30000, true); const spawnRefresh = vi.fn();
    readSharedOpenPrs(options({ env: { WE_PR_SNAPSHOT_STALE_OK_MS: '900000' }, spawnRefresh }));
    expect(spawnRefresh).not.toHaveBeenCalled();
  });
  it('does not schedule a refresh with an injected exec', () => {
    seed(600000); const spawnRefresh = vi.fn();
    readSharedOpenPrs(options({ exec: emptyExec(), env: { WE_PR_SNAPSHOT_STALE_OK_MS: '900000' }, spawnRefresh }));
    expect(spawnRefresh).not.toHaveBeenCalled();
  });
  it('does one synchronous fetch without a snapshot', () => {
    const exec = emptyExec();
    expect(readSharedOpenPrs(options({ exec, env: { WE_PR_SNAPSHOT_STALE_OK_MS: '900000', WE_PR_SNAPSHOT_SAMPLE: '2' } }))).toEqual([]);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(JSON.parse(readFileSync(snapshotPath(dir, repo), 'utf8')).prs).toEqual([]);
  });
  it('samples a fresh fetch while persisting the full result', () => {
    const exec = vi.fn((_cmd, args) => args[0] === 'api'
      ? JSON.stringify({ data: { repository: { pullRequests: { nodes: prs.map(pr => ({ ...pr, labels: { nodes: [] } })),
        totalCount: prs.length, pageInfo: { hasNextPage: false, endCursor: null } } } } })
      : JSON.stringify({ comments: [], body: '', files: [] }));
    expect(readSharedOpenPrs(options({ exec, env: { WE_PR_SNAPSHOT_SAMPLE: '3' } })))
      .toEqual([{ number: 2 }, { number: 4 }, { number: 1 }]);
    expect(JSON.parse(readFileSync(snapshotPath(dir, repo), 'utf8')).prs.map(pr => pr.number)).toEqual([9, 4, 2, 1]);
  });
  it('does not start a real refresh under test without an injected seam', () => {
    seed(600000);
    expect(readSharedOpenPrs(options({ env: { WE_PR_SNAPSHOT_STALE_OK_MS: '900000' } }))).toHaveLength(4);
  });
  it('ignores a refresh seam failure and still serves the stale snapshot', () => {
    seed(600000);
    expect(readSharedOpenPrs(options({ env: { WE_PR_SNAPSHOT_STALE_OK_MS: '900000' },
      spawnRefresh: () => { throw Error('spawn failed'); } }))).toHaveLength(4);
  });
  it('refreshes synchronously when the stale allowance expires', () => {
    seed(900000); const exec = emptyExec();
    expect(readSharedOpenPrs(options({ exec, env: { WE_PR_SNAPSHOT_STALE_OK_MS: '900000' } }))).toEqual([]);
    expect(exec).toHaveBeenCalledTimes(1);
  });
});
