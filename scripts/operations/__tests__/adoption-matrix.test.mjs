import { describe, it, expect } from 'vitest';
import { adoptionMatrixOperation, ADOPTION_MATRIX_OP, parseFixReadyLines,
  renderAdoptionMatrix, finishAdoptionMatrix } from '../adoption-matrix.mjs';
import { createAdoptionMatrixReader } from '../adoption-matrix-io.mjs';

const lines = [
  { at: '2026-10-20T00:00:00Z', ref: 'fix/a', sha: 'aaaa' },
  { at: '2026-10-22T00:00:00Z', ref: 'fix/a', sha: 'bbbb' },
  { at: '2026-10-21T00:00:00Z', ref: 'fix/a', sha: 'cccc' },
  { at: '2026-10-22T00:00:00Z', ref: 'fix/b' },
].map(JSON.stringify).join('\n');
const settings = { clones: ['/clones/yes', '/clones/no', '/clones/error', '/clones/missing'] };
const defaults = { env: {}, home: '/home', cwd: '/repo', settings, readdir: () => [],
  exec: () => { throw new Error('unexpected plist read'); },
  readText: () => lines, isDirectory: path => !path.endsWith('/missing'),
};

describe('adoption matrix', () => {
  it('takes the latest timestamp per ref, ignores corrupt lines and keeps its SHA', () => {
    expect(parseFixReadyLines(`${lines}\ninvalid\nnull\n{}\n`)).toEqual([
      { at: '2026-10-22T00:00:00Z', ref: 'fix/a', sha: 'bbbb' },
      { at: '2026-10-22T00:00:00Z', ref: 'fix/b', sha: '' },
    ]);
  });

  it('uses supplied SHAs, resolves other tips in the current repo, and only probes ancestry in clones', () => {
    const calls = [];
    const read = createAdoptionMatrixReader({ ...defaults, run: (bin, argv, options) => {
      calls.push(argv);
      expect(bin).toBe('git');
      expect(options.cwd).toBe('/repo');
      if (argv[0] === 'rev-parse') return { status: 0, stdout: 'dddd\n' };
      expect(argv.slice(2)).toEqual(['merge-base', '--is-ancestor', expect.stringMatching(/^(bbbb|dddd)$/), 'HEAD']);
      return { status: argv[1].endsWith('/yes') ? 0 : argv[1].endsWith('/no') ? 1 : 128 };
    } });
    const result = read();
    const byName = row => Object.fromEntries(result.clones.map((clone, i) => [clone.name, row.cells[i]]));
    expect(result.rows.map(row => row.tipSha)).toEqual(['bbbb', 'dddd']);
    for (const row of result.rows) expect(byName(row)).toEqual({ yes: 'yes', no: 'no', error: '?', missing: '?' });
    expect(calls.filter(argv => argv[0] === 'rev-parse')).toEqual([
      ['rev-parse', '--verify', '--end-of-options', 'origin/fix/b^{commit}'],
    ]);
    expect(calls.some(argv => argv.includes('/clones/missing'))).toBe(false);
  });

  it('explicit branches bypass the log, prefer origin then local, and unresolved tips yield unknown rows', () => {
    const calls = [];
    const read = createAdoptionMatrixReader({ ...defaults,
      readText: () => { throw new Error('must not read log'); }, run: (_bin, argv) => {
        calls.push(argv);
        if (argv[0] !== 'rev-parse') return { status: 0 };
        return argv.at(-1) === 'local^{commit}' ? { status: 0, stdout: 'eeee\n' } : { status: 128 };
      },
    });
    const result = read({ branches: ' local,missing,local ' });
    expect(result.rows.map(row => row.ref)).toEqual(['local', 'missing']);
    expect(result.rows[1]).toEqual({ ref: 'missing', tipSha: null, cells: ['?', '?', '?', '?'] });
    expect(calls.filter(argv => argv[0] === 'rev-parse').map(argv => argv.at(-1)))
      .toEqual(['origin/local^{commit}', 'local^{commit}', 'origin/missing^{commit}', 'missing^{commit}']);
  });

  it('a throwing or timed-out clone probe stays unknown', () => {
    for (const run of [() => { throw new Error('timeout'); }, () => ({ status: null, signal: 'SIGTERM' })]) {
      const result = createAdoptionMatrixReader({ ...defaults, run })();
      expect(result.rows[0].cells).toEqual(['?', '?', '?', '?']);
    }
  });

  it('uses env before settings before the built-in log path; missing logs produce no rows', () => {
    for (const [env, config, expected] of [
      [{ WE_FIX_READY_PATH: '/env' }, { fixReadyPath: '/file' }, '/env'],
      [{}, { fixReadyPath: '~/file' }, '/home/file'],
      [{}, {}, '/home/workspace/.operations/coordination/fix-ready.jsonl'],
    ]) {
      const paths = [];
      const result = createAdoptionMatrixReader({ ...defaults, env, settings: config,
        readText: path => { paths.push(path); throw new Error('missing'); }, run: () => { throw new Error('unexpected git'); },
      })();
      expect(paths).toEqual([expected]);
      expect(result.rows).toEqual([]);
    }
  });

  it('loads settings through injected file IO and exposes shared daemon labels in the snapshot', () => {
    const seen = [];
    const result = createAdoptionMatrixReader({ ...defaults, settings: undefined, settingsPath: '/settings',
      env: { WE_LAUNCH_AGENTS_DIR: '/agents' },
      readText: path => {
        seen.push(path);
        return path === '/settings' ? JSON.stringify({ fixReadyPath: '/fixes', clones: ['/extra'], excludeClones: ['/excluded'] }) : lines;
      },
      readdir: dir => {
        expect(dir).toBe('/agents');
        return ['com.we.one.plist', 'com.we.two.plist', 'com.we.excluded.plist'];
      },
      exec: (_bin, argv) => JSON.stringify({ WorkingDirectory: argv.at(-1).includes('excluded') ? '/excluded' : '/shared' }),
      isDirectory: () => true,
      run: (_bin, argv) => argv[0] === 'rev-parse' ? { status: 0, stdout: 'dddd' } : { status: 0 },
    })();
    expect(seen).toEqual(['/settings', '/fixes']);
    expect(result.clones).toEqual([
      { path: '/extra', name: 'extra', labels: [] },
      { path: '/shared', name: 'shared', labels: ['com.we.one', 'com.we.two'] },
    ]);
    expect(result.rows[0].cells).toEqual(['yes', 'yes']);
  });

  it('renders only a table and preserves the full JSON output', () => {
    const verdict = { clones: [{ name: 'one' }, { name: 'two' }], rows: [{ ref: 'fix/a', cells: ['yes', '?'] }] };
    expect(renderAdoptionMatrix(verdict)).toBe('BRANCH  one  two\nfix/a   yes  ?');
    expect(renderAdoptionMatrix({ clones: [], rows: [] })).toBe('BRANCH');
    const outcome = { run: { verdict }, code: 0, lines: ['json'], json: false };
    expect(finishAdoptionMatrix(outcome)).toEqual({ code: 0, lines: [renderAdoptionMatrix(verdict)] });
    expect(finishAdoptionMatrix({ ...outcome, json: true })).toEqual({ code: 0, lines: ['json'] });
    expect(finishAdoptionMatrix({ ...outcome, run: null })).toEqual({ code: 0, lines: ['json'] });
  });

  it('declares only compute IO with the branches input projected to the injected reader', () => {
    expect(() => adoptionMatrixOperation()).toThrow(/collect reader/);
    let seen;
    const declaration = adoptionMatrixOperation({ collect: input => { seen = input; return { clones: [], rows: [] }; } });
    expect(declaration.name).toBe(ADOPTION_MATRIX_OP);
    expect(declaration.steps.map(entry => entry.step.kind)).toEqual(['compute']);
    const step = declaration.steps[0].step;
    expect(step.reads).toEqual(['input.branches']);
    expect(step.fn({ input: { branches: 'fix/a' } })).toEqual({ clones: [], rows: [] });
    expect(seen).toEqual({ branches: 'fix/a' });
  });
});
