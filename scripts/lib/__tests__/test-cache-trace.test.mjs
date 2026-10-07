import { describe, it, expect } from 'vitest';
import { afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  analyzeTrace, buildSpawnArgs, describeSpawn, effectiveCwd, hashTracedInput,
  isAdmitted, nextAdmission, nodeScriptOf, parseChildTrace, parseSpawnArgs,
  sameTracedMap, sampledForTrace, traceEnabled, tracedMap,
} from '../test-cache-trace.mjs';

const tempDirs = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('spawn argument normalization', () => {
  const cb = () => {};
  const opts = { cwd: '/t/x' };
  it.each([
    ['spawn', ['cmd', ['arg'], opts], ['arg'], opts, undefined],
    ['spawn', ['cmd', opts], [], opts, undefined],
    ['exec', ['cmd', cb], [], {}, cb],
    ['execSync', ['cmd', opts], [], opts, undefined],
    ['execFile', ['cmd', ['arg'], opts, cb], ['arg'], opts, cb],
    ['fork', ['mod', ['arg']], ['arg'], {}, undefined],
  ])('round-trips %s %j through its normalized form', (kind, argv, args, options, callback) => {
    const parsed = parseSpawnArgs(kind, argv);
    expect(parsed).toEqual({ file: argv[0], args, options, cb: callback });
    const rebuilt = buildSpawnArgs(kind, parsed);
    const expected = ['exec', 'execSync'].includes(kind)
      ? [argv[0], options] : [argv[0], args, options];
    if (callback) expected.push(callback);
    expect(rebuilt).toEqual(expected);
    expect(parseSpawnArgs(kind, rebuilt)).toEqual(parsed);
  });

  it.each(['git status', 'FOO=bar git status'])('describes shell command %s', (command) => {
    expect(describeSpawn('exec', parseSpawnArgs('exec', [command, { cwd: 'child' }]), {
      execPath: '/bin/node', cwd: '/r/lane',
    })).toEqual({ k: 'spawn', kind: 'exec', cwd: '/r/lane/child', cmd: 'git', args: [], shell: true });
  });

  it('describes fork as node with the module before its arguments', () => {
    expect(describeSpawn('fork', parseSpawnArgs('fork', ['mod.mjs', ['a'], { cwd: '/t/x' }]), {
      execPath: '/bin/node', cwd: '/r/lane',
    })).toEqual({ k: 'spawn', kind: 'fork', cwd: '/t/x', cmd: '/bin/node', args: ['mod.mjs', 'a'] });
  });
});

describe('spawn paths', () => {
  it('skips value-taking node flags to find the entry script', () => {
    expect(nodeScriptOf({ cwd: '/r/lane', args: ['--import', 'preload.mjs', '-r', 'setup.cjs', 's.mjs', 'arg'] }))
      .toBe('/r/lane/s.mjs');
    expect(nodeScriptOf({ cwd: '/r/lane', args: ['-e', 'console.log(1)', 's.mjs'] })).toBeNull();
  });

  it('resolves git -C against the spawn cwd', () => {
    expect(effectiveCwd({ cmd: 'git', cwd: '/r/lane', args: ['-C', 'dir', 'status'] })).toBe('/r/lane/dir');
    expect(effectiveCwd({ cmd: 'git', cwd: '/r/lane', args: ['-C', '/t/x'] })).toBe('/t/x');
    expect(effectiveCwd({ cmd: 'node', cwd: '/r/lane', args: [] })).toBe('/r/lane');
  });
});

