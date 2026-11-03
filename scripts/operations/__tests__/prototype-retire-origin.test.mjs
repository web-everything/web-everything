/** Origin identity regression for fetch-failed retirement. All Git/GitHub IO is injected. */
import { describe, it, expect, vi } from 'vitest';
import { planFetchFailed } from '../prototype-retire.mjs';
import { defaultDeps } from '../prototype-load-io.mjs';
import { proveRetirement } from '../../daemon-overlay.mjs';

const REPO = 'web-everything/web-everything';
const REF = 'lane/example';
const TIP = 'a'.repeat(40);
const MERGE = 'b'.repeat(40);
const merged = (extra = {}) => ({ number: 7, state: 'MERGED', headRefName: REF, headRefOid: TIP,
  mergeCommit: { oid: MERGE }, headRepository: { nameWithOwner: REPO }, isCrossRepository: false, ...extra });

function proof(prs, row = { ref: REF }) {
  const gh = vi.fn((args) => {
    if (args[0] === 'repo' && args[1] === 'view') return { code: 0, stdout: REPO };
    if (args[0] === 'pr' && args[1] === 'list') return { code: 0, stdout: JSON.stringify(prs) };
    throw new Error(`unexpected gh call: ${args.join(' ')}`);
  });
  const git = vi.fn((args) => {
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
