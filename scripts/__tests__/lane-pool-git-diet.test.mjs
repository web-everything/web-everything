/**
 * @file lane-pool-git-diet.test.mjs — lane-pool applies the lane git diet (../lib/lane-git-diet.mjs) on the real
 *   CLI paths: a freshly provisioned lane carries the `^refs/heads/ops/*` refspec + unpackLimit=1 and no
 *   `origin/ops/*`; an existing lane without the diet gets it on its next acquire fetch, which then skips the
 *   advanced ops tip; an explicit by-name reader fetch still works.
 */
import { it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, chmodSync, existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { runReclaimCase } from '../conveyor/soak/breaks/lane-reset-symbolic-ops-proof.mjs';
import { laneGitHardeningEnv, laneGitConfigArgs, scrubGitRepoEnv } from '../lib/lane-git-hardening.mjs';

// These regressions exercise production functions without invoking the CLI or writing .git.
const repoSource = /function resolveRepo\([^]*?\n\}/.exec(readFileSync(resolve('scripts/lane-pool.mjs'), 'utf8'))[0];
function resolvePool(command, extra = {}) {
  return new Function('flags', 'cmd', 'resolve', 'expandHome', 'CWD_TOP_LEVEL', 'CHECKOUT_ROOT',
    'tryGit', 'LOCAL_GIT_TIMEOUT_MS', 'fail', 'basename', 'join', 'POOL_ROOT', 'resolveReal', 'sep', 'laneGitHardeningEnv', 'scrubGitRepoEnv',
    `${repoSource}; return resolveRepo();`)(
    { pool: 'existing', reference: '/reference', ...extra }, command, resolve, p => p,
    null, '/reference', () => null, 1000, message => { throw Error(message); },
    p => p.split('/').at(-1), join, '/pool', resolve, sep, laneGitHardeningEnv, scrubGitRepoEnv,
  );
}
it.each(['acquire', 'provision', 'refresh', 'remove', 'trim', 'reclaim', 'list'])(
  'read-only regression: %s rejects a missing canonical origin before probing an existing pool', command => {
    const flags = command === 'list' ? { acquirable: true } : {};
    expect(() => resolvePool(command, flags)).toThrow(/canonical origin.*--origin=/);
    expect(resolvePool(command, { ...flags, origin: '/canonical/origin.git' }).originUrl).toBe('/canonical/origin.git');
  },
);
it.each(['status', 'list', 'path', 'release', 'keep', 'map', 'unmap', 'gc'])(
  'read-only regression: metadata-only %s retains explicit-pool support without origin', command => {
    expect(resolvePool(command)).toMatchObject({ originUrl: null, poolDir: '/pool/existing' });
  },
);
it.each(['reclaim', 'trim', 'acquire'])(
  '%s refuses a lane-derived origin that advertises unique work', async laneOriginCommand => {
    expect((await runReclaimCase(resolve('.'), { laneOriginCommand })).violations).toEqual([]);
  }, 60000,
);
it('read-only regression: ordinary hardened callers retain their transport policy', () => {
  const inherited = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'protocol.file.allow', GIT_CONFIG_VALUE_0: 'always' };
  const env = laneGitHardeningEnv(inherited);
  const config = Object.fromEntries(Array.from({ length: Number(env.GIT_CONFIG_COUNT) }, (_, i) =>
    [env[`GIT_CONFIG_KEY_${i}`], env[`GIT_CONFIG_VALUE_${i}`]]));
  expect(Object.keys(config).filter(k => k.startsWith('protocol.'))).toEqual(['protocol.file.allow']);
  expect(laneGitConfigArgs().some(arg => arg.startsWith('protocol.'))).toBe(false);
});

