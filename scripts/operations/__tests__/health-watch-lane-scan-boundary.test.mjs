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
  it('every destructive lane action in health-watch lane code goes through guardLaneAction', () => {
    const mutators = new Set(['writeFileSync', 'mkdirSync', 'renameSync', 'rmSync', 'unlinkSync',
      'rmdirSync', 'appendFileSync', 'copyFileSync', 'symlinkSync']);
    const runners = new Set(['runner', 'run', 'exec', 'execSync', 'spawn', 'spawnSync',
      'execFile', 'execFileSync', 'git', 'laneGit']);
    const scan = (source, file = 'synthetic.mjs') => {
      const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
      expect(tree.parseDiagnostics, `${file}: unreadable syntax requires review`).toEqual([]);
      const walk = (node, fn) => { fn(node); ts.forEachChild(node, child => walk(child, fn)); };
      const aliases = new Map();
      walk(tree, node => {
        if (ts.isImportSpecifier(node)) aliases.set(node.name.text, node.propertyName?.text ?? node.name.text);
      });
      const calleeName = node => {
        const name = ts.isPropertyAccessExpression(node) ? node.name.text
          : ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)
            ? node.argumentExpression.text : ts.isIdentifier(node) ? node.text : '';
        return aliases.get(name) ?? name;
      };
      const owner = node => {
        for (let p = node.parent; p; p = p.parent) if (ts.isFunctionLike(p)) return p;
        return tree;
      };
      const functionName = node => node === tree ? '<module>'
        : node.name?.getText(tree) ?? (ts.isVariableDeclaration(node.parent)
          ? node.parent.name.getText(tree) : `${functionName(owner(node))}/<anonymous>`);
      const guarded = new Set();
      walk(tree, node => {
        if (ts.isCallExpression(node) && calleeName(node.expression) === 'guardLaneAction') guarded.add(owner(node));
      });
      // Inspect literal argv (including join(root, 'scripts/lane-pool.mjs')),
      // never comments or string contents elsewhere in the function.
      const literals = node => {
        if (ts.isStringLiteralLike(node)) return node.text.split(/\s+/);
        if (ts.isArrayLiteralExpression(node)) return node.elements.flatMap(literals);
        if (ts.isCallExpression(node) && calleeName(node.expression) === 'join') return node.arguments.flatMap(literals);
        return ['<dynamic>'];
      };
      const destructive = (callee, args) => {
        const words = args.flatMap(literals);
        if (['git', 'laneGit'].includes(callee)) words.unshift('git');
        const git = words.findIndex(word => /(?:^|\/)git$/.test(word));
        const argv = words.slice(git + 1);
        return (git >= 0 && argv.some((word, i) =>
          /^(reset|clean|checkout|switch|rm|gc|prune|restore)$/.test(word)
          || (word === 'stash' && /^(push|drop|pop|clear)$/.test(argv[i + 1]))
          || (word === 'branch' && argv.slice(i + 1).some(flag => /^-[Dd]$/.test(flag)))
          || (word === 'worktree' && /^(remove|prune)$/.test(argv[i + 1]))))
          || words.some((word, i) => /(?:^|\/)lane-pool(?:\.mjs)?$/.test(word)
            && words.slice(i + 1).some(action => /^(release|reclaim|reuse|reset)$/.test(action)));
      };
      const sites = [];
      walk(tree, node => {
        if (!ts.isCallExpression(node)) return;
        const callee = calleeName(node.expression);
        if (!mutators.has(callee) && !(runners.has(callee) && destructive(callee, [...node.arguments]))) return;
        const fn = owner(node);
        // Keep every occurrence, with target arguments: moving a reviewed write
        // from a cache/state file to a lane must change the exact inventory too.
        const targets = node.arguments.slice(0, callee === 'renameSync' || callee === 'copyFileSync'
          || callee === 'symlinkSync' || runners.has(callee) ? 2 : 1)
          .map(arg => arg.getText(tree).replace(/\s+/g, ' ')).join(', ');
        sites.push({ site: `${file}:${functionName(fn)}:${node.expression.getText(tree)}(${targets})`, guarded: guarded.has(fn) });
      });
      return sites;
    };
    // Explicit non-lane targets. cachedLaneScan operates on dir/lane-scan.json
    // and its temp file; health-watch's other writes operate on daemon state,
    // tick.lock and overrun.json. No entire function or file is exempted.
    const ALLOWLIST = [
      'scripts/lib/health-watch-lane-scan.mjs:cachedLaneScan:mkdirSync(dir)',
      'scripts/lib/health-watch-lane-scan.mjs:cachedLaneScan:writeFileSync(tmp)',
      'scripts/lib/health-watch-lane-scan.mjs:cachedLaneScan:renameSync(tmp, path)',
      'scripts/lib/health-watch-lane-scan.mjs:cachedLaneScan:rmSync(tmp)',
      'scripts/conveyor/health-watch.mjs:writeJsonAtomic:mkdirSync(dirname(path))',
      'scripts/conveyor/health-watch.mjs:writeJsonAtomic:writeFileSync(tmp)',
      'scripts/conveyor/health-watch.mjs:writeJsonAtomic:renameSync(tmp, path)',
      'scripts/conveyor/health-watch.mjs:acquireTickLock:mkdirSync(dir)',
      'scripts/conveyor/health-watch.mjs:acquireTickLock:unlinkSync(p)',
      'scripts/conveyor/health-watch.mjs:acquireTickLock:writeFileSync(p)',
      'scripts/conveyor/health-watch.mjs:acquireTickLock/<anonymous>:unlinkSync(p)',
      'scripts/conveyor/health-watch.mjs:tick:unlinkSync(overrunPath)',
    ];
    const violations = sites => sites.filter(({ site, guarded }) => !ALLOWLIST.includes(site) && !guarded);
    // Full inventory on every run: the allowlist spans all three files, so a scoped scan cannot equal it.
    const sites = ['scripts/lib/health-watch-lane-scan.mjs',
      'scripts/operations/stale-state-io.mjs', 'scripts/conveyor/health-watch.mjs']
      .flatMap(file => scan(readFileSync(new URL(`../../../${file}`, import.meta.url), 'utf8'), file));
    expect(sites.map(({ site }) => site).sort()).toEqual([...ALLOWLIST].sort());
    expect(violations(sites)).toEqual([]);
    expect(sites.filter(({ site }) => !ALLOWLIST.includes(site))).toHaveLength(0);

    const unguarded = "function resetLane() { execFileSync('git', ['reset', '--hard']); }";
    expect(violations(scan(unguarded))).toEqual([
      { site: "synthetic.mjs:resetLane:execFileSync('git', ['reset', '--hard'])", guarded: false },
    ]);
    expect(scan(unguarded)).toHaveLength(1);
    const wrapped = unguarded.replace("execFileSync(", "if (!guardLaneAction({ path, action: 'reset' }).act) return; execFileSync(");
    expect(scan(wrapped)).toHaveLength(1);
    expect(violations(scan(wrapped))).toEqual([]);
    // A guard in a sibling callback cannot bless the action's function.
    expect(violations(scan(unguarded.replace('execFileSync(', 'const other = () => guardLaneAction({}); execFileSync('))))
      .toHaveLength(1);
    for (const callee of mutators) expect(violations(scan(`${callee}(lane);`))).toHaveLength(1);
    for (const argv of ["['clean', '-fd']", "['checkout', 'main']", "['switch', 'main']",
      "['stash', 'push']", "['stash', 'drop']", "['stash', 'pop']", "['stash', 'clear']",
      "['branch', '-D', 'lane']", "['branch', '-d', 'lane']", "['worktree', 'remove', lane]",
      "['worktree', 'prune']", "['rm', 'file']", "['gc']", "['prune']", "['restore', '.']"]) {
      for (const callee of runners) {
        const args = ['git', 'laneGit'].includes(callee) ? argv : `'git', ${argv}`;
        expect(violations(scan(`${callee}(${args});`)), `${callee}(${args})`).toHaveLength(1);
      }
    }
    for (const action of ['release', 'reclaim', 'reuse', 'reset']) {
      expect(violations(scan(`runner(process.execPath, [join(root, 'scripts/lane-pool.mjs'), '${action}']);`)))
        .toHaveLength(1);
    }
    expect(scan("execFileSync('git', ['stash', 'list']); // rmSync(lane)\nconst text = 'git reset --hard';"))
      .toEqual([]);
  });
  // Enumerate executable call sites, including the git wrapper. A newly added
  // reset/reuse/reclaim/release command (even in an unexercised branch) fails this
  // allowlist. Health-watch has no lane mutations today; adding one requires a
  // guardLaneAction integration test before extending this list.
  const commands = (source, { qualifyHelpers = false } = {}) => {
    const tree = ts.createSourceFile('calls.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const runners = new Set(['run', 'exec', 'execFileSync', 'spawn', 'laneGit', 'git']);
    const helpers = new Set();
    const helperOrigins = new Map();
    const bindings = [];
    const walk = (node, fn) => { fn(node); ts.forEachChild(node, child => walk(child, fn)); };
    walk(tree, node => {
      if (ts.isImportDeclaration(node)) {
        // Imported helpers may hide lane mutations too. Pin their calls separately
        // instead of assuming only child_process can cross the action boundary.
        if (/^(node:)?(path|os|url)$/.test(node.moduleSpecifier.text)) return;
        const target = /^(node:)?child_process$/.test(node.moduleSpecifier.text) ? runners : helpers;
        const imported = (name, exported) => {
          target.add(name);
          if (target === helpers) helperOrigins.set(name, new Set([`${node.moduleSpecifier.text}#${exported}`]));
        };
        if (node.importClause?.name) imported(node.importClause.name.text, 'default');
        const named = node.importClause?.namedBindings;
        if (named && ts.isNamespaceImport(named)) imported(named.name.text, '*');
        else for (const binding of named?.elements ?? []) imported(binding.name.text, binding.propertyName?.text ?? binding.name.text);
      }
      if (ts.isVariableDeclaration(node) && node.initializer) {
        bindings.push({ name: node.name, initializer: node.initializer });
      } else if (ts.isBinaryExpression(node)
        && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
        && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
        bindings.push({ name: node.left, initializer: node.right });
      }
    });
    const uses = (node, names) => {
      if (ts.isIdentifier(node)) return names.has(node.text);
      if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)
        || ts.isParenthesizedExpression(node) || ts.isAwaitExpression(node)) {
        return names.has(node.getText(tree)) || uses(node.expression, names);
      }
      if (ts.isObjectLiteralExpression(node)) return node.properties.some(property => {
        if (ts.isPropertyAssignment(property)) return uses(property.initializer, names);
        if (ts.isShorthandPropertyAssignment(property)) return uses(property.name, names);
        return ts.isSpreadAssignment(property) && uses(property.expression, names);
      });
      if (ts.isArrayLiteralExpression(node)) return node.elements.some(element =>
        uses(ts.isSpreadElement(element) ? element.expression : element, names));
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
    const origins = expression => new Set([...helperOrigins].filter(([name]) => uses(expression, new Set([name])))
      .flatMap(([, values]) => [...values]));
    // Conservative, scope-independent propagation: aliases can only add sites to
    // the review inventory. Iterate to cover chains declared or assigned in
    // either order, including destructuring and member assignment targets.
    let changed;
    do {
      changed = false;
      for (const binding of bindings) {
        const target = uses(binding.initializer, runners) ? runners
          : uses(binding.initializer, helpers) ? helpers : null;
        if (!target) continue;
        const bind = name => {
          if (ts.isIdentifier(name) || ts.isPropertyAccessExpression(name) || ts.isElementAccessExpression(name)) {
            const key = name.getText(tree);
            if (!target.has(key)) { target.add(key); changed = true; }
            if (target === helpers) {
              const values = helperOrigins.get(key) ?? new Set();
              for (const origin of origins(binding.initializer)) {
                if (!values.has(origin)) { values.add(origin); changed = true; }
              }
              helperOrigins.set(key, values);
            }
          } else if (ts.isParenthesizedExpression(name)) bind(name.expression);
          else if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
            for (const element of name.elements) if (ts.isBindingElement(element)) bind(element.name);
          } else if (ts.isObjectLiteralExpression(name)) {
            for (const property of name.properties) {
              if (ts.isPropertyAssignment(property)) bind(property.initializer);
              else if (ts.isShorthandPropertyAssignment(property)) bind(property.name);
              else if (ts.isSpreadAssignment(property)) bind(property.expression);
            }
          } else if (ts.isArrayLiteralExpression(name)) {
            for (const element of name.elements) bind(ts.isSpreadElement(element) ? element.expression : element);
          } else if (ts.isBinaryExpression(name) && name.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
            bind(name.left);
          }
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
        const callee = node.expression.getText(tree);
        if (qualifyHelpers) {
          for (const origin of origins(node.expression)) calls.push(`helper:${origin}:${callee}`);
        } else calls.push(`helper:${callee}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(tree);
    return calls;
  };
  // Review all imported helper targets, including wrappers outside the lane-safety modules.
  // Module/export identity prevents an alias from impersonating a reviewed helper.
  const helperInventory = source => [...new Set(commands(source, { qualifyHelpers: true })
    .filter(call => call.startsWith('helper:')))].sort();
  const retainsExactCount = call => {
    const [, target, exported] = /^helper:(.+)#([^:]+):/.exec(call);
    // Only known read-only/noise helpers may vary in count. Mutating names/targets
    // and every helper owned by this PR override that exemption, including aliases.
    if (/\/(health-watch-lane-scan|lane-git-hardening|git-transport-branch)\.mjs$/.test(target)
      || /unlink|\brm|rename|write|mkdir|append|release|reclaim|reset|reuse|remove|trim|kill|spawn|exec|guardLaneAction|cachedLaneScan|laneRedirectConfig|hardenLaneGitArgs/i.test(call)) return true;
    const readOnlyFs = /^(?:node:)?fs$/.test(target)
      && /^(readFileSync|statSync|existsSync|readdirSync|realpathSync|readSync|closeSync)$/.test(exported);
    return !readOnlyFs && !/^(format|render)/.test(exported);
  };
  // No deduplication: each retained call occurrence increments its module/export/callee key.
  const helperCounts = source => commands(source, { qualifyHelpers: true })
    .filter(call => call.startsWith('helper:') && retainsExactCount(call)).reduce((counts, call) => {
      counts[call] = (counts[call] ?? 0) + 1;
      return counts;
    }, {});
  it.each(['unlinkSync', 'rmSync', 'renameSync', 'writeFileSync', 'mkdirSync', 'appendFileSync',
    'releaseLane', 'reclaimLane', 'resetLane', 'reuseLane', 'removeLane', 'trimPool', 'killLane',
    'spawnLane', 'execLane', 'guardLaneAction', 'cachedLaneScan', 'laneRedirectConfig', 'hardenLaneGitArgs'])(
    'counts every occurrence of mutating helper %s, including an alias', exported => {
      const source = `import { ${exported} as reviewedHelper } from './lane-actions.mjs';
        reviewedHelper(); reviewedHelper();`;
      const call = `helper:./lane-actions.mjs#${exported}:reviewedHelper`;
      expect(helperInventory(source)).toEqual([call]);
      expect(helperCounts(source)).toEqual({ [call]: 2 });
      expect(helperCounts(`${source}\nconst again = reviewedHelper; again();`)).toEqual({
        [call]: 2, [`helper:./lane-actions.mjs#${exported}:again`]: 1,
      });
    });
  it.each([
    ["./trim-lane.mjs", 'formatPreview'],
    ["./release-lane.mjs", 'readFileSync'],
    ["./lane-actions.mjs", 'scrubAndReset'],
    ["../lib/health-watch-lane-scan.mjs", 'laneProbeEnv'],
    ["../lib/lane-git-hardening.mjs", 'scrubInheritedGitEnv'],
    ["../lib/git-transport-branch.mjs", 'assertPushRef'],
  ])('keeps exact counts for safety helper %s#%s despite a read-only-looking name or alias', (target, exported) => {
    const source = `import { ${exported} as renderPreview } from '${target}'; renderPreview(); renderPreview();`;
    expect(helperCounts(source)).toEqual({ [`helper:${target}#${exported}:renderPreview`]: 2 });
  });
  it('counts identical local call names separately by imported module and export', () => {
    const source = `import { writeLane as first } from './one.mjs';
      import { resetLane as second } from './two.mjs';
      let action; action = first; action = second; action(); action();`;
    expect(helperCounts(source)).toEqual({
      'helper:./one.mjs#writeLane:action': 2,
      'helper:./two.mjs#resetLane:action': 2,
    });
  });
  const allowedHelperInventory = {
    "scripts/conveyor/health-watch.mjs": [
      "helper:../backlog-stranded-sweep.mjs#readBacklogCards:readBacklogCards",
      "helper:../lib/automation-home.mjs#workspaceOf:workspaceOf",
      "helper:../lib/claude-agents-cache.mjs#cachedClaudeAgents:cachedClaudeAgents",
      "helper:../lib/daemon-clone-branch-probe.mjs#probeDaemonCloneBranches:probeDaemonCloneBranches",
      "helper:../lib/daemon-clone-registry.mjs#daemonCloneRoots:daemonCloneRoots",
      "helper:../lib/daemon-rebuild/overlay-main-sync.mjs#kickOverlayMainSync:kickOverlayMainSync",
      "helper:../lib/gh-throttle.mjs#budgetProbeArgs:budgetProbeArgs",
      "helper:../lib/gh-throttle.mjs#ghThrottleLockRoot:ghThrottleLockRoot",
      "helper:../lib/gh-throttle.mjs#ghThrottleLogPath:ghThrottleLogPath",
      "helper:../lib/github-app-auth-env.mjs#defaultCachePath:defaultCachePath",
      "helper:../lib/github-app-auth-env.mjs#readGithubAppStatus:readGithubAppStatus",
      "helper:../lib/lane-history.mjs#laneJournalPath:laneJournalPath",
      "helper:../lib/lane-history.mjs#readLaneJournalTail:readLaneJournalTail",
      "helper:../lib/lane-history.mjs#reconcileLaneJournalEntry:reconcileLaneJournalEntry",
      "helper:../lib/lane-pool-paths.mjs#defaultPoolRoot:defaultPoolRoot",
      "helper:../lib/lane-pool-scan.mjs#laneIndicesIn:laneIndicesIn",
      "helper:../lib/lane-pool-scan.mjs#poolsWithLanes:poolsWithLanes",
      "helper:../lib/lane-verify.mjs#readVerifyMarker:readVerifyMarker",
      "helper:../lib/ledger-readiness-daily.mjs#ledgerReadinessHistoryPath:ledgerReadinessHistoryPath",
      "helper:../lib/ledger-readiness-daily.mjs#runDailyReadinessCheck:runDailyReadinessCheck",
      "helper:../lib/pr-events.mjs#readPrEventsStatuses:readPrEventsStatuses",
      "helper:../lib/pr-limit.mjs#isGlobalOffNow:isGlobalOffNow",
      "helper:../lib/pr-limit.mjs#resolvePrLimit:resolvePrLimit",
      "helper:../lib/pr-snapshot.mjs#readSharedOpenPrs:readSharedOpenPrs",
      "helper:../lib/proc-read.mjs#readGit:readGit",
      "helper:../lib/quiet-hours-io.mjs#flushDigest:flushDigest",
      "helper:../lib/quiet-hours-io.mjs#loadQuietSettings:loadQuietSettings",
      "helper:../lib/quiet-hours.mjs#breaksThrough:breaksThrough",
      "helper:../operations/card-batch-seal-io.mjs#sealDueBatches:sealDueBatches",
      "helper:../operations/coordination-root.mjs#resolveCoordinationRoot:resolveCoordinationRoot",
      "helper:../operations/live-state-io.mjs#defaultDrainHistoryPath:defaultDrainHistoryPath",
      "helper:../operations/needs-you-feed.mjs#publishAttention:publishAttention",
      "helper:../operations/review-extra-seats.mjs#readSeatCapUsage:readSeatCapUsage",
      "helper:../operations/run-store.mjs#daemonJobsRoot:daemonJobsRoot",
      // Archive-only hook: handles run/session files, never lane actions. Keep its exact count below.
      "helper:./archive-retention-tick.mjs#runArchiveRetentionTick:runArchiveRetentionTick",
      "helper:./branch-sync.mjs#notifyDesktopChecked:notifyDesktopChecked",
      "helper:./build-supervision.mjs#probeBuildSessions:probeBuildSessions",
      "helper:./build-supervision.mjs#probeExternalRuns:probeExternalRuns",
      "helper:./claude-jobs-archive.mjs#archiveClaudeJobs:archiveClaudeJobs",
      "helper:./claude-jobs-archive.mjs#formatClaudeJobsArchiveLine:formatClaudeJobsArchiveLine",
      "helper:./credential-inventory.mjs#normalizeInventory:normalizeInventory",
      "helper:./fix-loop-ledger.mjs#readFixLoopRows:readFixLoopRows",
      "helper:./health-file-request.mjs#planFileRequests:planFileRequests",
      "helper:./health-file-request.mjs#readLedgerStrict:readLedgerStrict",
      "helper:./health-file-request.mjs#recordRequested:recordRequested",
      "helper:./health-file-request.mjs#spliceFilingSection:spliceFilingSection",
      "helper:./health-file-request.mjs#withLedgerLock:withLedgerLock",
      "helper:./health-file-request.mjs#writeLedger:writeLedger",
      "helper:./health-investigate-dispatch.mjs#runInvestigations:runInvestigations",
      "helper:./health-smells/dispatch-permission-stall.mjs#stuckOnPermissionPrompt:stuckOnPermissionPrompt",
      "helper:./health-smells/index.mjs#SMELLS:(deps.smells || SMELLS).map",
      "helper:./health-smells/index.mjs#SMELLS:SMELLS.map",
      "helper:./health-watch-core.mjs#emptyHealthState:emptyHealthState",
      "helper:./health-watch-core.mjs#parsePsOutput:parsePsOutput",
      "helper:./health-watch-core.mjs#renderEpisodeReport:renderEpisodeReport",
      "helper:./health-watch-core.mjs#renderHealthSection:renderHealthSection",
      "helper:./health-watch-core.mjs#runHealthTick:runHealthTick",
      "helper:./health-watch-core.mjs#scrubDeep:scrubDeep",
      "helper:./health-watch-core.mjs#scrubText:scrubText",
      "helper:./health-watch-core.mjs#summarizeDiagnosisOutput:summarizeDiagnosisOutput",
      "helper:./health-watch-job.mjs#resolveHealthJobSwitches:resolveHealthJobSwitches",
      "helper:./health-watch-job.mjs#runGhProbeJobs:runGhProbeJobs",
      "helper:./health-watch-main-red.mjs#runMainRedAlert:runMainRedAlert",
      "helper:./health-watch-section.mjs#healthDir:healthDir",
      "helper:./health-watch-section.mjs#healthSectionLines:healthSectionLines",
      "helper:./heavy-run-ungated.mjs#appendSample:appendSample",
      "helper:./heavy-run-ungated.mjs#findUngatedHeavyRuns:findUngatedHeavyRuns",
      "helper:./heavy-run-ungated.mjs#readRecentSamples:readRecentSamples",
      "helper:./heavy-run-ungated.mjs#summarizeSample:summarizeSample",
      "helper:./main-ci-red-io.mjs#probeAndOwnMainCi:probeAndOwnMainCi",
      "helper:./needs-you-feed-job.mjs#superviseNeedsYouFeed:(deps.ensureNeedsYouFeedJob ?? superviseNeedsYouFeed)",
      "helper:./nightly-coroner-job.mjs#coronerNightDue:coronerNightDue",
      "helper:./nightly-coroner-job.mjs#nightlyCoronerTickAllowed:nightlyCoronerTickAllowed",
      "helper:./nightly-coroner-job.mjs#publishCoronerFailure:(deps.publishCoronerFailure ?? publishCoronerFailure)",
      "helper:./nightly-coroner-job.mjs#resolveNightlyCoronerSettings:resolveNightlyCoronerSettings",
      "helper:./nightly-coroner-job.mjs#runNightlyCoronerJob:(deps.runNightlyCoronerJob ?? runNightlyCoronerJob)",
      "helper:./pr-sweep-job.mjs#prSweepTickAllowed:prSweepTickAllowed",
      "helper:./pr-sweep-job.mjs#resolvePrSweepSettings:resolvePrSweepSettings",
      "helper:./pr-sweep-job.mjs#runPrSweepJob:(deps.runPrSweepJob ?? runPrSweepJob)",
      "helper:./review-tmp-health.mjs#probeDiskSpace:probeDiskSpace",
      "helper:./review-tmp-health.mjs#sweepReviewTmp:sweepReviewTmp",
      "helper:./session-watchdog.mjs#resolveSessionWatchdogConfig:resolveSessionWatchdogConfig",
      "helper:./tmp-sweep.mjs#formatTmpSweepLine:formatTmpSweepLine",
      "helper:./tmp-sweep.mjs#readBusyTopLevel:readBusyTopLevel",
      "helper:./tmp-sweep.mjs#sweepOurTmp:sweepOurTmp",
      "helper:node:fs#closeSync:closeSync",
      "helper:node:fs#existsSync:existsSync",
      "helper:node:fs#mkdirSync:mkdirSync",
      "helper:node:fs#openSync:openSync",
      "helper:node:fs#readFileSync:readFileSync",
      "helper:node:fs#readSync:readSync",
      "helper:node:fs#readdirSync:readdirSync",
      "helper:node:fs#realpathSync:realpathSync",
      "helper:node:fs#renameSync:renameSync",
      "helper:node:fs#statSync:statSync",
      "helper:node:fs#unlinkSync:unlinkSync",
      "helper:node:fs#writeFileSync:writeFileSync"
    ],
    "scripts/operations/stale-state-io.mjs": [
      "helper:../backlog/frontmatter.mjs#readField:readField",
      "helper:../backlog/id.mjs#idFromName:idFromName",
      "helper:../lib/git-transport-branch.mjs#assertPushRef:assertPushRef",
      "helper:../lib/health-watch-lane-scan.mjs#cachedLaneScan:cachedLaneScan",
      "helper:../lib/health-watch-lane-scan.mjs#laneProbeEnv:laneProbeEnv",
      "helper:../lib/health-watch-lane-scan.mjs#laneRedirectConfig:laneRedirectConfig",
      "helper:../lib/lane-git-hardening.mjs#hardenLaneGitArgs:hardenLaneGitArgs",
      "helper:../lib/lane-lease.mjs#isLeaseStale:isLeaseStale",
      "helper:./claim-io.mjs#createClaimReader:createClaimReader",
      "helper:./run-store.mjs#createFileRunStore:createFileRunStore",
      "helper:node:fs#readFileSync:readFileSync",
      "helper:node:fs#readdirSync:readdirSync"
    ]
  };
  // Reviewed per-file, per-module invocation counts; read-only noise alone is exempt.
  const allowedHelperCounts = {
    "scripts/conveyor/health-watch.mjs": {
      "helper:../backlog-stranded-sweep.mjs#readBacklogCards:readBacklogCards": 1,
      "helper:../lib/automation-home.mjs#workspaceOf:workspaceOf": 9,
      "helper:../lib/claude-agents-cache.mjs#cachedClaudeAgents:cachedClaudeAgents": 1,
      "helper:../lib/daemon-clone-branch-probe.mjs#probeDaemonCloneBranches:probeDaemonCloneBranches": 1,
      "helper:../lib/daemon-clone-registry.mjs#daemonCloneRoots:daemonCloneRoots": 6,
      "helper:../lib/daemon-rebuild/overlay-main-sync.mjs#kickOverlayMainSync:kickOverlayMainSync": 1,
      "helper:../lib/gh-throttle.mjs#budgetProbeArgs:budgetProbeArgs": 2,
      "helper:../lib/gh-throttle.mjs#ghThrottleLockRoot:ghThrottleLockRoot": 3,
      "helper:../lib/gh-throttle.mjs#ghThrottleLogPath:ghThrottleLogPath": 2,
      "helper:../lib/github-app-auth-env.mjs#defaultCachePath:defaultCachePath": 1,
      "helper:../lib/github-app-auth-env.mjs#readGithubAppStatus:readGithubAppStatus": 1,
      "helper:../lib/lane-history.mjs#laneJournalPath:laneJournalPath": 1,
      "helper:../lib/lane-history.mjs#readLaneJournalTail:readLaneJournalTail": 1,
      "helper:../lib/lane-history.mjs#reconcileLaneJournalEntry:reconcileLaneJournalEntry": 1,
      "helper:../lib/lane-pool-paths.mjs#defaultPoolRoot:defaultPoolRoot": 2,
      "helper:../lib/lane-pool-scan.mjs#laneIndicesIn:laneIndicesIn": 1,
      "helper:../lib/lane-pool-scan.mjs#poolsWithLanes:poolsWithLanes": 1,
      "helper:../lib/lane-verify.mjs#readVerifyMarker:readVerifyMarker": 1,
      "helper:../lib/ledger-readiness-daily.mjs#ledgerReadinessHistoryPath:ledgerReadinessHistoryPath": 1,
      "helper:../lib/ledger-readiness-daily.mjs#runDailyReadinessCheck:runDailyReadinessCheck": 1,
      "helper:../lib/pr-events.mjs#readPrEventsStatuses:readPrEventsStatuses": 1,
      "helper:../lib/pr-limit.mjs#isGlobalOffNow:isGlobalOffNow": 1,
      "helper:../lib/pr-limit.mjs#resolvePrLimit:resolvePrLimit": 1,
      "helper:../lib/pr-snapshot.mjs#readSharedOpenPrs:readSharedOpenPrs": 1,
      "helper:../lib/proc-read.mjs#readGit:readGit": 1,
      "helper:../lib/quiet-hours-io.mjs#flushDigest:flushDigest": 1,
      "helper:../lib/quiet-hours-io.mjs#loadQuietSettings:loadQuietSettings": 1,
      "helper:../lib/quiet-hours.mjs#breaksThrough:breaksThrough": 1,
      "helper:../operations/card-batch-seal-io.mjs#sealDueBatches:sealDueBatches": 1,
      "helper:../operations/coordination-root.mjs#resolveCoordinationRoot:resolveCoordinationRoot": 1,
      "helper:../operations/live-state-io.mjs#defaultDrainHistoryPath:defaultDrainHistoryPath": 1,
      "helper:../operations/needs-you-feed.mjs#publishAttention:publishAttention": 1,
      "helper:../operations/review-extra-seats.mjs#readSeatCapUsage:readSeatCapUsage": 1,
      "helper:../operations/run-store.mjs#daemonJobsRoot:daemonJobsRoot": 1,
      // Non-destructive to lanes; repeats still require review like every other maintenance helper.
      "helper:./archive-retention-tick.mjs#runArchiveRetentionTick:runArchiveRetentionTick": 1,
      "helper:./branch-sync.mjs#notifyDesktopChecked:notifyDesktopChecked": 4,
      "helper:./build-supervision.mjs#probeBuildSessions:probeBuildSessions": 1,
      "helper:./build-supervision.mjs#probeExternalRuns:probeExternalRuns": 1,
      "helper:./claude-jobs-archive.mjs#archiveClaudeJobs:archiveClaudeJobs": 2,
      "helper:./credential-inventory.mjs#normalizeInventory:normalizeInventory": 1,
      "helper:./fix-loop-ledger.mjs#readFixLoopRows:readFixLoopRows": 2,
      "helper:./health-file-request.mjs#planFileRequests:planFileRequests": 1,
      "helper:./health-file-request.mjs#readLedgerStrict:readLedgerStrict": 1,
      "helper:./health-file-request.mjs#recordRequested:recordRequested": 1,
      "helper:./health-file-request.mjs#spliceFilingSection:spliceFilingSection": 1,
      "helper:./health-file-request.mjs#withLedgerLock:withLedgerLock": 1,
      "helper:./health-file-request.mjs#writeLedger:writeLedger": 1,
      "helper:./health-investigate-dispatch.mjs#runInvestigations:runInvestigations": 1,
      "helper:./health-smells/dispatch-permission-stall.mjs#stuckOnPermissionPrompt:stuckOnPermissionPrompt": 1,
      "helper:./health-smells/index.mjs#SMELLS:(deps.smells || SMELLS).map": 1,
      "helper:./health-smells/index.mjs#SMELLS:SMELLS.map": 2,
      "helper:./health-watch-core.mjs#emptyHealthState:emptyHealthState": 1,
      "helper:./health-watch-core.mjs#parsePsOutput:parsePsOutput": 2,
      "helper:./health-watch-core.mjs#scrubDeep:scrubDeep": 3,
      "helper:./health-watch-core.mjs#scrubText:scrubText": 14,
      "helper:./health-watch-core.mjs#runHealthTick:runHealthTick": 1,
      "helper:./health-watch-core.mjs#summarizeDiagnosisOutput:summarizeDiagnosisOutput": 1,
      "helper:./health-watch-job.mjs#resolveHealthJobSwitches:resolveHealthJobSwitches": 1,
      "helper:./health-watch-job.mjs#runGhProbeJobs:runGhProbeJobs": 1,
      "helper:./health-watch-main-red.mjs#runMainRedAlert:runMainRedAlert": 1,
      "helper:./health-watch-section.mjs#healthDir:healthDir": 2,
      "helper:./health-watch-section.mjs#healthSectionLines:healthSectionLines": 1,
      "helper:./heavy-run-ungated.mjs#appendSample:appendSample": 1,
      "helper:./heavy-run-ungated.mjs#findUngatedHeavyRuns:findUngatedHeavyRuns": 1,
      "helper:./heavy-run-ungated.mjs#readRecentSamples:readRecentSamples": 1,
      "helper:./heavy-run-ungated.mjs#summarizeSample:summarizeSample": 1,
      "helper:./main-ci-red-io.mjs#probeAndOwnMainCi:probeAndOwnMainCi": 1,
      "helper:./needs-you-feed-job.mjs#superviseNeedsYouFeed:(deps.ensureNeedsYouFeedJob ?? superviseNeedsYouFeed)": 1,
      "helper:./nightly-coroner-job.mjs#coronerNightDue:coronerNightDue": 1,
      "helper:./nightly-coroner-job.mjs#nightlyCoronerTickAllowed:nightlyCoronerTickAllowed": 1,
      "helper:./nightly-coroner-job.mjs#publishCoronerFailure:(deps.publishCoronerFailure ?? publishCoronerFailure)": 1,
      "helper:./nightly-coroner-job.mjs#resolveNightlyCoronerSettings:resolveNightlyCoronerSettings": 1,
      "helper:./nightly-coroner-job.mjs#runNightlyCoronerJob:(deps.runNightlyCoronerJob ?? runNightlyCoronerJob)": 1,
      "helper:./pr-sweep-job.mjs#prSweepTickAllowed:prSweepTickAllowed": 1,
      "helper:./pr-sweep-job.mjs#resolvePrSweepSettings:resolvePrSweepSettings": 1,
      "helper:./pr-sweep-job.mjs#runPrSweepJob:(deps.runPrSweepJob ?? runPrSweepJob)": 1,
      "helper:./review-tmp-health.mjs#probeDiskSpace:probeDiskSpace": 1,
      "helper:./review-tmp-health.mjs#sweepReviewTmp:sweepReviewTmp": 1,
      "helper:./session-watchdog.mjs#resolveSessionWatchdogConfig:resolveSessionWatchdogConfig": 1,
      "helper:./tmp-sweep.mjs#readBusyTopLevel:readBusyTopLevel": 1,
      "helper:./tmp-sweep.mjs#sweepOurTmp:sweepOurTmp": 2,
      "helper:node:fs#openSync:openSync": 3,
      "helper:node:fs#mkdirSync:mkdirSync": 2,
      "helper:node:fs#renameSync:renameSync": 1,
      "helper:node:fs#unlinkSync:unlinkSync": 3,
      "helper:node:fs#writeFileSync:writeFileSync": 2
    },
    "scripts/operations/stale-state-io.mjs": {
      "helper:../backlog/frontmatter.mjs#readField:readField": 2,
      "helper:../backlog/id.mjs#idFromName:idFromName": 2,
      "helper:../lib/git-transport-branch.mjs#assertPushRef:assertPushRef": 1,
      "helper:../lib/health-watch-lane-scan.mjs#cachedLaneScan:cachedLaneScan": 1,
      "helper:../lib/health-watch-lane-scan.mjs#laneProbeEnv:laneProbeEnv": 2,
      "helper:../lib/health-watch-lane-scan.mjs#laneRedirectConfig:laneRedirectConfig": 1,
      "helper:../lib/lane-git-hardening.mjs#hardenLaneGitArgs:hardenLaneGitArgs": 1,
      "helper:../lib/lane-lease.mjs#isLeaseStale:isLeaseStale": 1,
      "helper:./claim-io.mjs#createClaimReader:createClaimReader": 1,
      "helper:./run-store.mjs#createFileRunStore:createFileRunStore": 1
    }
  };
  for (const file of scopedScanFiles(['scripts/conveyor/health-watch.mjs', 'scripts/operations/stale-state-io.mjs'])) {
    it.each(['reclaim', 'reset', 'reuse', 'release'])(
      `${file}: rejects an aliased %s wrapper imported from another module`, action => {
        const source = readFileSync(new URL(`../../../${file}`, import.meta.url), 'utf8');
        const allowed = allowedHelperInventory[file];
        expect(helperInventory(source)).toEqual(allowed);
        const proposed = `${source}
          import { ${action}Lane as proposedCleanup } from './unreviewed-lane-actions.mjs';
          const invokeCleanup = proposedCleanup;
          if (false) invokeCleanup('/fixture/lane');`;
        expect(helperInventory(proposed)).toContain(`helper:./unreviewed-lane-actions.mjs#${action}Lane:invokeCleanup`);
        expect(helperInventory(proposed)).not.toEqual(allowed);
      });
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
    ["import { reclaimLane } from './lane-actions.mjs'; let launch; launch ||= reclaimLane; launch(path);", 'helper:launch'],
    ["import { reclaimLane } from './lane-actions.mjs'; let launch; ({ action: launch } = { action: reclaimLane }); launch(path);", 'helper:launch'],
    ["let launch; [launch] = [exec]; launch('git', ['reset', '--hard']);", 'launch('],
    ["const actions = {}; actions['launch'] = exec; actions['launch']('git', ['reset', '--hard']);", "actions['launch']("],
    ["let launch; ({ action: [launch = null] } = { action: [exec] }); launch('git', ['reset', '--hard']);", 'launch('],
    ["let launch; [...launch] = [exec]; launch[0]('git', ['reset', '--hard']);", 'launch[0]('],
  ])('inventories indirect action call sites: %s', (source, site) => {
    // These are parsed, never executed. Each used to escape the literal-name
    // inventory, letting an unguarded action appear without changing its list.
    expect(commands(source).some(call => call.startsWith(site))).toBe(true);
  });
  it('keeps unrelated assignments and sibling members out of the command inventory', () => {
    expect(commands(`
      let launch; launch = unrelated; launch('node', ['lane-pool.mjs', 'reset']);
      const actions = {}; actions.launch = exec; actions.report();
      // launch = exec; launch('git', ['reset']);
      const example = "launch = exec; launch('git', ['reset'])";
    `)).toEqual([]);
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
      "laneGit(['rev-parse', '--verify', '--quiet', ref])",
      "laneGit(['rev-list', '--count', 'HEAD', '--not', ...tips])",
    ];
    const subprocesses = source => commands(source).filter(call => !call.startsWith('helper:'));
    const allowed = file === 'scripts/conveyor/health-watch.mjs' ? allowedWatch : allowedReader;
    expect(subprocesses(source)).toEqual(allowed);
    expect(helperInventory(source)).toEqual(allowedHelperInventory[file]);
    const allowedHelpers = allowedHelperCounts[file];
    expect(helperCounts(source)).toEqual(allowedHelpers);
    // Repeating an already reviewed mutation must fail even though the distinct
    // module/export inventory is unchanged. Pin each occurrence in both readers.
    const repeatedHelpers = file === 'scripts/conveyor/health-watch.mjs'
      ? ['writeFileSync', 'renameSync', 'unlinkSync', 'mkdirSync', 'runArchiveRetentionTick']
      : ['cachedLaneScan', 'laneRedirectConfig', 'hardenLaneGitArgs', 'laneProbeEnv', 'assertPushRef'];
    for (const callee of repeatedHelpers) {
      const call = Object.keys(allowedHelpers).find(key => key.endsWith(`:${callee}`));
      expect(call, `${file}: ${callee} must retain an exact invocation count`).toBeDefined();
      const proposed = `${source}\nif (false) ${callee}();`;
      expect(helperInventory(proposed)).toEqual(allowedHelperInventory[file]);
      expect(helperCounts(proposed)).toEqual({ ...allowedHelpers, [call]: allowedHelpers[call] + 1 });
      expect(helperCounts(proposed)).not.toEqual(allowedHelpers);
    }
    // Read-only noise may vary in count, but its module/export identity remains pinned.
    expect(helperCounts(`${source}\nif (false) readFileSync('unrelated');`)).toEqual(helperCounts(source));
    expect(helperInventory(`${source}\nif (false) readFileSync('unrelated');`)).toEqual(allowedHelperInventory[file]);
    expect(helperCounts(`${source}\nimport { guardLaneAction as checkAction } from '../lib/health-watch-lane-scan.mjs';
      if (false) checkAction({ path: '/fixture/lane', action: 'reset' });`)).not.toEqual(allowedHelpers);
    // Negative controls: real command shapes in an otherwise dormant branch
    // cannot be admitted by the allowlist. Comments/strings aren't call sites.
    for (const action of ['reclaim', 'reset', 'reuse', 'release']) {
      expect(subprocesses(`${source}\nif (false) run('node', ['lane-pool.mjs', '${action}']);`)).not.toEqual(allowed);
    }
    expect(subprocesses(`${source}\n// run('git', ['reset']);`)).toEqual(allowed);
  });

  it('pins the real stale-state call sites to reporting only, with no destructive lane action bypassing guardLaneAction', () => {
    const run = vi.fn((bin, argv) => bin === 'git'
      ? argv[0] === 'rev-parse' ? published : '0' : JSON.stringify({ lanes: [{
      path: '/fixture/lane', branch: 'lane/fixture', clean: true, lease: { agentPid: 123, acquiredAt: '2000-01-01T00:00:00Z' },
    }] }));
    const read = createStaleStateReader({ root: '/fixture', run, listFiles: () => [],
      probe: () => false, runStore: { list: () => [] } });
    const exec = vi.fn(() => JSON.stringify({ verdict: read() }));
    const result = probeStaleState({ repoRoot: '/fixture', exec });
    expect(result.records[0]).toMatchObject({ ownerPidAlive: false, hasUnsafeWork: null, lane: { clean: true, ahead: 0 },
      safety: { reason: 'local tracking refs cannot prove publication' } });
    expect(exec.mock.calls.map(([, argv]) => argv)).toEqual([
      ['/fixture/scripts/operations/run.mjs', 'stale-state', '--json'],
    ]);
    // Exact commands, not a blacklist of today's destructive verbs. Any added
    // action must change this contract and demonstrate its guardLaneAction gate.
    expect(run.mock.calls.map(([, argv]) => argv)).toEqual([
      ['/fixture/scripts/lane-pool.mjs', 'status', '--json'],
      ['config', '--show-scope', '--list', '--includes', '-z'],
      ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/lane/fixture'],
      ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main'],
      ['rev-list', '--count', 'HEAD', '--not', published, published],
    ]);
    expect(OPERATIONS['stale-state']().sinks).toEqual({});
  });
});
