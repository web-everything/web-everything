import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, it, expect } from 'vitest';
import { adoptionMatrixOperation, ADOPTION_MATRIX_OP, parseFixReadyLines,
  renderAdoptionMatrix, finishAdoptionMatrix } from '../adoption-matrix.mjs';
import { createAdoptionMatrixReader } from '../adoption-matrix-io.mjs';
import { withRealRepo } from './helpers/real-repo.mjs';

const lines = [
  { at: '2026-10-20T00:00:00Z', ref: 'fix/a', sha: 'aaaaaaa' },
  { at: '2026-10-22T00:00:00Z', ref: 'fix/a', sha: 'bbbbbbb' },
  { at: '2026-10-21T00:00:00Z', ref: 'fix/a', sha: 'ccccccc' },
  { at: '2026-10-22T00:00:00Z', ref: 'fix/b', sha: 'ddddddd' },
].map(JSON.stringify).join('\n');
const settings = { clones: ['/clones/yes', '/clones/no', '/clones/error', '/clones/missing'] };
const defaults = { env: {}, home: '/home', cwd: '/repo', settings, readdir: () => [],
  exec: () => { throw new Error('unexpected plist read'); },
  readText: () => lines, isDirectory: path => !path.endsWith('/missing'),
};

describe('adoption matrix', () => {
  it('takes the latest timestamp per ref, flags corrupt records and keeps its SHA', () => {
    const incomplete = [];
    expect(parseFixReadyLines(`${lines}\ninvalid\nnull\n{}\n`, { onIncomplete: reason => incomplete.push(reason) })).toEqual([
      { at: '2026-10-22T00:00:00Z', ref: 'fix/a', sha: 'bbbbbbb' },
      { at: '2026-10-22T00:00:00Z', ref: 'fix/b', sha: 'ddddddd' },
    ]);
    expect(incomplete).toEqual(Array(3).fill('fix-ready log malformed'));
  });

  it.each([
    ['invalid timestamp', JSON.stringify({ ref: 'fix/a', at: 'invalid', sha: 'eeeeeee' })],
    ['missing timestamp', JSON.stringify({ ref: 'fix/a', sha: 'eeeeeee' })],
    ['non-string timestamp', JSON.stringify({ ref: 'fix/a', at: 123, sha: 'eeeeeee' })],
    ['corrupt JSON', '{broken'],
  ])('marks older evidence incomplete after a record with %s', (_name, record) => {
    const result = createAdoptionMatrixReader({ ...defaults,
      readText: () => `${lines}\n${record}\n`, run: () => ({ status: 0 }),
    })();
    expect(result.rows.find(row => row.ref === 'fix/a').tipSha).toBe('bbbbbbb');
    expect(result.incomplete).toEqual(['fix-ready log malformed']);
    expect(renderAdoptionMatrix(result)).toMatch(/INCOMPLETE: fix-ready log malformed.*inspect.*retry/);
  });

  it.each([() => '{', () => { throw new Error('denied'); }])('refuses to create a reader when settings cannot be loaded', readText => {
    expect(() => createAdoptionMatrixReader({ ...defaults, settings: undefined, settingsPath: '/settings', readText })).toThrow();
  });

  it('checks object presence before ancestry and keeps unrelated exit 128 unknown', () => {
    const calls = [];
    const read = createAdoptionMatrixReader({ ...defaults, run: (bin, argv, options) => {
      calls.push(argv);
      expect(bin).toBe('git');
      expect(options.cwd).toBe('/repo');
      if (argv[0] === 'rev-parse') return { status: 0, stdout: 'ddddddd\n' };
      expect(argv[0]).toBe('-C');
      if (argv[2] === 'cat-file') {
        expect(argv.slice(2)).toEqual(['cat-file', '-e', expect.stringMatching(/^(bbbbbbb|ddddddd)\^\{commit\}$/)]);
        return { status: 0 };
      }
      expect(argv.slice(2)).toEqual(['merge-base', '--is-ancestor', expect.stringMatching(/^(bbbbbbb|ddddddd)$/), 'HEAD']);
      return { status: argv[1].endsWith('/yes') ? 0 : argv[1].endsWith('/no') ? 1 : 128 };
    } });
    const result = read();
    const byName = row => Object.fromEntries(result.clones.map((clone, i) => [clone.name, row.cells[i]]));
    expect(result.rows.map(row => row.tipSha)).toEqual(['bbbbbbb', 'ddddddd']);
    for (const row of result.rows) {
      expect(byName(row)).toEqual({ yes: 'yes', no: 'no', error: '?', missing: '?' });
    }
    expect(calls.some(argv => argv.includes('/clones/missing'))).toBe(false);
  });

  it.each([undefined, '', 'HEAD', ' abcdef0 ', 'main', 'abc123', 'a'.repeat(41), 'g'.repeat(40)])('rejects invalid logged SHA %s without resolving a replacement', sha => {
    const calls = [];
    const result = createAdoptionMatrixReader({ ...defaults,
      readText: () => JSON.stringify({ ref: 'fix/a', at: '2026-10-22T00:00:00Z', sha }),
      run: (...args) => { calls.push(args); return { status: 0, stdout: 'a'.repeat(40) }; },
    })();
    expect(result.rows[0].cells).toEqual(['?', '?', '?', '?']);
    expect(calls).toEqual([]);
  });

  it.each([1, 128])('recognizes only proven absent objects (cat-file exit %s)', status => {
    const calls = [];
    const result = createAdoptionMatrixReader({ ...defaults, run: (_bin, argv) => {
      calls.push(argv);
      return { status, stderr: `fatal: Not a valid object name ${argv.at(-1)}\n` };
    } })();
    expect(result.rows[0].cells).toEqual(['no (not in clone)', '?', 'no (not in clone)', 'no (not in clone)']);
    expect(calls.every(argv => argv[2] === 'cat-file' || argv[0] === 'rev-parse')).toBe(true);
  });

  it('marks log failures and unreadable discovery evidence incomplete in JSON and text', () => {
    for (const env of [{}, { WE_FIX_READY_PATH: '/explicit' }]) {
      const result = createAdoptionMatrixReader({ ...defaults, env,
        readText: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); },
        readdir: () => ['com.we.bad.plist'],
      })();
      expect(result.incomplete).toContain('fix-ready log unreadable');
      expect(result.incomplete).toContain('daemon plist unreadable');
      expect(renderAdoptionMatrix(result)).toMatch(/INCOMPLETE.*inspect.*retry/i);
    }
  });

  it('only a missing default log is an empty complete observation', () => {
    for (const env of [{}, { WE_FIX_READY_PATH: '/explicit' }]) {
      const result = createAdoptionMatrixReader({ ...defaults, env,
        readText: () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
      })();
      expect(result.incomplete ?? []).toEqual(env.WE_FIX_READY_PATH ? ['fix-ready log unreadable'] : []);
    }
  });

  it('bounds recent refs, clones and total git calls with explicit truncation and operator fallback', () => {
    let probes = 0;
    const result = createAdoptionMatrixReader({ ...defaults,
      settings: { clones: Array.from({ length: 80 }, (_, i) => `/clones/${i}`) },
      readText: () => Array.from({ length: 1000 }, (_, i) => JSON.stringify({
        ref: `fix/${i}`, at: new Date(i * 1000).toISOString(), sha: 'abcdef0',
      })).join('\n'),
      run: () => { probes++; return { status: 0 }; },
    })();
    expect(result.rows).toHaveLength(50);
    expect(result.rows[0].ref).toBe('fix/950');
    expect(result.rows.at(-1).ref).toBe('fix/999');
    expect(result.clones).toHaveLength(20);
    expect(probes).toBeLessThanOrEqual(500);
    expect(probes).toBe(500);
    expect(result.rows.at(-1).cells).toEqual(Array(20).fill('?'));
    expect(result.truncated).toBe(true);
    expect(renderAdoptionMatrix(result)).toMatch(/INCOMPLETE.*truncated.*inspect.*retry/i);
  });

  it('strips all terminal control and format characters from refs and clone names', () => {
    const unsafe = 'x\x1b[31m\x00\x7f\x85\u202e\u2066\r\n\t';
    const rendered = renderAdoptionMatrix({ clones: [{ name: unsafe }], rows: [{ ref: unsafe, cells: ['yes'] }] });
    expect(rendered.replaceAll('\n', '')).not.toMatch(/[\p{Cc}\p{Cf}]/u);
    expect(rendered).toContain('x[31m');
  });

  it('other exit codes stay unknown', () => {
    const result = createAdoptionMatrixReader({ ...defaults, run: () => ({ status: 2 }) })();
    expect(result.rows[0].cells).toEqual(['?', '?', '?', '?']);
  });

  it('explicit branches bypass the log, prefer origin then local, and unresolved tips yield unknown rows', () => {
    const calls = [];
    const read = createAdoptionMatrixReader({ ...defaults,
      readText: () => { throw new Error('must not read log'); }, run: (_bin, argv) => {
        calls.push(argv);
        if (argv[0] !== 'rev-parse') return { status: 0 };
        return argv.at(-1) === 'local^{commit}' ? { status: 0, stdout: 'eeeeeee\n' } : { status: 128 };
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

  it('uses env before settings before the built-in log path and reports generic read errors incomplete', () => {
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
      expect(result.incomplete).toEqual(['fix-ready log unreadable']);
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
      run: (_bin, argv) => argv[0] === 'rev-parse' ? { status: 0, stdout: 'ddddddd' } : { status: 0 },
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

it('real git distinguishes a missing commit from an invalid repository', () => withRealRepo(({ root: dir }) => {
  const absent = spawnSync('git', ['-C', dir, 'cat-file', '-e', 'deadbee^{commit}'], { encoding: 'utf8' });
  expect(absent.status).toBe(128);
  expect(absent.stderr).toContain('Not a valid object name');
  const result = createAdoptionMatrixReader({ ...defaults, cwd: dir,
    settings: { clones: [dir, join(dir, 'not-a-repo')] }, isDirectory: () => true,
    readText: () => JSON.stringify({ at: '2026-10-22T00:00:00Z', ref: 'fix/a', sha: 'deadbee' }), run: spawnSync,
  })();
  expect(result.rows[0].cells).toEqual(['no (not in clone)', '?']);
}));

it('bounds explicit branch resolution and marks its omitted rows truncated', () => {
  let probes = 0;
  const result = createAdoptionMatrixReader({ ...defaults, settings: { clones: ['/clone'] },
    run: () => { probes++; return { status: 128 }; },
  })({ branches: Array.from({ length: 100 }, (_, i) => `branch/${i}`).join(',') });
  expect(result.rows).toHaveLength(50);
  expect(probes).toBe(100);
  expect(result.truncated).toBe(true);
  expect(result.rows.every(row => row.cells[0] === '?')).toBe(true);
});

it('computes widths without argument spreads for large rendered matrices', () => {
  const rendered = renderAdoptionMatrix({ clones: [{ name: 'clone' }],
    rows: Array.from({ length: 150000 }, () => ({ ref: 'ref', cells: ['?'] })),
  });
  expect(rendered.split('\n')).toHaveLength(150001);
});

it.each(['abcdef0', 'A'.repeat(40)])('accepts only immutable logged hex SHA %s', sha => {
  const calls = [];
  const result = createAdoptionMatrixReader({ ...defaults, settings: { clones: ['/clone'] },
    readText: () => JSON.stringify({ ref: 'fix/a', at: '2026-10-22T00:00:00Z', sha }),
    run: (_bin, argv) => { calls.push(argv); return { status: 0 }; },
  })();
  expect(result.rows[0]).toEqual({ ref: 'fix/a', tipSha: sha, cells: ['yes'] });
  expect(calls).toEqual([
    ['-C', '/clone', 'cat-file', '-e', `${sha}^{commit}`],
    ['-C', '/clone', 'merge-base', '--is-ancestor', sha, 'HEAD'],
  ]);
});

it.each(['fatal: permission denied', 'fatal: not a git repository', 'fatal: ambiguous argument'])('keeps unrelated object-probe failure unknown: %s', stderr => {
  const result = createAdoptionMatrixReader({ ...defaults,
    run: () => ({ status: 128, stderr }),
  })();
  expect(result.rows.every(row => row.cells.every(cell => cell === '?'))).toBe(true);
});

it('shares the probe cap with explicit tip resolution', () => {
  const calls = [];
  const result = createAdoptionMatrixReader({ ...defaults,
    settings: { clones: Array.from({ length: 20 }, (_, i) => `/clone/${i}`) },
    run: (_bin, argv) => { calls.push(argv); return { status: 0, stdout: 'abcdef0' }; },
  })({ branches: Array.from({ length: 50 }, (_, i) => `branch/${i}`).join(',') });
  expect(calls).toHaveLength(500);
  expect(calls.some(argv => argv[0] === 'rev-parse')).toBe(true);
  expect(calls.some(argv => argv[2] === 'cat-file')).toBe(true);
  expect(calls.some(argv => argv[2] === 'merge-base')).toBe(true);
  expect(result.truncated).toBe(true);
  expect(result.rows.at(-1).cells).toEqual(Array(20).fill('?'));
});

it('bounds the real log read to a recent byte window and marks omitted evidence truncated', () => {
  const dir = mkdtempSync(join(tmpdir(), 'adoption-log-'));
  try {
    const log = join(dir, 'fix-ready.jsonl');
    writeFileSync(log, `${'x'.repeat(2 * 1024 * 1024)}\n${JSON.stringify({ ref: 'recent', at: '2026-10-22T00:00:00Z', sha: 'abcdef0' })}\n`);
    const cap = 1024 * 1024;
    const size = statSync(log).size;
    // Native ESM instrumentation observes the production reader's named fs imports.
    // A Vitest namespace spy can miss those imports or an optimized readFileSync.
    const { result, reads, wholeFileReads } = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      import { createAdoptionMatrixReader } from ${JSON.stringify(pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '../adoption-matrix-io.mjs')).href)};
      const log = process.argv[1];
      const reads = [], wholeFileReads = [];
      const originalRead = fs.readSync, originalReadFile = fs.readFileSync;
      fs.readSync = (fd, buffer, offset, length, position) => {
        const count = originalRead(fd, buffer, offset, length, position);
        reads.push({ length, position, count });
        return count;
      };
      fs.readFileSync = (...args) => {
        wholeFileReads.push(String(args[0]));
        return originalReadFile(...args);
      };
      syncBuiltinESMExports();
      let result;
      try {
        result = createAdoptionMatrixReader({ env: { WE_FIX_READY_PATH: log }, settings: {}, readdir: () => [] })();
      } finally {
        fs.readSync = originalRead;
        fs.readFileSync = originalReadFile;
        syncBuiltinESMExports();
      }
      process.stdout.write(JSON.stringify({ result, reads, wholeFileReads }));
    `, log], { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 }));
    expect(size).toBeGreaterThan(2 * cap);
    expect(wholeFileReads).toEqual([]);
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.reduce((total, read) => total + read.count, 0)).toBeLessThanOrEqual(cap);
    expect(reads.reduce((total, read) => total + read.length, 0)).toBeLessThanOrEqual(cap);
    for (const read of reads) {
      expect(Number.isInteger(read.position)).toBe(true);
      expect(read.position).toBeGreaterThanOrEqual(size - cap);
      expect(read.position + read.length).toBeLessThanOrEqual(size);
    }
    expect(result.rows).toEqual([{ ref: 'recent', tipSha: 'abcdef0', cells: [] }]);
    expect(result.truncated).toBe(true);
    expect(renderAdoptionMatrix(result)).toMatch(/INCOMPLETE.*truncated.*inspect.*retry/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
