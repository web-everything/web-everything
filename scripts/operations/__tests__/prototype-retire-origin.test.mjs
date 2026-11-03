/** Origin identity regression for fetch-failed retirement. All Git/GitHub IO is injected. */
import { describe, it, expect, vi } from 'vitest';
import { planFetchFailed, resolveOriginRepository } from '../prototype-retire.mjs';
import { defaultDeps } from '../prototype-load-io.mjs';
import { proveRetirement, proveSquashMerged } from '../../daemon-overlay.mjs';

const REPO = 'web-everything/web-everything';
const REF = 'lane/example';
const TIP = 'a'.repeat(40);
const MERGE = 'b'.repeat(40);
const repository = (repo, host = 'github.com') => JSON.stringify({ nameWithOwner: repo, url: `https://${host}/${repo}` });
const merged = (extra = {}) => ({ number: 7, state: 'MERGED', headRefName: REF, headRefOid: TIP,
  mergeCommit: { oid: MERGE }, headRepository: { nameWithOwner: REPO }, isCrossRepository: false, ...extra });

function proof(prs, row = { ref: REF }) {
  const gh = vi.fn((args) => {
    if (args[0] === 'repo' && args[1] === 'view') return { code: 0, stdout: repository(REPO) };
    if (args[0] === 'pr' && args[1] === 'list') return { code: 0, stdout: JSON.stringify(prs) };
    throw new Error(`unexpected gh call: ${args.join(' ')}`);
  });
  const git = vi.fn((args) => {
    if (args[0] === 'remote') return { code: 0, stdout: `https://github.com/${REPO}.git` };
    if (args[0] === 'fetch') return { code: 1, stdout: '' }; // deleted origin branch
    expect(args).toEqual(['merge-base', '--is-ancestor', MERGE, 'origin/main']);
    return { code: 0, stdout: '' };
  });
  const run = vi.fn((cmd, args) => {
    if (cmd === 'gh') {
      const result = gh(args);
      return { status: result.code, stdout: result.stdout };
    }
    expect(cmd).toBe('git');
    if (args.includes('remote')) return { status: 0, stdout: 'https://github.com/web-everything/web-everything.git' };
    if (args.includes('--git-common-dir')) return { status: 0, stdout: '/injected/objects-only' };
    if (args[0] === 'ls-remote' || args[0] === 'init') return { status: 0, stdout: '' };
    if (args[0] === 'fetch') return { status: args.some((a) => a.includes(`refs/heads/${REF}:`)) ? 1 : 0, stdout: '' };
    const result = git(args);
    return { status: result.code, stdout: result.stdout };
  });
  return { gh, git, run, row };
}

const paths = [
  ['planner', (p) => planFetchFailed({ row: p.row, git: p.git, gh: p.gh, repo: REPO })],
  ['loader wiring', (p) => defaultDeps().retirePlanner({ rows: [p.row], git: p.git, gh: p.gh })[0]],
  ['CLI re-proof', (p) => proveRetirement({ root: process.cwd(), entry: p.row, run: p.run })],
];

describe.each(paths)('deleted origin head identity: %s', (_name, decide) => {
  it.each([undefined, 7])('keeps an unrelated same-named fork even with recorded PR %s', (pr) => {
    const p = proof([merged({ isCrossRepository: true, headRepository: { nameWithOwner: 'contributor/web-everything' } })], { ref: REF, pr });
    expect(decide(p)).toMatchObject({ action: 'keep', reason: 'fetch-failed' });
  });

  it.each([
    ['other owner with a same-repo flag', { headRepository: { nameWithOwner: 'contributor/web-everything' } }],
    ['other repository with the same owner', { headRepository: { nameWithOwner: 'web-everything/unrelated' } }],
    ['cross-repo flag contradicting matching identity', { isCrossRepository: true }],
    ['missing cross-repo flag', { isCrossRepository: undefined }],
    ['malformed cross-repo flag', { isCrossRepository: 'false' }],
    ['null repository', { headRepository: null }],
    ['missing repository', { headRepository: undefined }],
    ['partial identity', { headRepository: { name: 'web-everything' } }],
    ['non-string identity', { headRepository: { nameWithOwner: 7 } }],
    ['identity with a trailing newline', { headRepository: { nameWithOwner: `${REPO}\n` } }],
    ['identity with invisible text', { headRepository: { nameWithOwner: `${REPO}\u200b` } }],
  ])('keeps on %s', (_label, extra) => {
    expect(decide(proof([merged(extra)]))).toMatchObject({ action: 'keep', reason: 'fetch-failed' });
  });

  it.each([REPO, 'Web-Everything/Web-Everything'])('allows an origin head with identity %s', (nameWithOwner) => {
    expect(decide(proof([merged({ headRepository: { nameWithOwner } })])))
      .toMatchObject({ action: 'retire', reason: 'pr-squash-merged', tip: TIP, pr: 7 });
  });

  it('requests full head repository identity and the cross-repository flag', () => {
    const p = proof([merged()]);
    decide(p);
    const args = p.gh.mock.calls.find(([args]) => args[0] === 'pr')[0];
    expect(args[args.indexOf('--json') + 1].split(','))
      .toEqual(expect.arrayContaining(['headRepository', 'isCrossRepository']));
  });
});

