import { describe, it, expect } from 'vitest';
import { quarantineEligible, quarantinedVerdict } from '../verify-quarantine.mjs';
import { readFileSync } from 'node:fs';
import { createFailureCollector } from '../verify-failures.mjs';
import { applyRevertRedToVerdict } from '../verify-revert-red.mjs';
import { reachesChanged } from '../red-cause.mjs';

const now = Date.parse('2026-11-18T12:00:00Z');
const file = 'scripts/lib/__tests__/daemon-jobs-runtime.test.mjs';
const other = 'scripts/lib/__tests__/other.test.mjs';
const entry = (test = file, extra = {}) => ({ test, brokenSha: 'abcdef123', owner: 'operator',
  reason: 'red on main', addedAt: now - 1000, expiresAt: now + 1000, ...extra });
const phase = (files = [file], extra = {}) => ({ phase: 'vitest', result: { exitCode: 1,
  failureDetails: { tests: files.map(file => ({ file, name: 'fails' })), truncated: false, summary: `Test Files  ${new Set(files).size} failed` }, ...extra } });
const input = (extra = {}) => ({ phaseResults: [phase()], now, changedFiles: [], onMain: false, runAllPhases: true, phased: true,
  read: { ok: true, list: { version: 1, mode: 'quarantine', entries: [entry()] } }, ...extra });
const verdict = (extra = {}) => quarantinedVerdict(input(extra));
const withEntries = entries => ({ ok: true, list: { version: 1, mode: 'quarantine', entries } });
const closed = result => expect(result).toMatchObject({ excused: false, files: [], why: expect.any(String) });

describe('verify post-hoc quarantine', () => {
  it('keeps a combined test-and-standards command red: standards execution is unproven', () => {
    closed(verdict({ phased: false }));
    closed(verdict({ phased: undefined }));
  });
  it('keeps red when standards were required but never executed', () => {
    closed(verdict({ standardsRequired: true }));
    expect(verdict({ standardsRequired: true, phaseResults: [phase(), { phase: 'standards', result: { exitCode: 0 } }] }).excused).toBe(true);
  });
  it('excuses all covered files across red vitest phases, preserving unique file names', () => {
    expect(verdict({ phaseResults: [phase([file, file]), phase([other]), { phase: 'scan', result: { exitCode: 0 } }],
      read: withEntries([entry(), entry(other)]) })).toEqual({
      excused: true, files: [file, other], why: expect.stringContaining('skipping 2'),
    });
  });
  it('keeps every branch red while a published main-fix PR is open', () => {
    const result = verdict({ read: { ok: true, list: { ...input().read.list, fixPrs: [123] } } });
    closed(result);
    expect(result.why).toContain('main-fix PR is open');
    expect(verdict({ read: { ok: true, list: { ...input().read.list, fixPrs: [] } } }).excused).toBe(true);
  });
  it.each([true, undefined, null])('keeps main or unknown branch red (%j)', onMain => closed(verdict({ onMain })));
  it.each([false, undefined])('keeps red when later planned phases may have been skipped (%j)', runAllPhases => closed(verdict({ runAllPhases })));
  it.each(['data.json', 'fixture.html', 'config.yaml', 'asset.svg', 'LICENSE'])('keeps runtime dependency evidence unknown for %s', changed => {
    closed(verdict({ changedFiles: ['unrelated.mjs', changed], touchesDiff: () => false }));
  });
  it.each(['mjs', 'js', 'cjs', 'ts', 'tsx', 'md', 'mdx'])('allows proven outside %s edits', ext => {
    expect(verdict({ changedFiles: [`unrelated.${ext}`], touchesDiff: () => false }).excused).toBe(true);
  });
  it('requires the distinct failing file count to match vitest, including duplicate test identities', () => {
    for (const summary of ['', 'Test Files  2 failed', 'Test Files  0 failed']) {
      closed(verdict({ phaseResults: [phase([file], { failureDetails: { tests: [{ file, name: 'fails' }], truncated: false, summary } })] }));
    }
    expect(verdict({ phaseResults: [phase([file, file])] }).excused).toBe(true);
  });
  it.each(['stdout', 'stderr'])('reconciles real collector output and %s counts', stream => {
    const collector = createFailureCollector();
    collector.push(` FAIL ${file} > fails\n`, 'stderr');
    collector.push(' Test Files  1 failed | 2 passed (3)\n', stream);
    const failureDetails = collector.finish();
    expect(verdict({ phaseResults: [phase([file], { failureDetails, output: null })] }).excused).toBe(true);
    closed(verdict({ phaseResults: [phase([file], { failureDetails, output: { [stream]: 'Test Files  2 failed' } })] }));
    expect(verdict({ phaseResults: [phase([file], { failureDetails: { ...failureDetails, summary: '' }, output: { [stream]: 'Test Files  1 failed' } })] }).excused).toBe(true);
  });
  it('routes quarantined green through revert-red enforcement before diagnostics and markers', () => {
    const source = readFileSync('scripts/verify-lane.mjs', 'utf8');
    const start = source.indexOf('const diffFiles =');
    const end = source.indexOf('// #5466 — the revert-red check, inside', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const decide = new Function('resolvedGate', 'editedDuringRun', 'tryGit', 'headSha', 'exitCode', 'signal', 'infrastructureNow', 'phaseTimeout',
      'quarantineEligible', 'phaseResults', 'quarantinedVerdict', 'readQuarantine', 'REPO', 'runAllPhases', 'reachesChanged', 'readRepoFile', 'process', 'phasedTestGate',
      'const failureDetails = undefined; ' + source.slice(start, end) + '; return { exitCode, quarantined };');
    const run = (branch, mainTip) => decide({ decision: { changedFiles: [] } }, [], args => args[0] === 'symbolic-ref' ? branch : mainTip,
      'head', 1, null, () => null, null, quarantineEligible, [phase()], args => quarantinedVerdict({ ...args, now }),
      () => input().read, '.', true, () => 'outside', () => '', { stderr: { write() {} } }, true);
    // Lane clones keep a local branch named main, so only HEAD == origin/main's tip counts as main.
    expect(run('lane/test', 'head').exitCode).toBe(1);
    expect(run('main', 'base').exitCode).toBe(0);
    const green = run('lane/test', 'base');
    expect(green).toMatchObject({ exitCode: 0, quarantined: { files: [file] } });
    const revert = source.indexOf('if (exitCode === 0 && !signal', end);
    const apply = source.indexOf('applyRevertRedToVerdict({ exitCode, failureDetails, revertRed })', revert);
    expect(revert).toBeGreaterThan(end);
    expect(apply).toBeGreaterThan(revert);
    expect(apply).toBeLessThan(source.indexOf('const diagnostic =', apply));
    expect(applyRevertRedToVerdict({ ...green, revertRed: { mode: 'enforce', status: 'flagged', blocking: true, line: 'revert-red: flagged' } }).exitCode).not.toBe(0);
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
