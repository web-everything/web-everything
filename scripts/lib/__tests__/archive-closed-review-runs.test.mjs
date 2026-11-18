// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { listRunIds, newRunRecord, writeRun } from '../../operations/run-store.mjs';
import {
  archiveClosedReviewRuns, ghPrState, listArchivedRunIds, readArchivedRun, restoreArchivedRun,
} from '../archive-closed-review-runs.mjs';

const race = vi.hoisted(() => ({ afterLink: undefined }));
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, linkSync: (...args) => {
    actual.linkSync(...args);
    race.afterLink?.(...args);
  } };
});

let runsDir, archiveDir;
beforeEach(() => {
  runsDir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'closed-review-runs-'));
  archiveDir = join(runsDir, 'archive', 'review-pr');
});
afterEach(() => { race.afterLink = undefined; rmSync(runsDir, { recursive: true, force: true }); });
function record(id = 'review-pr-one', overrides = {}) {
  const value = { ...newRunRecord({ id, op: 'review-pr', input: { repo: 'org/repo', pr: 12 } }), ...overrides };
  writeRun(value, runsDir);
  return value;
}
const run = (options = {}) => archiveClosedReviewRuns({ runsDir, dryRun: false, prState: () => 'closed', ...options });

function atomicReplace(source, value) {
  const temporary = `${source}.writer`;
  writeFileSync(temporary, JSON.stringify(value));
  renameSync(temporary, source);
}

it.each(['before link', 'after link'])('archive preserves an atomic unfinished writer %s after validation', timing => {
  const value = record();
  const source = join(runsDir, `${value.id}.json`);
  const original = readFileSync(source);
  const newer = { ...value, pending: { kind: 'declared', step: 'review', stepIndex: 0 } };
  const link = vi.fn((claim, destination) => {
    if (timing === 'before link') atomicReplace(source, newer);
    linkSync(claim, destination);
    if (timing === 'after link') atomicReplace(source, newer);
  });
  const result = run({ link });
  expect(result.errors).toEqual([]);
  expect(result.archived).toEqual([value.id]);
  expect(link).toHaveBeenCalledTimes(1);
  expect(JSON.parse(readFileSync(source, 'utf8'))).toEqual(newer);
  expect(readFileSync(join(archiveDir, `${value.id}.json`))).toEqual(original);
  expect(listRunIds(runsDir)).toEqual([value.id]);
  expect(readdirSync(runsDir).filter(name => name.includes('.archiving-'))).toEqual([]);
});

it.each(['before link', 'after link'])('restore preserves an atomic archive writer %s', timing => {
  const value = record();
  run();
  const source = join(archiveDir, `${value.id}.json`);
  const original = readFileSync(source);
  const newer = { ...value, pending: { kind: 'declared', step: 'review', stepIndex: 0 } };
  restoreArchivedRun(value.id, { runsDir, link: (claim, destination) => {
    if (timing === 'before link') atomicReplace(source, newer);
    linkSync(claim, destination);
    if (timing === 'after link') atomicReplace(source, newer);
  } });
  expect(JSON.parse(readFileSync(source, 'utf8'))).toEqual(newer);
  expect(readFileSync(join(runsDir, `${value.id}.json`))).toEqual(original);
  expect(listArchivedRunIds({ runsDir })).toEqual([value.id]);
});

it('keeps a terminal atomic replacement between classification and claim as changed', () => {
  const value = record();
  const source = join(runsDir, `${value.id}.json`);
  const newer = { ...value, input: { repo: 'org/newer', pr: 34 } };
  const afterClaim = vi.fn(claim => {
    expect(existsSync(source)).toBe(false);
    expect(JSON.parse(readFileSync(claim, 'utf8'))).toEqual(newer);
  });
  const result = run({ beforeMove: () => atomicReplace(source, newer), afterClaim });
  expect(afterClaim).toHaveBeenCalledTimes(1);
  expect(result.archived).toEqual([]);
  expect(result.kept.changed).toEqual([value.id]);
  const retained = join(runsDir, readdirSync(runsDir).find(name => name.includes('.archiving-')));
  expect(result.errors).toEqual([{ id: value.id, error: `claim retained at ${retained}` }]);
  expect(JSON.parse(readFileSync(retained, 'utf8'))).toEqual(newer);
  expect(JSON.parse(readFileSync(source, 'utf8'))).toEqual(newer);
  expect(listArchivedRunIds({ runsDir })).toEqual([]);
});

