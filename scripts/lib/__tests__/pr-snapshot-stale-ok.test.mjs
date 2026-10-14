import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, utimesSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSharedOpenPrs, SNAPSHOT_FIELDS, WE_PR_SNAPSHOT_SAMPLE, WE_PR_SNAPSHOT_STALE_OK_MS } from '../pr-snapshot.mjs';
import { snapshotPath, PR_SNAPSHOT_VERSION, snapshotKey } from '../pr-snapshot-store.mjs';

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
function seed(age = 1000, dirty = false) {
  writeFileSync(snapshotPath(dir, repo), JSON.stringify({ v: PR_SNAPSHOT_VERSION, repo,
    fetchedAtMs: clock - age, fields: [...SNAPSHOT_FIELDS], count: prs.length, prs }));
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
