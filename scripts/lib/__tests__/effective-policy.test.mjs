import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { formatCascadeSourcesLine } from '../policy-cascade.mjs';
import { readCascadeGenerationWatermark, parseCascadeLines, effectiveForKeys, shadowWarnings, readEffectivePolicies, writeWithEffective, effectiveOverrideReport } from '../effective-policy.mjs';
import { discoverDaemonLogPaths } from '../../operations/daemon-log-paths.mjs';

const key = 'reviewConcurrency.maxLiveReviewRounds';
const line = (value, layer, generation) => formatCascadeSourcesLine('reviewConcurrency', { value: { maxLiveReviewRounds: value }, generation, sources: { maxLiveReviewRounds: layer } });
describe('effective policy observations', () => {
  it('round-trips the existing formatter for all layers, nested leaves and JSON values', () => {
    const leafValues = { count: 8, flag: false, text: 'a, b (env)', object: { x: 2 }, array: [1, 2], nil: null, 'nested.cap': 3 };
    const layers = ['standard', 'platform', 'tool', 'env', 'operator-db'];
    const sources = Object.fromEntries(Object.keys(leafValues).map((leaf, i) => [leaf, layers[i % layers.length]]));
    const formatted = formatCascadeSourcesLine('test', { leafValues, sources });
    expect(parseCascadeLines(`[timestamp] ${formatted} · ignored invalid: test`)).toEqual({ test:
      { gen: null, leaves: Object.fromEntries(Object.entries(leafValues).map(([leaf, value]) => [leaf, { value, layer: sources[leaf] }])) } });
  });
  it('keeps latest per policy, replacing absent/malformed leaves rather than retaining stale values', () => {
    expect(parseCascadeLines(`${line(8, 'operator-db')}\n${line(6, 'env')}`)).toEqual({ reviewConcurrency: { gen: null, leaves: { maxLiveReviewRounds: { value: 6, layer: 'env' } } } });
    expect(parseCascadeLines(`${line(8, 'operator-db')}\npolicy-cascade · reviewConcurrency: maxLiveReviewRounds=bad (env)`)).toEqual({ reviewConcurrency: { gen: null, leaves: {} } });
    expect(parseCascadeLines('noise')).toEqual({});
  });
  it('refuses formatter-truncated values and unknown layers', () => {
    expect(parseCascadeLines(formatCascadeSourcesLine('test', { value: 'a'.repeat(80), sources: { '': 'env' } }))).toEqual({ test: { gen: null, leaves: {} } });
    expect(parseCascadeLines('policy-cascade · test: cap=8 (mystery)')).toEqual({ test: { gen: null, leaves: {} } });
  });
  it('maps nested keys for every discovered daemon, including unrelated and unreadable logs', () => {
    expect(effectiveForKeys({ review: parseCascadeLines(line(6, 'env')), unreadable: {}, unrelated: { host: {} } }, [key])).toEqual({
      [key]: { review: { value: 6, layer: 'env', gen: null }, unreadable: { value: null, layer: 'unknown', gen: null }, unrelated: { value: null, layer: 'unknown', gen: null } },
    });
  });
  it.each([
    ['matching generation', 3, 'operator-db', 'observed'],
    ['later generation', 4, 'operator-db', 'observed'],
    ['environment shadow', 3, 'env', 'observed'],
    ['lower generation', 2, 'operator-db', 'timeout'],
    ['missing generation', undefined, 'operator-db', 'timeout'],
    ['unknown generation', null, 'operator-db', 'timeout'],
  ])('%s confirms only generation evidence', async (_name, gen, layer, observation) => {
    const result = await writeWithEffective({ waitMs: 1 }, {
      read: () => ({ review: parseCascadeLines(line(8, layer, gen)) }),
      write: () => ({ key, new: 8, generation: 3 }), now: () => 100, sleep: async () => {}, pollMs: 1,
    });
    expect(result.observation).toBe(observation);
    expect(result.pending).toEqual(observation === 'observed' ? [] : [`${key}: unconfirmed (review: last seen gen ${gen ?? 'unknown'})`]);
    if (layer === 'env') expect(result.warnings[0]).toContain('env shadows');
  });
  it('round-trips generation suffix including invalid leaves and unknown generation', () => {
    for (const generation of [0, 42, null]) {
      const text = formatCascadeSourcesLine('test', { value: { cap: 8 }, sources: { cap: 'env' }, invalid: ['bad'], generation });
      expect(parseCascadeLines(text)).toEqual({ test: { gen: generation, leaves: { cap: { value: 8, layer: 'env' } } } });
    }
  });
  it('keeps no-line, unreadable and unreported-value daemons unconfirmed while another adopts', async () => {
    const result = await writeWithEffective({ waitMs: 1 }, {
      read: () => readEffectivePolicies({ discover: () => ({ review: 'ok', other: 'other', bad: 'bad', malformed: 'malformed' }), tail: path => {
        if (path === 'bad') throw Error('denied');
        return { text: path === 'ok' ? line(8, 'operator-db', 3) : path === 'malformed'
          ? 'policy-cascade · reviewConcurrency: maxLiveReviewRounds=bad (env) · operator-gen=3' : 'unrelated' };
      } }),
      write: () => ({ key, new: 8, generation: 3 }), now: () => 0, sleep: async () => {}, pollMs: 1,
    });
    expect(result.observation).toBe('timeout');
    expect(result.pending).toEqual(['other', 'bad', 'malformed'].map(d => `${key}: unconfirmed (${d}: last seen gen ${d === 'malformed' ? 3 : 'unknown'})`));
  });
  it('accepts adoption during an asynchronous write without needing another log append', async () => {
    let text = line(6, 'env', 2);
    const result = await writeWithEffective({ waitMs: 1 }, {
      read: () => ({ review: parseCascadeLines(text) }),
      write: async () => { await Promise.resolve(); text = line(8, 'operator-db', 3); return { key, new: 8, generation: 3 }; },
      sleep: async () => { throw Error('already observed'); },
    });
    expect(result.observation).toBe('observed');
  });
  it('reads bounded real UTF-8 tails without filesystem freshness metadata', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'effective-policy-'));
    const path = join(dir, 'daemon.log');
    try {
      const matching = line(8, 'operator-db', 3) + '\n';
      writeFileSync(path, 'é'.repeat(100) + '\n' + matching);
      expect(readEffectivePolicies({ discover: () => ({ review: path }), maxBytes: Buffer.byteLength(matching) + 4 }))
        .toEqual({ review: parseCascadeLines(matching) });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('warns once per key on env-shadow, value mismatch, and missing evidence; operator-db match is clean', () => {
    expect(shadowWarnings({ [key]: 8 }, { [key]: { review: { value: 6, layer: 'env' } } })[0]).toContain('env shadows');
    expect(shadowWarnings({ [key]: 8 }, { [key]: { review: { value: 8, layer: 'operator-db' } } })).toEqual([]);
    expect(shadowWarnings({ [key]: 8 }, { [key]: { review: { value: 7, layer: 'operator-db' } } })).toHaveLength(1);
    expect(shadowWarnings({ [key]: 8 }, {})).toHaveLength(1);
  });
  it('bounds each tail, fails soft per unreadable log, and discards a partial first line', () => {
    const tail = vi.fn(path => {
      if (path === 'bad') throw Error('unreadable');
      if (path === 'missing') return null;
      if (path === 'error') return { error: 'denied' };
      return { text: `${line(8, 'operator-db')}\n${line(6, 'env')}`, truncated: true };
    });
    const parsed = readEffectivePolicies({ discover: () => ({ review: 'ok', bad: 'bad', missing: 'missing', error: 'error' }), tail, maxBytes: 128 });
    expect(parsed).toEqual({ review: parseCascadeLines(line(6, 'env')), bad: {}, missing: {}, error: {} });
    expect(tail.mock.calls.every(([, opts]) => opts.maxBytes === 128)).toBe(true);
    expect(readEffectivePolicies({ discover: () => ({ review: 'huge' }), tail: () => ({ text: line(8, 'operator-db'), truncated: true }) })).toEqual({ review: {} });
    expect(readEffectivePolicies({ discover: () => { throw Error('denied'); } })).toEqual({});
  });
  it('reuses plist discovery and default/pass paths, isolating bad plists', () => {
    const paths = discoverDaemonLogPaths({ home: 'home', coordinationRoot: 'coord',
      listFiles: path => path.endsWith('LaunchAgents') ? [] : ['pass-daemon.audit.log'],
      listPlists: () => ['review', 'broken', 'build', 'pass'],
      readPlist: path => {
        if (path.includes('broken')) throw Error('bad plist');
        const script = path.includes('build') ? '/build-dispatch-daemon.mjs' : path.includes('pass') ? '/pass-daemon.mjs' : '/review-daemon.mjs';
        return { ProgramArguments: ['node', script, '--pass=audit'], StandardOutPath: `${script}.log` };
      },
    });
    expect(paths.review.path).toBe('/review-daemon.mjs.log');
    expect(paths.build.path).toBe('/build-dispatch-daemon.mjs.log');
    expect(paths.pass.path).toBe('/pass-daemon.mjs.log');
    expect(paths.fix.path).toContain('fix-dispatch-daemon.log');
  });
});