it('crash leftovers use private claim paths excluded from listRunIds', () => {
  const value = record();
  const source = join(runsDir, `${value.id}.json`);
  const original = readFileSync(source);
  // Simulate abrupt exit by inspecting the on-disk state inside the move hook.
  const result = run({ move: claim => {
    expect(claim).not.toBe(source);
    expect(claim.startsWith(join(runsDir, `.${value.id}.archiving-`))).toBe(true);
    expect(readFileSync(claim)).toEqual(original);
    expect(existsSync(source)).toBe(false);
    expect(listRunIds(runsDir)).toEqual([]);
    const scan = run({ dryRun: true });
    expect(scan.scanned).toBe(0);
    expect(scan.kept.claimed).toEqual([{ id: value.id, path: claim }]);
    expect(existsSync(source)).toBe(false);
    throw new Error('simulated crash boundary');
  } });
  expect(result.errors).toEqual([{ id: value.id, error: `simulated crash boundary; claim retained at ${join(runsDir, readdirSync(runsDir).find(name => name.includes('.archiving-')))}` }]);
  expect(readFileSync(source)).toEqual(original);
});

it.each(['archive', 'restore'])('%s retains and reports the claim if rollback meets a newer source', action => {
  const value = record();
  if (action === 'restore') run();
  const directory = action === 'archive' ? runsDir : archiveDir;
  const source = join(directory, `${value.id}.json`);
  const original = readFileSync(source);
  const newer = { ...value, input: { repo: 'org/newer', pr: 34 } };
  let retained;
  const move = claim => {
    retained = claim;
    atomicReplace(source, newer);
    throw new Error('disk unavailable');
  };
  if (action === 'archive') {
    const result = run({ move });
    expect(result.archived).toEqual([]);
    expect(result.errors).toEqual([expect.objectContaining({ id: value.id, error: expect.stringContaining(retained) })]);
  } else {
    expect(() => restoreArchivedRun(value.id, { runsDir, move })).toThrow(/claim retained at .*\.archiving-/);
  }
  expect(retained).not.toBe(source);
  expect(readFileSync(retained)).toEqual(original);
  expect(JSON.parse(readFileSync(source, 'utf8'))).toEqual(newer);
  expect(listRunIds(directory)).toEqual([value.id]);
});

it.each(['changed', 'unfinished', 'corrupt'])('retains an invalid %s claim when a writer recreates the live path', change => {
  const value = record();
  const source = join(runsDir, `${value.id}.json`);
  const invalid = change === 'corrupt' ? '{broken' : JSON.stringify(change === 'unfinished'
    ? { ...value, pending: { kind: 'declared', step: 'review', stepIndex: 0 } }
    : { ...value, input: { repo: 'org/changed', pr: 34 } });
  const newer = { ...value, input: { repo: 'org/newest', pr: 56 } };
  let retained;
  const result = run({
    beforeMove: () => writeFileSync(source, invalid),
    afterClaim: claim => {
      retained = claim;
      atomicReplace(source, newer);
    },
  });
  expect(result.archived).toEqual([]);
  expect(result.kept[change === 'unfinished' ? 'unfinished' : 'changed']).toEqual([value.id]);
  expect(result.errors).toEqual([expect.objectContaining({ id: value.id, error: expect.stringContaining(retained) })]);
  expect(readFileSync(retained, 'utf8')).toBe(invalid);
  expect(JSON.parse(readFileSync(source, 'utf8'))).toEqual(newer);
  expect(listRunIds(runsDir)).toEqual([value.id]);
  expect(listArchivedRunIds({ runsDir })).toEqual([]);
});

it.each(['changed', 'unfinished', 'corrupt'])('restore rejects %s evidence replaced before claiming', change => {
  const value = record();
  run();
  const source = join(archiveDir, `${value.id}.json`);
  const newer = change === 'unfinished'
    ? { ...value, pending: { kind: 'declared', step: 'review', stepIndex: 0 } }
    : { ...value, input: { repo: 'org/newer', pr: 34 } };
  expect(() => restoreArchivedRun(value.id, { runsDir, beforeMove: () => {
    if (change === 'corrupt') writeFileSync(source, '{broken');
    else atomicReplace(source, newer);
  } })).toThrow(/changed|unfinished/);
  expect(existsSync(join(runsDir, `${value.id}.json`))).toBe(false);
  expect(readFileSync(source, 'utf8')).toBe(change === 'corrupt' ? '{broken' : JSON.stringify(newer));
});

