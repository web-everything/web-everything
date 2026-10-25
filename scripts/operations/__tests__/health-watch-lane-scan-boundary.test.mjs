import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { freshLaneSafety, guardLaneAction } from '../../lib/health-watch-lane-scan.mjs';
import { createStaleStateReader } from '../stale-state-io.mjs';
import { OPERATIONS } from '../run.mjs';
import { probeStaleState } from '../../conveyor/health-watch.mjs';

const published = 'a'.repeat(40);
// A forged loose OR packed origin ref makes the old exclusion return zero. The
// trusted publication reader still knows only the parent of the unpublished HEAD.
const probe = (ahead = '1\n') => vi.fn((_bin, argv) => {
  if (argv[0] === 'rev-parse') return '.git/info/grafts\n';
  if (argv[0] === 'rev-list') return argv.includes('--remotes=origin') ? '0\n' : ahead;
  return '';
});

describe('published history trust boundary', () => {
  it.each(['reclaim', 'reset', 'reuse', 'release-on-behalf'])(
    '%s refuses a forged origin ref even when the cached record says safe', action => {
      const exec = probe();
      const readPublishedTips = vi.fn(() => [published]);
      expect(guardLaneAction({ path: '/fixture/lane', action, exec, readPublishedTips,
        record: { hasUnsafeWork: false }, log: vi.fn() })).toMatchObject({
        act: false, fresh: { reason: '1 unpushed commit(s)' },
      });
      expect(readPublishedTips).toHaveBeenCalledWith({ path: '/fixture/lane' });
      expect(exec.mock.calls.at(-1)[1]).toEqual(['rev-list', '--count', '--all', 'HEAD', '--not', published]);
    });

  it('refuses missing publication authority instead of trusting local origin', () => {
    expect(freshLaneSafety({ path: '/fixture/lane', exec: probe('0\n') }))
      .toMatchObject({ hasUnsafeWork: true, reason: 'trusted publication reader required' });
  });

  it.each([undefined, null, [], ['HEAD'], ['--all'], ['a'.repeat(41)], [published, null],
    [published + '\n'], [published + '\r'], [published + '\u2028'], ['`command`'], ['../origin'],
    Array(1), Array(4097).fill(published), Promise.resolve([published])].map(tips => ({ tips })))(
    'refuses missing, malformed, asynchronous or oversized publication evidence (%#)', ({ tips }) => {
      const exec = probe('0\n');
      expect(freshLaneSafety({ path: '/fixture/lane', exec, readPublishedTips: () => tips }))
        .toMatchObject({ hasUnsafeWork: true, reason: 'trusted publication tips unreadable or empty (limit 4096)' });
      expect(exec.mock.calls.some(([, argv]) => argv[0] === 'rev-list')).toBe(false);
    });

  it('refuses publication read errors and never falls back to tracking refs', () => {
    expect(guardLaneAction({ path: '/fixture/lane', action: 'reset', exec: probe('0\n'),
      readPublishedTips: () => { throw new Error('remote unavailable'); }, log: vi.fn() }))
      .toMatchObject({ act: false, fresh: { reason: 'fresh safety check failed', error: 'remote unavailable' } });
  });

  it('reads trusted publication tips anew for each action and accepts a proven clean lane', () => {
    const readPublishedTips = vi.fn(() => [published]);
    for (const action of ['reclaim', 'reset', 'reuse', 'release-on-behalf']) {
      expect(guardLaneAction({ path: '/fixture/lane', action, exec: probe('0\n'), readPublishedTips, log: vi.fn() }).act).toBe(true);
    }
    expect(readPublishedTips).toHaveBeenCalledTimes(4);
  });
});