// --origin accepts arbitrary Git URLs. Built-in HTTP/Git/SSH and local transports are supported;
// other schemes (including executable remote helpers) must fail closed even if inherited config allows them.
it.each([
  ['https://example.com/pool.git', 'https', true],
  ['http://example.com/pool.git', 'http', true],
  ['git://example.com/pool.git', 'git', true],
  ['ssh://example.com/pool.git', 'ssh', true],
  ['git@example.com:pool.git', 'ssh', true],
  ['/canonical/pool.git', 'file', true],
  ['file:///canonical/pool.git', 'file', true],
  ['./canonical/pool.git', 'file', true],
  ['ftp://example.com/pool.git', 'ftp', false],
  ['ftps://example.com/pool.git', 'ftps', false],
  ['rsync://example.com/pool.git', 'rsync', false],
  ['ext::sh -c echo', 'ext', false],
  ['custom::pool', 'custom', false],
])(
  'remote probe isolates lane config: %s (%s supported=%s)', (originUrl, protocol, supported) => {
  const source = /function liveRemoteShasProbe\([^]*?\n\}/.exec(readFileSync(resolve('scripts/lane-pool.mjs'), 'utf8'))[0];
  const calls = [], removed = [];
  const inherited = { GIT_DIR: '/lane/.git', GIT_COMMON_DIR: '/lane/.git', GIT_WORK_TREE: '/lane',
    GIT_CONFIG: '/lane/.git/config', GIT_CONFIG_PARAMETERS: "'protocol.allow=always'" };
  const probe = new Function('tryGit', 'mkdtempSync', 'tmpdir', 'join', 'dirname', 'rmSync', 'laneGitHardeningEnv', 'process', 'resolve', 'scrubGitRepoEnv',
    `${source}; return liveRemoteShasProbe;`)(
    (...args) => {
      calls.push(args);
      // Model Git's final transport allowlist without network access or repository writes.
      return args[2].env.GIT_ALLOW_PROTOCOL.split(':').includes(protocol) ? 'abc refs/heads/trunk' : null;
    },
    () => '/isolated/probe', () => '/isolated', join, () => '/isolated',
    (dir) => removed.push(dir), laneGitHardeningEnv, { env: { ...inherited,
      GIT_ALLOW_PROTOCOL: 'ext:file:http', GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'protocol.ext.allow', GIT_CONFIG_VALUE_0: 'always',
    } }, resolve, scrubGitRepoEnv,
  );
  const repo = { originUrl };
  expect(probe(repo)).toEqual({ ok: supported, shas: new Set(supported ? ['abc'] : []) });
  const [args, cwd, options] = calls[0];
  expect(args).toEqual(['ls-remote', '--heads', '--', originUrl.startsWith('.') ? resolve(originUrl) : originUrl]);
  expect(cwd).toBe('/isolated/probe');
  expect(options.env.GIT_CEILING_DIRECTORIES).toBe('/isolated');
  for (const key of Object.keys(inherited)) expect(options.env[key]).toBeUndefined();
  const config = Object.fromEntries(Array.from({ length: Number(options.env.GIT_CONFIG_COUNT) }, (_, i) =>
    [options.env[`GIT_CONFIG_KEY_${i}`], options.env[`GIT_CONFIG_VALUE_${i}`]]));
  const localOrigin = originUrl.startsWith('/') || originUrl.startsWith('.') || originUrl.startsWith('file:');
  expect(config['protocol.file.allow']).toBe(localOrigin ? 'always' : undefined);
  expect(config['protocol.allow']).toBe('never');
  expect(config['protocol.https.allow']).toBe('always');
  expect(config['protocol.http.allow']).toBe('always');
  expect(config['protocol.git.allow']).toBe('always');
  expect(config['protocol.ssh.allow']).toBe('always');
  expect(options.env.GIT_ALLOW_PROTOCOL).toBe(localOrigin ? 'https:http:git:ssh:file' : 'https:http:git:ssh');
  expect(options.timeout).toBe(20000);
  expect(removed).toEqual(['/isolated/probe']);
});

it.each(['missing origin', 'failed Git read', 'failed isolation'])(
  'remote probe fails closed on %s', (failure) => {
  const source = /function liveRemoteShasProbe\([^]*?\n\}/.exec(readFileSync(resolve('scripts/lane-pool.mjs'), 'utf8'))[0];
  const calls = [], removed = [];
  const probe = new Function('tryGit', 'mkdtempSync', 'tmpdir', 'join', 'dirname', 'rmSync', 'laneGitHardeningEnv', 'resolve', 'scrubGitRepoEnv',
    `${source}; return liveRemoteShasProbe;`)(
    (...args) => { calls.push(args); return null; },
    () => { if (failure === 'failed isolation') throw Error('unavailable'); return '/isolated/probe'; },
    () => '/isolated', join, () => '/isolated', (dir) => removed.push(dir), laneGitHardeningEnv, resolve, scrubGitRepoEnv,
  );
  expect(probe({ originUrl: failure === 'missing origin' ? null : 'https://example.com/pool.git' }))
    .toEqual({ ok: false, shas: new Set() });
  expect(calls).toHaveLength(failure === 'failed Git read' ? 1 : 0);
  expect(removed).toEqual(failure === 'failed Git read' ? ['/isolated/probe'] : []);
});

