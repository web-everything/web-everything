/**
 * @file scripts/lib/__tests__/static-selection-edges.test.mjs
 * @description Tier-1 proof of the SHADOW-ONLY static selection edges (AO S1, #7121 rescope). The new module only
 *   informs a `shadow` field; it never changes `mode`, `tests` or `complete`, and related-test-selection.mjs stays
 *   byte-identical to main (negative tests per merge-path-checklist lines 2 and 7).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { stripComments, staticEdgesOf, shadowSelection, MAX_INPUT_BYTES, readShadowFile } from '../static-selection-edges.mjs';
import { resolvedImportsOf, isGraphSourceFile, testDepths } from '../related-test-selection.mjs';
import { selectTests, SELECTION_FLAG, validateVitestReport, isLocalFullSuiteTrigger, isSensitivePath } from '../../readiness/test-selection.mjs';

const FILES = new Set(['scripts/lib/x.mjs', 'scripts/lib/a.mjs', 'scripts/lib/b.mjs', 'scripts/cli/run.mjs']);

describe('static-selection-edges: edges', () => {
  it('finds an import edge behind a multi-line comment between from and the specifier', () => {
    const text = 'import {x} from /* multi\nline */ "./x.mjs";';
    expect(staticEdgesOf('scripts/lib/a.mjs', text, FILES).edges).toEqual(['scripts/lib/x.mjs']);
  });
  it('ignores an import that only appears inside a comment', () => {
    const text = '// import "./x.mjs"\n/* import "./b.mjs" */\n';
    expect(staticEdgesOf('scripts/lib/a.mjs', text, FILES).edges).toEqual([]);
  });
  it('does not treat comment markers inside strings/templates as comments', () => {
    expect(stripComments('const u = "http://x"; import "./x.mjs";')).toContain('import "./x.mjs"');
    expect(stripComments('const t = `/* ${1} */`; // gone\nok')).toContain('/* ${1} */');
    expect(stripComments('a // gone\nb')).not.toContain('gone');
  });
  it('adds spawn and read edges to repo files named by string literals', () => {
    const text = "execFileSync('node', ['scripts/cli/run.mjs']); readFileSync('scripts/lib/b.mjs');";
    const { edges } = staticEdgesOf('scripts/lib/a.mjs', text, FILES);
    expect(edges).toContain('scripts/cli/run.mjs');
    expect(edges).toContain('scripts/lib/b.mjs');
  });
  it('adds alias edges from a supplied alias map', () => {
    const text = 'import y from "@lib/x.mjs";';
    const r = staticEdgesOf('scripts/cli/run.mjs', text, FILES, { aliases: { '@lib/': 'scripts/lib/' } });
    expect(r.edges).toEqual(['scripts/lib/x.mjs']);
  });
});

describe('static-selection-edges: bounds', () => {
  it('readShadowFile rejects an oversized stat before reading source bytes', async () => {
    const { vi } = await import('vitest');
    const readSource = vi.fn(() => 'source bytes');
    const stat = { isSymbolicLink: () => false, isFile: () => true, size: MAX_INPUT_BYTES + 1 };
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual('node:fs');
      const fixture = { lstatSync: vi.fn(() => stat), readFileSync: readSource };
      return { ...actual, ...fixture, default: { ...actual.default, ...fixture } };
    });
    vi.resetModules();
    try {
      const { readShadowFile: readBounded } = await import('../static-selection-edges.mjs');
      const root = resolve('fixture-root');
      expect(() => readBounded(root, 'oversized.mjs')).toThrow('unreadable or over cap');
      expect(readSource).not.toHaveBeenCalled();
      // Prove the reader is wired, and that the admission boundary is inclusive.
      stat.size = MAX_INPUT_BYTES;
      expect(readBounded(root, 'at-cap.mjs')).toBe('source bytes');
      expect(readSource).toHaveBeenCalledTimes(1);
      expect(readSource).toHaveBeenCalledWith(resolve(root, 'at-cap.mjs'), 'utf8');
    } finally {
      vi.doUnmock('node:fs');
      vi.resetModules();
    }
  });
  it('scans a 1 MB adversarial input in under 200 ms (linear) and marks it partial (over the cap)', () => {
    const evil = 'import ' + ' '.repeat(1024 * 1024) + 'from';
    const t = Date.now();
    const r = staticEdgesOf('scripts/lib/a.mjs', evil, FILES);
    expect(Date.now() - t).toBeLessThan(200);
    expect(r.partial).toBe(true);
  });
  it('a 400 KB adversarial input under the cap is also linear', () => {
    const evil = '/*'.repeat(100000) + "'".repeat(100000) + 'from '.repeat(20000);
    const t = Date.now();
    const r = staticEdgesOf('scripts/lib/a.mjs', evil, FILES);
    expect(Date.now() - t).toBeLessThan(200);
    expect(r.partial).toBe(false);
  });
  it('cap is 512 KB', () => expect(MAX_INPUT_BYTES).toBe(512 * 1024));
  it('an unreadable file marks the shadow partial', () => {
    const r = shadowSelection({
      changedFiles: ['scripts/lib/x.mjs'],
      files: ['scripts/lib/x.mjs', 'scripts/lib/a.mjs'],
      readFile: () => { throw new Error('ENOENT'); },
    });
    expect(r.partial).toBe(true);
  });
  it('shadowSelection selects tests through static edges', () => {
    const contents = { 'scripts/lib/__tests__/a.test.mjs': 'import /* c\n */ "../x.mjs"', 'scripts/lib/x.mjs': '' };
    const r = shadowSelection({
      changedFiles: ['scripts/lib/x.mjs'],
      files: Object.keys(contents),
      readFile: (f) => contents[f],
    });
    expect(r.tests).toEqual(['scripts/lib/__tests__/a.test.mjs']);
    expect(r.partial).toBe(false);
  });
});

describe('shadow never changes the decision (checklist 7)', () => {
  const runGit = (args) => (args[0] === 'merge-base' ? 'abc\n' : 'scripts/lib/x.mjs\ndocs/a.md\n');
  for (const flag of ['1', '0']) {
    it(`selectTests mode/tests/complete identical with shadow on and off (flag=${flag})`, () => {
      const env = { [SELECTION_FLAG]: flag };
      const off = selectTests({ runGit, env });
      const on = selectTests({ runGit, env, shadow: () => ({ tests: ['t.test.mjs'], partial: false }) });
      expect(on.shadow).toEqual({ tests: ['t.test.mjs'], partial: false });
      const { shadow, ...rest } = on;
      expect(rest).toEqual(off);
      expect('shadow' in off).toBe(false);
    });
  }
  it('a throwing shadow is swallowed into a partial shadow and changes nothing', () => {
    const off = selectTests({ runGit, env: {} });
    const on = selectTests({ runGit, env: {}, shadow: () => { throw new Error('boom'); } });
    expect(on.shadow).toEqual({ mode: 'full', tests: [], partial: true, reasons: ['shadow threw'] });
    const { shadow, ...rest } = on;
    expect(rest).toEqual(off);
  });
});

