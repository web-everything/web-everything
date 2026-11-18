import { describe, it, expect } from 'vitest';
import { ghRepoSlug } from '../../lib/constellation-repos.mjs';
import { parseArgs, awaitCondition, main, cloneDir, assertCloneRoot } from '../await.mjs';

const SHA = 'abc123def456abc123def456abc123def456abcd';
const CLONE = 'wev-fix-daemon';
const RUN = {
  databaseId: 123, status: 'completed', conclusion: 'success',
  url: 'https://github.com/example/project/actions/runs/123', headSha: SHA,
};

// Every process call and wait is in memory. Exhausted scripts fail loudly rather
// than accidentally reaching a real gh/git runner or spinning a fake clock forever.
function harness(responses) {
  let clock = 0;
  const calls = [];
  const sleeps = [];
  const remaining = [...responses];
  return {
    calls, sleeps,
    io: {
      exec(file, args) {
        calls.push([file, args]);
        expect(remaining.length, 'unexpected extra process call').toBeGreaterThan(0);
        const response = remaining.shift();
        if (response instanceof Error) throw response;
        return response;
      },
      now: () => clock,
      sleep(ms) {
        expect(ms).toBeGreaterThanOrEqual(30000);
        expect(Number.isFinite(ms)).toBe(true);
        sleeps.push(ms);
        clock += ms;
        expect(sleeps.length, 'polling must terminate').toBeLessThanOrEqual(20);
      },
    },
  };
}

const ciArgs = ['--kind', 'ci-run', '--branch', 'lane/await'];
const adoptionArgs = ['--kind', 'adoption', '--clone', CLONE, '--sha', SHA];
const prArgs = ['--kind', 'pr', '--pr', '42'];
const ciCall = (withSha = false) => ['gh', [
  'run', 'list', '--branch', 'lane/await',
  ...(withSha ? ['--commit', SHA] : []),
  '--limit', '1', '--json', 'databaseId,status,conclusion,url,headSha',
]];
const adoptionCall = ['git', ['-C', cloneDir(CLONE), 'merge-base', '--is-ancestor', SHA, 'HEAD']];
const prCall = ['gh', ['pr', 'view', '42', '--repo', ghRepoSlug('we'), '--json', 'state,labels']];

describe('parseArgs', () => {
  it('parses CI options with the default nine-minute wait and empty label lists', () => {
    expect(parseArgs([...ciArgs, '--sha', SHA])).toMatchObject({
      kind: 'ci-run', branch: 'lane/await', sha: SHA,
      labelsPresent: [], labelsAbsent: [], waitMs: 540000, json: false,
    });
  });

  it('parses adoption options and an explicit wait budget', () => {
    expect(parseArgs([...adoptionArgs, '--wait-ms', '60000'])).toMatchObject({
      kind: 'adoption', clone: CLONE, sha: SHA, waitMs: 60000,
    });
  });

  it('parses merged state, repeated label predicates, and JSON output', () => {
    expect(parseArgs([
      ...prArgs, '--state=merged', '--label-present', 'ready',
      '--label-present', 'reviewed', '--label-absent', 'blocked',
      '--label-absent', 'needs human', '--json',
    ])).toMatchObject({
      kind: 'pr', pr: 42, state: 'merged', json: true,
      labelsPresent: ['ready', 'reviewed'], labelsAbsent: ['blocked', 'needs human'],
    });
  });

  it('caps oversized wait budgets at 540000 ms', () => {
    expect(parseArgs([...ciArgs, '--wait-ms', '999999999']).waitMs).toBe(540000);
  });

  it.each([
    [], ['--kind', 'unknown'], ['--kind'],
    ['--kind', 'ci-run'], [...ciArgs, '--sha'],
    ['--kind', 'adoption', '--sha', SHA],
    ['--kind', 'adoption', '--clone', CLONE],
    ['--kind', 'adoption', '--clone', '.lanes/web-everything/lane-22', '--sha', SHA],
    ['--kind', 'adoption', '--clone', 'adoption-clone', '--sha', SHA],
    ['--kind', 'pr', '--state=merged'], [...prArgs],
    ['--kind', 'pr', '--pr', 'nope', '--state=merged'],
    ['--kind', 'pr', '--pr', '-1', '--state=merged'],
    [...prArgs, '--state=unknown'], [...prArgs, '--label-present'],
    [...prArgs, '--label-absent'], [...ciArgs, '--unknown'],
    [...ciArgs, '--wait-ms'], [...ciArgs, '--wait-ms', '-1'],
    [...ciArgs, '--wait-ms', 'NaN'], [...ciArgs, '--wait-ms', '1.5'],
  ])('rejects invalid or incomplete arguments: %j', (...argv) => {
    expect(() => parseArgs(argv)).toThrow(Error);
  });
});

