/**
 * Pool-lane stale checkout evidence and alert boundaries, with hermetic filesystem/Git fixtures.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import smell from '../lane-stale-checkout.mjs';
import { probeLaneCheckouts } from '../../lane-checkout-probe.mjs';
import { stepEpisodes } from '../../health-watch-core.mjs';

const now = 1_800_000_000_000;
// Exercise the actual post-#6913 parser, including its schema guards.
const freshSource = readFileSync(resolve('scripts/readiness/forge-exec-run.mjs'), 'utf8');
const staleSource = 'export function parseTelemetry(text) { return JSON.parse(text); }';
const lane = (overrides = {}) => ({ pool: 'web-everything', lane: 1, head: 'abcdef123', behind: 0, behindSinceMs: null, headLagMs: 0, forgeExecHasPrune: true, ...overrides });
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
    { behind: 201, behindSinceMs: now - smell.maxBehindMs, headLagMs: smell.maxBehindMs },
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

  it.each([smell.maxBehindMs, 0, -1000])('does not alert for head lag within the threshold: %s', (headLagMs) => {
    expect(evaluate(lane({ headLagMs })).breach).toBe(false);
  });

  it('fails closed for a readable lane with null head lag', () => {
    const result = evaluate(lane({ headLagMs: null }));
    expect(result.breach).toBe(true);
    expect(result.summary).toContain('lag unverifiable');
  });

  it('alerts for fork point or local main over 24 hours behind the real main tip even with zero local lag', () => {
    const result = evaluate(lane({ headLagMs: smell.maxBehindMs + 1 }));
    expect(result.breach).toBe(true);
    expect(result.summary).toContain('lane fork point or local origin/main trails main tip');
    expect(result.measure.headLagMs).toBe(smell.maxBehindMs + 1);
  });

  it.each([
    { behindSinceMs: null, headLagMs: null },
    { behindSinceMs: null, headLagMs: 0 },
    { behindSinceMs: now, headLagMs: null },
  ])('fails closed for excessive commit lag with unknown age or head lag: %o', (lag) => {
    const result = evaluate(lane({ behind: 1000, ...lag }));
    expect(result.breach).toBe(true);
    expect(result.summary).toContain('lag unverifiable');
    expect(result.recommendation).toContain('lane-pool refresh/reclaim');
  });

  it('keeps missing lane episodes open until explicit non-breach observations close them', () => {
    const step = (state, rows, tick) => stepEpisodes(state, [{ smell, results: smell.evaluate({ laneCheckouts: rows }, { now: tick }) }], tick);
    const stale = lane({ behind: 1000 });
    let { state } = step({}, [stale], now);
    const opened = step(state, [stale], now + 1);
    expect(opened.transitions.map(t => t.type)).toEqual(['opened']);
    state = opened.state;
    const key = Object.keys(state.episodes)[0];
    for (let i = 0; i < smell.closeAfter; i++) {
      const missing = step(state, [], now + 2 + i);
      expect(missing.transitions).toEqual([]);
      expect(missing.state.episodes[key]).toMatchObject({ status: 'open', cleanStreak: 0 });
      state = missing.state;
    }
    const fresh = step(state, [lane()], now + 10);
    expect(fresh.state.episodes[key]).toMatchObject({ status: 'open', cleanStreak: 1 });
    const closed = step(fresh.state, [lane()], now + 11);
    expect(closed.transitions.map(t => t.type)).toEqual(['closed']);
    expect(closed.state.episodes[key]).toBeUndefined();
  });

  it('returns no observations when lane evidence is missing', () => {
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
    if (args[0] === 'merge-base') return 'fork-sha';
    if (args[0] === 'rev-list') return stale ? '201\n' : '0\n';
    if (args[0] === 'log' && args[1] === '-1') return `${now / 1000}\n`;
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
    const rows = probeLaneCheckouts({ poolRoot: root, readFile, git, now, mainTipTimeMs: now });
    expect(rows).toEqual([
      { pool: 'pool', lane: 1, head: '111111111', behind: 201, behindSinceMs: now - 2 * smell.maxBehindMs, headLagMs: 0, forgeExecHasPrune: false },
      { pool: 'pool', lane: 2, head: '222222222', behind: 0, behindSinceMs: null, headLagMs: 0, forgeExecHasPrune: true },
    ]);
    expect(smell.evaluate({ laneCheckouts: rows }, { now }).map((r) => r.breach)).toEqual([true, false]);
    expect(readFile).toHaveBeenCalledTimes(2);
    expect(git.mock.calls.every(([, options]) => options.timeout === 2000 && options.maxBuffer === 65536)).toBe(true);
    expect(git.mock.calls.some(([args]) => args[0] === 'fetch')).toBe(false);
    expect(git).toHaveBeenCalledWith(['rev-list', '--count', 'HEAD..origin/main'], expect.objectContaining({ cwd: join(root, 'pool', 'lane-1') }));
  });

  it('preserves commit lag when the fork point is unreadable', () => {
    addLane(root, 1, freshSource);
    const fixture = gitFixture();
    const git = vi.fn((args, options) => {
      if (args[0] === 'merge-base') throw new Error('not an ancestor');
      return fixture(args, options);
    });
    const [row] = probeLaneCheckouts({ poolRoot: root, git, now, mainTipTimeMs: now });
    expect(row).toMatchObject({ head: '111111111', behind: 201, behindSinceMs: now - 2 * smell.maxBehindMs, forgeExecHasPrune: true });
    expect(evaluate(row).breach).toBe(true);
    expect(git).toHaveBeenCalledWith(['merge-base', 'HEAD', 'origin/main'], expect.any(Object));
    expect(row.headLagMs).toBe(null);
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
    const git = vi.fn((args, options) => args[0] === 'log' && args.at(-1) === 'origin/main'
      ? String((now - 2 * smell.maxBehindMs) / 1000) : fixture(args, options));
    const [row] = probeLaneCheckouts({ poolRoot: root, git, now, mainTipTimeMs: now });
    expect(row).toMatchObject({ behind: 0, behindSinceMs: null, headLagMs: 2 * smell.maxBehindMs });
    expect(evaluate(row).breach).toBe(true);
    expect(git).toHaveBeenCalledWith(['log', '-1', '--format=%ct', 'origin/main'], expect.any(Object));
  });

  it('preserves unknown head lag when the host main-tip time is unavailable', () => {
    addLane(root, 2, freshSource);
    const [row] = probeLaneCheckouts({ poolRoot: root, git: gitFixture(), now, mainTipTimeMs: null });
    expect(row.headLagMs).toBe(null);
  });

  const tokens = `const legacy = {...v}; delete legacy.prune; delete legacy.diskUsedPct;
    validPruneStatus(v.prune); Number.isFinite(v.diskUsedPct);`;

  it('does not mistake unrelated prune/disk fields outside parseTelemetry for support', () => {
    addLane(root, 1, `${staleSource}\nfunction otherParser(text) { const v = JSON.parse(text); ${tokens} return v; }`);
    expect(probeLaneCheckouts({ poolRoot: root, git: gitFixture(), now })[0].forgeExecHasPrune).toBe(false);
  });

  it.each([
    `export function parseTelemetry(text) { /* ${tokens} */ return JSON.parse(text); }`,
    `// ${tokens.replaceAll('\n', '\n// ')}\n${staleSource}`,
    `export function parseTelemetry(text) { const mention = ${JSON.stringify(tokens)}; return JSON.parse(text); }`,
    `${staleSource}\nconst v = {}; ${tokens}`,
    `const mention = ${JSON.stringify(tokens)};\n${staleSource}`,
    `export function parseTelemetry(text) { return JSON.parse(text); const v = {}; ${tokens} }`,
  ])('rejects unreachable tokens, comments, strings and code outside the parser: %s', (source) => {
    addLane(root, 2, source);
    const [row] = probeLaneCheckouts({ poolRoot: root, git: gitFixture(), now });
    expect(row.forgeExecHasPrune).toBe(false);
    expect(evaluate(row).breach).toBe(true);
  });

  it.each([
    'export function parseTelemetry(text) { throw new Error("broken"); }',
    'export function parseTelemetry(text) { while (true) {} }',
    'export function parseTelemetry(text) { return process.env; }',
    'export function parseTelemetry(text) { return JSON.constructor("return process")(); }',
  ])('handles VM throws, timeout and unavailable host globals: %s', source => {
    addLane(root, 2, source);
    expect(probeLaneCheckouts({ poolRoot: root, git: gitFixture(), now })[0].forgeExecHasPrune).toBe(false);
  });

  it('terminates infinite Promise microtasks and proceeds with subsequent health work', () => {
    const scheduleLoop = 'Promise.resolve().then(() => { while (true) {} });';
    // Cover both the reported raw-JSON bypass and an otherwise valid parser:
    // neither a false nor a true synchronous result may let queued work escape.
    addLane(root, 1, `export function parseTelemetry(text) { ${scheduleLoop} return JSON.parse(text); }`);
    addLane(root, 2, freshSource.replace('export function parseTelemetry(text) {',
      `export function parseTelemetry(text) { ${scheduleLoop}`));
    addLane(root, 3, freshSource);
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
      const probeUrl = process.argv[1];
      const { probeLaneCheckouts } = await import(probeUrl);
      const { default: smell } = await import(new URL('./health-smells/lane-stale-checkout.mjs', probeUrl));
      const now = 1800000000000;
      const rows = probeLaneCheckouts({
        poolRoot: process.argv[2], now, mainTipTimeMs: now,
        git: args => args[0] === 'rev-parse' ? 'abcdef123'
          : args[0] === 'merge-base' ? 'fork'
          : args[0] === 'rev-list' ? '0' : String(now / 1000),
      });
      // A later event-loop turn proves no queued infinite microtask escaped.
      setImmediate(() => {
        const health = smell.evaluate({ laneCheckouts: rows }, { now });
        process.stdout.write(JSON.stringify({
          parsers: rows.map(row => row.forgeExecHasPrune),
          breaches: health.map(row => row.breach),
          recommendation: health[0].recommendation,
          subsequentHealthWork: true,
        }));
      });
    `, pathToFileURL(resolve('scripts/conveyor/lane-checkout-probe.mjs')).href, root], {
      encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(JSON.parse(output)).toMatchObject({
      parsers: [false, false, true], breaches: [true, true, false], subsequentHealthWork: true,
      recommendation: expect.stringContaining('lane-pool refresh/reclaim'),
    });
  }, 10_000);

  it('survives parser memory exhaustion and continues subsequent health work', () => {
    addLane(root, 1, 'export function parseTelemetry(text) { return new Array(4294967295).fill(0); }');
    addLane(root, 2, `export function parseTelemetry(text) {
      const held = []; while (true) held.push(new Array(100000).fill(0));
    }`);
    addLane(root, 3, freshSource);
    // Bound the test's parent too: a regression must fail this subprocess, never
    // take down Vitest. Production parser children have their own smaller cap.
    const output = execFileSync(process.execPath, ['--max-old-space-size=128', '--input-type=module', '-e', `
      const probeUrl = process.argv[1];
      const { probeLaneCheckouts } = await import(probeUrl);
      const { default: smell } = await import(new URL('./health-smells/lane-stale-checkout.mjs', probeUrl));
      const now = 1800000000000;
      const rows = probeLaneCheckouts({
        poolRoot: process.argv[2], now, mainTipTimeMs: now,
        git: args => args[0] === 'rev-parse' ? 'abcdef123'
          : args[0] === 'merge-base' ? 'fork'
          : args[0] === 'rev-list' ? '0' : String(now / 1000),
      });
      setImmediate(() => {
        const health = smell.evaluate({ laneCheckouts: rows }, { now });
        process.stdout.write(JSON.stringify({
          parsers: rows.map(row => row.forgeExecHasPrune),
          breaches: health.map(row => row.breach),
          recommendation: health[0].recommendation,
          subsequentHealthWork: true,
        }));
      });
    `, pathToFileURL(resolve('scripts/conveyor/lane-checkout-probe.mjs')).href, root], {
      encoding: 'utf8', timeout: 8000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(JSON.parse(output)).toMatchObject({
      parsers: [false, false, true], breaches: [true, true, false], subsequentHealthWork: true,
      recommendation: expect.stringContaining('lane-pool refresh/reclaim'),
    });
  }, 10_000);

  it.each(['// no parser', 'export function parseTelemetry('])('keeps unextractable source unknown: %s', source => {
    addLane(root, 2, source);
    expect(probeLaneCheckouts({ poolRoot: root, git: gitFixture(), now })[0].forgeExecHasPrune).toBe(null);
  });

  it('breaches for a fresh lane commit on an old fork point', () => {
    addLane(root, 2, freshSource);
    const fixture = gitFixture();
    const git = vi.fn((args, options) => args[0] === 'log' && args.at(-1) === 'fork-sha'
      ? String((now - 2 * smell.maxBehindMs) / 1000) : fixture(args, options));
    const [row] = probeLaneCheckouts({ poolRoot: root, git, now, mainTipTimeMs: now });
    expect(row).toMatchObject({ head: '222222222', behind: 0, headLagMs: 2 * smell.maxBehindMs });
    expect(evaluate(row).breach).toBe(true);
    expect(git).toHaveBeenCalledWith(['merge-base', 'HEAD', 'origin/main'], expect.any(Object));
    expect(git).toHaveBeenCalledWith(['log', '-1', '--format=%ct', 'fork-sha'], expect.any(Object));
    expect(git.mock.calls.some(([args]) => args[0] === 'log' && args.at(-1) === 'HEAD')).toBe(false);
  });

  it('keeps freshness unknown if either timestamp is unreadable', () => {
    addLane(root, 2, freshSource);
    const fixture = gitFixture();
    const git = (args, options) => args[0] === 'log' && args.at(-1) === 'origin/main'
      ? 'invalid' : fixture(args, options);
    const [row] = probeLaneCheckouts({ poolRoot: root, git, now, mainTipTimeMs: now });
    expect(row.headLagMs).toBe(null);
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
    expect(evaluate(row).breach).toBe(true);
    expect(evaluate(row).summary).toContain('lag unverifiable');
    expect(evaluate(row).recommendation).toContain('lane-pool refresh/reclaim');
  });

  it('returns no lanes only when the pool root is unconfigured', () => {
    expect(probeLaneCheckouts({ poolRoot: null })).toEqual([]);
  });

  it('throws for missing, non-directory or unreadable configured roots', () => {
    expect(() => probeLaneCheckouts({ poolRoot: '' })).toThrow();
    expect(() => probeLaneCheckouts({ poolRoot: join(root, 'missing') })).toThrow();
    writeFileSync(join(root, 'file'), '');
    expect(() => probeLaneCheckouts({ poolRoot: join(root, 'file') })).toThrow();
    expect(() => probeLaneCheckouts({ poolRoot: root, readdir: () => { throw new Error('EACCES'); } })).toThrow('EACCES');
  });

  it('throws when an existing root yields zero pools, including swallowed child read failures', () => {
    expect(() => probeLaneCheckouts({ poolRoot: root })).toThrow('no pools');
    addLane(root, 2, freshSource);
    expect(() => probeLaneCheckouts({ poolRoot: root, readdir: path => {
      if (path === root) return ['pool'];
      throw new Error('EACCES');
    } })).toThrow('no pools');
  });
});