it.each(['closed', 'merged'])('%s terminal review is moved intact out of the top-level listing', state => {
  const value = record();
  const original = readFileSync(join(runsDir, `${value.id}.json`), 'utf8');
  const result = run({ prState: () => state });
  expect(result.scanned).toBe(1);
  expect(result.archived).toEqual([value.id]);
  expect(result.errors).toEqual([]);
  expect(existsSync(join(runsDir, `${value.id}.json`))).toBe(false);
  expect(readFileSync(join(archiveDir, `${value.id}.json`), 'utf8')).toBe(original);
  expect(listRunIds(runsDir)).not.toContain(value.id);
});
it('keeps an open PR', () => {
  const { id } = record();
  expect(run({ prState: () => 'open' }).kept.open).toEqual([id]);
  expect(listRunIds(runsDir)).toEqual([id]);
});
it.each([
  { pending: { kind: 'declared', step: 'review', stepIndex: 0 } },
  { effects: [{ key: 'e', type: 'dispatch', stepIndex: 0, index: 0, status: 'pending' }] },
  { effects: [{ key: 'e', type: 'dispatch', stepIndex: 0, index: 0, status: 'in-flight', handle: 'job' }] },
])('keeps closed but unfinished records: %j', overrides => {
  const { id } = record(undefined, overrides);
  const prState = vi.fn(() => 'closed');
  expect(run({ prState }).kept.unfinished).toEqual([id]);
  expect(prState).not.toHaveBeenCalled();
  expect(listRunIds(runsDir)).toEqual([id]);
});
it.each([undefined, 'UNKNOWN', 'CLOSED', () => { throw new Error('unavailable'); }])('fails closed on unknown or throwing PR state: %s', state => {
  const { id } = record();
  expect(run({ prState: typeof state === 'function' ? state : () => state }).kept.unknownState).toEqual([id]);
  expect(listRunIds(runsDir)).toEqual([id]);
});
it.each([{}, { repo: 'org/repo' }, { repo: 'org/repo', pr: 'bad' }, { repo: 'org/repo', pr: 0 }])('keeps incomplete PR identity: %j', input => {
  const { id } = record(undefined, { input });
  const prState = vi.fn();
  expect(run({ prState }).kept.unknownState).toEqual([id]);
  expect(prState).not.toHaveBeenCalled();
});
it('caches PR states across numeric and string PR numbers, including resolver failures', () => {
  record('review-pr-one');
  record('review-pr-two', { input: { repo: 'org/repo', pr: '12' } });
  const prState = vi.fn(() => { throw new Error('offline'); });
  expect(run({ prState }).kept.unknownState).toEqual(['review-pr-one', 'review-pr-two']);
  expect(prState).toHaveBeenCalledTimes(1);
  expect(prState).toHaveBeenCalledWith('org/repo', 12);
});
it('defaults to dry-run and creates no archive or moves', () => {
  const { id } = record();
  const move = vi.fn();
  expect(archiveClosedReviewRuns({ runsDir, prState: () => 'closed', move }).archived).toEqual([id]);
  expect(move).not.toHaveBeenCalled();
  expect(listRunIds(runsDir)).toEqual([id]);
  expect(existsSync(archiveDir)).toBe(false);
});
it('keeps a record resumed between classification and move', () => {
  const value = record();
  const result = run({ prState: () => {
    writeRun({ ...value, pending: { kind: 'declared', step: 'review', stepIndex: 0 } }, runsDir);
    return 'closed';
  } });
  expect(result.archived).toEqual([]);
  expect(result.kept.unfinished).toEqual([value.id]);
  expect(listRunIds(runsDir)).toEqual([value.id]);
  expect(existsSync(join(archiveDir, `${value.id}.json`))).toBe(false);
});
it.each(['bytes', 'mtime', 'corrupt', 'missing'])('keeps changed or unreadable evidence before move: %s', change => {
  const { id } = record();
  const source = join(runsDir, `${id}.json`);
  // Whole seconds let the byte-only rewrite restore the exact nanosecond mtime.
  utimesSync(source, 1700000000, 1700000000);
  const original = readFileSync(source);
  const stamp = lstatSync(source);
  const move = vi.fn();
  const result = run({ move, beforeMove: () => {
    if (change === 'bytes') {
      writeFileSync(source, Buffer.concat([original, Buffer.from(' ')]));
      utimesSync(source, stamp.atime, stamp.mtime);
      expect(lstatSync(source, { bigint: true }).mtimeNs).toBe(1700000000000000000n);
    } else if (change === 'mtime') {
      utimesSync(source, stamp.atime, new Date(stamp.mtimeMs + 10000));
    } else if (change === 'corrupt') writeFileSync(source, '{broken');
    else rmSync(source);
  } });
  expect(result.archived).toEqual([]);
  expect(result.kept.changed).toEqual([id]);
  expect(move).not.toHaveBeenCalled();
  expect(existsSync(join(archiveDir, `${id}.json`))).toBe(false);
});
it.each(['archive', 'restore'])('%s refuses a destination created after the existence check', action => {
  const { id } = record();
  if (action === 'restore') run();
  const source = join(action === 'archive' ? runsDir : archiveDir, `${id}.json`);
  const destination = join(action === 'archive' ? archiveDir : runsDir, `${id}.json`);
  const original = readFileSync(source);
  const beforeMove = () => writeFileSync(destination, 'racing writer');
  if (action === 'archive') {
    const result = run({ beforeMove });
    expect(result.archived).toEqual([]);
    expect(result.errors).toEqual([expect.objectContaining({ id, error: expect.stringMatching(/EEXIST/) })]);
  } else expect(() => restoreArchivedRun(id, { runsDir, beforeMove })).toThrow(/EEXIST/);
  expect(readFileSync(source)).toEqual(original);
  expect(readFileSync(destination, 'utf8')).toBe('racing writer');
});
it.each(['EXDEV', 'EPERM'])('uses exclusive copy when linking fails with %s, for archive and restore', code => {
  const { id } = record();
  const original = readFileSync(join(runsDir, `${id}.json`));
  const link = vi.fn(() => { throw Object.assign(new Error(code), { code }); });
  expect(run({ link }).archived).toEqual([id]);
  expect(readFileSync(join(archiveDir, `${id}.json`))).toEqual(original);
  expect(listRunIds(runsDir)).toEqual([]);
  restoreArchivedRun(id, { runsDir, link });
  expect(readFileSync(join(runsDir, `${id}.json`))).toEqual(original);
  expect(listArchivedRunIds({ runsDir })).toEqual([id]);
  expect(readFileSync(join(archiveDir, `${id}.json`))).toEqual(original);
  expect(link).toHaveBeenCalledTimes(2);
});
it.each(['archive', 'restore'])('%s exclusive-copy fallback preserves a racing destination and source', action => {
  const { id } = record();
  if (action === 'restore') run();
  const source = join(action === 'archive' ? runsDir : archiveDir, `${id}.json`);
  const original = readFileSync(source);
  const destination = join(action === 'archive' ? archiveDir : runsDir, `${id}.json`);
  const link = () => {
    writeFileSync(destination, 'racing copy writer');
    throw Object.assign(new Error('cross-device'), { code: 'EXDEV' });
  };
  if (action === 'archive') {
    const result = run({ link });
    expect(result.archived).toEqual([]);
    expect(result.errors).toHaveLength(1);
  } else expect(() => restoreArchivedRun(id, { runsDir, link })).toThrow(/EEXIST/);
  expect(readFileSync(source)).toEqual(original);
  expect(readFileSync(destination, 'utf8')).toBe('racing copy writer');
});
it('does not copy or remove the source for an unexpected link failure', () => {
  const { id } = record();
  const link = () => { throw Object.assign(new Error('I/O failure'), { code: 'EIO' }); };
  expect(run({ link }).errors).toEqual([{ id, error: `I/O failure; claim retained at ${join(runsDir, readdirSync(runsDir).find(name => name.includes('.archiving-')))}` }]);
  expect(listRunIds(runsDir)).toEqual([id]);
  expect(listArchivedRunIds({ runsDir })).toEqual([]);
});
it('uses a hard link before unlinking the source', () => {
  const { id } = record();
  const link = vi.fn((source, destination) => {
    linkSync(source, destination);
    expect(lstatSync(destination).ino).toBe(lstatSync(source).ino);
  });
  expect(run({ link }).archived).toEqual([id]);
  expect(link).toHaveBeenCalledTimes(1);
  expect(listRunIds(runsDir)).toEqual([]);
});
it('refuses an existing destination, preserving both records', () => {
  const { id } = record();
  mkdirSync(archiveDir, { recursive: true });
  const dest = join(archiveDir, `${id}.json`);
  writeFileSync(dest, 'existing evidence');
  const result = run();
  expect(result.archived).toEqual([]);
  expect(result.errors).toEqual([expect.objectContaining({ id, error: expect.stringMatching(/exists/) })]);
  expect(listRunIds(runsDir)).toEqual([id]);
  expect(readFileSync(dest, 'utf8')).toBe('existing evidence');
});
it('refuses a dangling destination symlink, preserving the source record and symlink', () => {
  const { id } = record();
  const source = join(runsDir, `${id}.json`);
  const original = readFileSync(source, 'utf8');
  mkdirSync(archiveDir, { recursive: true });
  const destination = join(archiveDir, `${id}.json`);
  const target = 'missing-review-record.json';
  symlinkSync(target, destination);
  expect(existsSync(destination)).toBe(false);

  const result = run();

  expect(result.archived).toEqual([]);
  expect(result.errors).toEqual([expect.objectContaining({ id, error: expect.stringMatching(/exists/) })]);
  expect(readFileSync(source, 'utf8')).toBe(original);
  expect(lstatSync(destination).isSymbolicLink()).toBe(true);
  expect(readlinkSync(destination)).toBe(target);
});
it('reads, lists and restores archived records explicitly for a reopened PR', () => {
  const value = record();
  run();
  expect(readArchivedRun(value.id, { runsDir })).toEqual(value);
  expect(listArchivedRunIds({ runsDir })).toEqual([value.id]);
  restoreArchivedRun(value.id, { runsDir });
  expect(listArchivedRunIds({ runsDir })).toEqual([value.id]);
  expect(listRunIds(runsDir)).toEqual([value.id]);
  expect(readArchivedRun(value.id, { runsDir })).toEqual(value);
});
it('readArchivedRun throws for corrupt archived JSON', () => {
  const id = 'review-pr-corrupt-archive';
  mkdirSync(archiveDir, { recursive: true });
  const archivedPath = join(archiveDir, `${id}.json`);
  writeFileSync(archivedPath, '{broken');

  expect(() => readArchivedRun(id, { runsDir })).toThrow(/refusing to read run/);
  expect(readFileSync(archivedPath, 'utf8')).toBe('{broken');
});
it('restore refuses to overwrite a live record', () => {
  const { id } = record();
  run();
  record(id, { input: { repo: 'org/reopened', pr: 12 } });
  expect(() => restoreArchivedRun(id, { runsDir })).toThrow(/exists/);
  expect(listArchivedRunIds({ runsDir })).toEqual([id]);
  expect(JSON.parse(readFileSync(join(runsDir, `${id}.json`), 'utf8')).input.repo).toBe('org/reopened');
});
it('leaves non-review ids untouched and classifies mismatched review operations', () => {
  record('build-one', { op: 'build' });
  record('review-pr-wrong', { op: 'other' });
  const result = run();
  expect(result.scanned).toBe(1);
  expect(result.kept.notReview).toEqual(['review-pr-wrong']);
  expect(listRunIds(runsDir)).toEqual(['build-one', 'review-pr-wrong']);
});
it('keeps corrupt and disappeared candidates without resolving their PRs', () => {
  writeFileSync(join(runsDir, 'review-pr-corrupt.json'), '{broken');
  const prState = vi.fn();
  const result = run({ list: () => ['review-pr-corrupt', 'review-pr-missing'], prState });
  expect(result.kept.corrupt).toEqual(['review-pr-corrupt', 'review-pr-missing']);
  expect(prState).not.toHaveBeenCalled();
  expect(existsSync(join(runsDir, 'review-pr-corrupt.json'))).toBe(true);
});
it('reports move and listing failures without claiming an archive', () => {
  const { id } = record();
  const result = run({ move: () => { throw new Error('disk unavailable'); } });
  expect(result.archived).toEqual([]);
  expect(result.errors).toEqual([{ id, error: `disk unavailable; claim retained at ${join(runsDir, readdirSync(runsDir).find(name => name.includes('.archiving-')))}` }]);
  expect(listRunIds(runsDir)).toEqual([id]);
  expect(run({ list: () => { throw new Error('unreadable'); } }).errors).toHaveLength(1);
});
it('supports a custom archive directory and injected list/read/move', () => {
  const archive = join(runsDir, 'custom');
  const value = newRunRecord({ id: 'review-pr-fake', op: 'review-pr', input: { repo: 'other/repo', pr: 7 } });
  writeRun(value, runsDir);
  const list = vi.fn(() => [value.id]);
  const read = vi.fn(() => value);
  const original = readFileSync(join(runsDir, `${value.id}.json`));
  const move = vi.fn((claim, destination) => {
    expect(claim.startsWith(join(runsDir, `.${value.id}.archiving-`))).toBe(true);
    expect(readFileSync(claim)).toEqual(original);
    linkSync(claim, destination);
    rmSync(claim);
  });
  expect(run({ archiveDir: archive, list, read, move }).archived).toEqual([value.id]);
  expect(list).toHaveBeenCalledWith(runsDir);
  expect(read).toHaveBeenCalledWith(value.id, runsDir);
  expect(move).toHaveBeenCalledTimes(1);
  expect(move).toHaveBeenCalledWith(expect.stringMatching(/\.archiving-\d+-[\da-f-]+$/), join(archive, `${value.id}.json`));
  expect(readFileSync(join(archive, `${value.id}.json`))).toEqual(original);
  expect(listRunIds(runsDir)).toEqual([]);
});