describe('awaitCondition: ci-run', () => {
  it('returns a completed successful run using only the injected gh runner', () => {
    const h = harness([JSON.stringify([RUN])]);
    expect(awaitCondition(parseArgs([...ciArgs, '--sha', SHA]), h.io)).toMatchObject({
      done: true, kind: 'ci-run', conclusion: 'success', runId: 123, url: RUN.url,
    });
    expect(h.calls).toEqual([ciCall(true)]);
    expect(h.sleeps).toEqual([]);
  });

  it('treats a completed failure as done, preserving its conclusion', () => {
    const h = harness([JSON.stringify([{ ...RUN, conclusion: 'failure' }])]);
    expect(awaitCondition(parseArgs(ciArgs), h.io)).toMatchObject({
      done: true, kind: 'ci-run', conclusion: 'failure', runId: 123, url: RUN.url,
    });
    expect(h.calls).toEqual([ciCall()]);
    expect(h.sleeps).toEqual([]);
  });

  it('polls through no run and an incomplete run before completion', () => {
    const h = harness([
      '[]', JSON.stringify([{ ...RUN, status: 'in_progress', conclusion: null }]),
      JSON.stringify([RUN]),
    ]);
    const result = awaitCondition(parseArgs([...ciArgs, '--wait-ms', '90000']), h.io);
    expect(result).toMatchObject({ done: true, conclusion: 'success' });
    expect(h.calls).toEqual([ciCall(), ciCall(), ciCall()]);
    expect(h.sleeps).toHaveLength(2);
  });

  it('times out with a resumable command when no run appears', () => {
    const h = harness(Array(20).fill('[]'));
    const result = awaitCondition(parseArgs([...ciArgs, '--wait-ms', '60000']), h.io);
    expect(result).toMatchObject({
      done: false, timedOut: true,
      resumeWith: 'node scripts/operations/run.mjs await --kind ci-run --branch lane/await --wait-ms 60000',
    });
    expect(h.calls.length).toBeGreaterThan(0);
    expect(h.calls.length).toBeLessThanOrEqual(3);
    expect(h.calls.every(call => JSON.stringify(call) === JSON.stringify(ciCall()))).toBe(true);
    expect(h.sleeps.reduce((sum, ms) => sum + ms, 0)).toBe(60000);
  });

  it('does not claim completion when the run remains queued until the deadline', () => {
    const h = harness(Array(20).fill(JSON.stringify([
      { ...RUN, status: 'queued', conclusion: null },
    ])));
    expect(awaitCondition(parseArgs([...ciArgs, '--wait-ms', '30000']), h.io))
      .toMatchObject({ done: false, timedOut: true });
  });
});

describe('awaitCondition: adoption', () => {
  it('returns adopted immediately when the injected git runner succeeds', () => {
    const h = harness(['']);
    expect(awaitCondition(parseArgs(adoptionArgs), h.io)).toMatchObject({ done: true, adopted: true });
    expect(h.calls).toEqual([adoptionCall]);
    expect(h.sleeps).toEqual([]);
  });

  it('polls after a thrown git result and then observes adoption', () => {
    const h = harness([new Error('not an ancestor'), '']);
    expect(awaitCondition(parseArgs(adoptionArgs), h.io)).toMatchObject({ done: true, adopted: true });
    expect(h.calls).toEqual([adoptionCall, adoptionCall]);
    expect(h.sleeps).toHaveLength(1);
  });

  it('fails closed with adopted false when git keeps throwing until timeout', () => {
    const h = harness(Array.from({ length: 20 }, () => new Error('not an ancestor')));
    expect(awaitCondition(parseArgs([...adoptionArgs, '--wait-ms', '60000']), h.io))
      .toMatchObject({ done: false, adopted: false, timedOut: true, resumeWith: expect.any(String) });
    expect(h.calls.length).toBeLessThanOrEqual(3);
    expect(h.calls).toEqual(h.calls.map(() => adoptionCall));
    expect(h.sleeps.reduce((sum, ms) => sum + ms, 0)).toBe(60000);
  });
});

