/**
 * Origin identity and deleted-tip regression for fetch-failed retirement. All Git/GitHub IO is injected.
 * A registration whose branch is gone retires only when GitHub's ref activity proves the branch's LAST tip was the
 * head of the one origin PR that merged it; a historical PR alone never authorizes the drop.
 */
import { describe, it, expect, vi } from 'vitest';
import { planFetchFailed, resolveOriginRepository } from '../prototype-retire.mjs';
import { defaultDeps } from '../prototype-load-io.mjs';
import { proveRetirement, proveSquashMerged } from '../../daemon-overlay.mjs';

const REPO = 'web-everything/web-everything';
const REF = 'lane/example';
const TIP = 'a'.repeat(40);
const OTHER = 'c'.repeat(40);
const MERGE = 'b'.repeat(40);
const ZERO = '0'.repeat(40);
const repository = (repo, host = 'github.com') => JSON.stringify({ nameWithOwner: repo, url: `https://${host}/${repo}` });
const merged = (extra = {}) => ({ number: 7, state: 'MERGED', headRefName: REF, headRefOid: TIP,
  mergeCommit: { oid: MERGE }, headRepository: { nameWithOwner: REPO }, isCrossRepository: false, ...extra });
/** The ref's activity log (newest first): created, pushed to `tip`, then deleted at `tip`. */
const deletedAt = (tip) => [
  { activity_type: 'branch_deletion', before: tip, after: ZERO, timestamp: '2026-11-02T11:00:00Z' },
  { activity_type: 'push', before: OTHER, after: tip, timestamp: '2026-11-02T10:00:00Z' },
  { activity_type: 'branch_creation', before: ZERO, after: OTHER, timestamp: '2026-11-02T09:00:00Z' },
];

