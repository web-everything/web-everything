import { spawnSync, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, it, expect } from 'vitest';
import { adoptionMatrixOperation, ADOPTION_MATRIX_OP, parseFixReadyLines,
  renderAdoptionMatrix, finishAdoptionMatrix } from '../adoption-matrix.mjs';
import { createAdoptionMatrixReader } from '../adoption-matrix-io.mjs';
import { withRealRepo } from './helpers/real-repo.mjs';

const lines = [
  { at: '2026-10-20T00:00:00Z', ref: 'fix/a', sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
  { at: '2026-10-22T00:00:00Z', ref: 'fix/a', sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
  { at: '2026-10-21T00:00:00Z', ref: 'fix/a', sha: 'cccccccccccccccccccccccccccccccccccccccc' },
  { at: '2026-10-22T00:00:00Z', ref: 'fix/b', sha: 'dddddddddddddddddddddddddddddddddddddddd' },
].map(JSON.stringify).join('\n');
const settings = { clones: ['/clones/yes', '/clones/no', '/clones/error', '/clones/missing'] };
const defaults = { env: {}, home: '/fixture-home', cwd: '/repo', settings, readdir: () => [],
  exec: () => { throw new Error('unexpected plist read'); },
  realpath: path => path, readText: () => lines, isDirectory: path => !path.endsWith('/missing'),
};

describe('adoption matrix', () => {
  it('takes the latest timestamp per ref, flags corrupt records and keeps its SHA', () => {
    const incomplete = [];
    expect(parseFixReadyLines(`${lines}\ninvalid\nnull\n{}\n`, { onIncomplete: reason => incomplete.push(reason) })).toEqual([
      { at: '2026-10-22T00:00:00Z', ref: 'fix/a', sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
      { at: '2026-10-22T00:00:00Z', ref: 'fix/b', sha: 'dddddddddddddddddddddddddddddddddddddddd' },
    ]);
    expect(incomplete).toEqual(Array(3).fill('fix-ready log malformed'));
  });

  it.each([
    ['invalid timestamp', JSON.stringify({ ref: 'fix/a', at: 'invalid', sha: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' })],
    ['missing timestamp', JSON.stringify({ ref: 'fix/a', sha: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' })],
    ['non-string timestamp', JSON.stringify({ ref: 'fix/a', at: 123, sha: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' })],
    ['missing ref', JSON.stringify({ at: '2026-10-23T00:00:00Z' })],
    ['blank ref', JSON.stringify({ ref: '  ', at: '2026-10-23T00:00:00Z' })],
    ['non-string ref', JSON.stringify({ ref: 42, at: '2026-10-23T00:00:00Z' })],
    ['corrupt JSON', '{broken'],
  ])('marks older evidence incomplete after a record with %s', (_name, record) => {
    const result = createAdoptionMatrixReader({ ...defaults,
      readText: () => `${lines}\n${record}\n`, run: () => ({ status: 0 }),
    })();
    expect(result.rows.find(row => row.ref === 'fix/a').tipSha).toBe('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
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
      if (argv[0] === 'rev-parse') return { status: 0, stdout: 'dddddddddddddddddddddddddddddddddddddddd\n' };
      expect(argv[0]).toBe('-C');
      if (argv.includes('--show-toplevel')) return { status: 0, stdout: argv[1] + '\n' };
      if (argv[2] === 'cat-file') {
        expect(argv.slice(2)).toEqual(['cat-file', '-e', expect.stringMatching(/^(bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb|dddddddddddddddddddddddddddddddddddddddd)\^\{commit\}$/)]);
        return { status: 0 };
      }
      if (argv[2] === 'rev-parse') {
        expect(argv.slice(2)).toEqual(['rev-parse', '--is-shallow-repository']);
        return { status: 0, stdout: 'false\n' };
      }
      expect(argv.slice(2)).toEqual(['merge-base', '--is-ancestor', expect.stringMatching(/^(bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb|dddddddddddddddddddddddddddddddddddddddd)$/), 'HEAD']);
      return { status: argv[1].endsWith('/yes') ? 0 : argv[1].endsWith('/no') ? 1 : 128 };
    } });
    const result = read();
    const byName = row => Object.fromEntries(result.clones.map((clone, i) => [clone.name, row.cells[i]]));
    expect(result.rows.map(row => row.tipSha)).toEqual(['bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'dddddddddddddddddddddddddddddddddddddddd']);
    for (const row of result.rows) {
      expect(byName(row)).toEqual({ yes: 'yes', no: 'no', error: '?', missing: '?' });
    }
    expect(calls.some(argv => argv.includes('/clones/missing'))).toBe(false);
  });

  it.each([undefined, '', 'HEAD', ' abcdef0000000000000000000000000000000000 ', 'main', 'abc123', 'abcdef0', 'a'.repeat(39), 'a'.repeat(41), 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(40), 'a'.repeat(40) + '\n'])('rejects invalid logged SHA %s without resolving a replacement', sha => {
    const calls = [];
    const result = createAdoptionMatrixReader({ ...defaults,
      readText: () => JSON.stringify({ ref: 'fix/a', at: '2026-10-22T00:00:00Z', sha }),
      run: (...args) => { calls.push(args); return { status: 0, stdout: 'a'.repeat(40) }; },
    })();
    expect(result.rows[0].cells).toEqual(['?', '?', '?', '?']);
    expect(calls).toEqual([]);
  });

  it('keeps a 7-character logged SHA unknown without resolving it in any clone', () => {
    const calls = [];
    const result = createAdoptionMatrixReader({ ...defaults,
      readText: () => JSON.stringify({ ref: 'fix/a', at: '2026-10-22T00:00:00Z', sha: 'abcdef0' }),
      run: (...args) => { calls.push(args); return { status: 0 }; },
    })();
    expect(result.rows[0]).toEqual({ ref: 'fix/a', tipSha: null, cells: ['?', '?', '?', '?'] });
    expect(calls).toEqual([]);
  });

  it('caps oversized refs, column names and cells with visible truncation and a full-data fallback', () => {
    const verdict = { clones: [{ name: 'c'.repeat(10000) }],
      rows: [{ ref: 'r'.repeat(10000), cells: ['v'.repeat(10000)] }, { ref: 'short', cells: ['?'] }] };
    const rendered = renderAdoptionMatrix(verdict);
    const table = rendered.split('\n').slice(0, 3);
    expect(table.every(line => line.length <= 162)).toBe(true);
    expect(table[0]).toContain('c'.repeat(79) + '…');
    expect(table[1]).toBe('r'.repeat(79) + '…  ' + 'v'.repeat(79) + '…');
    expect(rendered).toMatch(/display text truncated.*--json/);
    expect(verdict.rows[0].ref).toHaveLength(10000);
    expect(finishAdoptionMatrix({ run: { verdict }, code: 0, lines: ['full JSON'], json: true }).lines).toEqual(['full JSON']);
  });

  it.each([1, 128])('recognizes only proven absent objects (cat-file exit %s)', status => {
    const calls = [];
    const result = createAdoptionMatrixReader({ ...defaults, run: (_bin, argv) => {
      calls.push(argv);
      if (argv.includes('--show-toplevel')) return { status: 0, stdout: argv[1] };
      return { status, stderr: `fatal: Not a valid object name ${argv.at(-1)}\n` };
    } })();
    expect(result.rows[0].cells).toEqual(['no (not in clone)', '?', 'no (not in clone)', 'no (not in clone)']);
    expect(calls.every(argv => argv[2] === 'cat-file' || argv[2] === 'rev-parse' || argv[0] === 'rev-parse')).toBe(true);
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
        ref: `fix/${i}`, at: new Date(i * 1000).toISOString(), sha: 'abcdef0000000000000000000000000000000000',
      })).join('\n'),
      run: (_bin, argv) => { probes++; return { status: 0, stdout: argv[1] }; },
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
    const result = createAdoptionMatrixReader({ ...defaults, run: (_bin, argv) => argv.includes('--show-toplevel') ? { status: 0, stdout: argv[1] } : { status: 2 } })();
    expect(result.rows[0].cells).toEqual(['?', '?', '?', '?']);
  });

  it('explicit branches bypass the log, prefer origin then local, and unresolved tips yield unknown rows', () => {
    const calls = [];
    const read = createAdoptionMatrixReader({ ...defaults,
      readText: () => { throw new Error('must not read log'); }, run: (_bin, argv) => {
        calls.push(argv);
        if (argv[0] !== 'rev-parse') return { status: 0 };
        return argv.at(-1) === 'local^{commit}' ? { status: 0, stdout: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee\n' } : { status: 128 };
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
      [{}, { fixReadyPath: '~/file' }, '/fixture-home/file'],
      [{}, {}, '/fixture-home/workspace/.operations/coordination/fix-ready.jsonl'],
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
      run: (_bin, argv) => argv.includes('--show-toplevel') ? { status: 0, stdout: argv[1] } : argv[0] === 'rev-parse' ? { status: 0, stdout: 'dddddddddddddddddddddddddddddddddddddddd' } : { status: 0 },
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
  const absent = spawnSync('git', ['-C', dir, 'cat-file', '-e', 'deadbeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee^{commit}'], { encoding: 'utf8' });
  expect(absent.status).toBe(128);
  expect(absent.stderr).toContain('Not a valid object name');
  const result = createAdoptionMatrixReader({ ...defaults, cwd: dir, realpath: realpathSync,
    settings: { clones: [dir, join(dir, 'not-a-repo')] }, isDirectory: () => true,
    readText: () => JSON.stringify({ at: '2026-10-22T00:00:00Z', ref: 'fix/a', sha: 'deadbeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' }), run: spawnSync,
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

it.each(['a'.repeat(40), 'A'.repeat(40), 'b'.repeat(64)])('accepts only immutable logged hex SHA %s', sha => {
  const calls = [];
  const result = createAdoptionMatrixReader({ ...defaults, settings: { clones: ['/clone'] },
    readText: () => JSON.stringify({ ref: 'fix/a', at: '2026-10-22T00:00:00Z', sha }),
    run: (_bin, argv) => { calls.push(argv); return { status: 0, stdout: argv[1] }; },
  })();
  expect(result.rows[0]).toEqual({ ref: 'fix/a', tipSha: sha, cells: ['yes'] });
  expect(calls).toEqual([
    ['-C', '/clone', 'rev-parse', '--show-toplevel'],
    ['-C', '/clone', 'cat-file', '-e', `${sha}^{commit}`],
    ['-C', '/clone', 'merge-base', '--is-ancestor', sha, 'HEAD'],
  ]);
});

it.each(['fatal: permission denied', 'fatal: not a git repository', 'fatal: ambiguous argument'])('keeps unrelated object-probe failure unknown: %s', stderr => {
  const result = createAdoptionMatrixReader({ ...defaults,
    run: (_bin, argv) => argv.includes('--show-toplevel') ? { status: 0, stdout: argv[1] } : { status: 128, stderr },
  })();
  expect(result.rows.every(row => row.cells.every(cell => cell === '?'))).toBe(true);
});

it('shares the probe cap with explicit tip resolution', () => {
  const calls = [];
  const result = createAdoptionMatrixReader({ ...defaults,
    settings: { clones: Array.from({ length: 20 }, (_, i) => `/clone/${i}`) },
    run: (_bin, argv) => { calls.push(argv); return { status: 0, stdout: argv.includes('--show-toplevel') ? argv[1] : 'abcdef0000000000000000000000000000000000' }; },
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
    writeFileSync(log, `${'x'.repeat(2 * 1024 * 1024)}\n${JSON.stringify({ ref: 'recent', at: '2026-10-22T00:00:00Z', sha: 'abcdef0000000000000000000000000000000000' })}\n`);
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
    expect(result.rows).toEqual([{ ref: 'recent', tipSha: 'abcdef0000000000000000000000000000000000', cells: [] }]);
    expect(result.truncated).toBe(true);
    expect(renderAdoptionMatrix(result)).toMatch(/INCOMPLETE.*truncated.*inspect.*retry/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it.each(['FIFO', 'directory'])('marks a %s log unreadable without blocking', (kind, context) => {
  const dir = mkdtempSync(join(tmpdir(), 'adoption-nonregular-log-'));
  try {
    const log = kind === 'directory' ? dir : join(dir, 'fix-ready.fifo');
    if (kind === 'FIFO') {
      const made = spawnSync('mkfifo', [log], { encoding: 'utf8', timeout: 5000 });
      if (made.error?.code === 'ENOENT') { context.skip(); return; }
      expect(made.error).toBeUndefined();
      expect(made.status, made.stderr).toBe(0);
    }
    // A blocking open must time out in a child rather than hang the test worker.
    const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `
      import { createAdoptionMatrixReader } from ${JSON.stringify(pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '../adoption-matrix-io.mjs')).href)};
      const result = createAdoptionMatrixReader({
        env: { WE_FIX_READY_PATH: process.argv[1] }, settings: {}, readdir: () => [],
      })();
      process.stdout.write(JSON.stringify(result));
    `, log], { encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024 }));
    expect(result.rows).toEqual([]);
    expect(result.incomplete).toEqual(['fix-ready log unreadable']);
    expect(renderAdoptionMatrix(result)).toMatch(/INCOMPLETE: fix-ready log unreadable.*inspect.*retry/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it('strips repository overrides and disables lazy fetch and replacement objects in every Git child', () => {
  const dir = mkdtempSync(join(tmpdir(), 'adoption-git-env-'));
  try {
    const log = join(dir, 'calls.jsonl');
    writeFileSync(join(dir, 'git'), `#!${process.execPath}
const { appendFileSync } = require('node:fs');
const argv = process.argv.slice(2);
const overrides = Object.fromEntries(Object.entries(process.env).filter(([key]) => ${JSON.stringify(['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR', 'GIT_NAMESPACE', 'GIT_CEILING_DIRECTORIES'])}.includes(key)));
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv, overrides, env: { PATH: process.env.PATH,
  GIT_NO_LAZY_FETCH: process.env.GIT_NO_LAZY_FETCH, GIT_NO_REPLACE_OBJECTS: process.env.GIT_NO_REPLACE_OBJECTS, GIT_TERMINAL_PROMPT: process.env.GIT_TERMINAL_PROMPT } }) + '\\n');
if (argv.includes('--show-toplevel')) process.stdout.write(argv[1]);
else if (argv.includes('--is-shallow-repository')) process.stdout.write('false');
else if (argv[0] === 'rev-parse') process.stdout.write('abcdef0000000000000000000000000000000000');
else if (argv.includes('merge-base')) process.exitCode = 1;
`, { mode: 0o755 });
    const env = { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH}`,
      GIT_NO_LAZY_FETCH: '0', GIT_NO_REPLACE_OBJECTS: '0', GIT_TERMINAL_PROMPT: '1',
      ...Object.fromEntries(['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
        'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR', 'GIT_NAMESPACE', 'GIT_CEILING_DIRECTORIES']
        .map(key => [key, '/unrelated-repository'])) };
    const result = createAdoptionMatrixReader({ ...defaults, cwd: dir, settings: { clones: ['/clone'] }, env,
      run: spawnSync,
    })({ branches: 'fix/a' });
    expect(result.rows[0].cells).toEqual(['no']);
    const calls = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(calls.map(call => call.argv[0] === '-C' ? call.argv[2] : call.argv[0]))
      .toEqual(['rev-parse', 'rev-parse', 'cat-file', 'merge-base', 'rev-parse']);
    for (const call of calls) {
      expect(call.overrides).toEqual({});
      expect(call.env).toMatchObject({ PATH: env.PATH, GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0' });
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it.each([
  ['shallow', { status: 0, stdout: 'true\n' }, '?'],
  ['non-shallow', { status: 0, stdout: 'false\n' }, 'no'],
  ['failed', { status: 128 }, '?'],
  ['malformed', { status: 0, stdout: '' }, '?'],
])('negative ancestry is definitive only with proven non-shallow history (%s)', (_name, shallow, expected) => {
  const calls = [];
  const result = createAdoptionMatrixReader({ ...defaults, settings: { clones: ['/clone'] },
    run: (_bin, argv) => {
      calls.push(argv);
      if (argv.includes('--show-toplevel')) return { status: 0, stdout: argv[1] };
      return argv[2] === 'rev-parse' ? shallow : { status: argv[2] === 'merge-base' ? 1 : 0 };
    },
  })();
  expect(result.rows.map(row => row.cells)).toEqual([[expected], [expected]]);
  expect(calls.filter(argv => argv.includes('--is-shallow-repository'))).toEqual(
    Array(2).fill(['-C', '/clone', 'rev-parse', '--is-shallow-repository']));
});


it('real git accepts repository roots and symlinks but rejects a repository subdirectory', () => withRealRepo(({ root, git }) => {
  const subdir = join(root, 'scripts');
  const alias = join(root, 'root-alias');
  mkdirSync(subdir);
  symlinkSync(root, alias, 'dir');
  const sha = git(['rev-parse', 'HEAD']).trim();
  const result = createAdoptionMatrixReader({ env: process.env, cwd: root, readdir: () => [],
    settings: { clones: [root, subdir, alias] },
    readText: () => JSON.stringify({ at: '2026-10-22T00:00:00Z', ref: 'fix/a', sha }),
  })();
  expect(Object.fromEntries(result.clones.map((clone, i) => [clone.path, result.rows[0].cells[i]])))
    .toEqual({ [root]: 'yes', [subdir]: '?', [alias]: 'yes' });
}));

it.each([
  ['failed', { status: 128 }],
  ['empty', { status: 0, stdout: '' }],
  ['parent repository', { status: 0, stdout: '/' }],
])('keeps %s root evidence unknown without probing objects', (_name, rootResult) => {
  const calls = [];
  const result = createAdoptionMatrixReader({ ...defaults, settings: { clones: ['/clone'] },
    run: (_bin, argv) => { calls.push(argv); return rootResult; },
  })();
  expect(result.rows.map(row => row.cells)).toEqual([['?'], ['?']]);
  expect(calls).toEqual([['-C', '/clone', 'rev-parse', '--show-toplevel']]);
});

it('keeps unreadable realpath evidence unknown without invoking Git', () => {
  const calls = [];
  const result = createAdoptionMatrixReader({ ...defaults, settings: { clones: ['/clone'] },
    realpath: () => { throw new Error('denied'); },
    run: (...args) => { calls.push(args); return { status: 0 }; },
  })();
  expect(result.rows.map(row => row.cells)).toEqual([['?'], ['?']]);
  expect(calls).toEqual([]);
});