describe('related-test-selection stays byte-identical to main (checklist 2)', () => {
  it('file bytes equal origin/main', () => {
    // sha256 of the file on main at the time this change was written (pinned: no live git access in tests).
    const here = readFileSync('scripts/lib/related-test-selection.mjs', 'utf8');
    expect(createHash('sha256').update(here).digest('hex')).toBe('2ffa9cc250e7a89624dfa0152e41d73d8d38ccce3c96070012cf1aa194c2c0f3');
  });
  it('resolvedImportsOf snapshot: unchanged behaviour on main regex', () => {
    const files = new Set(['a/x.mjs', 'a/y.mjs', 'a/z.mjs']);
    const text = 'import a from "./x.mjs"; const m = await import("./y.mjs"); import "./z.mjs"; import {q} from /* c\n */ "./x.mjs"';
    expect(resolvedImportsOf('a/t.test.mjs', text, files).sort()).toEqual(['a/x.mjs', 'a/y.mjs', 'a/z.mjs']);
    // main's regex does not see the commented gap form:
    expect(resolvedImportsOf('a/t.test.mjs', 'import {q} from /* c\n */ "./x.mjs"', files)).toEqual([]);
  });
});

describe('audit regressions: regex literals and aliases', () => {
  it('preserves regex comment markers, classes and escapes in every expression-start context', () => {
    const prefixes = ['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', ';', 'return ', '\n'];
    const literals = ['/[//]/', '/[/*]/', String.raw`/[\]/]/`, String.raw`/a\/b/`];
    for (const prefix of prefixes) {
      for (const literal of literals) {
        const source = `${prefix}${literal}; /* gone */ import "./x.mjs"; // gone`;
        expect(stripComments(source)).toContain(literal);
        expect(stripComments(source)).not.toContain('gone');
        expect(staticEdgesOf('scripts/lib/a.mjs', source, FILES)).toEqual({ edges: ['scripts/lib/x.mjs'], unknown: false, partial: false });
      }
    }
  });

  it('marks uncertain slash contexts unknown without making the graph partial', () => {
    for (const source of ['if (ok) /[/*]/;', 'const r = /[abc\nimport "./x.mjs";', 'return /abc\\\nimport "./x.mjs";']) {
      expect(staticEdgesOf('scripts/lib/a.mjs', source, FILES).unknown).toBe(true);
      expect(shadowSelection({ changedFiles: [], files: ['scripts/lib/a.mjs'], readFile: () => source }).partial).toBe(false);
    }
  });

  it('scans repeated regex classes and malformed single-line literals linearly under the cap', () => {
    const source = ('/[/*]/; // gone\n/[unterminated\n').repeat(10000) + 'import "./x.mjs";';
    const started = Date.now();
    expect(staticEdgesOf('scripts/lib/a.mjs', source, FILES)).toEqual({ edges: ['scripts/lib/x.mjs'], unknown: true, partial: false });
    expect(Date.now() - started).toBeLessThan(200);
  });

  it('passes aliases through shadowSelection to reach importing tests', () => {
    const contents = { 'scripts/lib/__tests__/alias.test.mjs': 'import "@lib/x.mjs";', 'scripts/lib/x.mjs': '' };
    const options = { changedFiles: ['scripts/lib/x.mjs'], files: Object.keys(contents), readFile: (file) => contents[file] };
    expect(shadowSelection(options)).toMatchObject({ tests: [], partial: false });
    expect(shadowSelection({ ...options, aliases: { '@lib/': 'scripts/lib/' } })).toMatchObject({ tests: ['scripts/lib/__tests__/alias.test.mjs'], partial: false });
  });
});