it('show reports logged generations after clear and marks missing/lower evidence stale', () => {
  const report = effectiveOverrideReport({}, {
    current: parseCascadeLines(line(6, 'env', 3)), stale: parseCascadeLines(line(8, 'operator-db', 2)), absent: {},
  }, 3);
  expect(report.generation).toBe(3);
  expect(report.effective.find(row => row.key === key)).toEqual({ key, override: null, daemons: {
    current: { gen: 3, value: 6, layer: 'env', status: 'confirmed' },
    stale: { gen: 2, value: 8, layer: 'operator-db', status: 'stale/unconfirmed' },
    absent: { gen: null, value: null, layer: 'unknown', status: 'stale/unconfirmed' },
  } });
});

it('a latest legacy or unknown line replaces earlier generation evidence', () => {
  for (const gen of [undefined, null]) {
    const parsed = parseCascadeLines(line(8, 'operator-db', 4) + '\n' + line(8, 'operator-db', gen));
    expect(parsed.reviewConcurrency.gen).toBeNull();
  }
});

it('retains and waits for both labels of one daemon family', async () => {
  const paths = discoverDaemonLogPaths({ home: 'home', coordinationRoot: 'coord',
    listFiles: () => [], listPlists: () => ['review-one', 'review-two'],
    readPlist: path => ({ ProgramArguments: ['node', '/review-daemon.mjs'], StandardOutPath: path + '.log' }),
  });
  expect(paths['review-one']).toEqual({ family: 'review', path: expect.stringContaining('review-one.plist.log') });
  expect(paths['review-two']).toEqual({ family: 'review', path: expect.stringContaining('review-two.plist.log') });
  let adopted = false;
  const tail = vi.fn(path => ({ text: line(8, 'operator-db', path.includes('review-two') && !adopted ? 2 : 3) }));
  const sleep = vi.fn(async () => { adopted = true; });
  const result = await writeWithEffective({ waitMs: 1 }, {
    read: () => readEffectivePolicies({ discover: () => paths, tail }),
    write: () => ({ key, new: 8, generation: 3 }), now: () => 0, sleep, pollMs: 1,
  });
  expect(sleep).toHaveBeenCalledOnce();
  expect(result.observation).toBe('observed');
  expect(result.after[key]).toHaveProperty('review-one');
  expect(result.after[key]).toHaveProperty('review-two');
});