describe('awaitCondition: pr', () => {
  it('matches MERGED immediately via the injected gh runner', () => {
    const h = harness([JSON.stringify({ state: 'MERGED', labels: [] })]);
    expect(awaitCondition(parseArgs([...prArgs, '--state=merged']), h.io)).toMatchObject({ done: true });
    expect(h.calls).toEqual([prCall]);
    expect(h.sleeps).toEqual([]);
  });

  it('waits until a forbidden label disappears', () => {
    const h = harness([
      JSON.stringify({ state: 'OPEN', labels: [{ name: 'blocked' }] }),
      JSON.stringify({ state: 'OPEN', labels: [] }),
    ]);
    expect(awaitCondition(parseArgs([...prArgs, '--label-absent', 'blocked']), h.io))
      .toMatchObject({ done: true });
    expect(h.calls).toEqual([prCall, prCall]);
    expect(h.sleeps).toHaveLength(1);
  });

  it('requires state and every present/absent label predicate together', () => {
    const view = (state, names) => JSON.stringify({ state, labels: names.map(name => ({ name })) });
    const h = harness([
      view('CLOSED', ['ready', 'reviewed']), view('MERGED', ['ready']),
      view('MERGED', ['ready', 'reviewed', 'blocked']),
      view('MERGED', ['ready', 'reviewed']),
    ]);
    const result = awaitCondition(parseArgs([
      ...prArgs, '--state=merged', '--label-present', 'ready',
      '--label-present', 'reviewed', '--label-absent', 'blocked', '--wait-ms', '120000',
    ]), h.io);
    expect(result).toMatchObject({ done: true });
    expect(h.calls).toEqual([prCall, prCall, prCall, prCall]);
    expect(h.sleeps).toHaveLength(3);
  });

  it('times out while the PR remains open and supplies a resume command', () => {
    const h = harness(Array(20).fill(JSON.stringify({ state: 'OPEN', labels: [] })));
    expect(awaitCondition(parseArgs([...prArgs, '--state=merged', '--wait-ms', '60000']), h.io))
      .toMatchObject({ done: false, timedOut: true, resumeWith: expect.any(String) });
    expect(h.calls.length).toBeLessThanOrEqual(3);
    expect(h.sleeps.reduce((sum, ms) => sum + ms, 0)).toBe(60000);
  });
});

describe('polling bounds and resume options', () => {
  it('never sleeps less than 30000 ms and times out without sleeping on a shorter budget', () => {
    const h = harness(Array(20).fill('[]'));
    expect(awaitCondition(parseArgs([...ciArgs, '--wait-ms', '1']), h.io))
      .toMatchObject({ done: false, timedOut: true });
    expect(h.sleeps).toHaveLength(0);
  });

  it.each([
    [...ciArgs, '--sha', SHA, '--wait-ms', '30000', '--json'],
    // A simple portable path keeps this round-trip independent of shell quoting style.
    ['--kind', 'adoption', '--clone', 'wev-merge-daemon', '--sha', SHA, '--wait-ms', '30000'],
    [...prArgs, '--state=merged', '--label-present', 'ready', '--label-absent', 'blocked', '--wait-ms', '30000'],
    [...ciArgs, '--wait-ms', '999999999'],
  ])('rebuilds a resume command retaining parsed options: %j', (...argv) => {
    const opts = parseArgs(argv);
    const pending = opts.kind === 'adoption' ? new Error('not adopted')
      : opts.kind === 'pr' ? JSON.stringify({ state: 'OPEN', labels: [{ name: 'blocked' }] }) : '[]';
    const h = harness(Array(20).fill(pending));
    const result = awaitCondition(opts, h.io);
    const prefix = 'node scripts/operations/run.mjs await ';
    expect(result).toMatchObject({ done: false, timedOut: true });
    expect(result.resumeWith.startsWith(prefix)).toBe(true);
    expect(result.resumeWith).toMatch(/--wait-ms(?:=| )\d+/);
    expect(parseArgs(result.resumeWith.slice(prefix.length).split(/\s+/))).toEqual(opts);
  });
});

