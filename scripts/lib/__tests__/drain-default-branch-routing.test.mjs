// @vitest-environment node
import { it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildOpenPrPageQuery } from '../pr-list-paged.mjs';
import { classifyChildFailure } from '../child-failure-class.mjs';
import { SNAPSHOT_FIELDS } from '../pr-snapshot.mjs';
import { PR_SNAPSHOT_VERSION } from '../pr-snapshot-store.mjs';
import { daemonAppEnv } from '../../__tests__/fixtures/daemon-app-env.mjs';
import { openPrPageFixture } from '../../__tests__/fixtures/open-pr-page-fixture.mjs';
import { completeCheckReadFixture } from '../../__tests__/fixtures/complete-check-read-fixture.mjs';
import { createLiveDefaultBranchReader } from '../default-branch-cache.mjs';
import { ownerFromGhArgv, ownerOfSlug } from '../github-app-installations.mjs';

// Execute the CLI's actual reader/warning closures without starting its mutation loop.
const source = readFileSync(new URL('../../merge-ai-prs.mjs', import.meta.url), 'utf8');
const errorText = new Function(`${source.slice(source.indexOf('export function ghListErrText('),
  source.indexOf('\n/**', source.indexOf('export function ghListErrText('))).replace('export ', '')}; return ghListErrText;`)();
const readerSource = source.slice(source.indexOf('  const newDefaultBranchReader ='),
  source.indexOf('  const verifyDefaultBranch ='));
const localRepo = 'web-everything/web-everything';
const repos = [localRepo, 'frontier-ui/frontierui', 'plateauapp/plateau-app'];

function fixture(unreadable = null, stderr = null) {
  const warnings = [], calls = [], map = new Map();
  const exec = async (file, args, options) => {
    calls.push({ file, args, options });
    // Same owner selection as the App shim: argv, GH_REPO, then checkout origin.
    const owner = ownerFromGhArgv(args) || ownerOfSlug(options.env?.GH_REPO || localRepo);
    if (owner !== ownerOfSlug(args[2]) || args[2] === unreadable) {
      throw Object.assign(new Error('Command failed: gh repo view'), {
        stderr: stderr ?? `GraphQL: Could not resolve to a Repository\n for ${args[2]}`,
      });
    }
    return { stdout: 'trunk\n' };
  };
  const create = new Function('createLiveDefaultBranchReader', 'defaultBranchByRepo', 'execFileP', 'process', 'ghListErrText', 'classifyChildFailure',
    `${readerSource}; return newDefaultBranchReader;`)(
    options => createLiveDefaultBranchReader({ ...options, writeCache: () => {} }), map, exec,
    { env: { GH_REPO: localRepo }, stderr: { write: line => warnings.push(line) } }, errorText, classifyChildFailure);
  return { create, warnings, calls, map };
}

it('resolves every constellation default branch with the target owner despite ambient GH_REPO', async () => {
  const f = fixture();
  for (const repo of repos) expect(await f.create()(repo)).toBe('trunk');
  expect(f.calls.map(c => c.options.env.GH_REPO)).toEqual(repos);
  expect(f.warnings).toEqual([]);
});

it('refuses an unreadable sibling branch and logs its fixed error class for the next-pass retry', async () => {
  const f = fixture(repos[1]);
  expect(await f.create()(repos[1])).toBeNull();
  expect(f.map.get(repos[1])).toBeNull();
  expect(f.warnings.join('')).toContain('class=gh-not-found');
  expect(f.warnings.join('')).not.toContain('Could not resolve');
  expect(f.warnings.join('')).toContain('retry on the next pass');
});

it('keeps shared gh errors on the last nonempty line with the historical 300-character bound', () => {
  expect(errorText({ message: 'Command failed\nignored', stderr: 'warning\nGraphQL: not mergeable\n \n' }))
    .toBe('Command failed — gh: GraphQL: not mergeable');
  expect(errorText({ message: 'Command failed', stderr: `warning\n${'x'.repeat(500)}` }))
    .toBe(`Command failed — gh: ${'x'.repeat(300)}`);
});

it('publishes only a fixed class for hostile default-branch stderr', async () => {
  const secret = 'ghp_' + 'A'.repeat(2100);
  const f = fixture(repos[1], 'Authorization: Negotiate ' + secret + '\nGraphQL: denied');
  expect(await f.create()(repos[1])).toBeNull();
  const warning = f.warnings.join('');
  expect(warning).toContain('class=unknown');
  expect(warning).not.toContain(secret);
  expect(warning).not.toContain('GraphQL: denied');
  expect(warning).not.toContain('Authorization');
});