it('remote probe protocol pins override inherited permissive defaults', () => {
  const env = laneGitHardeningEnv({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'protocol.allow', GIT_CONFIG_VALUE_0: 'always' }, { remoteProbe: true });
  const config = Object.fromEntries(Array.from({ length: Number(env.GIT_CONFIG_COUNT) }, (_, i) =>
    [env[`GIT_CONFIG_KEY_${i}`], env[`GIT_CONFIG_VALUE_${i}`]]));
  expect(config['protocol.allow']).toBe('never');
  expect(config['protocol.https.allow']).toBe('always');
  expect(config['protocol.ssh.allow']).toBe('always');
});

// Read-only proof tests can run even where the launcher forbids Git metadata writes.
const proofSource = /function localRemoteShas\([^]*?\n\}/.exec(readFileSync(resolve('scripts/lane-pool.mjs'), 'utf8'))[0];
const defaultFetch = '+refs/heads/*:refs/remotes/origin/*';
const excludedOps = '^refs/heads/ops/*';
const reclaimSource = /function laneReclaimPreservationProof\([^]*?\n\}/.exec(readFileSync(resolve('scripts/lane-pool.mjs'), 'utf8'))[0];
const fileProofSource = /function filePreservedInMain\([^]*?\n\}/.exec(readFileSync(resolve('scripts/lane-whois.mjs'), 'utf8'))[0];
function countReclaimProbes({ dirty = 3, commits = 20, tips = 30, liveBase = true, env = {}, unreadable = false } = {}) {
  const shows = [], contains = [];
  const fileProof = new Function('tryGit', `${fileProofSource}; return filePreservedInMain;`)(
    (_dir, args) => { shows.push(args[1]); return null; },
  );
  const paths = Array.from({ length: dirty }, (_, i) => `file-${i}`);
  const proof = new Function('gitStatusSummary', 'aheadCommits', 'aheadCommitsPreserved', 'liveRemoteShas',
    'tryGit', 'readFileSync', 'join', 'filePreservedInMain', 'process', `${reclaimSource}; return laneReclaimPreservationProof;`)(
    () => ({ trackedModifiedPaths: paths.slice(0, 1), untrackedPaths: paths.slice(1) }),
    () => Array.from({ length: commits }, (_, i) => ({ sha: `commit-${i}` })), () => new Map(),
    () => new Set([...(liveBase ? ['base'] : []), ...Array.from({ length: tips }, (_, i) => `tip-${i}`)]),
    args => { if (args[0] === 'rev-parse') return 'base'; contains.push(args); return null; },
    () => { if (unreadable) throw Error('unreadable'); return 'local content'; }, join, fileProof, { env },
  );
  const result = proof('/lane', 'trunk', { originUrl: '/canonical' });
  return { result, contains, shows, fallback: shows.filter(ref => !ref.startsWith('base:')) };
}
it('read-only regression: reclaim bounds default fallback probes across all dirty files and commits', () => {
  const { result, shows, fallback, contains } = countReclaimProbes();
  expect(result.preserved).toBe(false);
  expect(contains).toHaveLength(15);
  expect(shows).toHaveLength(43); // three base reads + forty lane-wide fallbacks
  expect(fallback.filter(ref => ref.endsWith(':file-0'))).toHaveLength(20);
  expect(fallback.filter(ref => ref.endsWith(':file-1'))).toHaveLength(20);
  expect(fallback.filter(ref => ref.endsWith(':file-2'))).toHaveLength(0);
});
it.each([true, false])('read-only regression: explicit budgets exhaust across files with live base %s', liveBase => {
  const { shows, fallback, contains } = countReclaimProbes({ dirty: 4, liveBase, env: {
    WE_LANE_WHOIS_MAX_REFS: '3', WE_LANE_WHOIS_MAX_FALLBACK_SHOWS: '5', WE_LANE_WHOIS_MAX_CONTAINS_PROBES: '2',
  } });
  expect(contains).toHaveLength(2);
  expect(shows).toHaveLength(liveBase ? 9 : 5);
  expect(fallback.map(ref => ref.split(':')[1])).toEqual(['file-0', 'file-0', 'file-0', 'file-1', 'file-1']);
});
it.each([25, 26])('read-only regression: reclaim skips fallback above 25 dirty files (%s)', dirty => {
  for (const liveBase of [true, false]) {
    const { shows, fallback } = countReclaimProbes({ dirty, liveBase, commits: 0 });
    expect(fallback).toHaveLength(dirty === 25 ? 40 : 0);
    expect(shows).toHaveLength((liveBase ? dirty : 0) + (dirty === 25 ? 40 : 0));
  }
});
it('read-only regression: failed file reads consume no show probes', () => {
  expect(countReclaimProbes({ unreadable: true }).shows).toHaveLength(0);
});
// Exercise the production proof without invoking the CLI or writing Git metadata. The old
// whois helpers deliberately report the stale tracking ref as preserved, reproducing the gap.
it.each(['commit', 'dirty file', 'failed remote read', 'stale base patch'])(
  'reclaim live proof rejects %s backed only by stale tracking refs', (variant) => {
  const dirty = variant === 'dirty file';
  const proof = new Function('gitStatusSummary', 'aheadCommits', 'aheadCommitsPreserved',
    'lanePreservedFileChecker', 'liveRemoteShas', 'tryGit', 'readFileSync', 'join', 'filePreservedInMain',
    `${reclaimSource}; return laneReclaimPreservationProof;`)(
    () => ({ trackedModifiedPaths: dirty ? ['file.txt'] : [], untrackedPaths: [] }),
    () => dirty ? [] : [{ sha: 'unique', subject: 'unique work' }],
    (_dir, branch, _commits, maxProbes) => new Map([['unique', maxProbes !== 0 || branch === 'stale-base']]),
    () => () => true,
    () => new Set(variant === 'failed remote read' ? [] : ['trunk']),
    (args) => args[0] === 'rev-parse' ? (variant === 'stale base patch' ? 'stale-base' : 'trunk') : 'unique',
    () => 'unique content', join,
    (_dir, _path, ref, _content, refs = []) => [ref, ...refs].includes('unique'),
  );
  const result = proof('/unused', 'trunk');
  expect(result.preserved).toBe(false);
  expect(dirty ? result.unpreservedFiles : result.unpreservedCommitShas).toEqual([dirty ? 'file.txt' : 'unique']);
});
const ensureSource = /function ensureLaneDietConfig\([^]*?\n\}/.exec(readFileSync(resolve('scripts/lane-pool.mjs'), 'utf8'))[0];
it.each([
  ['unchanged', [], false, [defaultFetch, excludedOps]],
  ['repaired', [['config', '--local', '--add', 'remote.origin.fetch', excludedOps]], false, undefined],
  ['failed', [], true, undefined],
])('fetch config snapshot is reused only when %s', (_name, ops, failed, expected) => {
  const ensureLaneDietConfig = new Function('applyLaneDietConfig', 'log', `${ensureSource}; return ensureLaneDietConfig;`)(
    () => { if (failed) throw new Error('config failed'); return ops; }, () => {},
  );
  expect(ensureLaneDietConfig('/unused', { effectiveFetchValues: [defaultFetch, excludedOps] })).toEqual(expected);
  expect(ensureLaneDietConfig('/unused')).toBeUndefined();
});
it.each([[defaultFetch, excludedOps], [defaultFetch, excludedOps, '+refs/heads/ops/*:refs/remotes/origin/archive/*']])(
  'local proof uses the effective config from its successful fetch (%j)', (...fetchValues) => {
  const calls = [];
  const localRemoteShas = new Function('tryGit', `${proofSource}; return localRemoteShas;`)((args) => {
    calls.push(args);
    if (args[0] === 'config') throw new Error('redundant config spawn');
    return 'fresh refs/remotes/origin/trunk \n';
  });
  expect([...localRemoteShas('/unused', fetchValues)]).toEqual(fetchValues.length === 2 ? ['fresh'] : []);
  expect(calls.every((args) => args[0] === 'for-each-ref')).toBe(true);
});
const customFetchCases = [
  ['exact ops remap', [defaultFetch, excludedOps, '+refs/heads/ops/review-requests:refs/remotes/origin/saved']],
  ['wildcard ops remap', [defaultFetch, excludedOps, '+refs/heads/ops/*:refs/remotes/origin/archive/*']],
  ['additional exclusion', [defaultFetch, excludedOps, '^refs/heads/saved']],
  ['restricted positive mapping', ['+refs/heads/trunk:refs/remotes/origin/trunk', excludedOps]],
  ['tag remap', [defaultFetch, excludedOps, '+refs/tags/*:refs/remotes/origin/tags/*']],
  ['missing config', null],
  ['empty config', []],
];
it.each(customFetchCases)('local remote proof rejects %s', (_name, fetchValues) => {
  const tryGit = (args) => args[0] === 'config'
    ? fetchValues?.join('\n') ?? null
    : 'unique refs/remotes/origin/saved \nunique refs/remotes/origin/archive/review-requests ';
  const localRemoteShas = new Function('tryGit', `${proofSource}; return localRemoteShas;`)(tryGit);
  expect([...localRemoteShas('/unused')]).toEqual([]);
});
it.each([[defaultFetch], [defaultFetch, excludedOps], [defaultFetch, excludedOps, defaultFetch]])(
  'local remote proof retains standard direct refs and excludes symbolic and ops refs (%j)', (...fetchValues) => {
  const tryGit = (args) => args[0] === 'config'
    ? fetchValues.join('\n')
    : 'fresh refs/remotes/origin/trunk \nstale refs/remotes/origin/ops/review-requests \nstale refs/remotes/origin/saved refs/remotes/origin/ops/review-requests';
  const localRemoteShas = new Function('tryGit', `${proofSource}; return localRemoteShas;`)(tryGit);
  expect([...localRemoteShas('/unused')]).toEqual(['fresh']);
});