const ORIGIN_REPO = 'contributor/web-everything';
const ORIGIN_URL = `git@github.com:${ORIGIN_REPO}.git`;
const repositoryPaths = [
  ['loader deleted branch', (p) => defaultDeps().retirePlanner({ rows: [p.row], git: p.git, gh: p.gh })[0], false],
  ['loader fetched branch', (p) => defaultDeps().retirePlanner({ rows: [p.row], git: p.git, gh: p.gh })[0], true],
  ['CLI deleted branch', (p) => proveRetirement({ root: process.cwd(), entry: p.row, run: p.run }), false],
  ['CLI fetched branch', (p) => proveRetirement({ root: process.cwd(), entry: p.row, run: p.run }), true],
  ['CLI direct squash proof', (p) => proveSquashMerged({ root: process.cwd(), entry: p.row, run: p.run }), false],
];

function repositoryProof({ fetched, originCode = 0, originUrl = ORIGIN_URL, repoCode = 0, repo = ORIGIN_REPO,
  host = 'github.com', rawRepo, prs = [] }) {
  const p = proof([]);
  p.gh.mockImplementation((args) => {
    if (args[0] === 'repo') return args[2] === originUrl
      ? { code: repoCode, stdout: rawRepo ?? repository(repo, host) }
      : { code: 0, stdout: repository(REPO) }; // GH_REPO overrides the default
    expect(args.slice(0, 2)).toEqual(['pr', 'list']);
    const target = args[args.indexOf('--repo') + 1];
    // An unqualified selector can read GH_HOST's unrelated repository with the same owner/name.
    return { code: 0, stdout: JSON.stringify(target === `${host}/${repo}` ? prs
      : [merged({ headRepository: { nameWithOwner: target === REPO ? REPO : ORIGIN_REPO } })]) };
  });
  p.git.mockImplementation((args) => {
    if (args[0] === 'remote') return { code: originCode, stdout: originUrl };
    if (args[0] === 'fetch') return { code: fetched ? 0 : 1, stdout: '' };
    if (args[0] === 'rev-parse') return { code: 0, stdout: TIP };
    if (args[0] === 'rev-list') return { code: 0, stdout: args.includes('--no-merges') ? TIP : '' };
    if (args[0] === 'merge-tree') return { code: 0, stdout: MERGE }; // unique work, not in main
    if (args[0] === 'merge-base') return { code: 0, stdout: '' }; // upstream merge is in origin/main
    throw new Error(`unexpected git call: ${args.join(' ')}`);
  });
  p.run.mockImplementation((cmd, args) => {
    if (cmd === 'gh') {
      const r = p.gh(args);
      return { status: r.code, stdout: r.stdout };
    }
    if (args.includes('remote')) return { status: originCode, stdout: originUrl };
    if (args.includes('--git-common-dir')) return { status: 0, stdout: '/injected/objects-only' };
    if (args[0] === 'ls-remote' || args[0] === 'init') return { status: 0, stdout: '' };
    if (args[0] === 'fetch') return { status: !fetched && args.some((a) => a.includes(`refs/heads/${REF}:`)) ? 1 : 0, stdout: '' };
    const r = p.git(args);
    return { status: r.code, stdout: r.stdout };
  });
  return p;
}