it.each([['OPEN', 'open'], ['CLOSED', 'closed'], ['MERGED', 'merged'], ['UNKNOWN', undefined], ['__proto__', undefined]])('CLI resolver maps only known GitHub state %s', (state, expected) => {
  const exec = vi.fn(() => `${state}\n`);
  expect(ghPrState('org/repo', 12, { exec })).toBe(expected);
  expect(exec).toHaveBeenLastCalledWith('gh', [
    'pr', 'view', '12', '--repo', 'org/repo', '--json', 'state', '-q', '.state',
  ], expect.objectContaining({ timeout: 30_000, maxBuffer: 64 * 1024 }));
});
it('missing resolver fails closed without using the CLI resolver', () => {
  const { id } = record();
  expect(run({ prState: undefined }).kept.unknownState).toEqual([id]);
  expect(listRunIds(runsDir)).toEqual([id]);
});
it.each([{ args: [] }, { args: ['--apply'] }, { args: ['--json'] }])('CLI reports buckets without network for an empty store: $args', ({ args }) => {
  const cli = resolve('scripts/lib/archive-closed-review-runs.mjs');
  const output = spawnSync(process.execPath, [cli, ...args], {
    env: { ...process.env, WE_SHARED_RUNS_DIR: runsDir }, encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024,
  });
  expect(output.status, output.stderr).toBe(0);
  if (args.includes('--json')) expect(JSON.parse(output.stdout)).toEqual({
    scanned: 0, archived: [], kept: { open: [], unfinished: [], unknownState: [], corrupt: [], notReview: [], changed: [], claimed: [] }, errors: [],
  });
  else {
    expect(output.stdout).toContain(`${args.includes('--apply') ? 'archived' : 'would-archive'}: 0`);
    for (const bucket of ['open', 'unfinished', 'unknown', 'corrupt', 'claimed']) expect(output.stdout).toContain(`${bucket}: 0`);
  }
});