it('provision + acquire keep ops/* out of a lane while explicit reader fetches still work', () => {
  const base = mkdtempSync(join(tmpdir(), 'pool-git-diet-'));
  const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  const opsRefs = (cwd) => git(['for-each-ref', '--format=%(refname)', 'refs/remotes/origin/ops/'], cwd);
  try {
    const origin = join(base, 'origin.git'), reference = join(base, 'reference'), pool = join(base, 'pool');
    git(['init', '--quiet', '--bare', '--initial-branch=trunk', origin]);
    git(['clone', '--quiet', origin, reference]);
    git(['config', 'user.email', 'test@example.com'], reference);
    git(['config', 'user.name', 'Test'], reference);
    writeFileSync(join(reference, 'file.txt'), 'seed');
    git(['add', '.'], reference);
    git(['commit', '--quiet', '-m', 'seed'], reference);
    git(['push', '--quiet', origin, 'HEAD:refs/heads/trunk', 'HEAD:refs/heads/ops/review-requests'], reference);
    const args = [`--origin=${origin}`, `--reference=${reference}`, '--name=diet', '--branch=trunk', '--no-install'];
    const run = (extra) => spawnSync('node', [resolve('scripts/lane-pool.mjs'), ...extra, ...args], { encoding: 'utf8', env: { ...process.env, LANE_POOL_ROOT: pool } });

    const provision = run(['provision', '--count=1']);
    expect(provision.status, provision.stderr).toBe(0);
    const lane = join(pool, 'diet', 'lane-1');
    expect(git(['config', '--get-all', 'remote.origin.fetch'], lane).split('\n')).toContain('^refs/heads/ops/*');
    expect(git(['config', '--get', 'fetch.unpackLimit'], lane)).toBe('1');
    expect(git(['config', '--get', 'transfer.unpackLimit'], lane)).toBe('1');
    expect(opsRefs(lane)).toBe('');

    // An OLD lane (pre-diet config) re-gains the diet on its next acquire fetch.
    git(['config', '--unset', 'remote.origin.fetch', '\\^refs/heads/ops/\\*'], lane);
    git(['config', '--unset', 'fetch.unpackLimit'], lane);
    writeFileSync(join(reference, 'ledger.jsonl'), 'row\n');
    git(['add', '.'], reference);
    git(['commit', '--quiet', '-m', 'ledger'], reference);
    git(['push', '--quiet', origin, 'HEAD:refs/heads/ops/review-requests'], reference);
    const acquire = run(['acquire', '--lane=1', '--session=diet-test']);
    expect(acquire.status, acquire.stderr).toBe(0);
    expect(git(['config', '--get-all', 'remote.origin.fetch'], lane).split('\n')).toContain('^refs/heads/ops/*');
    expect(git(['config', '--get', 'fetch.unpackLimit'], lane)).toBe('1');
    expect(opsRefs(lane)).toBe('');

    // A reader that fetches by name still gets the current tip.
    git(['fetch', '--quiet', 'origin', '+refs/heads/ops/review-requests:refs/remotes/origin/ops/review-requests'], lane);
    expect(git(['rev-parse', 'origin/ops/review-requests'], lane)).toBe(git(['rev-parse', 'HEAD'], reference));
    run(['release', '--lane=1', '--session=diet-test']);

    // Scrubbing an include invalidates the earlier config snapshot: the included diet settings disappear.
    git(['config', '--unset', 'remote.origin.fetch', '\\^refs/heads/ops/\\*'], lane);
    git(['config', '--unset', 'fetch.unpackLimit'], lane);
    git(['config', '--unset', 'transfer.unpackLimit'], lane);
    const included = join(base, 'included.config');
    writeFileSync(included, '[remote "origin"]\nfetch = ^refs/heads/ops/*\n[fetch]\nunpackLimit = 1\n[transfer]\nunpackLimit = 1\n');
    git(['config', 'include.path', included], lane);
    const reacquire = run(['acquire', '--lane=1', '--session=diet-test']);
    expect(reacquire.status, reacquire.stderr).toBe(0);
    expect(git(['config', '--local', '--get-all', 'remote.origin.fetch'], lane).split('\n')).toContain('^refs/heads/ops/*');
    expect(git(['config', '--local', '--get', 'fetch.unpackLimit'], lane)).toBe('1');
    expect(git(['config', '--local', '--get', 'transfer.unpackLimit'], lane)).toBe('1');
    run(['release', '--lane=1', '--session=diet-test']);
  } finally { rmSync(base, { recursive: true, force: true }); }
}, 60000);