describe('validateVitestReport — fail closed on incomplete evidence', () => {
  it.each([
    ['missing report', undefined],
    ['null report', null],
    ['non-object report', 'text'],
    ['array report', []],
    ['missing testResults', {}],
    ['non-array testResults', { testResults: {} }],
    ['empty testResults', { testResults: [] }],
    ['entry without name and status', { testResults: [{}] }],
    ['null entry', { testResults: [null] }],
    ['malformed entry after a good entry', { testResults: [{ name: 'a.test.mjs', status: 'passed' }, {}] }],
    ['non-string name', { testResults: [{ name: 1, status: 'passed' }] }],
    ['missing status', { testResults: [{ name: 'a.test.mjs' }] }],
    ['non-string status', { testResults: [{ name: 'a.test.mjs', status: false }] }],
    ['report runtime error', { testResults: [{ name: 'a.test.mjs', status: 'passed' }], numRuntimeErrorTestSuites: 1 }],
    ['entry runtime error', { testResults: [{ name: 'a.test.mjs', status: 'passed', runtimeError: { message: 'crash' } }] }],
    ['entry runtime error count', { testResults: [{ name: 'a.test.mjs', status: 'passed', numRuntimeErrorTestSuites: 1 }] }],
    ['suite execution error', { testResults: [{ name: 'a.test.mjs', status: 'failed', testExecError: { message: 'crash' } }] }],
    ['unhandled report error', { testResults: [{ name: 'a.test.mjs', status: 'passed' }], unhandledErrors: [{ message: 'crash' }] }],
  ])('rejects %s with a reason', (_label, report) => {
    expect(validateVitestReport(report)).toEqual({ ok: false, reason: expect.any(String) });
    expect(validateVitestReport(report).reason.length).toBeGreaterThan(0);
  });

  it.each(['passed', 'failed'])('accepts a named %s entry without assertionResults', (status) => {
    expect(validateVitestReport({ testResults: [{ name: 'a.test.mjs', status }], numRuntimeErrorTestSuites: 0 }))
      .toEqual({ ok: true, reason: null });
  });

  // PR #7212 ruling: malformed suite names and statuses must not pass as valid false-green evidence.
  const one = (entry, extra = {}) => ({ testResults: [{ name: 'a.test.mjs', status: 'passed', ...entry }], ...extra });
  it.each([
    ['empty name', one({ name: '' })],
    ['whitespace-only name', one({ name: '   ' })],
    ['name with surrounding whitespace', one({ name: ' a.test.mjs ' })],
    ['name with newline', one({ name: 'a.test.mjs\nb.test.mjs' })],
    ['name with carriage return', one({ name: 'a.test.mjs\r' })],
    ['name with U+2028', one({ name: `a.test.mjs${String.fromCharCode(0x2028)}` })],
    ['name with NUL', one({ name: 'a\0.test.mjs' })],
    ['name that normalizes to empty', one({ name: './' })],
    ['name with a .. segment', one({ name: 'scripts/../../etc/a.test.mjs' })],
    ['name with a backslash .. segment', one({ name: 'scripts\\..\\..\\a.test.mjs' })],
    ['duplicate suite names', { testResults: [{ name: 'a.test.mjs', status: 'passed' }, { name: './a.test.mjs', status: 'failed' }] }],
    ['empty status', one({ status: '' })],
    ['unknown status', one({ status: 'bogus' })],
    ['status with wrong case', one({ status: 'Failed' })],
    ['status with whitespace', one({ status: 'failed ' })],
    ['assertion-level status at suite level', one({ status: 'skipped' })],
    ['non-array assertionResults', one({ assertionResults: {} })],
    ['null assertion entry', one({ assertionResults: [null] })],
    ['assertion without status', one({ assertionResults: [{}] })],
    ['assertion with unknown status', one({ assertionResults: [{ status: 'bogus' }] })],
    ['passed suite with a failed assertion', one({ status: 'passed', assertionResults: [{ status: 'failed' }] })],
    ['non-array unhandledErrors', one({}, { unhandledErrors: { message: 'crash' } })],
    ['non-numeric runtime-error count', one({}, { numRuntimeErrorTestSuites: 'x' })],
    ['negative runtime-error count', one({}, { numRuntimeErrorTestSuites: -1 })],
    // Self-review round: invisible characters, foreign checkouts, path-shape normalization, incomplete runs.
    ['name with a zero-width space', one({ name: `a${String.fromCharCode(0x200b)}.test.mjs` })],
    ['name with a BOM', one({ name: `${String.fromCharCode(0xfeff)}a.test.mjs` })],
    ['name with a bidi override', one({ name: `a${String.fromCharCode(0x202e)}.test.mjs` })],
    ['name that is not NFKC-normalized', one({ name: `${String.fromCharCode(0xff41)}.test.mjs` })],
    ['absolute name from another checkout', one({ name: '/elsewhere/lane-9/a.test.mjs' })],
    ['windows absolute name', one({ name: 'C:\\elsewhere\\a.test.mjs' })],
    ['name with a doubled slash', one({ name: 'scripts//a.test.mjs' })],
    ['name with a ./ segment', one({ name: 'scripts/./a.test.mjs' })],
    ['name with a trailing slash', one({ name: 'scripts/a.test.mjs/' })],
    ['duplicate suite names differing only in case', { testResults: [{ name: 'A.test.mjs', status: 'passed' }, { name: 'a.test.mjs', status: 'failed' }] }],
    ['never-run (pending) assertion', one({ assertionResults: [{ status: 'passed' }, { status: 'pending' }] })],
    ['non-string assertion status', one({ assertionResults: [{ status: 1 }] })],
    ['pending tests counter', one({}, { numPendingTests: 2 })],
    ['non-integer counter', one({}, { numTotalTests: 1.5 })],
    ['string counter', one({}, { numFailedTests: '0' })],
    ['non-boolean success', one({}, { success: 'true' })],
    ['success with a failed suite', one({ status: 'failed' }, { success: true })],
    ['failure with no failed suite', one({}, { success: false })],
    ['numTotalTests disagreeing with assertions', one({ assertionResults: [{ status: 'passed' }] }, { numTotalTests: 3 })],
    ['numFailedTests disagreeing with assertions', one({ status: 'failed', assertionResults: [{ status: 'failed' }] }, { numFailedTests: 0 })],
  ])('rejects %s with a reason', (_label, report) => {
    const result = validateVitestReport(report);
    expect(result.ok).toBe(false);
    expect(typeof result.reason).toBe('string');
    expect(result.reason.length).toBeGreaterThan(0);
  });

  it('accepts well-formed assertions on a failed suite', () => {
    expect(validateVitestReport(one({ status: 'failed', assertionResults: [{ status: 'passed' }, { status: 'failed' }, { status: 'skipped' }] })))
      .toEqual({ ok: true, reason: null });
  });

  it('accepts a report shaped like the vitest json reporter, with absolute names under this checkout', async () => {
    const { resolve } = await import('node:path');
    const root = resolve('.');
    expect(validateVitestReport({
      numTotalTestSuites: 4, numFailedTestSuites: 1, numPendingTestSuites: 0,
      numTotalTests: 4, numPassedTests: 3, numFailedTests: 1, numPendingTests: 0, numTodoTests: 1,
      success: false,
      testResults: [
        { name: `${root}/scripts/a.test.mjs`, status: 'failed', assertionResults: [{ status: 'passed' }, { status: 'failed' }] },
        { name: `${root}/scripts/b.test.mjs`, status: 'passed', assertionResults: [{ status: 'skipped' }, { status: 'todo' }] },
      ],
    })).toEqual({ ok: true, reason: null });
  });

  it('rejects an empty selected report by default but accepts it when allowEmpty is set', () => {
    expect(validateVitestReport({ testResults: [] }).ok).toBe(false);
    expect(validateVitestReport({ testResults: [] }, { allowEmpty: true })).toEqual({ ok: true, reason: null });
    expect(validateVitestReport({ testResults: [{ name: '', status: 'passed' }] }, { allowEmpty: true }).ok).toBe(false);
  });
});

