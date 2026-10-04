import { describe, it, expect, vi } from 'vitest';
import { stripGhDebug, rateLimitRecords } from '../gh-throttle.mjs';
import { meteredPrCommits, meteredAlreadyDone } from '../gh-metered-reads.mjs';
import { attributeSpend } from '../gh-spend.mjs';
import { fetchPrCommits, countBackpressurePrs } from '../pr-limit.mjs';
import { readGitPrCommits } from '../git-pr-commits.mjs';
import { readGitAlreadyDone } from '../git-already-done.mjs';
import { classifyGhWrite } from '../gh-throttle.mjs';
import { defaultCheckAlreadyDone, defaultCheckAlreadyDoneAsync } from '../../operations/dispatch-lane-io.mjs';

const merge = '88396bb20\0' + '2026-09-30T12:00:00Z\0aaa bbb\0Merge pull request #3084 from chalbert/lane/4386-prepare-item\n\nWE #4386: prepare item — Design/MVP/Test plan/Proof plan/Follow-ups\n\0';
const OID = 'f'.repeat(40);
function gitFixture(log = merge, files = 'backlog/4386-item.md\0') {
  return vi.fn((_file, args) => {
    if (args[0] === 'rev-parse') return args.includes('--is-shallow-repository') ? 'false\n' : `${OID}\n`;
    if (args[0] === 'remote') return 'git@github.com:web-everything/web-everything.git\n';
    if (args.includes('--grep=JIT-number')) return 'drain: JIT-number xcyvee3→#4586 at land (#2288)\n';
    if (args[0] === 'log') return log;
    if (args[0] === 'diff') return files;
    return '';
  });
}

describe('in-band cost', () => {
  it('captures the response cost, not a concurrent caller’s shared delta', () => {
    const trace = '* Request at now\n* Request to https://api.github.com/graphql\n< HTTP/2.0 200 OK\n< X-Ratelimit-Used: 100\n< X-Ratelimit-Reset: 200\n< X-Ratelimit-Resource: graphql\n\n{"data":{"rateLimit":{"cost":1}}}\n\n* Request took 1ms\n';
    const records = rateLimitRecords(stripGhDebug(trace).responses);
    expect(records[0].cost).toBe(1);
    const result = attributeSpend([{ ts: '2026-09-30T12:00:00Z', outcome: 'call', id: 'app', op: 'api graphql', rl: records }], { baselines: { 'app|graphql|200': { used: 10, t: Date.parse('2026-09-30T11:59:00Z') } } });
    expect(result.gaps[0]).toMatchObject({ delta: 90, attributed: 1, unattributed: 89 });
  });
});

describe('git paths', () => {
  it('excludes a real prepare merge with no GitHub calls, sync and async', async () => {
    const gh = vi.fn(() => { throw new Error('GitHub must not run'); });
    expect(defaultCheckAlreadyDone('4386', { git: gitFixture(), exec: gh })).toEqual({ done: false, pr: null, checked: true });
    expect(await defaultCheckAlreadyDoneAsync('4386', { git: gitFixture(), execFileFn: gh })).toEqual({ done: false, pr: null, checked: true });
    expect(gh).not.toHaveBeenCalled();
  });
  it('retains body-disclaimer safety by falling back for a potentially implementing merge', () => {
    const gh = vi.fn(() => JSON.stringify([{ title: 'WE #4386: build', body: 'does not resolve #4386', files: [{ path: 'scripts/a.mjs' }] }]));
    const git = gitFixture(merge.replace('4386-prepare-item', '4386-build').replace('prepare item', 'build'), 'scripts/a.mjs\0');
    expect(defaultCheckAlreadyDone('4386', { git, exec: gh }).done).toBe(false);
    expect(gh).toHaveBeenCalledTimes(1);
  });
  it('reads commits after fetch and gives the existing classifier equivalent inputs at zero GitHub calls', () => {
    const git = gitFixture('abc\0Nic\0nic@example.com\0Build\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n\0Claude <noreply@anthropic.com>\0');
    const gh = vi.fn(() => { throw new Error('GitHub must not run'); });
    const commits = fetchPrCommits('web-everything/web-everything', 3084, { headRefName: 'lane/4386-build', headRefOid: OID, baseRefName: 'main', git, exec: gh });
    expect(commits[0].authors).toContainEqual({ name: 'Claude', email: 'noreply@anthropic.com' });
    expect(countBackpressurePrs([{ number: 3084, commits }])).toHaveLength(1);
    expect(git.mock.calls.findIndex(([, a]) => a[0] === 'fetch')).toBeLessThan(git.mock.calls.findIndex(([, a]) => a[0] === 'log'));
    expect(gh).not.toHaveBeenCalled();
  });
  it('falls back when fetch fails', () => {
    const git = vi.fn(() => { throw new Error('offline'); });
    const gh = vi.fn(() => JSON.stringify([{ data: { repository: { pullRequest: { commits: { nodes: [] } } } } }]));
    expect(fetchPrCommits('web-everything/web-everything', 3084, { headRefName: 'lane/4386', headRefOid: OID, baseRefName: 'main', git, exec: gh })).toEqual([]);
    expect(gh).toHaveBeenCalledTimes(1);
  });
});


