// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { acquireWrite, releaseWrite } from '../daemon-clone-lock.mjs';
import { readFastDrainRoundListing, readFastDrainRoundSnapshot, withFastDrainRoundLock, verifyFastDrainEnqueue } from '../fast-drain-scope.mjs';
import { enqueuePr } from '../merge-queue-enqueue.mjs';
import { buildLiveListingsByRepo, classifyPr } from '../../merge-ai-prs.mjs';

const roots = [];
afterEach(() => { vi.useRealTimers(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const setup = () => {
  const root = mkdtempSync(join(tmpdir(), 'fast-drain-round-')); roots.push(root);
  return join(root, 'round.json');
};
const repo = 'owner/repo';
const head = 'a'.repeat(40);
const green = { name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' };
const row = (number = 42) => ({ number, headRefOid: head, state: 'OPEN', baseRefName: 'main',
  body: 'Describe the change', mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED',
  labels: [{ name: 'ready-to-merge' }], statusCheckRollup: [green] });
const save = (path, rows = [row()], extra = {}) => writeFileSync(path, JSON.stringify({ repo, writtenAt: Date.now(), rows, defaultBranch: 'main', ...extra }));
const options = path => ({ path, repo, onlyPr: 42, env: {}, log: () => {}, readTarget: async () => row() });

it('single-flights N concurrent catch-ups into one listing and one default-branch read', async () => {
  const path = setup();
  let release;
  const ready = new Promise(resolve => { release = resolve; });
  const listLive = vi.fn(async () => { await ready; return [row(), row(43), row(44)]; });
  const defaultBranch = vi.fn(async () => 'main');
  const branches = [];
  const children = [42, 43, 44].map(onlyPr => readFastDrainRoundListing({ ...options(path), onlyPr,
    listLive, defaultBranch, requireDefaultBranch: true, reuseDefaultBranch: name => branches.push(name),
    readTarget: async () => row(onlyPr),
    lock: fn => withFastDrainRoundLock(path, fn, { pollMs: 1 }),
  }));
  release();
  const rows = await Promise.all(children);
  expect(listLive).toHaveBeenCalledOnce();
  expect(defaultBranch).toHaveBeenCalledOnce();
  expect(branches).toEqual(['main', 'main', 'main']);
  expect(rows.every(rs => rs.length === 3)).toBe(true);
  expect(readFastDrainRoundSnapshot({ path, repo, env: {} }).defaultBranch).toBe('main');
});

it('waits beyond 180 seconds for an alive writer and consumes its snapshot without live fallback', async () => {
  const path = setup();
  const root = join(path, '..');
  const holder = { owner: 'round-writer-holder', lockRoot: `${path}.locks` };
  vi.useFakeTimers({ toFake: ['Date'] });
  const start = Date.now();
  expect(await acquireWrite(root, holder)).toEqual({ ok: true });
  const sleep = vi.fn(async ms => {
    vi.setSystemTime(Date.now() + ms);
    // Release after the historical deadline, within the generous overall bound.
    if (Date.now() - start === 181_000) { save(path); releaseWrite(root, holder); }
    if (Date.now() - start > 181_000) throw new Error('waiter did not adopt released writer');
  });
  const listLive = vi.fn(async () => { throw new Error('must not list live'); });
  try {
    expect(await readFastDrainRoundListing({ ...options(path), listLive,
      lock: fn => withFastDrainRoundLock(path, fn, { owner: 'waiter', sleep }),
    })).toEqual([row()]);
    expect(sleep).toHaveBeenCalledTimes(181);
    expect(listLive).not.toHaveBeenCalled();
  } finally { releaseWrite(root, holder); }
});

it('falls back to exact live rows at the default 600-second deadline while the writer keeps heartbeating', async () => {
  const path = setup();
  const root = join(path, '..');
  const holder = { owner: 'heartbeating-holder', lockRoot: `${path}.locks` };
  vi.useFakeTimers({ toFake: ['Date'] });
  const start = Date.now();
  expect(await acquireWrite(root, holder)).toEqual({ ok: true });
  const sleep = vi.fn(async ms => {
    vi.setSystemTime(Date.now() + ms);
    expect(await acquireWrite(root, holder)).toEqual({ ok: true });
    // Even a fresh snapshot at expiry must not substitute for the exact live fallback.
    if (Date.now() - start === 600_000) save(path, [row(99)]);
    if (Date.now() - start > 600_000) throw Error('overall lock deadline exceeded');
  });
  const listLive = vi.fn(async () => [row(), row(43)]);
  const write = vi.fn();
  const log = vi.fn();
  const defaultBranch = vi.fn(async () => 'main');
  try {
    expect(await readFastDrainRoundListing({ ...options(path), listLive, write, log,
      defaultBranch, requireDefaultBranch: true,
      lock: fn => withFastDrainRoundLock(path, fn, { owner: 'waiter', sleep }),
    })).toEqual([row(), row(43)]);
    expect(Date.now() - start).toBe(600_000);
    expect(listLive).toHaveBeenCalledOnce();
    expect(defaultBranch).toHaveBeenCalledOnce();
    expect(write).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('deadline expired — falling back to exact live listing'));
    expect(readFastDrainRoundSnapshot({ path, repo, env: {} }).rows).toEqual([row(99)]);
    expect(await withFastDrainRoundLock(path, () => { throw Error('holder lock stolen'); }, { waitMs: 0 }))
      .toMatchObject({ ok: false, reason: 'round-lock-deadline' });
  } finally { releaseWrite(root, holder); }
});

it('reclaims a stale writer lease before doing one live listing', async () => {
  const path = setup();
  const holder = { owner: 'stale-holder', lockRoot: `${path}.locks` };
  vi.useFakeTimers({ toFake: ['Date'] });
  expect(await acquireWrite(join(path, '..'), holder)).toEqual({ ok: true });
  vi.setSystemTime(Date.now() + 11 * 60_000);
  const listLive = vi.fn(async () => [row()]);
  expect(await readFastDrainRoundListing({ ...options(path), listLive })).toEqual([row()]);
  expect(listLive).toHaveBeenCalledOnce();
});

it('reclaims a dead same-host writer without waiting out its lease', async () => {
  const path = setup();
  const holder = { owner: `${hostname()}:2147483647`, pid: 2147483647, lockRoot: `${path}.locks` };
  expect(await acquireWrite(join(path, '..'), holder)).toEqual({ ok: true });
  const sleep = vi.fn(async () => { throw Error('dead writer must be reclaimed immediately'); });
  const listLive = vi.fn(async () => [row()]);
  expect(await readFastDrainRoundListing({ ...options(path), listLive,
    lock: fn => withFastDrainRoundLock(path, fn, { sleep }),
  })).toEqual([row()]);
  expect(listLive).toHaveBeenCalledOnce();
  expect(sleep).not.toHaveBeenCalled();
});

it('fails closed on an unreadable lock instead of starting an uncoordinated listing', async () => {
  const listLive = vi.fn();
  await expect(readFastDrainRoundListing({ ...options(setup()), listLive,
    lock: async () => { throw Error('unreadable'); },
  })).rejects.toThrow('lock unreadable — retry next pass');
  expect(listLive).not.toHaveBeenCalled();
});

it('upgrades a historical snapshot missing its branch once, without re-listing its rows', async () => {
  const path = setup();
  const writtenAt = Date.now() - 10_000;
  save(path, [row()], { defaultBranch: null, writtenAt });
  const defaultBranch = vi.fn(async () => 'main');
  const listLive = vi.fn();
  const branches = [];
  for (let i = 0; i < 2; i++) await readFastDrainRoundListing({ ...options(path), listLive,
    defaultBranch, requireDefaultBranch: true, reuseDefaultBranch: value => branches.push(value) });
  expect(defaultBranch).toHaveBeenCalledOnce();
  expect(listLive).not.toHaveBeenCalled();
  expect(branches).toEqual(['main', 'main']);
  expect(readFastDrainRoundSnapshot({ path, repo, env: {} }).writtenAt).toBe(writtenAt);
});

it('fails closed when the required default branch is unreadable', async () => {
  await expect(readFastDrainRoundListing({ ...options(setup()), listLive: async () => [row()],
    requireDefaultBranch: true, defaultBranch: async () => null,
  })).rejects.toThrow('default branch unreadable — retry next pass');
});

it('invalidates the cached target row on a changed live head, retaining unrelated siblings', async () => {
  const path = setup(); save(path, [row(), row(43)]);
  const changed = { ...row(), headRefOid: 'b'.repeat(40), statusCheckRollup: [] };
  const listLive = vi.fn();
  const rows = await readFastDrainRoundListing({ ...options(path), listLive, readTarget: async () => changed });
  expect(rows).toEqual([changed, row(43)]);
  expect(listLive).not.toHaveBeenCalled();
});

it('excludes snapshot rows even with historical roundContext while preserving live unfiltered siblings', () => {
  const sibling = { ...row(43), labels: [], baseRefName: 'release' };
  const rows = [row(), sibling];
  expect(buildLiveListingsByRepo([{ repo, rows, prs: [row()], listing: 'snapshot', roundContext: true }]).has(repo)).toBe(false);
  expect(buildLiveListingsByRepo([{ repo, rows, prs: [row()], listing: 'live' }]).get(repo)).toBe(rows);
  expect(buildLiveListingsByRepo([{ repo, rows, listing: 'snapshot' }]).has(repo)).toBe(false);
});

it.each([
  ['default at 59s', {}, 59_000, true], ['default at 60s', {}, 60_000, false],
  ['invalid override', { WE_FAST_DRAIN_LISTING_SNAPSHOT_TTL_SEC: 'bad' }, 60_000, false],
  ['historical 180s override', { WE_FAST_DRAIN_LISTING_SNAPSHOT_TTL_SEC: '180' }, 60_000, true],
  ['zero override', { WE_FAST_DRAIN_LISTING_SNAPSHOT_TTL_SEC: '0' }, 0, false],
])('honors the 60-second default and TTL override: %s', (_name, env, age, fresh) => {
  const path = setup(); save(path, [row()], { writtenAt: Date.now() - age });
  expect(!!readFastDrainRoundSnapshot({ path, repo, env })).toBe(fresh);
});

it.each(['foreign', 'incomplete', 'oversized'])('rejects %s snapshot evidence', kind => {
  const path = setup();
  save(path, kind === 'incomplete' ? [{ number: 42 }] : [row()], kind === 'foreign' ? { repo: 'other/repo' } : {});
  expect(readFastDrainRoundSnapshot({ path, repo, env: {},
    ...(kind === 'oversized' ? { read: () => 'x'.repeat(64 * 1024 * 1024 + 1) } : {}),
  })).toBeNull();
});

it.each(['head moved', 'red check', 'missing checks', 'unreadable'])('final LIVE %s beats a cached green row on the actual enqueue path', async kind => {
  const path = setup(); save(path);
  const [candidate] = await readFastDrainRoundListing({ ...options(path), listLive: vi.fn() });
  const tip = 'c'.repeat(40);
  const calls = [];
  const exec = (cmd, args) => {
    calls.push([cmd, args]);
    if (cmd === 'git' && args[0] === 'ls-remote') return `${tip}\trefs/heads/main\n`;
    if (cmd === 'gh' && args[0] === 'pr') return JSON.stringify({ id: 'PR_42', headRefOid: head, baseRefName: 'main' });
    if (cmd === 'gh' && args.includes('graphql')) return JSON.stringify({ data: { repository: { pullRequest: { isInMergeQueue: false, headRefOid: head } } } });
    throw Error(`unexpected IO ${cmd} ${args}`);
  };
  const live = { ...candidate,
    ...(kind === 'head moved' ? { headRefOid: 'b'.repeat(40) } : {}),
    ...(kind === 'red check' ? { statusCheckRollup: [{ ...green, conclusion: 'FAILURE' }] } : {}),
    ...(kind === 'missing checks' ? { statusCheckRollup: [] } : {}),
  };
  const readLive = vi.fn(() => { if (kind === 'unreadable') throw Error('offline'); return live; });
  const result = enqueuePr({ repo, num: 42, headSha: candidate.headRefOid, exec, cwd: join(path, '..'),
    preparedSurface: { headSha: head, base: 'main', baseSha: tip, files: [] },
    sameHeadAdmission: () => verifyFastDrainEnqueue({ headSha: head, requiredChecks: ['test'], classifyPr,
      readLive }),
  });
  expect(readLive).toHaveBeenCalledOnce();
  expect(result).toMatchObject({ ok: false, held: true });
  expect(calls.some(([, args]) => args.some(arg => arg.includes('mutation')))).toBe(false);
});

it('final live green checks on the pinned open head permit admission; an unknown required set refuses', () => {
  expect(verifyFastDrainEnqueue({ headSha: head, requiredChecks: ['test'], classifyPr, readLive: () => row() }).hold).toBe(false);
  expect(verifyFastDrainEnqueue({ headSha: head, requiredChecks: null, classifyPr, readLive: () => row() }).hold).toBe(true);
});

it('final classifier holds green test when required integration has no row', () => {
  expect(verifyFastDrainEnqueue({ headSha: head, requiredChecks: ['test', 'integration'], classifyPr,
    readLive: () => row() })).toMatchObject({ hold: true, line: expect.stringContaining('integration (missing)') });
});

it('final verification holds when the standard classifier is unavailable', () => {
  expect(verifyFastDrainEnqueue({ headSha: head, requiredChecks: ['test'], readLive: () => row() }).hold).toBe(true);
});

it.each([undefined, null, false])('refuses cached rows when the live target reader is missing (%s)', async readTarget => {
  const path = setup(); save(path);
  const listLive = vi.fn();
  await expect(readFastDrainRoundListing({ ...options(path), listLive, readTarget }))
    .rejects.toThrow('live target reader missing — retry next pass');
  expect(listLive).not.toHaveBeenCalled();
});

it.each([null, {}, { ...row(), number: 99 }, { ...row(), state: 'UNKNOWN' }])(
  'refuses cached rows when the live target is unreadable (%j)', async target => {
    const path = setup(); save(path);
    await expect(readFastDrainRoundListing({ ...options(path), readTarget: async () => target }))
      .rejects.toThrow('live target unreadable');
  });