it('retains rollback evidence when an atomic writer replaces the recovery back-link', () => {
  const value = record();
  const source = join(runsDir, `${value.id}.json`);
  const original = readFileSync(source);
  const newer = { ...value, input: { repo: 'org/newest', pr: 56 } };
  let retained;
  race.afterLink = (claim, destination) => {
    if (destination !== source) return;
    retained = claim;
    atomicReplace(source, newer);
  };
  const result = run({ move: () => { throw new Error('disk unavailable'); } });
  expect(result.archived).toEqual([]);
  expect(result.errors).toEqual([{ id: value.id, error: `disk unavailable; claim retained at ${retained}` }]);
  expect(readFileSync(retained)).toEqual(original);
  expect(JSON.parse(readFileSync(source, 'utf8'))).toEqual(newer);
});

it('restore keeps archived evidence when a writer replaces the newly linked live path', () => {
  const value = record();
  run();
  const source = join(archiveDir, `${value.id}.json`);
  const original = readFileSync(source);
  const destination = join(runsDir, `${value.id}.json`);
  const newer = { ...value, input: { repo: 'org/newest', pr: 56 } };
  restoreArchivedRun(value.id, { runsDir, link: (claim, live) => {
    linkSync(claim, live);
    atomicReplace(live, newer);
  } });
  expect(readFileSync(source)).toEqual(original);
  expect(readArchivedRun(value.id, { runsDir })).toEqual(value);
  expect(JSON.parse(readFileSync(destination, 'utf8'))).toEqual(newer);
});