describe('health-watch destructive lane action call-site contract', () => {
  // Enumerate executable call sites, including the git wrapper. A newly added
  // reset/reuse/reclaim/release command (even in an unexercised branch) fails this
  // allowlist. Health-watch has no lane mutations today; adding one requires a
  // guardLaneAction integration test before extending this list.
  const commands = source => {
    const tree = ts.createSourceFile('calls.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const calls = [];
    const visit = node => {
      if (ts.isCallExpression(node) && ['run', 'exec', 'execFileSync', 'spawn', 'laneGit', 'git'].includes(node.expression.getText(tree))) {
        const name = node.expression.getText(tree);
        calls.push(`${name}(${node.arguments.slice(0, ['git', 'laneGit'].includes(name) ? 1 : 2)
          .map(arg => arg.getText(tree).replace(/\s+/g, ' ')).join(', ')})`);
      }
      ts.forEachChild(node, visit);
    };
    visit(tree);
    return calls;
  };
  it('allowlists every health-watch and stale-state command call site; new destructive lane actions require a guard', () => {
    const watch = readFileSync(new URL('../../conveyor/health-watch.mjs', import.meta.url), 'utf8');
    const reader = readFileSync(new URL('../stale-state-io.mjs', import.meta.url), 'utf8');
    const allowedWatch = [
      'execFileSync(cmd, args)',
      "exec('git', ['-C', cwd, ...args])",
      "git(['fetch', '--quiet', 'origin', 'main'])",
      "git(['rev-parse', 'origin/main'])",
      "git(['rev-parse', 'HEAD'])",
      "git(['merge-base', '--is-ancestor', head, tip])",
      "git(['log', '--reverse', '--format=%ct', `${head}..${tip}`])",
      "exec('git', ['-C', root, 'status', '--porcelain', '--untracked-files=all', '--', 'backlog'])",
      'execFileSync(cmd, args)',
      "exec('ps', ['-Ao', 'pid,ppid,pcpu,etime,command'])",
      "exec('gh', budgetProbeArgs('graphql'))",
      "exec('gh', budgetProbeArgs('core'))",
      "exec('gh', ['pr', 'list', '--repo', slug, '--state', 'open', '--limit', '100', '--json', fields])",
      "exec('gh', ['pr', 'view', String(pr.number), '--repo', slug, '--json', 'state,labels,headRefOid,headRefName,baseRefName'])",
      "exec('gh', args)",
      "exec('claude', ['agents', '--json'])",
      "exec(process.execPath, [join(repoRoot, 'scripts/operations/run.mjs'), 'stale-state', '--json'])",
      "exec('gh', ['pr', 'list', '--repo', CONSTELLATION_REPOS.we.slug, '--state', 'merged', '--limit', String(limit), '--json', 'number,title,headRefName,body'])",
      "run(process.execPath, [join(REPO_ROOT, 'scripts/readiness/heavy-admission.mjs'), 'status', '--json'])",
      "spawn(process.execPath, [script, ...argv, '--in-process'])",
    ];
    const allowedReader = [
      'run(bin, argv)', "run('git', hardenLaneGitArgs(argv))",
      "exec(process.execPath, [join(root, 'scripts/lane-pool.mjs'), 'status', '--json'])",
      'laneGit([...LANE_CONFIG_LIST_ARGS])',
      "laneGit(['rev-list', '--count', 'HEAD', '--not', '--remotes=origin'])",
    ];
    expect(commands(watch)).toEqual(allowedWatch);
    expect(commands(reader)).toEqual(allowedReader);
    // Negative controls: real command shapes in an otherwise dormant branch
    // cannot be admitted by the allowlist. Comments/strings aren't call sites.
    for (const action of ['reclaim', 'reset', 'reuse', 'release']) {
      expect(commands(`${watch}\nif (false) run('node', ['lane-pool.mjs', '${action}']);`)).not.toEqual(allowedWatch);
    }
    expect(commands(`${reader}\n// run('git', ['reset']);`)).toEqual(allowedReader);
  });

  it('pins the real stale-state call sites to reporting only, with no destructive lane action bypassing guardLaneAction', () => {
    const run = vi.fn((bin) => bin === 'git' ? '0' : JSON.stringify({ lanes: [{
      path: '/fixture/lane', clean: true, lease: { agentPid: 123, acquiredAt: '2000-01-01T00:00:00Z' },
    }] }));
    const read = createStaleStateReader({ root: '/fixture', run, listFiles: () => [],
      probe: () => false, runStore: { list: () => [] } });
    const exec = vi.fn(() => JSON.stringify({ verdict: read() }));
    const result = probeStaleState({ repoRoot: '/fixture', exec });
    expect(result.records[0]).toMatchObject({ ownerPidAlive: false, hasUnsafeWork: false });
    expect(exec.mock.calls.map(([, argv]) => argv)).toEqual([
      ['/fixture/scripts/operations/run.mjs', 'stale-state', '--json'],
    ]);
    // Exact commands, not a blacklist of today's destructive verbs. Any added
    // action must change this contract and demonstrate its guardLaneAction gate.
    expect(run.mock.calls.map(([, argv]) => argv)).toEqual([
      ['/fixture/scripts/lane-pool.mjs', 'status', '--json'],
      ['config', '--show-scope', '--list', '--includes', '-z'],
      ['rev-list', '--count', 'HEAD', '--not', '--remotes=origin'],
    ]);
    expect(OPERATIONS['stale-state']().sinks).toEqual({});
  });
});