describe.each(repositoryPaths)('repository binding: %s', (_name, decide, fetched) => {
  it('uses origin even when GH_REPO points at an upstream with a merged same-named PR', () => {
    const p = repositoryProof({ fetched });
    const result = decide(p);
    expect(result == null || result.action === 'keep').toBe(true);
    expect(p.gh).toHaveBeenCalledWith(['repo', 'view', ORIGIN_URL, '--json', 'nameWithOwner,url']);
    const lists = p.gh.mock.calls.map(([args]) => args).filter((args) => args[0] === 'pr');
    expect(lists.length).toBeGreaterThan(0);
    for (const args of lists) expect(args[args.indexOf('--repo') + 1]).toBe(`github.com/${ORIGIN_REPO}`);
  });

  it.each([
    ['unreadable origin', { originCode: 1 }],
    ['empty origin', { originUrl: '' }],
    ['unresolvable origin', { repoCode: 1 }],
    ['malformed repository identity', { repo: 'invalid' }],
    ['invalid repository JSON', { rawRepo: '{' }],
    ['missing host identity', { rawRepo: JSON.stringify({ nameWithOwner: ORIGIN_REPO }) }],
    ['contradictory repository URL', { rawRepo: JSON.stringify({ nameWithOwner: ORIGIN_REPO, url: `https://github.com/${REPO}` }) }],
  ])('keeps the registration with %s', (_label, options) => {
    const p = repositoryProof({ fetched, ...options });
    const result = decide(p);
    expect(result == null || result.action === 'keep').toBe(true);
    expect(p.gh.mock.calls.filter(([args]) => args[0] === 'pr')).toEqual([]);
    if (options.originCode || options.originUrl === '') expect(p.gh).not.toHaveBeenCalled();
  });

  it.each(['github.com', 'enterprise.example'])('qualifies every PR query with origin host %s', (host) => {
    const p = repositoryProof({ fetched, host, originUrl: `https://${host}/${ORIGIN_REPO}.git` });
    const result = decide(p);
    expect(result == null || result.action === 'keep').toBe(true);
    const lists = p.gh.mock.calls.map(([args]) => args).filter((args) => args[0] === 'pr');
    expect(lists.length).toBeGreaterThan(0);
    for (const args of lists) expect(args[args.indexOf('--repo') + 1]).toBe(`${host}/${ORIGIN_REPO}`);
  });

  if (!fetched) it('still retires a merged PR from origin when GH_REPO names upstream', () => {
    const p = repositoryProof({ fetched, prs: [merged({ headRepository: { nameWithOwner: ORIGIN_REPO } })] });
    expect(decide(p)).toMatchObject({ action: 'retire', reason: 'pr-squash-merged', pr: 7 });
  });
});

describe('origin GitHub binding', () => {
  it('binds GraphQL superseder reads and recorded PR views to the same origin host', () => {
    const git = vi.fn(() => ({ code: 0, stdout: `ssh://git@enterprise.example/${ORIGIN_REPO}.git` }));
    const rawGh = vi.fn(() => ({ code: 0, stdout: repository(ORIGIN_REPO, 'enterprise.example') }));
    const { gh } = resolveOriginRepository({ git, gh: rawGh });
    gh(['api', 'graphql', '-f', 'query=example']);
    expect(rawGh).toHaveBeenLastCalledWith(['api', 'graphql', '-f', 'query=example', '--hostname', 'enterprise.example']);
    gh(['pr', 'view', '7', '--repo', ORIGIN_REPO, '--json', 'commits']);
    expect(rawGh).toHaveBeenLastCalledWith(['pr', 'view', '7', '--repo', `enterprise.example/${ORIGIN_REPO}`, '--json', 'commits']);
  });

  it.each(['--help', 'https://github.com/a/b\nother', 'https://github.com/a/b\0'])('refuses an unsafe origin argument %j', (url) => {
    const rawGh = vi.fn();
    expect(resolveOriginRepository({ git: () => ({ code: 0, stdout: url }), gh: rawGh }).repo).toBe('');
    expect(rawGh).not.toHaveBeenCalled();
  });

  it.each(['git', 'gh'])('fails closed when %s throws', (command) => {
    const fail = () => { throw new Error('unreadable'); };
    const result = resolveOriginRepository({
      git: command === 'git' ? fail : () => ({ code: 0, stdout: ORIGIN_URL }), gh: fail,
    });
    expect(result.repo).toBe('');
    expect(result.gh(['pr', 'list', '--repo', REPO]).code).not.toBe(0);
  });
});
