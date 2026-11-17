/**
 * Pool-lane stale checkout evidence and alert boundaries, with hermetic filesystem/Git fixtures.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import smell from '../lane-stale-checkout.mjs';
import { probeLaneCheckouts } from '../../lane-checkout-probe.mjs';

const now = 1_800_000_000_000;
const freshSource = `export function parseTelemetry(text) {
  const v = JSON.parse(text);
  const legacy = {...v};
  delete legacy.diskUsedPct; delete legacy.prune;
  if (('prune' in v && !validPruneStatus(v.prune))
    || ('diskUsedPct' in v && !Number.isFinite(v.diskUsedPct))) throw new Error('invalid');
  return v;
}
`;
const staleSource = 'export function parseTelemetry(text) { return JSON.parse(text); }';
const lane = (overrides = {}) => ({ pool: 'web-everything', lane: 1, head: 'abcdef123', behind: 0, behindSinceMs: null, headLagMs: null, forgeExecHasPrune: true, ...overrides });
const evaluate = (row, model = smell) => model.evaluate({ laneCheckouts: [row] }, { now })[0];

describe('lane-stale-checkout', () => {
  it('alerts for stale Forge handling with a pool/lane subject and product refresh recommendation', () => {
    const result = evaluate(lane({ forgeExecHasPrune: false }));
    expect(result.breach).toBe(true);
    expect(result.subject).toBe('lane-checkout:web-everything/lane-1');
    expect(result.summary).toContain('parseTelemetry lacks prune/diskUsedPct');
    expect(result.recommendation).toContain('product lane-pool refresh/reclaim');
    expect(result.recommendation).toContain('never by hand');
    expect(smell).toMatchObject({ id: 'lane-stale-checkout', scope: 'host', cadence: 'every-tick', probes: ['laneCheckouts'], openAfter: 2, closeAfter: 2, severity: 'high', action: 'alert' });
  });

  it('clears stale evidence once the lane is fresh', () => {
    expect(evaluate(lane()).breach).toBe(false);
  });

  it('alerts for a far-behind lane older than 24 hours and names the lag reason', () => {
    const result = evaluate(lane({ behind: 201, behindSinceMs: now - smell.maxBehindMs - 1 }));
    expect(result.breach).toBe(true);
    expect(result.summary).toContain('201 commits behind origin/main');
  });

  it.each([
    { behind: 200, behindSinceMs: now - smell.maxBehindMs - 1 },
    { behind: 201, behindSinceMs: now - smell.maxBehindMs },
    { behind: 1, behindSinceMs: now - 2 * smell.maxBehindMs },
  ])('does not alert for just-behind or insufficiently aged evidence: %o', (lag) => {
    expect(evaluate(lane(lag)).breach).toBe(false);
  });

  it('uses configurable commit and age thresholds', () => {
    expect(evaluate(lane({ behind: 3, behindSinceMs: now - 1001 }), { ...smell, maxBehindCommits: 2, maxBehindMs: 1000 }).breach).toBe(true);
  });

  it('fails closed when the Forge parser cannot be verified', () => {
    const result = evaluate(lane({ forgeExecHasPrune: null }));
    expect(result.breach).toBe(true);
    expect(result.summary).toContain('cannot verify forge telemetry parser');
  });

  it('fails closed when the lane HEAD is unreadable', () => {
    const result = evaluate(lane({ head: null }));
    expect(result.breach).toBe(true);
    expect(result.summary).toContain('lane checkout unreadable');
  });

  it.each([smell.maxBehindMs, 0, -1000, null])('does not alert for head lag within the threshold: %s', (headLagMs) => {
    expect(evaluate(lane({ headLagMs })).breach).toBe(false);
  });

  it('alerts for HEAD over 24 hours behind the real main tip even with zero local lag', () => {
    const result = evaluate(lane({ headLagMs: smell.maxBehindMs + 1 }));
    expect(result.breach).toBe(true);
    expect(result.summary).toContain('lane HEAD trails main tip');
    expect(result.measure.headLagMs).toBe(smell.maxBehindMs + 1);
  });

  it('retains the existing incomplete commit-lag behavior', () => {
    expect(evaluate(lane({ behind: 1000, behindSinceMs: null })).breach).toBe(false);
    expect(smell.evaluate({}, { now })).toEqual([]);
  });
});

describe('probeLaneCheckouts', () => {
  let root;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'lane-checkout-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });
  const addLane = (root, n, source) => {
    const dir = join(root, 'pool', `lane-${n}`, 'scripts', 'readiness');
    mkdirSync(dir, { recursive: true });
    if (source != null) writeFileSync(join(dir, 'forge-exec-run.mjs'), source);
  };
  const gitFixture = () => vi.fn((args, { cwd }) => {
    const stale = basename(cwd) === 'lane-1';
    if (args[0] === 'rev-parse') return stale ? '111111111111' : '222222222222';
    if (args[0] === 'merge-base') return '';
    if (args[0] === 'rev-list') return stale ? '201\n' : '0\n';
    if (args[0] === 'log') return `${(now - 2 * smell.maxBehindMs) / 1000}\n${now / 1000}\n`;
    throw new Error('unexpected git command');
  });

  it('walks only pools and returns stale and fresh lane evidence with injected file/Git IO', () => {
    addLane(root, 1, staleSource);
    addLane(root, 2, freshSource);
    mkdirSync(join(root, 'daemon-clone'));
    writeFileSync(join(root, 'sentinel'), 'not a pool');
    const git = gitFixture();
    const readFile = vi.fn(readFileSync);
    const rows = probeLaneCheckouts({ poolRoot: root, readFile, git, now });
    expect(rows).toEqual([
      { pool: 'pool', lane: 1, head: '111111111', behind: 201, behindSinceMs: now - 2 * smell.maxBehindMs, headLagMs: null, forgeExecHasPrune: false },
      { pool: 'pool', lane: 2, head: '222222222', behind: 0, behindSinceMs: null, headLagMs: null, forgeExecHasPrune: true },
    ]);
    expect(smell.evaluate({ laneCheckouts: rows }, { now }).map((r) => r.breach)).toEqual([true, false]);
    expect(readFile).toHaveBeenCalledTimes(2);
    expect(git.mock.calls.every(([, options]) => options.timeout === 2000 && options.maxBuffer === 65536)).toBe(true);
    expect(git.mock.calls.some(([args]) => args[0] === 'fetch')).toBe(false);
    expect(git).toHaveBeenCalledWith(['rev-list', '--count', 'HEAD..origin/main'], expect.objectContaining({ cwd: join(root, 'pool', 'lane-1') }));
  });

  it('measures lag for divergent HEADs without requiring ancestry', () => {
    addLane(root, 1, freshSource);
    const fixture = gitFixture();
    const git = vi.fn((args, options) => {
      if (args[0] === 'merge-base') throw new Error('not an ancestor');
      return fixture(args, options);
    });
    const [row] = probeLaneCheckouts({ poolRoot: root, git, now });
    expect(row).toMatchObject({ head: '111111111', behind: 201, behindSinceMs: now - 2 * smell.maxBehindMs, forgeExecHasPrune: true });
    expect(evaluate(row).breach).toBe(true);
    expect(git.mock.calls.some(([args]) => args[0] === 'merge-base')).toBe(false);
    expect(git).toHaveBeenCalledWith(['log', '--reverse', '--format=%ct', 'HEAD..origin/main'], expect.any(Object));
  });

  it('breaches on a missing Forge file even when HEAD is readable', () => {
    addLane(root, 2, null);
    const [row] = probeLaneCheckouts({ poolRoot: root, git: gitFixture(), now });
    expect(row.forgeExecHasPrune).toBe(null);
    expect(evaluate(row).breach).toBe(true);
    expect(evaluate(row).summary).toContain('cannot verify forge telemetry parser');
  });

  it('breaches when reading the Forge file fails', () => {
    addLane(root, 2, freshSource);
    const [row] = probeLaneCheckouts({ poolRoot: root, git: gitFixture(), now,
      readFile: () => { throw new Error('EACCES'); } });
    expect(row.forgeExecHasPrune).toBe(null);
    expect(evaluate(row).breach).toBe(true);
    expect(evaluate(row).summary).toContain('cannot verify forge telemetry parser');
  });

  it('breaches on unreadable HEAD even when the Forge parser is current', () => {
    addLane(root, 1, freshSource);
    const [row] = probeLaneCheckouts({ poolRoot: root, git: () => { throw new Error('timeout'); }, now });
    expect(row).toMatchObject({ head: null, behind: null, behindSinceMs: null, forgeExecHasPrune: true });
    expect(evaluate(row).breach).toBe(true);
    expect(evaluate(row).summary).toContain('lane checkout unreadable');
  });

  it('uses the host main-tip time when the lane origin/main is stale', () => {
    addLane(root, 2, freshSource);
    const fixture = gitFixture();
    const git = vi.fn((args, options) => args[0] === 'log' && args[1] === '-1'
      ? String((now - 2 * smell.maxBehindMs) / 1000) : fixture(args, options));
    const [row] = probeLaneCheckouts({ poolRoot: root, git, now, mainTipTimeMs: now });
    expect(row).toMatchObject({ behind: 0, behindSinceMs: null, headLagMs: 2 * smell.maxBehindMs });
    expect(evaluate(row).breach).toBe(true);
    expect(git).toHaveBeenCalledWith(['log', '-1', '--format=%ct', 'HEAD'], expect.any(Object));
  });

  it('preserves unknown head lag when the host main-tip time is unavailable', () => {
    addLane(root, 2, freshSource);
    const [row] = probeLaneCheckouts({ poolRoot: root, git: gitFixture(), now, mainTipTimeMs: null });
    expect(row.headLagMs).toBe(null);
  });

  it('does not mistake unrelated prune/disk fields outside parseTelemetry for support', () => {
    addLane(root, 1, `${staleSource}\n${freshSource.replace('parseTelemetry', 'otherParser')}`);
    expect(probeLaneCheckouts({ poolRoot: root, git: gitFixture(), now })[0].forgeExecHasPrune).toBe(false);
  });

  it.each([
    `export function parseTelemetry(text) { /* ${freshSource} */ return JSON.parse(text); }`,
    `// ${freshSource.replaceAll('\n', '\n// ')}\n${staleSource}`,
    `export function parseTelemetry(text) { const mention = ${JSON.stringify(freshSource)}; return JSON.parse(text); }`,
    `${staleSource}\n${freshSource.slice(freshSource.indexOf('{') + 1, freshSource.lastIndexOf('}'))}`,
    `const mention = ${JSON.stringify(freshSource)};\n${staleSource}`,
  ])('breaches when parser support appears only in comments, strings or outside its body: %s', (source) => {
    addLane(root, 2, source);
    const [row] = probeLaneCheckouts({ poolRoot: root, git: gitFixture(), now });
    expect(row.forgeExecHasPrune).toBe(false);
    expect(evaluate(row).breach).toBe(true);
  });

  it('keeps oversized Git output unknown and allows an operator refresh recommendation', () => {
    addLane(root, 1, freshSource);
    const git = (args, options) => {
      if (args[0] === 'log') throw new Error('maxBuffer exceeded');
      return gitFixture()(args, options);
    };
    const [row] = probeLaneCheckouts({ poolRoot: root, git, now });
    expect(row).toMatchObject({ behind: 201, behindSinceMs: null, headLagMs: null, forgeExecHasPrune: true });
    expect(evaluate(row).breach).toBe(false);
    expect(evaluate(row).recommendation).toContain('lane-pool refresh/reclaim');
  });

  it('returns no lanes for null, missing or non-directory roots', () => {
    expect(probeLaneCheckouts({ poolRoot: null })).toEqual([]);
    expect(probeLaneCheckouts({ poolRoot: join(root, 'missing') })).toEqual([]);
    writeFileSync(join(root, 'file'), '');
    expect(probeLaneCheckouts({ poolRoot: join(root, 'file') })).toEqual([]);
  });
});
