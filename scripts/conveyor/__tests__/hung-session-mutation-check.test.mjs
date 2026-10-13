/** @file #4492 — exercise checker decisions and its admitted subprocess/cleanup boundary. */
import { describe, it, expect, vi } from 'vitest';
import { join } from 'node:path';
import { run, makeRealRunVitest, DEFAULT_MUTATIONS, CASES, NAMED_PREFIX, TEST_FILE } from '../hung-session-mutation-check.mjs';

const ROOT = '/fixture';
const SOURCE = DEFAULT_MUTATIONS.map((mutation) => mutation.find).join('\n');
function evidence(failed = []) {
  return {
    status: failed.length ? 1 : 0, signal: null, runtimeErrors: 0,
    report: {
      numFailedTestSuites: 0, numPendingTestSuites: 0, numFailedTests: failed.length, success: !failed.length,
      testResults: [{ name: join(ROOT, TEST_FILE), message: '', status: failed.length ? 'failed' : 'passed',
        assertionResults: CASES.map((name) => ({ fullName: `${NAMED_PREFIX} ${name}`,
          status: failed.includes(name) ? 'failed' : 'passed',
          failureMessages: failed.includes(name) ? ['expected 0 to be 12345 // Object.is equality'] : [],
        })) }],
    },
  };
}
const tests = (result) => result.report.testResults[0].assertionResults;
function check({ stage = -1, corrupt = () => {}, source = SOURCE, mutations = DEFAULT_MUTATIONS } = {}) {
  const runVitest = vi.fn((mutant) => {
    const index = mutant === null ? -1 : mutations.findIndex((mutation) => mutant === source.replace(mutation.find, () => mutation.replace));
    const result = evidence(index < 0 ? [] : mutations[index].kills);
    if (index === stage) corrupt(result);
    return result;
  });
  return { ...run({ root: ROOT, readSource: () => source, runVitest, mutations }), runVitest };
}

describe('hung-session mutation evidence', () => {
  it('pins the independent mutations and their required kill cases', () => {
    expect(DEFAULT_MUTATIONS.map(({ find, replace, kills }) => ({ find, replace, kills }))).toEqual([
      { find: "Date.parse(entry?.ts ?? '')", replace: "Date.parse(entry?.ts ?? '1970-01-01T00:00:00.000Z')", kills: ['omitted', 'null'] },
      { find: 'lastActivityMs = statFn(file).mtimeMs;', replace: 'lastActivityMs = 0;', kills: ['omitted', 'null', 'empty', 'invalid'] },
      { find: 'if (lastActivityMs === null) {', replace: 'if (true) {', kills: ['mixed-forward', 'mixed-reverse'] },
    ]);
  });

  it('passes only after baseline and all three independently killed mutants', () => {
    const result = check();
    expect(result.ok).toBe(true);
    expect(result.runVitest.mock.calls.map(([source]) => source)).toEqual([
      null, ...DEFAULT_MUTATIONS.map((mutation) => SOURCE.replace(mutation.find, () => mutation.replace)),
    ]);
  });

  it('accepts Vitest 1 full names prefixed by its empty file-suite title', () => {
    expect(check({ corrupt: (result) => { for (const test of tests(result)) test.fullName = ` ${test.fullName}`; } }).ok).toBe(true);
  });

  it.each(DEFAULT_MUTATIONS.map((mutation, index) => [mutation.name, index]))('rejects survivor %s', (_, stage) => {
    expect(check({ stage, corrupt: (result) => Object.assign(result, evidence()) }).problems.join()).toContain('SURVIVED');
  });

  it.each([['absent', 'nothing', 0], ['duplicate', `${SOURCE}\n${SOURCE}`, 2]])('rejects %s replacement targets', (_, source, count) => {
    const result = check({ source });
    expect(result.problems.join()).toContain(`exactly once, found ${count}`);
    expect(result.runVitest).not.toHaveBeenCalled();
  });

  it('rejects a no-op mutation before accepting any evidence', () => {
    const result = check({ mutations: [{ ...DEFAULT_MUTATIONS[0], replace: DEFAULT_MUTATIONS[0].find }] });
    expect(result.problems.join()).toContain('no-op');
    expect(result.runVitest).not.toHaveBeenCalled();
  });

  it('rejects a failed baseline and does not run mutants', () => {
    const result = check({ corrupt: (result) => Object.assign(result, evidence(['omitted'])) });
    expect(result.problems.join()).toContain('baseline failed');
    expect(result.runVitest).toHaveBeenCalledTimes(1);
  });

  const invalid = [
    ['missing case', (result) => tests(result).pop()],
    ['skipped case', (result) => { tests(result)[0].status = 'skipped'; }],
    ['duplicate name', (result) => tests(result).push({ ...tests(result)[0] })],
    ['wrong file', (result) => { result.report.testResults[0].name = '/elsewhere/hung-session.test.mjs'; }],
    ['empty report', (result) => { result.report = {}; }],
    ['missing report', (result) => { delete result.report; }],
    ['malformed report', (result) => { result.report.testResults = 'invalid'; }],
    ['malformed assertions', (result) => { result.report.testResults[0].assertionResults = null; }],
    ['runner error', (result) => { result.error = new Error('spawn failed'); }],
    ['signal', (result) => { result.signal = 'SIGTERM'; }],
    ['null exit', (result) => { result.status = null; }],
    ['unexpected exit', (result) => { result.status = 2; }],
    ['unhandled error', (result) => { result.runtimeErrors = 1; }],
    ['missing runtime receipt', (result) => { delete result.runtimeErrors; }],
    ['collection error', (result) => { result.report.numFailedTestSuites = 1; }],
    ['suite-load error', (result) => { result.report.testResults[0].message = 'Cannot load module'; }],
    ['extra failed file', (result) => { result.report.testResults.push({ name: '/bad.mjs', status: 'failed', assertionResults: [] }); }],
    ['inconsistent exit', (result) => { result.status = result.status === 0 ? 1 : 0; }],
    ['thrown runner', () => { throw new Error('runner exploded'); }],
  ];
  describe.each([['baseline', -1], ...DEFAULT_MUTATIONS.map((mutation, index) => [mutation.name, index])])('%s refuses invalid evidence', (_, stage) => {
    it.each(invalid)('%s', (_, corrupt) => { expect(check({ stage, corrupt }).ok).toBe(false); });
    it.each(CASES)('requires %s exactly once and without skips', (name) => {
      for (const status of ['missing', 'skipped', 'pending', 'todo']) {
        const result = check({ stage, corrupt: (result) => {
          const assertions = tests(result);
          const index = assertions.findIndex((test) => test.fullName === `${NAMED_PREFIX} ${name}`);
          if (status === 'missing') assertions.splice(index, 1);
          else assertions[index].status = status;
        } });
        expect(result.ok).toBe(false);
      }
    });
  });

  it.each([[[]], [['']], [['TypeError: undefined is not a function']]])('requires assertion evidence, not merely failed status (%j)', (message) => {
    expect(check({ stage: 0, corrupt: (result) => { tests(result)[0].failureMessages = message; } }).ok).toBe(false);
  });

  it('handles thrown runner and source errors as failures', () => {
    expect(run({ readSource: () => SOURCE, runVitest: () => { throw new Error('runner exploded'); } }).ok).toBe(false);
    expect(run({ readSource: () => { throw new Error('read failed'); }, runVitest: vi.fn() }).ok).toBe(false);
  });
});