describe('analyzeTrace', () => {
  const analyze = (events) => analyzeTrace({
    events, root: '/r/lane', fuiRoot: '/r/fui', tmpRoots: ['/t'], home: '/h',
    cacheDir: '/h/.cache/c', closure: new Set(['/r/lane/a.mjs']), execPath: '/custom/node-runtime',
  });

  it.each(['/r/lane/a.mjs', '/t/x', '/r/lane/node_modules/pkg/a.mjs', '/h/.cache/c/x', '/r/lane/package.json'])(
    'does not trace or deny covered read %s', (p) => {
      expect(analyze([{ k: 'read', p }])).toEqual({ denies: [], traced: [], reads: 1, spawns: 0 });
    },
  );

  it('records additional repo files and directory listings', () => {
    expect(analyze([
      { k: 'read', p: '/r/lane/b.mjs' }, { k: 'list', p: '/r/lane/d' },
    ])).toEqual({
      denies: [], traced: [{ path: '/r/lane/b.mjs', kind: 'file' }, { path: '/r/lane/d', kind: 'dir' }],
      reads: 2, spawns: 0,
    });
    expect(analyze([{ k: 'read', p: '/r/fui/a.mjs' }]).traced).toEqual([{ path: '/r/fui/a.mjs', kind: 'file' }]);
  });

  it('denies home reads', () => {
    expect(analyze([{ k: 'read', p: '/h/.claude/x' }]).denies).toEqual(['home-read: .claude/x']);
  });

  it('denies external network access', () => {
    expect(analyze([{ k: 'net', host: 'example.com' }]).denies).toEqual(['network: example.com']);
  });

  it.each([{ k: 'net', host: 'localhost' }, { k: 'net', path: '/t/socket', host: 'example.com' }])(
    'allows local network event %j', (event) => {
      expect(analyze([event]).denies).toEqual([]);
    },
  );

  it.each([
    ['ls', '/t/x', [], ['tool: ls']],
    ['git', '/r/lane', [], ['checkout-cwd: git']],
    ['git', '/r/lane', ['-C', '/t/x'], []],
  ])('classifies %s at %s with args %j', (cmd, cwd, args, denies) => {
    expect(analyze([{ k: 'spawn', cmd, cwd, args }])).toEqual({ denies, traced: [], spawns: 1, reads: 0 });
  });

  it.each(['node', '/custom/node-runtime'])('traces the entry script for %s', (cmd) => {
    expect(analyze([{ k: 'spawn', cmd, cwd: '/t/x', args: ['/r/lane/s.mjs'] }])).toEqual({
      denies: [], traced: [{ path: '/r/lane/s.mjs', kind: 'file' }], spawns: 1, reads: 0,
    });
  });
});

describe('traced input hashing', () => {
  it('hashes contents, missing files and sorted directory entries with portable map labels', () => {
    const base = mkdtempSync(join(tmpdir(), 'tct-'));
    tempDirs.push(base);
    const root = join(base, 'lane');
    const fuiRoot = join(base, 'fui');
    const dir = join(root, 'd');
    mkdirSync(dir, { recursive: true });
    mkdirSync(fuiRoot);
    const file = { path: join(root, 'a.mjs'), kind: 'file' };
    const missing = { path: join(root, 'missing'), kind: 'file' };
    const listing = { path: dir, kind: 'dir' };
    const fui = { path: join(fuiRoot, 'b.mjs'), kind: 'file' };
    writeFileSync(file.path, 'first');
    writeFileSync(fui.path, 'fui');
    writeFileSync(join(dir, 'z'), 'z');
    writeFileSync(join(dir, 'a'), 'a');
    const sha = (value) => createHash('sha256').update(value).digest('hex');
    expect(hashTracedInput(file)).toBe(sha('first'));
    expect(hashTracedInput(missing)).toBe('absent');
    expect(hashTracedInput(listing)).toBe(sha('a\nz'));
    const inputs = [file, missing, listing, fui];
    const before = tracedMap(inputs, { root, fuiRoot });
    expect(before).toEqual({
      'file:a.mjs': sha('first'), 'file:missing': 'absent', 'dir:d': sha('a\nz'), 'file:@fui/b.mjs': sha('fui'),
    });
    expect(sameTracedMap(before, tracedMap([...inputs].reverse(), { root, fuiRoot }))).toBe(true);
    expect(sameTracedMap(before, { ...before, 'file:extra': 'absent' })).toBe(false);
    writeFileSync(file.path, 'second');
    const changed = tracedMap(inputs, { root, fuiRoot });
    expect(changed['file:a.mjs']).not.toBe(before['file:a.mjs']);
    expect(sameTracedMap(before, changed)).toBe(false);
    writeFileSync(join(dir, 'm'), 'm');
    expect(hashTracedInput(listing)).toBe(sha('a\nm\nz'));
    expect(hashTracedInput(listing)).not.toBe(before['dir:d']);
  });
});

