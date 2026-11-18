import { describe, it, expect } from 'vitest';
import { quarantineEligible, quarantinedVerdict } from '../verify-quarantine.mjs';
import { reachesChanged } from '../red-cause.mjs';

const now = Date.parse('2026-11-18T12:00:00Z');
const file = 'scripts/lib/__tests__/daemon-jobs-runtime.test.mjs';
const other = 'scripts/lib/__tests__/other.test.mjs';
const entry = (test = file, extra = {}) => ({ test, brokenSha: 'abcdef123', owner: 'operator',
  reason: 'red on main', addedAt: now - 1000, expiresAt: now + 1000, ...extra });
const phase = (files = [file], extra = {}) => ({ phase: 'vitest', result: { exitCode: 1,
  failureDetails: { tests: files.map(file => ({ file, name: 'fails' })), truncated: false }, ...extra } });
const input = (extra = {}) => ({ phaseResults: [phase()], now, changedFiles: [],
  read: { ok: true, list: { version: 1, mode: 'quarantine', entries: [entry()] } }, ...extra });
const verdict = (extra = {}) => quarantinedVerdict(input(extra));
const withEntries = entries => ({ ok: true, list: { version: 1, mode: 'quarantine', entries } });
const closed = result => expect(result).toMatchObject({ excused: false, files: [], why: expect.any(String) });

describe('verify post-hoc quarantine', () => {
  it('excuses all covered files across red vitest phases, preserving unique file names', () => {
    expect(verdict({ phaseResults: [phase([file, file]), phase([other]), { phase: 'scan', result: { exitCode: 0 } }],
      read: withEntries([entry(), entry(other)]) })).toEqual({
      excused: true, files: [file, other], why: expect.stringContaining('skipping 2'),
    });
  });
  it('does not mutate the actual test outcomes', () => {
    const args = input();
    const before = structuredClone(args);
    expect(quarantinedVerdict(args).excused).toBe(true);
    expect(args).toEqual(before);
  });
  it('rejects an expired entry at its exact expiry', () => {
    closed(verdict({ read: withEntries([entry(file, { expiresAt: now })]) }));
  });
  it('rejects stop mode and absent mode', () => {
    for (const mode of ['stop', undefined]) closed(verdict({ read: { ok: true, list: { ...input().read.list, mode } } }));
  });
  it.each([null, { ok: false, error: 'unreachable' }, { ok: true },
    { ok: true, list: { version: 1, mode: 'quarantine', entries: [{}] } },
    { ok: true, list: { version: 1, mode: 'quarantine', entries: 'bad' } },
  ])('fails closed on unreadable or malformed list %j', read => closed(verdict({ read })));
  it('fails closed when accessing the read throws', () => {
    closed(verdict({ read: { get ok() { throw new Error('read failed'); } } }));
  });
  it('never expands name-qualified quarantine to the whole file', () => {
    closed(verdict({ read: withEntries([entry(`${file}::fails`)]) }));
  });
  it('does not excuse a failing file changed by the diff', () => closed(verdict({ changedFiles: [file] })));
  it('fails closed on unknown or malformed diff evidence', () => {
    for (const changedFiles of [undefined, null, [null]]) closed(verdict({ changedFiles }));
  });
  it('keeps mixed covered and uncovered failures red', () => closed(verdict({ phaseResults: [phase([file, other])] })));
  it('keeps a quarantined unchanged test red when it imports edited source', () => {
    const changedFiles = ['scripts/lib/changed-source.mjs'];
    const touchesDiff = testFile => reachesChanged({ testFile, changedFiles,
      readFile: path => {
        if (path === file) return "import '../changed-source.mjs';";
        throw new Error('absent');
      } }) !== 'outside';
    expect(touchesDiff(file)).toBe(true);
    closed(verdict({ changedFiles, touchesDiff }));
  });
  it('keeps red when the dependency walk hits its bound and returns unknown', () => {
    const changedFiles = ['scripts/lib/changed-source.mjs'];
    const touchesDiff = testFile => {
      const reach = reachesChanged({ testFile, changedFiles, maxDepth: 0, readFile: () => '' });
      return reach === 'unknown' ? 'unknown' : reach === 'reaches';
    };
    expect(touchesDiff(file)).toBe('unknown');
    closed(verdict({ changedFiles, touchesDiff }));
  });
  it('excuses a quarantined failure only with proven outside dependency evidence', () => {
    const changedFiles = ['scripts/lib/unrelated.mjs'];
    const touchesDiff = testFile => reachesChanged({ testFile, changedFiles, readFile: () => '' }) !== 'outside';
    expect(verdict({ changedFiles, touchesDiff }).excused).toBe(true);
  });
  it('keeps red when dependency evidence is missing, invalid or throws', () => {
    for (const touchesDiff of [undefined, () => undefined, () => null, () => { throw new Error('unreadable'); }]) {
      closed(verdict({ changedFiles: ['scripts/lib/changed-source.mjs'], touchesDiff }));
    }
  });
  it('keeps mixed outside and dependency-affected failing files red', () => {
    closed(verdict({ changedFiles: ['scripts/lib/changed-source.mjs'], phaseResults: [phase([file, other])],
      read: withEntries([entry(), entry(other)]), touchesDiff: testFile => testFile === other }));
  });
  it.each(['scan', 'standards'])('keeps a red %s phase red', name => {
    closed(verdict({ phaseResults: [phase(), { ...phase(), phase: name }] }));
  });
  it.each([undefined, {}, { tests: [] }, { tests: [{ name: 'unknown file' }] },
    { tests: [{ file, name: null }], truncated: true }, { tests: [{ file }] },
  ])('rejects unknown or incomplete failing tests %j', failureDetails => {
    const phaseResults = [phase([file], { failureDetails })];
    expect(quarantineEligible(phaseResults)).toBe(false);
    closed(verdict({ phaseResults }));
  });
  it.each([{ signal: 'SIGTERM' }, { exitCode: 137 }, { timedOut: true },
    { infrastructure: { reason: 'unsettled' } }, { exitCode: 124, remoteAttempt: true }, { exitCode: null },
  ])('rejects infrastructure, signals and unknown exit status %j', extra => {
    const phaseResults = [phase([file], extra)];
    expect(quarantineEligible(phaseResults)).toBe(false);
    closed(verdict({ phaseResults }));
  });
  it('requires a red gate and a known clock', () => {
    closed(verdict({ phaseResults: [] }));
    closed(verdict({ phaseResults: [phase([file], { exitCode: 0 })] }));
    closed(verdict({ now: NaN }));
  });
  it('uses CI default job scope: legacy and unit shards, excluding other jobs', () => {
    expect(verdict({ read: withEntries([entry(file, { job: 'test-shard (2)' })]) }).excused).toBe(true);
    closed(verdict({ read: withEntries([entry(file, { job: 'integration' })]) }));
  });
});