describe('audit regression: measure CLI report evidence', () => {
  it.each([['0', 'normal'], ['1', 'normal'], ['1', 'listing-failed'], ['1', 'package']])('fails closed and preserves mode/tests with selection flag=%s, shadow=%s', async (flag, scenario) => {
    const { vi } = await import('vitest');
    const { resolve } = await import('node:path');
    const cliPath = resolve('scripts/readiness/test-selection.mjs');
    const argv = process.argv;
    let output;
    let recorded;
    let reportText;
    let selectedText;
    const historical = [{ falseGreen: true }, { falseGreen: false }, { falseGreen: null, status: 'report-invalid' }];
    let persisted = [...historical];
    vi.stubEnv('WE_STATIC_EDGES_SHADOW', '1');
    vi.stubEnv(SELECTION_FLAG, flag);
    vi.doMock('node:child_process', async () => {
      const actual = await vi.importActual('node:child_process');
      const execFileSync = (file, args) => {
        if (file !== 'git') throw new Error('unexpected child process');
        if (args[0] === 'rev-parse') return 'a'.repeat(40) + '\n';
        if (args[0] === 'merge-base') return 'abc\n';
        if (args[0] === 'diff') return scenario === 'package' ? 'package.json\n' : 'docs/a.md\n';
        if (args[0] === 'ls-files') {
          if (scenario === 'listing-failed') throw Error('ls-files failed');
          return 'scripts/lib/x.mjs\0docs/a.md\0';
        }
        throw new Error(`unexpected git command: ${args[0]}`);
      };
      return { ...actual, execFileSync, default: { ...actual.default, execFileSync } };
    });
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual('node:fs');
      const fixture = {
      lstatSync: (path, ...rest) => String(path).endsWith('/scripts/lib/x.mjs')
        ? { isSymbolicLink: () => false, isFile: () => true, size: 0 } : actual.lstatSync(path, ...rest),
      readFileSync: (path, ...rest) => {
        if (String(path) === 'audit-report.json') {
          if (reportText === undefined) throw new Error('ENOENT');
          return reportText;
        }
        if (String(path) === 'selected.json') return selectedText;
        if (String(path).endsWith('/false-green-log.json')) return JSON.stringify(persisted);
        if (String(path).endsWith('/scripts/lib/x.mjs')) return '';
        return actual.readFileSync(path, ...rest);
      },
      mkdirSync: () => {},
      writeFileSync: (_path, text) => { persisted = JSON.parse(text); recorded = persisted.at(-1); },
      renameSync: () => {},
      };
      return { ...actual, ...fixture, default: { ...actual.default, ...fixture } };
    });
    vi.doMock('../../readiness/heavy-admission.mjs', () => ({ admittedArgv: () => { throw new Error('unexpected related run'); } }));
    vi.doMock('../write-all-sync.mjs', () => ({ writeAllSync: (_fd, text) => { output = JSON.parse(text); } }));
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {});
    try {
      let baseline;
      const reports = [
        [undefined, false], [null, false], ['{invalid', false], ['{}', false], ['[]', false], ['"text"', false],
        ['{"testResults":{}}', false], ['{"testResults":[]}', false], ['{"testResults":[{}]}', false],
        ['{"testResults":[{"name":"a.test.mjs","status":"passed"}],"numRuntimeErrorTestSuites":1}', false],
        ['{"testResults":[{"name":"escaped.test.mjs","status":"failed"}]}', true],
        ['{"testResults":[{"name":"a.test.mjs","status":"passed"}]}', true],
        // PR #7212 ruling: malformed suite names and statuses are invalid evidence end to end.
        ['{"testResults":[{"name":"","status":"failed"}]}', false],
        ['{"testResults":[{"name":"escaped.test.mjs\\n","status":"failed"}]}', false],
        ['{"testResults":[{"name":"escaped.test.mjs","status":"bogus"}]}', false],
        ['{"testResults":[{"name":"escaped.test.mjs","status":"passed","assertionResults":[{"status":"failed"}]}]}', false],
        // A supplied --selected-json is evidence too (read only on a shrink decision, i.e. flag=1).
        ['{"testResults":[{"name":"escaped.test.mjs","status":"failed"}]}', flag !== '1' || scenario === 'package', '{"testResults":[{"name":"","status":"passed"}]}'],
        ['{"testResults":[{"name":"escaped.test.mjs","status":"failed"}]}', flag !== '1' || scenario === 'package', '{"testResults":[{"name":"escaped.test.mjs","status":"bogus"}]}'],
        ['{"testResults":[{"name":"escaped.test.mjs","status":"failed"}]}', flag !== '1' || scenario === 'package', '{"testResults":{}}'],
        ['{"testResults":[{"name":"escaped.test.mjs","status":"failed"}]}', true, '{"testResults":[{"name":"escaped.test.mjs","status":"passed"}]}'],
        ['{"testResults":[{"name":"escaped.test.mjs","status":"failed"}]}', true, '{"testResults":[]}'],
      ];
      for (const [report, valid, selected] of reports) {
        reportText = report ?? undefined;
        selectedText = selected;
        vi.resetModules();
        process.argv = [argv[0], cliPath, '--measure', '--no-related',
          ...(report === undefined ? [] : ['--vitest-json=audit-report.json']),
          ...(selected === undefined ? [] : ['--selected-json=selected.json'])];
        await import('../../readiness/test-selection.mjs');
        expect(exit).toHaveBeenLastCalledWith(valid ? 0 : 1);
        expect(output.recorded).toEqual(recorded);
        expect(recorded.hadReport).toBe(valid);
        expect(recorded.head).toMatch(/^[a-f0-9]{40}$/);
        expect(recorded.base).toBe('origin/main');
        expect(recorded.shadow.mode).toBe(scenario === 'normal' ? 'related' : 'full');
        expect(recorded.shadow.testCount).toBe(0);
        expect(recorded.shadow.totalTests).toBe(scenario === 'listing-failed' ? null : 0);
        expect(recorded.shadow.unknownCount).toBe(scenario === 'listing-failed' ? null : 0);
        if (scenario === 'listing-failed') expect(recorded.shadow.reasons).toEqual(['shadow threw']);
        const escapes = scenario !== 'package' && flag === '1' && (report ?? '').includes('escaped.test.mjs') && !(selected ?? '').includes('escaped.test.mjs');
        if (!valid) {
          expect(recorded).toMatchObject({ falseGreen: null, status: 'report-invalid', failedCount: null, escaped: null });
          expect(output.falseGreen).toMatchObject({ falseGreen: null, failedCount: null, escaped: null });
          if (selected !== undefined) expect(recorded.reason).toMatch(/^selected-json: /);
        } else {
          expect(recorded.falseGreen).toBe(escapes);
          expect(recorded.failedCount).toBe(report.includes('escaped.test.mjs') ? 1 : 0);
          expect(recorded.escaped).toEqual(escapes ? ['escaped.test.mjs'] : []);
          expect(recorded.status).toBeUndefined();
        }
        expect(output.shadow.partial).toBe(!valid || scenario === 'listing-failed');
        expect(output.decision.shadow).toEqual(output.shadow);
        expect(output.shadowEscaped).toEqual(valid ? (scenario === 'normal' && report.includes('escaped.test.mjs') ? ['escaped.test.mjs'] : []) : null);
        expect(recorded.shadowEscaped).toEqual(output.shadowEscaped);
        expect(output.shadowEscapedStatic).toEqual(valid && scenario !== 'listing-failed' ? (report.includes('escaped.test.mjs') ? ['escaped.test.mjs'] : []) : null);
        expect(recorded.shadowEscapedStatic).toEqual(output.shadowEscapedStatic);
        expect(recorded.shadow.staticTestCount).toBe(scenario === 'listing-failed' ? null : 0);
        expect(recorded.shadow.staticTests).toEqual(scenario === 'listing-failed' ? undefined : []);
        const { shadow, ...decision } = output.decision;
        baseline ??= decision;
        expect(decision).toEqual(baseline);
      }
      // The recorder retains unknown measurements alongside historical boolean samples.
      expect(persisted).toHaveLength(historical.length + reports.length);
      expect(persisted.slice(0, historical.length)).toEqual(historical);
      expect(persisted.slice(historical.length).map((row) => row.falseGreen)).toEqual(
        reports.map(([report, valid, selected]) => valid
          ? scenario !== 'package' && flag === '1' && report.includes('escaped.test.mjs') && !(selected ?? '').includes('escaped.test.mjs')
          : null),
      );
      expect(exit).toHaveBeenCalledTimes(reports.length);
    } finally {
      process.argv = argv;
      exit.mockRestore();
      vi.unstubAllEnvs();
      for (const name of ['node:child_process', 'node:fs', '../../readiness/heavy-admission.mjs', '../write-all-sync.mjs']) vi.doUnmock(name);
      vi.resetModules();
    }
  });
});