it('generation recovery scans earlier higher lines across all discovered labels', () => {
  const discover = () => ({ one: { family: 'review', path: 'one' }, two: { family: 'review', path: 'two' } });
  const tail = vi.fn(path => ({ text: path === 'one' ? line(8, 'env', 9000) + '\n' + line(8, 'env', 2) : line(8, 'env', 10000) }));
  expect(readCascadeGenerationWatermark({ discover, tail })).toEqual({ max: 10000, complete: true });
  expect(tail.mock.calls.every(([, options]) => options.requireComplete)).toBe(true);
});
it.each(['unreadable', 'oversized', 'missing', 'unknown'])('generation recovery refuses %s evidence', mode => {
  expect(readCascadeGenerationWatermark({ discover: () => ({ review: 'log' }), tail: () => {
    if (mode === 'unreadable') throw Error('denied');
    return mode === 'missing' ? null : { text: line(8, 'env', mode === 'unknown' ? null : 9000), truncated: mode === 'oversized' };
  } }).complete).toBe(false);
  expect(readCascadeGenerationWatermark({ discover: () => { throw Error('plist unavailable'); } }).complete).toBe(false);
});
it('oversized real logs leave recovery incomplete instead of trusting a bounded tail', () => {
  const dir = mkdtempSync(join(tmpdir(), 'generation-bound-'));
  const path = join(dir, 'daemon.log');
  try {
    writeFileSync(path, line(8, 'env', 9000) + '\n' + line(8, 'env', 2));
    expect(readCascadeGenerationWatermark({ discover: () => ({ review: path }), maxBytes: 32 })).toEqual({ max: 0, complete: false });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it.each([['empty', ''], ['non-cascade-only', 'daemon started\nwaiting for work\n']])('generation recovery requires evidence in every readable log: %s', (_name, text) => {
  expect(readCascadeGenerationWatermark({
    discover: () => ({ observed: 'observed', rotated: 'rotated' }),
    tail: path => ({ text: path === 'observed' ? line(8, 'env', 9000) : text }),
  })).toEqual({ max: 9000, complete: false });
});
