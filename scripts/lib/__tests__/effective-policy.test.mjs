import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { formatCascadeSourcesLine } from '../policy-cascade.mjs';
import { parseCascadeLines, effectiveForKeys, shadowWarnings, readEffectivePolicies, writeWithEffective } from '../effective-policy.mjs';
import { discoverDaemonLogPaths } from '../../operations/daemon-log-paths.mjs';

const key = 'reviewConcurrency.maxLiveReviewRounds';
const line = (value, layer) => formatCascadeSourcesLine('reviewConcurrency', { value: { maxLiveReviewRounds: value }, sources: { maxLiveReviewRounds: layer } });
describe('effective policy observations', () => {
  it('round-trips the existing formatter for all layers, nested leaves and JSON values', () => {
    const leafValues = { count: 8, flag: false, text: 'a, b (env)', object: { x: 2 }, array: [1, 2], nil: null, 'nested.cap': 3 };
    const layers = ['standard', 'platform', 'tool', 'env', 'operator-db'];
    const sources = Object.fromEntries(Object.keys(leafValues).map((leaf, i) => [leaf, layers[i % layers.length]]));
    const formatted = formatCascadeSourcesLine('test', { leafValues, sources });
    expect(parseCascadeLines(`[timestamp] ${formatted} · ignored invalid: test`)).toEqual({ test:
      Object.fromEntries(Object.entries(leafValues).map(([leaf, value]) => [leaf, { value, layer: sources[leaf] }])) });
  });
  it('keeps latest per policy, replacing absent/malformed leaves rather than retaining stale values', () => {
    expect(parseCascadeLines(`${line(8, 'operator-db')}\n${line(6, 'env')}`)).toEqual({ reviewConcurrency: { maxLiveReviewRounds: { value: 6, layer: 'env' } } });
    expect(parseCascadeLines(`${line(8, 'operator-db')}\npolicy-cascade · reviewConcurrency: maxLiveReviewRounds=bad (env)`)).toEqual({ reviewConcurrency: {} });
    expect(parseCascadeLines('noise')).toEqual({});
  });
  it('refuses formatter-truncated values and unknown layers', () => {
    expect(parseCascadeLines(formatCascadeSourcesLine('test', { value: 'a'.repeat(80), sources: { '': 'env' } }))).toEqual({ test: {} });
    expect(parseCascadeLines('policy-cascade · test: cap=8 (mystery)')).toEqual({ test: {} });
  });
  it('maps nested keys for every discovered daemon, including unrelated and unreadable logs', () => {
    expect(effectiveForKeys({ review: parseCascadeLines(line(6, 'env')), unreadable: {}, unrelated: { host: {} } }, [key])).toEqual({
      [key]: { review: { value: 6, layer: 'env' }, unreadable: { value: null, layer: 'unknown' }, unrelated: { value: null, layer: 'unknown' } },
    });
  });
  it('keeps a readable daemon with no requested policy line pending after another adopts', async () => {
    let published = false;
    const result = await writeWithEffective({ waitMs: 1 }, {
      read: () => readEffectivePolicies({ discover: () => ({ review: 'review', other: 'other' }),
        tail: path => {
          const text = path === 'other' ? 'policy-cascade · host: cap=2 (env)'
            : line(6, 'env') + (published ? '\n' + line(8, 'operator-db') : '');
          return { text, dev: 1, ino: 1, size: Buffer.byteLength(text), start: 0 };
        } }),
      write: () => ({ key, new: 8 }), now: () => 100, sleep: async () => { published = true; }, pollMs: 1,
    });
    expect(result.observation).toBe('timeout');
    expect(result.pending).toEqual([`${key}: no policy line seen (other)`]);
    expect(result.warnings[0]).toContain('other: effective value unavailable');
  });
  it.each([
    ['rotated log with old matching line and fresh unrelated activity', 2, 1, 'old', false, 'timeout'],
    ['inode changed despite an appended match', 2, 1, 'append', false, 'timeout'],
    ['device changed', 1, 2, 'append', false, 'timeout'],
    ['truncated log', 1, 1, 'truncate', false, 'timeout'],
    ['unreadable before write', 1, 1, 'append', true, 'timeout'],
    ['normal append after offset with unchanged mtime', 1, 1, 'append', false, 'observed'],
    ['identical policy line appended again', 1, 1, 'repeat', false, 'observed'],
    ['old matching line plus unrelated append', 1, 1, 'old', false, 'timeout'],
    ['line crossing the write offset', 1, 1, 'cross', false, 'timeout'],
  ])('proves freshness by byte offset: %s', async (_name, ino, dev, mode, unreadable, observation) => {
    let published = false;
    const matching = line(8, 'operator-db');
    const initial = mode === 'truncate' ? 'noise'.repeat(100) : mode === 'cross' ? matching.slice(0, 20)
      : mode === 'old' || mode === 'repeat' ? matching + '\n' : 'é before\n' + line(6, 'env') + '\n';
    const after = mode === 'truncate' ? matching + '\n' : mode === 'cross' ? matching + '\n'
      : initial + (mode === 'old' ? 'fresh unrelated activity\n' : matching + '\n');
    const result = await writeWithEffective({ waitMs: 1 }, {
      read: () => readEffectivePolicies({ discover: () => ({ review: 'review' }), tail: () => {
        if (!published && unreadable) throw Error('denied');
        const text = published ? after : initial;
        return { text, size: Buffer.byteLength(text), dev: published ? dev : 1,
          ino: published ? ino : 1, start: 0, mtimeMs: mode === 'append' && ino === 1 && dev === 1 ? 90 : published ? 101 : 90 };
      } }),
      write: () => ({ key, new: 8 }), now: () => 100, sleep: async () => { published = true; }, pollMs: 1,
    });
    expect(result.observation).toBe(observation);
    if (ino !== 1 || dev !== 1 || unreadable || mode === 'truncate')
      expect(result.pending[0]).toContain('log rotated/unverifiable; cannot prove the line is newer than the write');
    else expect(result.pending).toEqual(observation === 'observed' ? [] : [`${key}: not yet seen by review`]);
  });
  it('does not acknowledge a matching append before publication', async () => {
    let text = line(6, 'env') + '\n', published = false;
    const result = await writeWithEffective({ waitMs: 1 }, {
      read: () => readEffectivePolicies({ discover: () => ({ review: 'review' }),
        tail: () => ({ text, dev: 1, ino: 1, size: Buffer.byteLength(text), start: 0 }) }),
      write: async () => {
        // A daemon sees the previous matching override while publication is still waiting.
        await Promise.resolve();
        text += line(8, 'operator-db') + '\n';
        await Promise.resolve();
        published = true;
        return { key, new: 8 };
      },
      now: () => 100, sleep: async () => {}, pollMs: 1,
    });
    expect(published).toBe(true);
    expect(result.observation).toBe('timeout');
    expect(result.pending).toEqual([`${key}: not yet seen by review`]);
  });
  it.each(['unreadable boundary', 'line crossing boundary'])('refuses %s after publication', async mode => {
    const matching = line(8, 'operator-db') + '\n';
    let text = line(6, 'env') + '\n', reads = 0;
    const result = await writeWithEffective({ waitMs: 1 }, {
      read: () => readEffectivePolicies({ discover: () => ({ review: 'review' }), tail: () => {
        if (++reads === 2 && mode === 'unreadable boundary') throw Error('denied');
        return { text, dev: 1, ino: 1, size: Buffer.byteLength(text), start: 0 };
      } }),
      write: () => {
        if (mode === 'line crossing boundary') text += matching.slice(0, 20);
        return { key, new: 8 };
      },
      now: () => 100, sleep: async () => { text += mode === 'line crossing boundary' ? matching.slice(20) : matching; }, pollMs: 1,
    });
    expect(result.observation).toBe('timeout');
    expect(result.pending[0]).toContain(mode === 'unreadable boundary' ? 'log rotated/unverifiable' : 'not yet seen');
  });
  it('reads real bounded tails with a split UTF-8 prefix and observes only appended bytes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'effective-policy-'));
    const path = join(dir, 'daemon.log');
    try {
      const matching = line(8, 'operator-db') + '\n';
      writeFileSync(path, 'é'.repeat(100) + '\n' + matching);
      const run = append => writeWithEffective({ waitMs: 1 }, {
        read: () => readEffectivePolicies({ discover: () => ({ review: path }), maxBytes: Buffer.byteLength(matching) + 4 }),
        write: () => ({ key, new: 8 }),
        now: () => 100, sleep: async () => { appendFileSync(path, append); }, pollMs: 1,
      });
      expect((await run('x\n')).observation).toBe('timeout');
      expect((await run(matching)).observation).toBe('observed');
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
    expect(paths.review).toBe('/review-daemon.mjs.log');
    expect(paths.builder).toBe('/build-dispatch-daemon.mjs.log');
    expect(paths['pass:audit']).toBe('/pass-daemon.mjs.log');
    expect(paths.fix).toContain('fix-dispatch-daemon.log');
  });
});
