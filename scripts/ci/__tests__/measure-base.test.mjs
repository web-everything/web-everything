// @vitest-environment node
/** The measure diff base is the last successfully measured main commit, never HEAD~1. */
import { describe, expect, it } from 'vitest';
import { pickMeasureBase, coveredMerges, lastMeasuredSha, main } from '../measure-base.mjs';

const ancestors = (set) => (sha) => set.includes(sha);

describe('pickMeasureBase', () => {
  it('uses the last measured sha when it is an ancestor of head, not HEAD^', () => {
    const r = pickMeasureBase({ head: 'h3', lastMeasured: 'm0', isAncestor: ancestors(['m0']) });
    expect(r.base).toBe('m0');
    expect(r.base).not.toBe('HEAD^');
    expect(r.cumulative).toBe(true);
  });
  it('falls back to HEAD^ with no previous measurement', () => {
    expect(pickMeasureBase({ head: 'h', lastMeasured: null, isAncestor: () => true })).toEqual({ base: 'HEAD^', cumulative: false });
  });
  it('falls back to HEAD^ when the last measured sha is not an ancestor (force-moved main)', () => {
    expect(pickMeasureBase({ head: 'h', lastMeasured: 'gone', isAncestor: () => false }).base).toBe('HEAD^');
  });
  it('falls back to HEAD^ when last measured equals head (re-run)', () => {
    expect(pickMeasureBase({ head: 'h', lastMeasured: 'h', isAncestor: () => true }).base).toBe('HEAD^');
  });
});

describe('lastMeasuredSha', () => {
  const runs = [
    { head_sha: 'c', conclusion: 'cancelled' },
    { head_sha: 'b', conclusion: 'success' },
    { head_sha: 'a', conclusion: 'success' },
  ];
  it('picks the newest successful run other than the current head', () => {
    expect(lastMeasuredSha({ runs, head: 'z' })).toBe('b');
    expect(lastMeasuredSha({ runs, head: 'b' })).toBe('a');
  });
  it('returns null when nothing succeeded', () => {
    expect(lastMeasuredSha({ runs: [{ head_sha: 'c', conclusion: 'cancelled' }], head: 'z' })).toBeNull();
  });
  it('requires a sample as well as success and skips the current head', () => {
    const checked = [];
    expect(lastMeasuredSha({ runs, head: 'z', hasSample: run => {
      checked.push(run.head_sha);
      return run.head_sha === 'a';
    } })).toBe('a');
    expect(checked).toEqual(['b', 'a']);
    expect(lastMeasuredSha({ runs, head: 'b', hasSample: () => false })).toBeNull();
  });
});

describe('measurement CLI', () => {
  function run({ history = () => [], artifacts = () => [{ artifacts: [] }], writeError = false } = {}) {
    const calls = [], events = [];
    main({ repository: 'owner/repo', outputPath: 'covered.txt',
      exec: (command, args) => {
        calls.push([command, args]);
        if (command === 'git') {
          if (args[0] === 'rev-parse') return 'head\n';
          if (args[0] === 'merge-base') return '';
          if (args[0] === 'log') return 'head\nmerge\n';
        }
        if (command === 'gh') {
          const endpoint = args.at(-1);
          if (endpoint.includes('/artifacts')) return JSON.stringify(artifacts(endpoint));
          return JSON.stringify({ workflow_runs: history(Number(new URL(`https://fixture/${endpoint}`).searchParams.get('page'))) });
        }
        throw new Error(`unexpected command: ${command}`);
      },
      writeFile: (path, content) => {
        events.push(['write', path, content]);
        if (writeError) throw new Error('permission denied');
      },
      stderr: text => events.push(['stderr', text]),
      stdout: text => events.push(['stdout', text]),
    });
    return { calls, events };
  }
  const success = (id) => ({ id, head_sha: `sha-${id}`, conclusion: 'success' });
  const sample = { name: 'false-green-signal', expired: false };

  it('finds a measured success beyond 100 cancelled runs and writes coverage before printing the base', () => {
    const { calls, events } = run({
      history: page => page === 1 ? Array(100).fill({ conclusion: 'cancelled' }) : [success(2)],
      artifacts: () => [{ artifacts: [] }, { artifacts: [sample] }],
    });
    expect(calls.filter(([command]) => command === 'gh')).toEqual([
      ['gh', ['api', 'repos/owner/repo/actions/workflows/test-selection-measure.yml/runs?branch=main&status=completed&per_page=100&page=1']],
      ['gh', ['api', 'repos/owner/repo/actions/workflows/test-selection-measure.yml/runs?branch=main&status=completed&per_page=100&page=2']],
      ['gh', ['api', '--paginate', '--slurp', 'repos/owner/repo/actions/runs/2/artifacts?per_page=100']],
    ]);
    expect(events).toEqual([['write', 'covered.txt', 'head\nmerge\n'], ['stdout', 'sha-2\n']]);
  });

  it.each([
    [], [{ name: 'measure-covered', expired: false }],
    [{ ...sample, expired: true }], [{ name: 'false-green-signal' }],
  ].map(artifactList => ({ artifactList })))('skips successes without a confirmed unexpired sample ($artifactList)', ({ artifactList }) => {
    const { events } = run({ history: () => [success(1), success(2)],
      artifacts: endpoint => [{ artifacts: endpoint.includes('/1/') ? artifactList : [sample] }],
    });
    expect(events.at(-1)).toEqual(['stdout', 'sha-2\n']);
  });

  it('falls back with a diagnostic when artifact evidence is unreadable', () => {
    const { events } = run({ history: () => [success(1)], artifacts: () => { throw new Error('API unavailable'); } });
    expect(events[0]).toEqual(['stderr', expect.stringContaining('measurement lookup failed')]);
    expect(events.at(-1)).toEqual(['stdout', 'HEAD^\n']);
  });

  it('bounds cancelled history at five pages and tells operators to inspect older runs', () => {
    const { calls, events } = run({ history: () => Array(100).fill({ conclusion: 'cancelled' }) });
    expect(calls.filter(([command]) => command === 'gh')).toHaveLength(5);
    expect(events[0]).toEqual(['stderr', expect.stringContaining('inspect older runs manually')]);
    expect(events.at(-1)).toEqual(['stdout', 'HEAD^\n']);
  });

  it('warns on stderr for covered-list write failures before printing the base', () => {
    const { events } = run({ writeError: true });
    expect(events).toEqual([
      ['write', 'covered.txt', 'head\nmerge\n'],
      ['stderr', expect.stringMatching(/warning: could not write covered list: permission denied/)],
      ['write', 'covered.txt', ''],
      ['stderr', expect.stringMatching(/warning: could not write empty covered list: permission denied/)],
      ['stdout', 'HEAD^\n'],
    ]);
  });
});

describe('coveredMerges', () => {
  it('lists every commit between base and head so per-merge attribution survives a cumulative diff', () => {
    const log = (range) => (range === 'm0..h3' ? 'h3\nh2\nh1\n' : '');
    expect(coveredMerges({ base: 'm0', head: 'h3', runGit: log })).toEqual(['h3', 'h2', 'h1']);
  });
});
