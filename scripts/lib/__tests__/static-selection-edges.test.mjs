/**
 * @file scripts/lib/__tests__/static-selection-edges.test.mjs
 * @description Tier-1 proof of the SHADOW-ONLY static selection edges (AO S1, #7121 rescope). The new module only
 *   informs a `shadow` field; it never changes `mode`, `tests` or `complete`, and related-test-selection.mjs stays
 *   byte-identical to main (negative tests per merge-path-checklist lines 2 and 7).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';import { stripComments, staticEdgesOf, shadowSelection, MAX_INPUT_BYTES } from '../static-selection-edges.mjs';
import { resolvedImportsOf } from '../related-test-selection.mjs';
import { selectTests, SELECTION_FLAG } from '../../readiness/test-selection.mjs';

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
    expect(on.shadow.partial).toBe(true);
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
    const prefixes = ['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', 'return ', '\n'];
    const literals = ['/[//]/', '/[/*]/', String.raw`/[\]/]/`, String.raw`/a\/b/`];
    for (const prefix of prefixes) {
      for (const literal of literals) {
        const source = `${prefix}${literal}; /* gone */ import "./x.mjs"; // gone`;
        expect(stripComments(source)).toContain(literal);
        expect(stripComments(source)).not.toContain('gone');
        expect(staticEdgesOf('scripts/lib/a.mjs', source, FILES)).toEqual({ edges: ['scripts/lib/x.mjs'], partial: false });
      }
    }
  });

  it('marks uncertain slash contexts and unterminated single-line regexes partial', () => {
    for (const source of ['if (ok) /[/*]/;', 'value / divisor;', 'const r = /[abc\nimport "./x.mjs";', 'return /abc\\\nimport "./x.mjs";']) {
      expect(staticEdgesOf('scripts/lib/a.mjs', source, FILES).partial).toBe(true);
      expect(shadowSelection({ changedFiles: [], files: ['scripts/lib/a.mjs'], readFile: () => source }).partial).toBe(true);
    }
  });

  it('scans repeated regex classes and malformed single-line literals linearly under the cap', () => {
    const source = ('/[/*]/; // gone\n/[unterminated\n').repeat(10000) + 'import "./x.mjs";';
    const started = Date.now();
    expect(staticEdgesOf('scripts/lib/a.mjs', source, FILES)).toEqual({ edges: ['scripts/lib/x.mjs'], partial: true });
    expect(Date.now() - started).toBeLessThan(200);
  });

  it('passes aliases through shadowSelection to reach importing tests', () => {
    const contents = { 'scripts/lib/__tests__/alias.test.mjs': 'import "@lib/x.mjs";', 'scripts/lib/x.mjs': '' };
    const options = { changedFiles: ['scripts/lib/x.mjs'], files: Object.keys(contents), readFile: (file) => contents[file] };
    expect(shadowSelection(options)).toEqual({ tests: [], partial: false });
    expect(shadowSelection({ ...options, aliases: { '@lib/': 'scripts/lib/' } })).toEqual({ tests: ['scripts/lib/__tests__/alias.test.mjs'], partial: false });
  });
});

describe('audit regression: measure CLI report evidence', () => {
  it('fails closed for missing or malformed reports and preserves mode/tests with valid reports', async () => {
    const { vi } = await import('vitest');
    const { resolve } = await import('node:path');
    const cliPath = resolve('scripts/readiness/test-selection.mjs');
    const argv = process.argv;
    let output;
    let recorded;
    let reportText;
    vi.stubEnv('WE_STATIC_EDGES_SHADOW', '1');
    vi.stubEnv(SELECTION_FLAG, '0');
    vi.doMock('node:child_process', async () => {
      const actual = await vi.importActual('node:child_process');
      const execFileSync = (file, args) => {
        if (file !== 'git') throw new Error('unexpected child process');
        if (args[0] === 'merge-base') return 'abc\n';
        if (args[0] === 'diff') return 'scripts/lib/x.mjs\n';
        if (args[0] === 'ls-files') return 'scripts/lib/x.mjs\0';
        throw new Error(`unexpected git command: ${args[0]}`);
      };
      return { ...actual, execFileSync, default: { ...actual.default, execFileSync } };
    });
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual('node:fs');
      const fixture = {
      readFileSync: (path, ...rest) => {
        if (String(path) === 'audit-report.json') {
          if (reportText === undefined) throw new Error('ENOENT');
          return reportText;
        }
        if (String(path).endsWith('/scripts/lib/x.mjs')) return '';
        return actual.readFileSync(path, ...rest);
      },
      mkdirSync: () => {},
      writeFileSync: (_path, text) => { recorded = JSON.parse(text).at(-1); },
      renameSync: () => {},
      };
      return { ...actual, ...fixture, default: { ...actual.default, ...fixture } };
    });
    vi.doMock('../../readiness/heavy-admission.mjs', () => ({ admittedArgv: () => { throw new Error('unexpected related run'); } }));
    vi.doMock('../write-all-sync.mjs', () => ({ writeAllSync: (_fd, text) => { output = JSON.parse(text); } }));
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {});
    try {
      let baseline;
      const reports = [undefined, null, '{invalid', '{}', '[]', '"text"', '{"testResults":{}}', '{"testResults":[]}', '{"testResults":[{"name":"escaped.test.mjs","status":"failed"}]}'];
      for (const report of reports) {
        reportText = report ?? undefined;
        vi.resetModules();
        process.argv = [argv[0], cliPath, '--measure', '--no-related', ...(report === undefined ? [] : ['--vitest-json=audit-report.json'])];
        await import('../../readiness/test-selection.mjs');
        const valid = report?.startsWith('{"testResults":[') === true;
        expect(output.recorded).toEqual(recorded);
        expect(recorded.hadReport).toBe(valid);
        expect(output.shadow.partial).toBe(!valid);
        expect(output.decision.shadow).toEqual(output.shadow);
        expect(output.shadowEscaped).toEqual(valid ? (report.includes('escaped.test.mjs') ? ['escaped.test.mjs'] : []) : null);
        expect(recorded.shadowEscaped).toEqual(output.shadowEscaped);
        const { shadow, ...decision } = output.decision;
        baseline ??= decision;
        expect(decision).toEqual(baseline);
      }
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
