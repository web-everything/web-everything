// @vitest-environment node
// Read command call sites from disk without Vite's browser asset URL rewriting.
// @repo-scanning-test scope=files
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { freshLaneSafety, guardLaneAction } from '../../lib/health-watch-lane-scan.mjs';
import { createStaleStateReader } from '../stale-state-io.mjs';
import { OPERATIONS } from '../run.mjs';
import { probeStaleState } from '../../conveyor/health-watch.mjs';
import { scopedScanFiles } from '../../lib/repo-scan-tests.mjs';

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
    const runners = new Set(['run', 'exec', 'execFileSync', 'spawn', 'laneGit', 'git']);
    const helpers = new Set();
    const bindings = [];
    const walk = (node, fn) => { fn(node); ts.forEachChild(node, child => walk(child, fn)); };
    walk(tree, node => {
      if (ts.isImportDeclaration(node)) {
        // Imported helpers may hide lane mutations too. Pin their calls separately
        // instead of assuming only child_process can cross the action boundary.
        if (/^(node:)?(path|os|url)$/.test(node.moduleSpecifier.text)) return;
        const target = /^(node:)?child_process$/.test(node.moduleSpecifier.text) ? runners : helpers;
        if (node.importClause?.name) target.add(node.importClause.name.text);
        const named = node.importClause?.namedBindings;
        if (named && ts.isNamespaceImport(named)) target.add(named.name.text);
        else for (const binding of named?.elements ?? []) target.add(binding.name.text);
      }
      if (ts.isVariableDeclaration(node) && node.initializer) bindings.push(node);
    });
    const uses = (node, names) => {
      if (ts.isIdentifier(node)) return names.has(node.text);
      if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)
        || ts.isParenthesizedExpression(node) || ts.isAwaitExpression(node)) return uses(node.expression, names);
      if (ts.isBinaryExpression(node)) return uses(node.left, names) || uses(node.right, names);
      if (ts.isConditionalExpression(node)) return uses(node.whenTrue, names) || uses(node.whenFalse, names);
      if (ts.isCallExpression(node)) {
        if (node.expression.getText(tree) === 'require') return true;
        if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'bind') {
          return uses(node.expression.expression, names);
        }
      }
      return false;
    };
    // Conservative, scope-independent propagation: aliases can only add sites to
    // the review inventory. Iterate to cover chains declared in either order.
    let changed;
    do {
      changed = false;
      for (const binding of bindings) {
        const target = uses(binding.initializer, runners) ? runners
          : uses(binding.initializer, helpers) ? helpers : null;
        if (!target) continue;
        const bind = name => {
          if (ts.isIdentifier(name)) {
            if (!target.has(name.text)) { target.add(name.text); changed = true; }
          } else for (const element of name.elements) if (ts.isBindingElement(element)) bind(element.name);
        };
        bind(binding.name);
      }
    } while (changed);
    const calls = [];
    const visit = node => {
      if (ts.isCallExpression(node) && uses(node.expression, runners)) {
        const name = node.expression.getText(tree);
        calls.push(`${name}(${node.arguments.slice(0, ['git', 'laneGit'].includes(name) ? 1 : 2)
          .map(arg => arg.getText(tree).replace(/\s+/g, ' ')).join(', ')})`);
      } else if (ts.isCallExpression(node) && uses(node.expression, helpers)) {
        calls.push(`helper:${node.expression.getText(tree)}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(tree);
    return calls;
  };
  for (const file of scopedScanFiles(['scripts/conveyor/health-watch.mjs', 'scripts/operations/stale-state-io.mjs'])) {
    it.each(['reclaim', 'reset', 'reuse', 'release-on-behalf'])(
      `${file}: every added %s call site requires guardLaneAction review, including assigned runners`, action => {
        const source = readFileSync(new URL(`../../../${file}`, import.meta.url), 'utf8');
        const before = commands(source);
        // Parsed only: exercise the same source inventory that protects the real
        // reporting entry points, without executing a destructive lane command.
        // A new action must trip that boundary even if its runner was declared
        // earlier and assigned later, rather than initialized at declaration.
        for (const assignment of ['launch = exec', 'launch ||= exec', 'launch ??= exec',
          'launch = later; later = exec', '({ launch } = { launch: exec })',
          '[launch] = [exec]', 'actions.launch = exec']) {
          const callee = assignment.startsWith('actions.') ? 'actions.launch' : 'launch';
          const added = `${source}\nfunction proposedLaneAction() {
            let launch, later; const actions = {};
            ${assignment};
            ${callee}('node', ['lane-pool.mjs', '${action}', '--lane=1']);
          }`;
          expect(commands(added), `${action} bypass via ${assignment}`).not.toEqual(before);
          expect(commands(added).some(call => call.startsWith(`${callee}(`)),
            `the ${action} invocation itself must be inventoried`).toBe(true);
        }
      });
  }
  it.each([
    ["import { execFileSync as launch } from 'node:child_process'; launch('git', ['reset', '--hard']);", 'launch('],
    ["import { spawnSync } from 'child_process'; spawnSync('git', ['reset', '--hard']);", 'spawnSync('],
    ["import * as child from 'node:child_process'; child.execFileSync('git', ['reset', '--hard']);", 'child.execFileSync('],
    ["import child from 'child_process'; child['spawn']('git', ['reset', '--hard']);", "child['spawn']("],
    ["const launch = exec; launch('git', ['reset', '--hard']);", 'launch('],
    ["const launch = later; const later = run; launch('git', ['reset', '--hard']);", 'launch('],
    ["const { execFileSync: launch } = require('node:child_process'); launch('git', ['reset', '--hard']);", 'launch('],
    ["const child = require('child_process'); child[method]('git', ['reset', '--hard']);", 'child[method]('],
    ["(deps.runDiagnosis || run)('git', ['reset', '--hard']);", '(deps.runDiagnosis || run)('],
    ["const launch = exec.bind(null); launch('git', ['reset', '--hard']);", 'launch('],
    ["exec.call(null, 'git', ['reset', '--hard']);", 'exec.call('],
    ["import { reclaimLane } from './lane-actions.mjs'; reclaimLane(path);", 'helper:reclaimLane'],
  ])('inventories indirect action call sites: %s', (source, site) => {
    // These are parsed, never executed. Each used to escape the literal-name
    // inventory, letting an unguarded action appear without changing its list.
    expect(commands(source).some(call => call.startsWith(site))).toBe(true);
  });
  it.each(scopedScanFiles(['scripts/conveyor/health-watch.mjs', 'scripts/operations/stale-state-io.mjs']))(
    'allowlists every command call site in %s; new destructive lane actions require a guard', file => {
    const source = readFileSync(new URL(`../../../${file}`, import.meta.url), 'utf8');
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
      '(deps.runDiagnosis || run)(command, args)',
      "spawn(process.execPath, [script, ...argv, '--in-process'])",
    ];
    const allowedReader = [
      'run(bin, argv)', "run('git', hardenLaneGitArgs(argv))",
      "exec(process.execPath, [join(root, 'scripts/lane-pool.mjs'), 'status', '--json'])",
      'laneGit([...LANE_CONFIG_LIST_ARGS])',
      "laneGit(['rev-list', '--count', 'HEAD', '--not', '--remotes=origin'])",
    ];
    const subprocesses = source => commands(source).filter(call => !call.startsWith('helper:'));
    const helperCounts = source => commands(source).filter(call => call.startsWith('helper:')).reduce((counts, call) => {
      const name = call.slice('helper:'.length);
      counts[name] = (counts[name] ?? 0) + 1;
      return counts;
    }, {});
    const allowed = file === 'scripts/conveyor/health-watch.mjs' ? allowedWatch : allowedReader;
    expect(subprocesses(source)).toEqual(allowed);
    // Keep imported-helper coverage visible and reviewable. A new helper call or
    // additional invocation requires inspection even if its name hides its effect.
    const allowedHelpers = file === 'scripts/conveyor/health-watch.mjs' ? {
      resolveCoordinationRoot: 1, readFileSync: 12, mkdirSync: 2, writeFileSync: 2, renameSync: 1,
      openSync: 3, readSync: 3, closeSync: 3, statSync: 9, existsSync: 14, readdirSync: 8,
      daemonCloneRoots: 5, workspaceOf: 8, daemonJobsRoot: 1, realpathSync: 3, readGit: 1,
      poolsWithLanes: 1, laneIndicesIn: 1, readVerifyMarker: 1, laneJournalPath: 1,
      readLaneJournalTail: 1, reconcileLaneJournalEntry: 1, parsePsOutput: 2,
      ghThrottleLogPath: 2, ghThrottleLockRoot: 3, budgetProbeArgs: 2, resolvePrLimit: 1,
      isGlobalOffNow: 1, defaultCachePath: 1, readSharedOpenPrs: 1, cachedClaudeAgents: 1,
      resolveSessionWatchdogConfig: 1, defaultDrainHistoryPath: 1, stuckOnPermissionPrompt: 1,
      readBacklogCards: 1, scrubText: 14, probeBuildSessions: 1, unlinkSync: 3, readBusyTopLevel: 1,
      healthDir: 2, emptyHealthState: 1, sweepOurTmp: 2, sweepReviewTmp: 1, sealDueBatches: 1,
      archiveClaudeJobs: 2, resolvePrSweepSettings: 1, prSweepTickAllowed: 1,
      '(deps.runPrSweepJob ?? runPrSweepJob)': 1, resolveNightlyCoronerSettings: 1,
      nightlyCoronerTickAllowed: 1, '(deps.runNightlyCoronerJob ?? runNightlyCoronerJob)': 1,
      '(deps.publishCoronerFailure ?? publishCoronerFailure)': 1, coronerNightDue: 1,
      probeDaemonCloneBranches: 1, readFixLoopRows: 2, defaultPoolRoot: 2, readGithubAppStatus: 1,
      probeDiskSpace: 1, readRecentSamples: 1, readSeatCapUsage: 1, readPrEventsStatuses: 1,
      runDailyReadinessCheck: 1, ledgerReadinessHistoryPath: 1, probeExternalRuns: 1,
      probeAndOwnMainCi: 1, normalizeInventory: 1, resolveHealthJobSwitches: 1, runGhProbeJobs: 1,
      '(deps.ensureNeedsYouFeedJob ?? superviseNeedsYouFeed)': 1, runHealthTick: 1,
      appendSample: 1, summarizeSample: 1, findUngatedHeavyRuns: 1, scrubDeep: 3,
      publishAttention: 1, '(deps.smells || SMELLS).map': 1, summarizeDiagnosisOutput: 1,
      runInvestigations: 1, 'SMELLS.map': 2, withLedgerLock: 1, readLedgerStrict: 1,
      planFileRequests: 1, recordRequested: 1, writeLedger: 1, notifyDesktopChecked: 4,
      loadQuietSettings: 1, breaksThrough: 1, flushDigest: 1, renderEpisodeReport: 1,
      spliceFilingSection: 1, renderHealthSection: 1, formatClaudeJobsArchiveLine: 2,
      formatTmpSweepLine: 2, healthSectionLines: 1,
    } : {
      readdirSync: 1, readFileSync: 1, createFileRunStore: 1, laneProbeEnv: 2, hardenLaneGitArgs: 1,
      laneRedirectConfig: 1, cachedLaneScan: 1, isLeaseStale: 1, idFromName: 2, createClaimReader: 1, readField: 2,
    };
    expect(helperCounts(source)).toEqual(allowedHelpers);
    // Negative controls: real command shapes in an otherwise dormant branch
    // cannot be admitted by the allowlist. Comments/strings aren't call sites.
    for (const action of ['reclaim', 'reset', 'reuse', 'release']) {
      expect(subprocesses(`${source}\nif (false) run('node', ['lane-pool.mjs', '${action}']);`)).not.toEqual(allowed);
    }
    expect(subprocesses(`${source}\n// run('git', ['reset']);`)).toEqual(allowed);
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