describe('metered fallback query shapes', () => {
  it('keeps cost in-band and projects the same consumer JSON', () => {
    const rows = [{ number: 42, title: 'WE #4386: build' }];
    const exec = vi.fn(() => JSON.stringify(rows));
    expect(meteredAlreadyDone('web-everything/web-everything', '4386', { exec })).toEqual(rows);
    const pages = [
      { data: { repository: { pullRequest: { commits: { nodes: [{ commit: { oid: 'a', authors: { nodes: [{ name: 'N', email: 'e' }] } } }] } } } } },
      { data: { repository: { pullRequest: { commits: { nodes: [{ commit: { oid: 'b', authors: { nodes: [] } } }] } } } } },
    ];
    const execPages = vi.fn(() => JSON.stringify(pages));
    expect(meteredPrCommits('web-everything/web-everything', 42, { exec: execPages })).toEqual([{ oid: 'a', authors: [{ name: 'N', email: 'e' }] }, { oid: 'b', authors: [] }]);
    for (const [argv] of [...exec.mock.calls, ...execPages.mock.calls]) expect(argv.find((arg) => arg.startsWith('query='))).toContain('rateLimit { cost }');
    const argv = execPages.mock.calls[0][0];
    expect(argv).toEqual(expect.arrayContaining(['--paginate', '--slurp']));
    expect(argv).not.toContain('--jq'); // gh rejects --slurp together with --jq
  });
  it('can attribute the first response from its own cost without a preceding counter', () => {
    const { gaps } = attributeSpend([{ ts: '2026-09-30T12:00:00Z', outcome: 'call', id: 'app', op: 'api graphql', rl: [{ res: 'graphql', reset: 200, used: 100, cost: 2 }] }]);
    expect(gaps[0]).toMatchObject({ delta: 2, attributed: 2, unattributed: 0 });
  });
});

describe('readGitPrCommits null-return guards', () => {
  const ok = { headRefOid: OID, baseRefName: 'main' };
  const gitFor = (over = {}) => vi.fn((_f, args) => {
    const k = args.join(' ');
    for (const [needle, v] of Object.entries(over)) if (k.includes(needle)) return v;
    if (k.includes('is-shallow')) return 'false\n';
    if (args[0] === 'rev-parse') return OID + '\n';
    if (args[0] === 'remote') return 'https://github.com/web-everything/web-everything.git\n';
    if (args[0] === 'log') return '';
    return '';
  });
  const read = (git, o = ok, head = 'lane/x') => readGitPrCommits('web-everything/web-everything', head, { git, ...o });
  it('reads when every guard passes', () => expect(read(gitFor())).toEqual([]));
  it('falls back without headRefOid', () => expect(read(gitFor(), { baseRefName: 'main' })).toBeNull());
  it('falls back on head oid mismatch', () => expect(read(gitFor({ 'rev-parse origin/': 'a'.repeat(40) + '\n' }))).toBeNull());
  it('falls back for a non-main (stacked) base', () => expect(read(gitFor(), { ...ok, baseRefName: 'lane/other' })).toBeNull());
  it('falls back without a base', () => expect(read(gitFor(), { headRefOid: OID })).toBeNull());
  it('falls back on a foreign remote', () => expect(read(gitFor({ 'remote get-url': 'https://github.com/someone/web-everything.git\n' }))).toBeNull());
  it('falls back on a non-github host', () => expect(read(gitFor({ 'remote get-url': 'https://evil.example/web-everything/web-everything.git\n' }))).toBeNull());
  it('falls back on shallow history', () => expect(read(gitFor({ 'is-shallow': 'true\n' }))).toBeNull());
  it.each(['-x', 'a b', '..', ''])('falls back on invalid head %j', (h) => expect(read(gitFor(), ok, h)).toBeNull());
});