describe('static-selection-edges: shadow accuracy', () => {
  const test = 'tests/hoisted.test.mjs';
  const run = (contents, changedFiles = ['scripts/x.mjs'], extra = {}) => shadowSelection({
    changedFiles, files: Object.keys(contents), readFile: (f) => contents[f],
    ...extra,
  });
  it('selects a test that spawns a script through a hoisted path constant', () => {
    expect(run({ [test]: "const CLI = join(ROOT, 'scripts/x.mjs'); execFileSync('node', [CLI]);", 'scripts/x.mjs': '' }).tests).toEqual([test]);
  });
  it('new URL(relative, import.meta.url) passed to spawnSync is an edge', () => {
    expect(run({ [test]: "const CLI = new URL('../scripts/x.mjs', import.meta.url); spawnSync('node', [CLI]);", 'scripts/x.mjs': '' }).tests).toEqual([test]);
  });
  it('resolves a bare relative URL literal against its containing module', () => {
    expect(staticEdgesOf('scripts/lib/a.mjs', "new URL('x.mjs', import.meta.url)", FILES).edges).toEqual(['scripts/lib/x.mjs']);
  });
  it.each(['execFile', 'fork', 'resolve', 'join'])('finds tracked literals in %s calls', (call) => {
    expect(run({ [test]: `${call}('scripts/x.mjs')`, 'scripts/x.mjs': '' }).tests).toEqual([test]);
  });
  it('a division-only file elsewhere in the repo does not mark an unrelated selection partial', () => {
    const r = run({ [test]: '', 'scripts/x.mjs': '', 'other.mjs': 'value / divisor; 12 / 3; arr[0] / 2; value\n / divisor;' });
    expect(r).toMatchObject({ partial: false, unknownFiles: [], tests: [] });
  });
  it.each(['if (ok) /[/*]/;', 'import(target)', 'require(target)', 'vi.mock(target)', 'import(`./${target}`)'])('an ambiguous or computed-import test is always selected (unknown widens): %s', (source) => {
    expect(run({ [test]: source, 'scripts/x.mjs': '' })).toMatchObject({ tests: [test], partial: false, unknownFiles: [test] });
  });
  it('unknown source adds every test reaching it', () => {
    expect(run({ [test]: 'import "../helper.mjs"', 'helper.mjs': 'require(target)', 'scripts/x.mjs': '', 'other.test.mjs': '' }).tests).toEqual([test]);
  });
  it.each(['package.json', 'package-lock.json', 'vitest.config.ts', 'docs/agent/testing.md', 'new.mjs'])('package.json, a lockfile, vitest config or an untracked non-test change gives shadow mode full: %s', (file) => {
    expect(run({ [test]: '', 'scripts/x.mjs': '' }, [file], { isFullSuiteTrigger: (f) => isLocalFullSuiteTrigger(f) || isSensitivePath(f) })).toMatchObject({ mode: 'full', tests: [test], reasons: [expect.any(String), ...(isGraphSourceFile(file) ? [`unknown file: ${file}`] : [])] });
  });
  it('a deleted changed module marks the shadow partial and still reaches importers', () => {
    expect(run({ [test]: 'import "../scripts/x.mjs"' })).toMatchObject({ tests: [test], partial: true });
  });
  it('unchanged over-cap tests are unknown and widen without partial evidence', () => {
    expect(run({ [test]: 'x'.repeat(MAX_INPUT_BYTES + 1), 'scripts/x.mjs': '' })).toMatchObject({ tests: [test], staticTests: [test], partial: false, unknownFiles: [test], reasons: [`unknown file: ${test}`] });
    expect(run({ [test]: '', 'scripts/x.mjs': '' }, undefined, { readFile: () => { throw Error('unreadable'); } })).toMatchObject({ tests: [test], partial: true });
  });
  it('changed over-cap sources are partial and retain every importer', () => {
    expect(run({ [test]: 'import "../scripts/x.mjs"', 'scripts/x.mjs': 'x'.repeat(MAX_INPUT_BYTES + 1) })).toMatchObject({
      partial: true, unknownFiles: ['scripts/x.mjs'], staticTests: [test], reasons: ['unknown file: scripts/x.mjs'],
    });
  });
  it.each(['over-cap', 'unreadable'])('unchanged %s sources widen to importers without marking partial', (kind) => {
    const contents = { [test]: 'import "../helper.mjs"', 'helper.mjs': 'x'.repeat(MAX_INPUT_BYTES + 1), 'scripts/x.mjs': '', 'other.test.mjs': '' };
    expect(run(contents, undefined, { readFile: (file) => {
      if (file === 'helper.mjs' && kind === 'unreadable') throw Error('unreadable');
      return contents[file];
    } })).toMatchObject({ partial: false, staticTests: [test], unknownFiles: ['helper.mjs'], reasons: ['unknown file: helper.mjs'] });
  });
  it('full escalation preserves sorted pure static reach including unknown widening', () => {
    const contents = { 'z.test.mjs': 'import "./scripts/x.mjs"', 'scripts/x.mjs': '', 'a.test.mjs': 'import(target)', 'other.test.mjs': '' };
    expect(run(contents, undefined, { isFullSuiteTrigger: isSensitivePath })).toMatchObject({
      mode: 'full', tests: ['a.test.mjs', 'other.test.mjs', 'z.test.mjs'], staticTests: ['a.test.mjs', 'z.test.mjs'],
      reasons: ['full-suite trigger: scripts/x.mjs', 'unknown file: a.test.mjs'],
    });
    expect(run(contents, undefined, { maxTests: 1 })).toMatchObject({ mode: 'full', staticTests: ['a.test.mjs', 'z.test.mjs'] });
  });
  it('symlink and outside-ROOT paths are unknown, not read', () => {
    const root = mkdtempSync(join(tmpdir(), 'ao-s1b-'));
    try {
      writeFileSync(join(root, 'target.mjs'), 'import "./x.mjs"');
      symlinkSync(join(root, 'target.mjs'), join(root, 'link.test.mjs'));
      expect(() => readShadowFile(root, 'link.test.mjs')).toThrow();
      expect(() => readShadowFile(root, '../outside.mjs')).toThrow();
      expect(shadowSelection({ files: ['link.test.mjs'], changedFiles: [], readFile: (f) => readShadowFile(root, f) })).toMatchObject({ tests: ['link.test.mjs'], unknownFiles: ['link.test.mjs'] });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it.each(['0', '1'])('shrink-path diff: mode/tests/complete identical with shadow on and off (flag=%s)', (flag) => {
    const options = { runGit: (args) => args[0] === 'merge-base' ? 'abc' : 'docs/a.md\n', env: { [SELECTION_FLAG]: flag } };
    const off = selectTests(options);
    const { shadow, ...on } = selectTests({ ...options, shadow: () => run({ [test]: '' }, ['docs/a.md']) });
    expect(on).toEqual(off);
    expect(off.mode).toBe(flag === '1' ? 'shrink' : 'full');
    expect(shadow).toBeDefined();
  });
});


describe('static-selection-edges: import-only superset', () => {
  it('contains main import-only reach for the last 30 merged main diffs on the checkout graph', () => {
    const diffs = [
      ["c18c5279b42bf127f0661c482a96f1d695f898c3", ["scripts/lib/__tests__/operator-override-enum.test.mjs", "scripts/lib/operator-enum-store.mjs", "scripts/lib/operator-override-reader.mjs", "scripts/lib/operator-override-store.mjs", "scripts/operations/__tests__/http-adapter.test.mjs", "scripts/operations/operator-override.mjs"]],
      ["b784af27ea3e824caa8ab3ae0286b265306a20a4", ["scripts/ci/test-timings.json"]],
      ["52ca65fd9f5fa4a9390e96d89815c81b84ed9c08", [".github/workflows/test-selection-measure.yml", "scripts/ci/__tests__/ci-light-checkout.test.mjs", "scripts/ci/__tests__/test-selection-measure-workflow.test.mjs"]],
      ["cd0e13d14c2f9e9d2c0812a7b5db6e9f5219017e", ["scripts/lib/daemon-heap-log.mjs"]],
      ["1aceeb9470f1a455ca01daf358ea366d0de62772", ["scripts/ci/test-timings.json"]],
      ["45e3fe5cd96a880ed05ff837abbd73a8ba3a52c5", ["scripts/__tests__/review-set-label.accept-keeps-sendback.test.mjs", "scripts/__tests__/review-set-label.test.mjs", "scripts/review-set-label.mjs"]],
      ["f8172ecb48fd13609ba33615b76777db44ca1e63", ["docs/agent/testing.md", "scripts/__tests__/fixtures/merge-ai-prs-cli-harness.mjs", "scripts/__tests__/merge-ai-prs-listing-dedupe.test.mjs", "scripts/__tests__/merge-ai-prs.test.mjs", "scripts/lib/__tests__/drain-gh-async.test.mjs", "scripts/lib/__tests__/gh-list-retry.test.mjs", "scripts/lib/__tests__/pr-list-paged.test.mjs", "scripts/lib/drain-gh-async.mjs", "scripts/lib/gh-list-retry.mjs", "scripts/lib/pr-list-paged.mjs", "scripts/merge-ai-prs.mjs"]],
      ["5f0ac19801fbd86aae33b6c3c9b3f85a3ca9be15", ["scripts/operations/__tests__/pr-sweep.test.mjs", "scripts/operations/pr-sweep-core.mjs"]],
      ["29061ad0c9a6676fcbbefa25c1feefb793290bd8", ["scripts/conveyor/__tests__/ci-heal-loop.test.mjs", "scripts/conveyor/ci-heal-loop.mjs", "scripts/lib/audit-settings.mjs"]],
      ["e0ae787e6686b1ead28d81c6c0ff9d900f82eed7", ["scripts/lib/direct-entry-guard.mjs", "scripts/operations/__tests__/ruling-cli-loud.test.mjs", "scripts/operations/extend-rounds.mjs", "scripts/operations/record-red-team-ruling.mjs"]],
      ["4e90997ff4832b54605a160392b76a8d7996c3b3", ["scripts/ci/test-timings.json", "scripts/conveyor/soak/breaks/redteam-label-settles-from-check.mjs", "scripts/conveyor/soak/breaks/redteam-label-settles-from-check.soak.test.mjs", "scripts/lib/__tests__/red-team-label-settle.test.mjs", "scripts/lib/drain-red-team-evidence.mjs", "scripts/lib/red-team-check-run.mjs", "scripts/lib/red-team-status-labels.mjs", "scripts/operations/red-team-gate-apply.mjs", "scripts/operations/review-job.mjs", "scripts/settings/privacy-terms-allowlist.json"]],
      ["d12688ce238e1ca4c303eb13ed22680d9587c11b", ["backlog/8613-ao-s1-shadow-accuracy.md", "docs/agent/testing.md", "scripts/lib/__tests__/static-selection-edges.test.mjs", "scripts/lib/static-selection-edges.mjs", "scripts/readiness/test-selection.mjs"]],
      ["9ca451cd9126e9d6a5306a4abccb887613f0bba0", ["scripts/ci/test-timings.json"]],
      ["a7a8c19d246f02b5d8dbc1620078eeedaa0c2128", ["docs/agent/testing.md", "scripts/__tests__/drain-workflow-edit-replay.test.mjs", "scripts/__tests__/fixtures/pinned-leaf-diff-fixture.mjs", "scripts/__tests__/fixtures/pinned-pr-diff-fixture.mjs", "scripts/__tests__/gate-entrypoint-integration.test.mjs", "scripts/__tests__/merge-ai-prs-merge-failure-isolation.test.mjs", "scripts/__tests__/merge-ai-prs-merge-queue-hook-wiring.test.mjs", "scripts/__tests__/merge-ai-prs-net-diff-computation.test.mjs", "scripts/__tests__/merge-ai-prs-red-main-hold-wiring.test.mjs", "scripts/__tests__/merge-ai-prs-stuck-unknown-mergeability.test.mjs", "scripts/__tests__/merge-ai-prs.test.mjs", "scripts/__tests__/merge-gate-check-pr-event-candidacy.test.mjs", "scripts/__tests__/pr-merge-gate.test.mjs", "scripts/lib/__tests__/drain-followup-wiring.test.mjs", "scripts/lib/__tests__/merge-gate-carried-approval.test.mjs", "scripts/lib/__tests__/merge-gate-ci.test.mjs", "scripts/lib/merge-gate-ci.mjs", "scripts/lib/pr-merge-gate.mjs", "scripts/merge-ai-prs.mjs", "scripts/operations/__tests__/land-human-only.test.mjs"]],
      ["92a87671bd7891ed9774bfa3e8d8ab0552adce13", ["scripts/ci/test-timings.json", "scripts/conveyor/soak/breaks/needs-you-feed-card-policy.mjs", "scripts/conveyor/soak/breaks/needs-you-feed-card-policy.soak.test.mjs", "scripts/operations/__tests__/needs-you-feed.test.mjs", "scripts/operations/needs-you-feed.mjs"]],
      ["8aa12ff99f31fa9cca3fa09b0ebf1c89a01cfabe", ["docs/agent/testing.md", "scripts/lib/__tests__/redteam-pending-settle.test.mjs", "scripts/lib/__tests__/review-run-index.test.mjs", "scripts/lib/review-red-team-on-skip.mjs"]],
      ["ccfae258f90d1d2e85ed41f63ce3a886a4122226", ["scripts/ci/test-timings.json", "scripts/conveyor/soak/breaks/transient-fetch-retries-before-needs-you.mjs", "scripts/conveyor/soak/breaks/transient-fetch-retries-before-needs-you.soak.test.mjs", "scripts/lib/__tests__/daemon-rebuild-overlay-main-sync.test.mjs", "scripts/lib/daemon-rebuild/overlay-main-sync.mjs"]],
      ["62bce5de8e85363886ddaf4fc92b1c11da97dd24", ["scripts/lib/daemon-heap-log.mjs"]],
      ["aa41c14403624aa5189e7fa5f8274b0fdb26a4e6", ["scripts/ci/test-timings.json", "scripts/operations/__tests__/record-red-team-ruling-judge-bot.test.mjs", "scripts/operations/record-red-team-ruling-io.mjs"]],
      ["a6ce3c7fc347bfb8a5e46b29329c2b54fe59bd68", ["backlog/8612-urgent-verify-signing-key-readable-by-checkout-subprocesses.md", "scripts/operations/__tests__/urgent-verify.test.mjs", "scripts/operations/run.mjs", "scripts/operations/urgent-verify-marker.mjs", "scripts/operations/urgent-verify.mjs", "scripts/readiness/heavy-admission.mjs"]],
      ["7543fd2eb8b74c84adea876609727b8c5cf2fdd7", ["docs/agent/testing.md", "scripts/operations/__tests__/cli-adapter.test.mjs", "scripts/operations/__tests__/effect-executor.test.mjs", "scripts/operations/__tests__/file-item-card-branch.test.mjs", "scripts/operations/__tests__/file-item-io.test.mjs", "scripts/operations/__tests__/file-item.test.mjs", "scripts/operations/cli-adapter.mjs", "scripts/operations/effect-executor.mjs", "scripts/operations/file-item-io.mjs", "scripts/operations/file-item.mjs", "skills-src/file-item/SKILL.md"]],
      ["dd8eabc1d7a48a1e64a679f0a18e6ed8290e4c8c", ["agent-memory-src/feedback-no-local-paths-committed.md", "backlog/6080-shrink-the-host-local-path-baseline-to-zero.md", "docs/agent/settings-registry.md", "scripts/check-standards.mjs", "scripts/ci/test-timings.json", "scripts/lib/__tests__/settings-files.test.mjs", "scripts/lib/__tests__/settings-registry.test.mjs", "scripts/lib/host-path-baseline.json", "scripts/lib/settings-registry-metadata.json", "scripts/lib/settings-registry.mjs", "scripts/lint-host-paths.mjs"]],
      ["892bd66dfe0f0ac49bce177007f6d53310e9c6ab", ["scripts/lib/__tests__/enqueue-on-event.test.mjs", "scripts/lib/enqueue-on-event.mjs"]],
      ["957ccac56889abf6ba2bdff4173978afc38d91ad", ["scripts/lib/gh-throttle.mjs", "skills-src/conveyor/__tests__/reconcile-fix-dispatch-daemon.test.mjs", "skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs"]],
      ["6a2c792e59f83ae2405ea871c1051eea383729bf", [".github/workflows/ci-self.yml", ".github/workflows/ci.yml", "docs/agent/testing.md", "scripts/ci/__tests__/ci-self-workflow.test.mjs"]],
      ["98e57b4c75e6202498fc613e547a5582240a5bae", ["docs/agent/testing.md", "scripts/ci/test-timings.json", "scripts/conveyor/__tests__/infra-blocked.test.mjs", "scripts/conveyor/infra-blocked.mjs", "scripts/conveyor/soak/breaks/build-daemon-retry-blocks-tick-on-slow-ci-wait.mjs", "scripts/conveyor/soak/breaks/runtime-admission-infra-retention.mjs", "scripts/conveyor/soak/breaks/runtime-admission-infra-retention.soak.test.mjs", "scripts/lib/__tests__/build-priority-runtime.test.mjs", "scripts/lib/__tests__/runtime-admission.test.mjs", "scripts/lib/build-queue.mjs", "scripts/lib/runtime-admission.mjs", "skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs", "skills-src/conveyor/build-dispatch-daemon.mjs"]],
      ["718507d7769194b0839a34e1c4159745c5d7a1dd", ["backlog/8597-lane-pool-2924-containment-probe-fails-inside-agent-shells-d.md", "backlog/8598-lane-pool-auto-pick-keeps-choosing-lanes-with-unpushed-work.md", "backlog/8599-operator-override-store-does-not-authenticate-the-writer.md", "backlog/8600-fail-open-guard-code-in-ci-heal-reserve-dispatch-throttle-re.md", "scripts/conveyor/tick-core.mjs", "scripts/lib/__tests__/capacity-leaf.test.mjs", "scripts/lib/__tests__/ci-heal-reserve.test.mjs", "scripts/lib/__tests__/operator-override-store.test.mjs", "scripts/lib/capacity-leaf.mjs", "scripts/lib/ci-heal-reserve.mjs", "scripts/lib/operator-override-reader.mjs", "scripts/lib/operator-override-store.mjs", "scripts/operations/ci-heal-pr-dispatch.mjs", "scripts/readiness/dispatch-plan.mjs"]],
      ["0d47fafa69922b3bc2fb00f0c30162c56d981088", ["scripts/lib/__tests__/operator-cli-fresh.test.mjs", "scripts/lib/drain-skip-reasons.mjs", "scripts/lib/main-staleness.mjs", "scripts/lib/merge-gate-inventory.mjs"]],
      ["9fc2a1ad5bfe43a29a8823ada7f8651f312154a0", ["scripts/operations/__tests__/canonical-audit-gate.test.mjs", "scripts/operations/canonical-audit-gate.mjs"]],
      ["3ccef93f4630a63d688bb1fa28854ded5e026dd9", ["scripts/ci/test-timings.json", "scripts/conveyor/soak/breaks/red-team-writer-no-app-token-orphan-hold.mjs", "scripts/conveyor/soak/breaks/red-team-writer-no-app-token-orphan-hold.soak.test.mjs", "scripts/lib/__tests__/drain-red-team-evidence.test.mjs", "scripts/lib/__tests__/merge-gate-ci.test.mjs", "scripts/lib/__tests__/red-team-check-run.test.mjs", "scripts/lib/drain-red-team-evidence.mjs", "scripts/lib/red-team-check-run.mjs", "scripts/operations/__tests__/review-job-rebase-carry.test.mjs"]],
    ];
    const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).split('\0').filter(Boolean);
    const fileSet = new Set(files);
    const contents = new Map();
    const reverse = new Map();
    for (const file of files.filter(isGraphSourceFile)) {
      let text;
      try { text = readShadowFile(process.cwd(), file); } catch { continue; }
      contents.set(file, text);
      for (const target of resolvedImportsOf(file, text, fileSet)) {
        if (!reverse.has(target)) reverse.set(target, new Set());
        reverse.get(target).add(file);
      }
    }
    for (const [head, changedFiles] of diffs) {
      const shadow = shadowSelection({ changedFiles, files,
        readFile: (file) => { if (!contents.has(file)) throw Error('unreadable'); return contents.get(file); },
        isFullSuiteTrigger: (f) => isLocalFullSuiteTrigger(f) || isSensitivePath(f),
      });
      const selected = new Set(shadow.staticTests);
      for (const test of testDepths(changedFiles, reverse).keys()) expect(selected.has(test), `${head}: ${test}`).toBe(true);
    }
  }, 120000);
});

describe('static-selection-edges: weakening mutations', () => {
  const test = 'tests/hoisted.test.mjs';
  it.each([
    ['drop literal-anywhere', (s) => s.replace('if (fileSet.has(literal)) add(literal);', 'if (false) add(literal);').replace("else add(resolveSpecifier(fromFile, literal, fileSet) || resolveSpecifier(fromFile, './' + literal, fileSet));", 'else {}'), "const CLI = join(ROOT, 'scripts/x.mjs'); execFileSync('node', [CLI]);", 'hoisted'],
    ['unknown widens nothing', (s) => s.replace('...changedFiles, ...unknownFiles', '...changedFiles').replace('...unknownFiles.filter(isVitestTestFile),', ''), 'import(target)', 'unknown'],
    ['remove full escalation', (s) => s.replace("mode: reasons.length ? 'full' : 'related'", "mode: 'related'").replace('tests: reasons.length ? allTests : [...selected].sort()', 'tests: [...selected].sort()'), '', 'package'],
    ['restore global ambiguity', (s) => s.replace('ambiguous ||= !division', 'ambiguous = true').replace('partial ||= result.partial && changed.has(file);', 'partial ||= result.partial || result.unknown;'), 'value / divisor;', 'division'],
  ])('kills mutation: %s', (_name, mutate, source, contract) => {
    const root = mkdtempSync(join(tmpdir(), 'ao-s1b-mutation-'));
    try {
      const original = readFileSync('scripts/lib/static-selection-edges.mjs', 'utf8');
      const modulePath = join(root, 'mutated.mjs');
      const dependency = pathToFileURL(resolve('scripts/lib/related-test-selection.mjs')).href;
      const mutated = mutate(original).replace("'./related-test-selection.mjs'", JSON.stringify(dependency));
      expect(mutated).not.toBe(original);
      writeFileSync(modulePath, mutated);
      const code = `import { shadowSelection } from ${JSON.stringify(pathToFileURL(modulePath).href)};
        import assert from 'node:assert/strict';
        const files = ${JSON.stringify({ [test]: source, 'scripts/x.mjs': '' })};
        const r = shadowSelection({ files: Object.keys(files), changedFiles: [${JSON.stringify(contract === 'package' ? 'package.json' : 'scripts/x.mjs')}], readFile: f => files[f], isFullSuiteTrigger: f => f === 'package.json' });
        if (${JSON.stringify(contract)} === 'division') assert.equal(r.partial, false);
        else if (${JSON.stringify(contract)} === 'package') assert.equal(r.mode, 'full');
        else assert.ok(r.tests.includes(${JSON.stringify(test)}));`;
      let failure;
      try { execFileSync(process.execPath, ['--input-type=module', '-e', code], { stdio: 'pipe', timeout: 5000, maxBuffer: 128 * 1024 }); }
      catch (error) { failure = error; }
      expect(failure?.status).toBe(1);
      expect(String(failure.stderr)).toContain('AssertionError');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