describe('real runner adapters', () => {
  function harness(mode, source) {
    const files = new Map();
    const removed = [];
    const filesystem = {
      mkdtempSync: () => '/temp/run',
      writeFileSync: (path, value) => files.set(path, value),
      readFileSync: (path) => {
        if (!files.has(path)) throw new Error('ENOENT');
        return files.get(path);
      },
      rmSync: (path, options) => {
        removed.push(path);
        for (const key of files.keys()) if (key === path || (options.recursive && key.startsWith(`${path}/`))) files.delete(key);
      },
    };
    let config;
    let reporter;
    const spawn = vi.fn(() => {
      config = files.get('/fixture/vitest.hung-session-tag.config.mts');
      reporter = files.get('/temp/run/runtime-reporter.mjs');
      if (mode === 'throw') throw new Error('spawn exploded');
      if (mode !== 'missing') files.set('/temp/run/report.json', mode === 'malformed' ? '{' : JSON.stringify(evidence().report));
      files.set('/temp/run/runtime.json', JSON.stringify({ runtimeErrors: 0 }));
      return { status: 0, signal: null };
    });
    const runner = makeRealRunVitest({ root: ROOT, filesystem, spawn, tempRoot: '/temp', unique: () => 'tag' });
    let result, error;
    try { result = runner(source); } catch (caught) { error = caught; }
    return { files, removed, spawn, config, reporter, result, error };
  }

  it.each([null, 'mutated source'])('wraps subprocess and aliases only a mutant (%s)', (source) => {
    const h = harness('ok', source);
    expect(h.error).toBeUndefined();
    const [command, args, options] = h.spawn.mock.calls[0];
    expect(command).toBe(process.execPath);
    expect(args[0]).toMatch(/scripts\/readiness\/heavy-admission\.mjs$/);
    expect(args.slice(1, 4)).toEqual(['run', '--', '/fixture/node_modules/.bin/vitest']);
    expect(args).toContain(TEST_FILE);
    expect(options.cwd).toBe(ROOT);
    expect(options).not.toHaveProperty('env'); // inherit the held admission slot
    expect(h.config.includes('hung-session.mutant-tag.mjs')).toBe(source !== null);
    expect(h.reporter).toContain('runtimeErrors: errors.length');
    expect(h.result.runtimeErrors).toBe(0);
    expect(h.files.size).toBe(0);
    expect(h.removed).toHaveLength(3);
  });

  it.each(['malformed', 'missing', 'throw'])('cleans every artifact on %s report/runner failure', (mode) => {
    const h = harness(mode, 'mutated source');
    expect(h.error).toBeInstanceOf(Error);
    expect(h.files.size).toBe(0);
    expect(h.removed).toEqual(['/fixture/scripts/conveyor/hung-session.mutant-tag.mjs', '/fixture/vitest.hung-session-tag.config.mts', '/temp/run']);
  });
});