describe('readGitAlreadyDone squash/rebase safety', () => {
  const run = (log) => readGitAlreadyDone('4386', { git: gitFixture(log), filter: (p) => p, now: () => Date.now() });
  it('falls back when a squash-merged first-parent commit names the item', () => {
    expect(run('abc123\x002026-09-30T12:00:00Z\0parent1\0WE #4386: build the thing (#3090)\n\0')).toBeNull();
  });
  it('still answers locally when one-parent commits do not name the item', () => {
    expect(run('abc123\x002026-09-30T12:00:00Z\0parent1\0WE #9999: something else (#3091)\n\0')).toEqual({ done: false, pr: null, checked: true });
  });
  it('fetches origin/main once across back-to-back checks', () => {
    const git = gitFixture();
    for (let i = 0; i < 3; i++) readGitAlreadyDone('4386', { git, cwd: '/fetch-once-fixture', filter: (p) => p });
    expect(git.mock.calls.filter(([, a]) => a[0] === 'fetch')).toHaveLength(1);
  });
});

describe('read-only graphql is not a write', () => {
  it('does not count a query as a write, but does count a mutation', () => {
    expect(classifyGhWrite(['api', 'graphql', '-f', 'query=query { viewer { login } }'])).toBe(false);
    expect(classifyGhWrite(['api', 'graphql', '-f', 'query=mutation { addStar(input:{}) { clientMutationId } }'])).toBe(true);
    expect(classifyGhWrite(['api', 'repos/o/n/issues', '-f', 'title=x'])).toBe(true);
  });
  it('the real metered argv is classified as a read', () => {
    const exec = vi.fn(() => '[]');
    meteredPrCommits('o/n', 1, { exec });
    meteredAlreadyDone('o/n', '1', { exec });
    for (const [argv] of exec.mock.calls) expect(classifyGhWrite(argv)).toBe(false);
  });
});

describe('review-round hardening (#3103)', () => {
  it('a graphql query whose text is hidden (@file / --input) stays a write', () => {
    expect(classifyGhWrite(['api', 'graphql', '-F', 'query=@q.graphql'])).toBe(true);
    expect(classifyGhWrite(['api', 'graphql', '-f', 'query=query { viewer { login } }', '--input', 'body.json'])).toBe(true);
  });
  it('meteredAlreadyDone forwards the caller subprocess bounds to the exec', () => {
    const exec = vi.fn(() => '[]');
    meteredAlreadyDone('o/n', '1', { exec, opts: { timeout: 123, killSignal: 'SIGKILL', maxBuffer: 4096 } });
    expect(exec.mock.calls[0][1]).toMatchObject({ timeout: 123, killSignal: 'SIGKILL', maxBuffer: 4096, encoding: 'utf8' });
  });
  it.each(['(a+)+$', '.*', 'x1;y', ''])('falls back on an unsafe bornAs %j', (bornAs) => {
    expect(readGitAlreadyDone('4386', { git: gitFixture(), bornAs, filter: (p) => p })).toBeNull();
  });
  it('falls back for merged PRs outside main ancestry (a non-main long-lived base exists)', () => {
    const base = gitFixture('');
    const git = vi.fn((f, args, o) => (args[0] === 'ls-remote' ? 'aaa\trefs/heads/main\nbbb\trefs/heads/release/1.0\n' : base(f, args, o)));
    expect(readGitAlreadyDone('4386', { git, cwd: '/other-base-fixture', filter: (p) => p })).toBeNull();
  });
  it('still answers locally when only main and lane/* heads exist', () => {
    const base = gitFixture('');
    const git = vi.fn((f, args, o) => (args[0] === 'ls-remote' ? 'aaa\trefs/heads/main\nbbb\trefs/heads/lane/x\n' : base(f, args, o)));
    expect(readGitAlreadyDone('4386', { git, cwd: '/lane-only-fixture', filter: (p) => p })).toEqual({ done: false, pr: null, checked: true });
  });
});

it('the planner reads PR commit facts locally and does not fetch or fall back to GitHub', () => {
  const git = gitFixture('');
  const exec = vi.fn(() => { throw new Error('network forbidden'); });
  expect(fetchPrCommits('web-everything/web-everything', 1, { git, exec, localOnly: true,
    headRefName: 'lane/x-test', headRefOid: OID, baseRefName: 'main' })).toEqual([]);
  expect(git.mock.calls.some(([, args]) => args[0] === 'fetch')).toBe(false);
  expect(exec).not.toHaveBeenCalled();
  expect(fetchPrCommits('web-everything/web-everything', 1, { git: () => { throw new Error('missing object'); }, exec,
    localOnly: true, headRefName: 'lane/x-test', headRefOid: OID, baseRefName: 'main' })).toBeNull();
  expect(exec).not.toHaveBeenCalled();
});