// Exercise both localRemoteShas callers: explicit acquire's pre-fetch check and auto-pick's
// post-fetch re-verification. The latter must distrust even an ops ref that proved containment
// at pick time, because the default fetch cannot refresh or prune it.
const staleOpsCases = ['explicit', 'auto'].flatMap((mode) =>
  ['exact tip', 'ancestor'].flatMap((containment) =>
    ['deleted', 'moved'].flatMap((change) =>
      ['none', 'direct', 'chained', 'HEAD', 'external', 'mapped', 'wildcard-mapped'].map((alias) => ({ mode, containment, change, alias })))));

it.each(staleOpsCases)('$mode acquire protects $containment work when its only ops proof was $change (alias: $alias)', ({ mode, containment, change, alias }) => {
  withContainmentLane(({ base, origin, reference, lane, git, run }) => {
    const head = git(['rev-parse', 'HEAD'], lane);
    const content = readFileSync(join(lane, 'file.txt'), 'utf8');
    const ops = 'refs/heads/ops/review-requests';
    git(['fetch', '--quiet', lane, 'HEAD'], reference);
    if (containment === 'ancestor') {
      git(['checkout', '--quiet', '--detach', 'FETCH_HEAD'], reference);
      writeFileSync(join(reference, 'ledger.jsonl'), 'later ledger entry\n');
      git(['add', 'ledger.jsonl'], reference);
      git(['commit', '--quiet', '-m', 'containing ops tip'], reference);
    }
    git(['push', '--quiet', origin, `${containment === 'ancestor' ? 'HEAD' : 'FETCH_HEAD'}:${ops}`], reference);
    git(['fetch', '--quiet', 'origin', `+${ops}:refs/remotes/origin/ops/review-requests`], lane);
    const staleTip = git(['rev-parse', 'origin/ops/review-requests'], lane);
    expect(staleTip === head).toBe(containment === 'exact tip');
    expect(git(['merge-base', '--is-ancestor', head, staleTip], lane)).toBe('');
    expect(git(['for-each-ref', '--contains=HEAD', '--format=%(refname)', 'refs/remotes/origin/'], lane))
      .toBe('refs/remotes/origin/ops/review-requests');

    // Symbolic refs have their own innocent-looking names, but resolve to tips the default
    // fetch does not refresh. Include multi-hop aliases and targets outside origin entirely.
    const opsTracking = 'refs/remotes/origin/ops/review-requests';
    if (alias === 'direct' || alias === 'chained') {
      git(['symbolic-ref', 'refs/remotes/origin/saved', opsTracking], lane);
      if (alias === 'chained') git(['symbolic-ref', 'refs/remotes/origin/backup', 'refs/remotes/origin/saved'], lane);
    } else if (alias === 'HEAD') {
      git(['symbolic-ref', 'refs/remotes/origin/HEAD', opsTracking], lane);
    } else if (alias === 'external') {
      git(['update-ref', 'refs/saved/proof', staleTip], lane);
      git(['symbolic-ref', 'refs/remotes/origin/saved', 'refs/saved/proof'], lane);
    } else if (alias === 'mapped' || alias === 'wildcard-mapped') {
      const mapping = alias === 'mapped'
        ? `+${ops}:refs/remotes/origin/saved`
        : '+refs/heads/ops/*:refs/remotes/origin/archive/*';
      git(['config', '--add', 'remote.origin.fetch', mapping], lane);
      git(['fetch', '--quiet', 'origin', mapping], lane);
    }

    const mutation = change === 'deleted'
      ? ['update-ref', '-d', ops]
      : ['update-ref', ops, 'refs/heads/trunk'];
    // Explicit acquire checks local refs before fetching. Auto-pick first sees a genuinely live
    // remote proof; mutate origin at the fetch boundary to make that proof stale deterministically.
    if (mode === 'explicit') git(mutation, origin);
    const bin = join(base, 'bin'), trace = join(base, 'git-trace.jsonl');
    mkdirSync(bin);
    writeFileSync(trace, '');
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    writeFileSync(join(bin, 'git'), `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const { appendFileSync } = require('node:fs');
const args = process.argv.slice(2);
// Match and trace the subcommand after transport-hardening config options; forward the original argv.
const commandArgs = args.slice();
while (commandArgs[0] === '-c') commandArgs.splice(0, 2);
appendFileSync(${JSON.stringify(trace)}, JSON.stringify(commandArgs) + '\\n');
if (${JSON.stringify(mode)} === 'auto' && commandArgs[0] === 'fetch') {
  const changed = spawnSync(${JSON.stringify(realGit)}, ${JSON.stringify(mutation)}, { cwd: ${JSON.stringify(origin)}, stdio: 'inherit' });
  if (changed.status !== 0) process.exit(changed.status ?? 1);
}
const result = spawnSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit' });
process.exit(result.status ?? 1);
`);
    chmodSync(join(bin, 'git'), 0o755);

    const acquire = run(['acquire', ...(mode === 'explicit' ? ['--lane=1'] : []), '--session=stale-ops', '--hard-max=1'], { PATH: `${bin}:${process.env.PATH}` });
    expect(acquire.status, acquire.stderr).not.toBe(0);
    expect(acquire.stderr).toMatch(mode === 'explicit' ? /would destroy that work/ : /no longer provably safe to reset/);
    const calls = readFileSync(trace, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    if (mode === 'auto') expect(calls.some((args) => args[0] === 'fetch' && args.includes('--prune'))).toBe(true);
    expect(calls.some((args) => (args[0] === 'checkout' && args.includes('-B')) || args[0] === 'clean')).toBe(false);
    expect(git(['rev-parse', 'origin/ops/review-requests'], lane)).toBe(staleTip);
    expect(git(['for-each-ref', '--contains=' + head, '--format=%(refname)', 'refs/heads/'], origin)).toBe('');
    expect(git(['rev-parse', 'HEAD'], lane)).toBe(head);
    expect(readFileSync(join(lane, 'file.txt'), 'utf8')).toBe(content);
    expect(existsSync(join(lane, '.git', '.lane-lease'))).toBe(false);
  });
}, 60000);

it.each(['explicit', 'auto'])('%s acquire can still reset work contained by a fresh non-ops ref', (mode) => {
  withContainmentLane(({ origin, lane, git, run }) => {
    git(['push', '--quiet', origin, 'HEAD:refs/heads/lane/landed'], lane);
    git(['fetch', '--quiet', 'origin'], lane);
    const acquire = run(['acquire', ...(mode === 'explicit' ? ['--lane=1'] : []), '--session=fresh-proof', '--hard-max=1']);
    expect(acquire.status, acquire.stderr).toBe(0);
    expect(acquire.stdout.trim()).toBe(lane);
    expect(git(['rev-parse', 'HEAD'], lane)).toBe(git(['rev-parse', 'refs/heads/trunk'], origin));
    expect(readFileSync(join(lane, 'file.txt'), 'utf8')).toBe('seed\n');
  });
}, 60000);

it.each([
  {}, { change: 'deleted' }, { containment: 'ancestor' },
  { alias: 'symbolic', change: 'deleted', containment: 'ancestor' },
  { alias: 'mapped' }, { alias: 'wildcard-mapped' },
  { kind: 'dirty' }, { alias: 'wildcard-mapped', kind: 'dirty' },
  { dryRun: true }, { race: true }, { live: true },
  { live: true, containment: 'ancestor' }, { live: true, kind: 'dirty' },
  { dryRun: true, hostileRemote: 'origin' },
  { dryRun: true, hostileRemote: 'rewrite' },
  { dryRun: true, hostileRemote: 'worktree-rewrite' },
  { dryRun: true, live: true, hostileRemote: 'origin' },
  { dryRun: true, live: true, hostileRemote: 'rewrite' },
  { dryRun: true, live: true, missingOrigin: true },
])('refresh then reclaim validates live preservation (%j)', async (options) => {
  const report = await runReclaimCase(resolve('.'), options);
  expect(report.violations).toEqual([]);
}, 60000);

function withContainmentLane(check) {
  const base = mkdtempSync(join(tmpdir(), 'pool-ops-containment-'));
  const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  try {
    const origin = join(base, 'origin.git'), reference = join(base, 'reference'), pool = join(base, 'pool');
    git(['init', '--quiet', '--bare', '--initial-branch=trunk', origin]);
    git(['clone', '--quiet', origin, reference]);
    git(['config', 'user.email', 'test@example.com'], reference);
    git(['config', 'user.name', 'Test'], reference);
    writeFileSync(join(reference, 'file.txt'), 'seed\n');
    git(['add', 'file.txt'], reference);
    git(['commit', '--quiet', '-m', 'seed'], reference);
    git(['push', '--quiet', origin, 'HEAD:refs/heads/trunk'], reference);
    const args = [`--origin=${origin}`, `--reference=${reference}`, '--name=containment', '--branch=trunk', '--no-install'];
    const run = (extra, env = {}) => spawnSync('node', [resolve('scripts/lane-pool.mjs'), ...extra, ...args], {
      encoding: 'utf8', env: { ...process.env, LANE_POOL_ROOT: pool, ...env }, timeout: 30000,
    });
    const provision = run(['provision', '--count=1']);
    expect(provision.status, provision.stderr).toBe(0);
    const lane = join(pool, 'containment', 'lane-1');
    git(['config', 'user.email', 'test@example.com'], lane);
    git(['config', 'user.name', 'Test'], lane);
    writeFileSync(join(lane, 'file.txt'), 'irreplaceable lane work\n');
    git(['add', 'file.txt'], lane);
    git(['commit', '--quiet', '-m', 'unique lane work'], lane);
    expect(git(['rev-list', '--count', 'origin/trunk..HEAD'], lane)).toBe('1');
    check({ base, origin, reference, lane, git, run });
  } finally { rmSync(base, { recursive: true, force: true }); }
}