function proof(prs, row = { ref: REF }, activity = deletedAt(TIP)) {
  const gh = vi.fn((args) => {
    if (args[0] === 'repo' && args[1] === 'view') return { code: 0, stdout: repository(REPO) };
    if (args[0] === 'pr' && args[1] === 'list') return { code: 0, stdout: JSON.stringify(prs) };
    if (args[0] === 'api') return { code: 0, stdout: JSON.stringify(activity) };
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
const RETIRE = { action: 'retire', reason: 'pr-squash-merged', tip: TIP, pr: 7 };
const KEEP = { action: 'keep', reason: 'fetch-failed' };

describe.each(paths)('deleted branch with an authoritative last tip: %s', (_name, decide) => {
  it.each([undefined, 7])('retires when the branch was last deleted at the merged PR head (recorded PR %s)', (pr) => {
    const p = proof([merged()], { ref: REF, pr });
    expect(decide(p)).toMatchObject({ ...RETIRE, evidence: { refGone: true, prState: 'MERGED', mergeCommit: MERGE, deletedTip: TIP } });
  });

  it('keeps unmerged reuse: the name was reused after the merged PR and deleted again at another tip', () => {
    const p = proof([merged()], { ref: REF, pr: 7 }, deletedAt(OTHER));
    expect(decide(p)).toMatchObject(KEEP);
  });

  it('keeps when the newest ref event is not a deletion (the name was recreated)', () => {
    const recreated = [{ activity_type: 'branch_creation', before: ZERO, after: OTHER, timestamp: '2026-11-02T12:00:00Z' }, ...deletedAt(TIP)];
    expect(decide(proof([merged()], { ref: REF }, recreated))).toMatchObject(KEEP);
  });

  it.each([TIP, OTHER])('does not trust incidental SHA metadata %s on the registration', (sha) => {
    const p = proof([merged()], { ref: REF, pr: 7, sha }, deletedAt(OTHER));
    expect(decide(p)).toMatchObject(KEEP);
  });

  it('keeps when the activity log is unreadable', () => {
    const p = proof([merged()]);
    const original = p.gh.getMockImplementation();
    p.gh.mockImplementation((args) => (args[0] === 'api' ? { code: 1, stdout: '' } : original(args)));
    expect(decide(p)).toMatchObject(KEEP);
  });
});

it('direct CLI squash proof retires on the same evidence and refuses reuse', () => {
  expect(proveSquashMerged({ root: process.cwd(), entry: { ref: REF, pr: 7 }, run: proof([merged()]).run })).toMatchObject(RETIRE);
  expect(proveSquashMerged({ root: process.cwd(), entry: { ref: REF, pr: 7 }, run: proof([merged()], undefined, deletedAt(OTHER)).run })).toBeNull();
});

describe.each(paths)('deleted reused branch: %s', (_name, decide) => {
  it.each(['CLOSED', 'OPEN', 'MERGED'])('keeps an old merge alongside a newer %s PR', (state) => {
    const prs = [merged(), merged({ number: 8, state, headRefOid: OTHER,
      mergeCommit: state === 'MERGED' ? { oid: 'd'.repeat(40) } : null })];
    for (const pr of [null, 7, 8]) {
      const p = proof(prs, { ref: REF, pr });
      const original = p.gh.getMockImplementation();
      // Model GitHub's state filter: a merged-only lookup hides the reused branch's work.
      p.gh.mockImplementation((args) => args[0] === 'pr' && args[1] === 'list'
        ? { code: 0, stdout: JSON.stringify(args[args.indexOf('--state') + 1] === 'merged'
          ? prs.filter((candidate) => candidate.state === 'MERGED') : prs) }
        : original(args));
      expect(decide(p)).toMatchObject(KEEP);
    }
  });

  it('reads every PR state, so a newer closed PR is seen', () => {
    const p = proof([merged()]);
    decide(p);
    const lists = p.gh.mock.calls.map(([args]) => args).filter((args) => args[0] === 'pr');
    expect(lists.length).toBeGreaterThan(0);
    for (const args of lists) expect(args[args.indexOf('--state') + 1]).toBe('all');
  });

  it('keeps a full result page with only one merged PR', () => {
    const prs = [merged(), ...Array.from({ length: 9 }, (_, i) => merged({ number: i + 8, state: 'CLOSED', mergeCommit: null }))];
    expect(decide(proof(prs))).toMatchObject(KEEP);
  });
});

describe.each(paths)('deleted origin head identity: %s', (_name, decide) => {
  it.each([undefined, 7])('keeps an unrelated same-named fork even with recorded PR %s', (pr) => {
    const p = proof([merged({ isCrossRepository: true, headRepository: { nameWithOwner: 'contributor/web-everything' } })], { ref: REF, pr });
    expect(decide(p)).toMatchObject(KEEP);
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
    ['identity with invisible text', { headRepository: { nameWithOwner: `${REPO}​` } }],
  ])('keeps on %s', (_label, extra) => {
    expect(decide(proof([merged(extra)]))).toMatchObject(KEEP);
  });

  it.each([REPO, 'Web-Everything/Web-Everything'])('retires an origin head with identity %s', (nameWithOwner) => {
    expect(decide(proof([merged({ headRepository: { nameWithOwner } })]))).toMatchObject(RETIRE);
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
  host = 'github.com', rawRepo, prs = [], activity = deletedAt(TIP) }) {
  const p = proof([]);
  p.gh.mockImplementation((args) => {
    if (args[0] === 'repo') return args[2] === originUrl
      ? { code: repoCode, stdout: rawRepo ?? repository(repo, host) }
      : { code: 0, stdout: repository(REPO) }; // GH_REPO overrides the default
    if (args[0] === 'api') {
      // An unbound activity read would see the upstream repository's deletion at the same tip.
      const bound = args[1].startsWith(`repos/${repo}/activity?`) && args[args.indexOf('--hostname') + 1] === host;
      return { code: 0, stdout: JSON.stringify(bound ? activity : deletedAt(TIP)) };
    }
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
    expect(p.gh.mock.calls.filter(([args]) => args[0] === 'pr' || args[0] === 'api')).toEqual([]);
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

  if (!fetched) {
    const merged7 = () => merged({ headRepository: { nameWithOwner: ORIGIN_REPO } });
    it('retires a deleted branch from the origin PR and origin-bound, host-qualified activity when GH_REPO names upstream', () => {
      const p = repositoryProof({ fetched, prs: [merged7()] });
      expect(decide(p)).toMatchObject(RETIRE);
      const reads = p.gh.mock.calls.map(([args]) => args).filter((args) => args[0] === 'api');
      expect(reads.length).toBeGreaterThan(0);
      for (const args of reads) {
        expect(args[1]).toContain(`repos/${ORIGIN_REPO}/activity?`);
        expect(args.slice(-2)).toEqual(['--hostname', 'github.com']);
      }
    });

    it.each(['github.com', 'enterprise.example'])('reads activity from origin host %s', (host) => {
      const p = repositoryProof({ fetched, host, originUrl: `https://${host}/${ORIGIN_REPO}.git`, prs: [merged7()] });
      expect(decide(p)).toMatchObject(RETIRE);
      for (const [args] of p.gh.mock.calls.filter(([a]) => a[0] === 'api')) expect(args.slice(-2)).toEqual(['--hostname', host]);
    });

    it('keeps when the origin repository was last deleted at another tip', () => {
      const p = repositoryProof({ fetched, prs: [merged7()], activity: deletedAt(OTHER) });
      const result = decide(p);
      expect(result == null || result.action === 'keep').toBe(true);
    });
  }
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