// Exercise the actual CLI and its App refusal shim. Positional `repo view` must
// select the target owner's installation through GH_REPO, even with a local ambient repo.
function catchUpCli(unreadable = '', probeQuery = null, { indexMode = 'shadow', branchError = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'branch-routing-'));
  try {
    const bin = join(dir, 'bin'), snapshots = join(dir, 'snapshots');
    mkdirSync(bin); mkdirSync(snapshots); mkdirSync(join(dir, 'backlog'));
    const target = { number: 7, title: 'routing fixture', body: '', headRefName: 'lane/routing',
      headRefOid: '7'.repeat(40), updatedAt: '2026-11-23T00:00:00Z', state: 'OPEN', isDraft: false,
      baseRefName: 'trunk', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: '',
      labels: [], files: [], statusCheckRollup: [], commits: [], rowsHead: '7'.repeat(40), rowsComplete: true };
    for (const repo of repos) writeFileSync(join(snapshots, `${repo.replace('/', '__')}.json`),
      JSON.stringify({ v: PR_SNAPSHOT_VERSION, repo, fetchedAtMs: Date.now(), fields: SNAPSHOT_FIELDS,
        count: repo === localRepo ? 1 : 0, prs: repo === localRepo ? [target] : [] }));
    writeFileSync(join(dir, 'target.json'), JSON.stringify(target));
    writeFileSync(join(dir, 'calls.jsonl'), '');
    writeFileSync(join(bin, 'git'), `#!/usr/bin/env node
const a = process.argv.slice(2);
if (a[0] === 'remote' && a[1] === 'get-url') process.stdout.write('https://github.com/${localRepo}.git');
// No real git is reachable and no .git files are created or written.
`, { mode: 0o755 });
    writeFileSync(join(bin, 'gh'), `#!/usr/bin/env node
const fs = require('node:fs');
const a = process.argv.slice(2);
const repo = a.includes('--repo') ? a[a.indexOf('--repo') + 1] : process.env.GH_REPO;
fs.appendFileSync(process.env.ROUTING_CALLS, JSON.stringify({args:a,repo}) + '\\n');
const target = JSON.parse(fs.readFileSync(process.env.ROUTING_TARGET, 'utf8'));
const out = v => { process.stdout.write(JSON.stringify(v)); process.exit(0); };
const openPrPageFixture = ${openPrPageFixture};
const completeCheckReadFixture = ${completeCheckReadFixture};
const checks = completeCheckReadFixture([target], a);
if (checks !== undefined) out(checks);
if (a[0] === 'repo' && a[1] === 'view') {
  if (repo?.split('/')[0] !== a[2]?.split('/')[0] || a[2] === process.env.ROUTING_UNREADABLE) {
    process.stderr.write(process.env.ROUTING_BRANCH_ERROR || 'GraphQL: Could not resolve to a Repository\\n for ' + a[2]); process.exit(1);
  }
  process.stdout.write('trunk'); process.exit(0);
}
if (a[0] === 'api' && a[1]?.includes('/git/ref/heads/trunk')) { process.stdout.write('a'.repeat(40)); process.exit(0); }
if (a[0] === 'api' && a[1] === 'graphql') {
  const query = a.find(v => v.startsWith('query=')) || '';
  const expected = ${JSON.stringify(repos.map(repo => 'query=' + buildOpenPrPageQuery({ repo, pageSize: 100, inventoryOnly: true })))};
  if (!expected.includes(query)) {
    process.stderr.write('unported fixture call: ' + a.join(' ')); process.exit(1);
  }
  const rows = query.includes('owner:"web-everything"') && query.includes('name:"web-everything"') ? [target] : [];
  const page = openPrPageFixture(rows, query);
  page.data.repository.pullRequests.nodes.forEach(p => { p.state = 'OPEN'; });
  out(page);
}
if (a[0] === 'pr' && a[1] === 'view' && a[2] === '7') out(target);
// Refuse every mutation and unknown call instead of silently making the fixture pass.
process.stderr.write('unported fixture call: ' + a.join(' ')); process.exit(1);
`, { mode: 0o755 });
    if (probeQuery !== null) return spawnSync(process.execPath, [join(bin, 'gh'), 'api', 'graphql', '-f', `query=${probeQuery}`], {
      encoding: 'utf8', env: { ...process.env, GH_REPO: localRepo,
        ROUTING_CALLS: join(dir, 'calls.jsonl'), ROUTING_TARGET: join(dir, 'target.json') },
    });
    const round = join(dir, 'round.json');
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../../merge-ai-prs.mjs', import.meta.url)),
      '--only=7', '--this-repo', '--json', '--from-catch-up', `--listing-snapshot=${round}`,
      '--label=ready-to-merge', '--no-reconcile-labels', '--no-drain-lease', '--no-red-main-freeze', '--repoll-delay=0'], {
      cwd: dir, encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, ...daemonAppEnv(dir), PATH: `${bin}:${process.env.PATH}`, GH_REPO: localRepo,
        WE_UNDER_TEST: '1', WE_FAST_DRAIN_CONTEXT: 'snapshot', WE_FAST_DRAIN_LISTING: 'snapshot', WE_FAST_DRAIN_SCOPE: 'target',
        WE_FAST_DRAIN_INDEX_MODE: indexMode,
        WE_PR_SNAPSHOT: '1', WE_PR_SNAPSHOT_DIR: snapshots, WE_PR_SNAPSHOT_TTL_MS: '75000',
        WE_DEFAULT_BRANCH_CACHE_DIR: join(dir, 'branches'), WE_GH_THROTTLE_GH_BIN: join(bin, 'gh'),
        WE_GH_THROTTLE_RETRY_MAX_ATTEMPTS: '1', WE_GH_THROTTLE_COST_HEADERS: '0',
        ROUTING_UNREADABLE: unreadable, ROUTING_BRANCH_ERROR: branchError || '',
        ROUTING_CALLS: join(dir, 'calls.jsonl'), ROUTING_TARGET: join(dir, 'target.json') },
    });
    expect(result.stderr).not.toContain('unported fixture call');
    const calls = readFileSync(join(dir, 'calls.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
    const expected = repos.map(repo => 'query=' + buildOpenPrPageQuery({ repo, pageSize: 100, inventoryOnly: true }));
    for (const call of calls.filter(c => c.args[0] === 'api' && c.args[1] === 'graphql')) {
      expect(expected).toContain(call.args.find(a => a.startsWith('query=')));
    }
    return { ...result, calls, round: existsSync(round) ? JSON.parse(readFileSync(round, 'utf8')) : null };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

it('catch-up fast drain with a listing snapshot resolves cross-owner branches and returns valid JSON', () => {
  const r = catchUpCli();
  expect(r.error, r.stderr).toBeUndefined();
  expect(r.status, r.stderr).toBe(0);
  expect(JSON.parse(r.stdout)).toMatchObject({ ok: true, merged: [], failed: [] });
  expect(r.round.repos.toSorted()).toEqual(repos.toSorted());
  for (const repo of repos) {
    expect(r.round.heads[repo]).toEqual({ sha: 'a'.repeat(40), defaultBranch: 'trunk' });
    expect(r.calls.some(c => c.args[0] === 'repo' && c.args[2] === repo && c.repo === repo)).toBe(true);
  }
  expect(r.stderr).not.toContain('unported fixture call');
}, 40_000);

it.each(repos)('catch-up snapshot refuses unreadable branch %s before merge or enqueue', repo => {
  const r = catchUpCli(repo);
  expect(r.error, r.stderr).toBeUndefined();
  expect(r.status, r.stderr).toBe(1);
  expect(r.stderr).toContain('fast-drain: incomplete pass context (default branch unresolved live)');
  expect(r.stderr).toContain(`${repo}: default branch unresolved live (class=gh-not-found)`);
  expect(r.stderr).not.toContain('Could not resolve to a Repository');
  expect(r.stdout.trim()).toBe('');
  expect(r.round).toBeNull();
  expect(r.calls.some(c => c.args[0] === 'pr' && ['merge', 'edit'].includes(c.args[1]))).toBe(false);
  expect(r.calls.some(c => c.args[0] === 'api' && c.args.some(a => /enqueuePullRequest|mergePullRequest|\bmutation\b|POST/.test(a)))).toBe(false);
}, 40_000);

it.each(['shadow', 'on'])('captures hostile synchronous branch stderr and defers without writes (index %s)', indexMode => {
  const secret = 'ghp_' + 'Z'.repeat(100);
  const r = catchUpCli(localRepo, null, { indexMode,
    branchError: `GraphQL: Could not resolve to a Repository\nAuthorization: Negotiate ${secret}` });
  expect(r.error, r.stderr).toBeUndefined();
  expect(r.stderr).not.toContain(secret);
  expect(r.stderr).not.toContain('Authorization');
  expect(r.stderr).not.toContain('Could not resolve to a Repository');
  if (indexMode === 'shadow') {
    expect(r.status, r.stderr).toBe(1);
    expect(r.stderr).toContain('fast-drain: incomplete pass context (default branch unresolved live)');
    expect(r.stderr).toContain(`${localRepo}: default branch unresolved live (class=gh-not-found)`);
    expect(r.stdout.trim()).toBe('');
  } else {
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: true, considered: 0,
      enqueueOutcomes: [{ enqueued: false, deferred: true, kind: 'defer-to-pass:queue-precondition' }] });
  }
  expect(r.round).toBeNull();
  expect(r.calls.some(c => c.args[0] === 'pr' && ['merge', 'edit'].includes(c.args[1]))).toBe(false);
  expect(r.calls.some(c => c.args[0] === 'api' && c.args.some(a => /enqueuePullRequest|mergePullRequest|\bmutation\b|POST/.test(a)))).toBe(false);
}, 40_000);

it.each([
  'mutation { mergePullRequest(input:{pullRequestId:"PR_7"}) { clientMutationId } }',
  'mutation { enqueuePullRequest(input:{pullRequestId:"PR_7"}) { clientMutationId } }',
  'query Unexpected { viewer { login } }',
])('fake gh refuses unexpected GraphQL: %s', query => {
  const result = catchUpCli('', query);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('unported fixture call');
});