it.each([false, true])('reports a real leftover claim and recovers only in apply mode: %s', apply => {
  const id = 'review-pr-leftover';
  const path = join(runsDir, `.${id}.archiving-123-12345678-abcd`);
  const value = newRunRecord({ id, op: 'review-pr', input: { repo: 'org/repo', pr: 12 } });
  const bytes = JSON.stringify(value);
  writeFileSync(path, bytes);
  expect(listRunIds(runsDir)).toEqual([]);
  const prState = vi.fn();
  const result = run({ dryRun: !apply, prState });
  expect(result.kept.claimed).toEqual([{ id, path }]);
  expect(result.errors).toEqual([]);
  expect(result.archived).toEqual([]);
  expect(prState).not.toHaveBeenCalled();
  expect(readFileSync(path, 'utf8')).toBe(bytes);
  const live = join(runsDir, `${id}.json`);
  expect(existsSync(live)).toBe(apply);
  if (apply) expect(readFileSync(live, 'utf8')).toBe(bytes);
});

it('leftover recovery preserves a newer live record and reports the claim on repeated scans', () => {
  const value = record();
  const path = join(runsDir, `.${value.id}.archiving-123-abcdef`);
  writeFileSync(path, 'older evidence');
  const original = readFileSync(join(runsDir, `${value.id}.json`));
  expect(run().kept.claimed).toEqual([{ id: value.id, path }]);
  expect(run().kept.claimed).toEqual([{ id: value.id, path }]);
  expect(readFileSync(path, 'utf8')).toBe('older evidence');
  expect(readFileSync(join(runsDir, `${value.id}.json`))).toEqual(original);
});