describe('main', () => {
  it('prints one JSON line and returns 0 for a completed condition', () => {
    const h = harness([JSON.stringify([RUN])]);
    const output = [];
    expect(main([...ciArgs, '--json'], { ...h.io, out: text => output.push(text) })).toBe(0);
    expect(output).toHaveLength(1);
    const lines = output.join('').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ done: true, conclusion: 'success', runId: 123 });
    expect(h.calls).toEqual([ciCall()]);
  });

  it('prints readable text when JSON is not requested', () => {
    const h = harness([JSON.stringify([RUN])]);
    const output = [];
    expect(main(ciArgs, { ...h.io, out: text => output.push(text) })).toBe(0);
    expect(output.join('')).toMatch(/success/i);
    expect(() => JSON.parse(output.join(''))).toThrow();
  });

  it('returns 0 for a completed CI failure', () => {
    const h = harness([JSON.stringify([{ ...RUN, conclusion: 'failure' }])]);
    const output = [];
    expect(main([...ciArgs, '--json'], { ...h.io, out: text => output.push(text) })).toBe(0);
    expect(JSON.parse(output.join(''))).toMatchObject({ done: true, conclusion: 'failure' });
  });

  it('prints a JSON timeout and returns 75 when the condition is not done', () => {
    const h = harness(Array(20).fill('[]'));
    const output = [];
    expect(main([...ciArgs, '--wait-ms', '30000', '--json'], {
      ...h.io, out: text => output.push(text),
    })).toBe(75);
    expect(output).toHaveLength(1);
    expect(JSON.parse(output.join(''))).toMatchObject({
      done: false, timedOut: true, resumeWith: expect.any(String),
    });
  });

  it('returns 2 for usage errors without executing commands or sleeping', () => {
    const h = harness([]);
    const output = [];
    expect(main(['--kind', 'unknown'], { ...h.io, out: text => output.push(text) })).toBe(2);
    expect(output.join('').trim().length).toBeGreaterThan(0);
    expect(h.calls).toEqual([]);
    expect(h.sleeps).toEqual([]);
  });
});

describe('adoption hardening', () => {
  it('refuses an abbreviated --sha for adoption', () => {
    expect(() => parseArgs(['--kind', 'adoption', '--clone', CLONE, '--sha', 'abc123def456'])).toThrow(/40-hex/);
  });

  const ws = '/w';
  it('accepts a clone whose realpath equals its registry root', () => {
    const realpath = p => ({ '/w': '/real/w', '/w/wev-fix-daemon': '/real/w/wev-fix-daemon' })[p];
    expect(assertCloneRoot('/w/wev-fix-daemon', { realpath, workspace: ws })).toBe('/real/w/wev-fix-daemon');
  });

  it('refuses a registered clone path that is a symlink to elsewhere (e.g. a pool lane)', () => {
    const realpath = p => ({ '/w': '/real/w', '/w/wev-fix-daemon': '/real/w/.lanes/web-everything/lane-22' })[p];
    expect(() => assertCloneRoot('/w/wev-fix-daemon', { realpath, workspace: ws })).toThrow(/symlink refused/);
  });

  it('a probe finishing after the deadline cannot certify adoption: done:false with resumeWith', () => {
    let clock = 0;
    const io = { now: () => clock, sleep: () => { throw new Error('must not sleep'); },
      exec() { clock += 90000; return ''; } };
    const r = awaitCondition(parseArgs([...adoptionArgs, '--wait-ms', '60000']), io);
    expect(r).toMatchObject({ done: false, adopted: false, timedOut: true, resumeWith: expect.stringContaining('run.mjs await') });
  });
});