describe('admission', () => {
  it('admits after three clean runs of the same digest and restarts for a new digest', () => {
    let state;
    for (let count = 1; count <= 3; count += 1) {
      state = nextAdmission(state, { clean: true, digest: 'same' });
      expect(state).toEqual({ cleanRuns: count, digest: 'same', status: 'clean', reasons: [], admitted: count === 3 });
      expect(isAdmitted(state)).toBe(count === 3);
    }
    expect(nextAdmission(state, { clean: true, digest: 'different' })).toEqual({
      cleanRuns: 1, digest: 'different', status: 'clean', reasons: [], admitted: false,
    });
    expect(nextAdmission(state, { clean: false, digest: 'same', reasons: ['tool: ls'] })).toEqual({
      cleanRuns: 0, digest: null, status: 'denied', reasons: ['tool: ls'], admitted: false,
    });
    expect(nextAdmission(state, { clean: false, digest: 'same' })).toEqual({
      cleanRuns: 0, digest: null, status: 'unclean', reasons: [], admitted: false,
    });
  });

  it.each([
    [undefined, false], [{ status: 'clean', cleanRuns: 2 }, false],
    [{ status: 'clean', cleanRuns: 3 }, true], [{ status: 'clean', cleanRuns: 4 }, true],
    [{ status: 'denied', cleanRuns: 3 }, false], [{ status: 'unclean', cleanRuns: 4 }, false],
  ])('checks admission for %j', (state, expected) => {
    expect(isAdmitted(state)).toBe(expected);
  });
});

describe('child trace parsing', () => {
  it('decodes file URLs, ignores non-file modules and junk, and flattens fs batches', () => {
    const read = { k: 'read', p: '/r/lane/a.mjs' };
    const list = { k: 'list', p: '/r/lane/d' };
    const stat = { k: 'stat', p: '/r/lane/b.mjs' };
    const lines = [
      JSON.stringify({ t: 'mod', u: 'file:///r/lane/a%20b.mjs' }),
      JSON.stringify({ t: 'mod', u: 'node:fs' }),
      JSON.stringify({ t: 'mod', u: 'https://example.com/a.mjs' }),
      'junk', '', '{', JSON.stringify({ t: 'other' }),
      JSON.stringify({ t: 'fs', events: [read, list] }),
      JSON.stringify({ t: 'fs', events: [stat] }),
    ];
    expect(parseChildTrace(lines.join('\n'))).toEqual([{ k: 'mod', p: '/r/lane/a b.mjs' }, read, list, stat]);
  });
});

describe('trace switches and sampling', () => {
  it.each([
    [{}, true], [{ CI: '1' }, false], [{ WE_TEST_CACHE: '0' }, false], [{ WE_TEST_CACHE_TRACE: '0' }, false],
  ])('evaluates trace enablement for %j', (env, expected) => {
    expect(traceEnabled(env)).toBe(expected);
  });

  it.each([{}, { WE_TEST_CACHE_TRACE_SAMPLE: '1' }, { WE_TEST_CACHE_TRACE_SAMPLE: '0' }, { WE_TEST_CACHE_TRACE_SAMPLE: '-2' }])(
    'always samples with %j', (env) => {
      for (let i = 0; i < 200; i += 1) expect(sampledForTrace(`file-${i}.mjs`, 'run', env)).toBe(true);
    },
  );

  it('samples roughly a quarter of 200 names when N=4', () => {
    const sampled = Array.from({ length: 200 }, (_, i) => sampledForTrace(`file-${i}.mjs`, 'run', {
      WE_TEST_CACHE_TRACE_SAMPLE: '4',
    })).filter(Boolean).length;
    expect(sampled).toBeGreaterThan(20);
    expect(sampled).toBeLessThan(80);
  });
});

describe('analyzeTrace — toolchain', () => {
  it('reads inside the node install dir are the toolchain (keyed by node version), not a home read', () => {
    const base = { root: '/r/lane', tmpRoots: ['/t'], home: '/h', closure: new Set(), execPath: '/h/.nvm/versions/node/v22/bin/node' };
    const out = analyzeTrace({ ...base, events: [{ k: 'read', p: '/h/.nvm/versions/node/v22/lib/x.js' }, { k: 'read', p: '/h/.npmrc' }] });
    expect(out.denies).toEqual(['home-read: .npmrc']);
  });
});