it.each(['existing', 'racing'])('archives identical already-archived bytes safely: %s destination', timing => {
  const value = record();
  const source = join(runsDir, `${value.id}.json`);
  const original = readFileSync(source);
  mkdirSync(archiveDir, { recursive: true });
  const destination = join(archiveDir, `${value.id}.json`);
  const populate = () => writeFileSync(destination, original);
  if (timing === 'existing') populate();
  const result = run({ beforeMove: timing === 'racing' ? populate : undefined });
  expect(result.errors).toEqual([]);
  expect(result.archived).toEqual([value.id]);
  expect(existsSync(source)).toBe(false);
  expect(readFileSync(destination)).toEqual(original);
  expect(readdirSync(runsDir).filter(name => name.includes('.archiving-'))).toEqual([]);
});

it('restores and then rearchives identical evidence while keeping the archive readable', () => {
  const value = record();
  run();
  restoreArchivedRun(value.id, { runsDir });
  expect(readArchivedRun(value.id, { runsDir })).toEqual(value);
  expect(run().archived).toEqual([value.id]);
  expect(readArchivedRun(value.id, { runsDir })).toEqual(value);
  expect(listRunIds(runsDir)).toEqual([]);
});


it('CLI reports a nonzero claimed count for on-disk crash evidence', () => {
  const path = join(runsDir, '.review-pr-crash.archiving-123-abcdef');
  writeFileSync(path, 'crash evidence');
  const output = spawnSync(process.execPath, [resolve('scripts/lib/archive-closed-review-runs.mjs')], {
    env: { ...process.env, WE_SHARED_RUNS_DIR: runsDir }, encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024,
  });
  expect(output.status, output.stderr).toBe(0);
  expect(output.stdout).toContain('claimed: 1');
  expect(readFileSync(path, 'utf8')).toBe('crash evidence');
  expect(listRunIds(runsDir)).toEqual([]);
});
