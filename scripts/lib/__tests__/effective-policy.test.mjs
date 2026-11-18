import { describe, it, expect, vi } from 'vitest';
import { formatCascadeSourcesLine } from '../policy-cascade.mjs';
import { parseCascadeLines, effectiveForKeys, shadowWarnings, readEffectivePolicies } from '../effective-policy.mjs';
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
  it('maps nested keys per relevant daemon and retains unknown unreadable logs', () => {
    expect(effectiveForKeys({ review: parseCascadeLines(line(6, 'env')), unreadable: {}, unrelated: { host: {} } }, [key])).toEqual({
      [key]: { review: { value: 6, layer: 'env' }, unreadable: { value: null, layer: 'unknown' } },
    });
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
