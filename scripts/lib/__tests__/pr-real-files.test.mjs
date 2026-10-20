// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { gitRealFiles, resolveRealFiles, realFilesCardOnly } from '../pr-real-files.mjs';
const repo = 'web-everything/web-everything';
const pr = { headRefName: 'lane/cards', headRefOid: 'a'.repeat(40), baseRefName: 'main' };
const card = 'backlog/123-card.md';
// The single combined fetch (`fetch --no-tags origin main refs/heads/<b>`) fails here by default, so these tests pin
// the original two-fetch fallback; the combined path has its own tests below.
const isCombined = args => args[0] === 'fetch' && args.includes('main') && args.length === 5;
function runner({ head = pr.headRefOid, remote = `https://github.com/${repo}.git`, files = `${card}\0`, fail = '' } = {}) {
  return vi.fn((_cmd, args) => ({ status: args[0] === fail || isCombined(args) ? 1 : 0,
    stdout: args[0] === 'remote' ? remote : args[0] === 'rev-parse' ? head : args[0] === 'diff' ? files : '' }));
}
describe('PR real files', () => {
  it('git wins disagreement and missing/capped GitHub evidence', () => {
    const run = runner();
    for (const ghFiles of [['scripts/stale.mjs'], null, Array.from({ length: 100 }, () => card)]) {
      expect(resolveRealFiles({ pr, repo, ghFiles, run })).toMatchObject({ files: [card], source: 'git', disagreed: true });
    }
    expect(realFilesCardOnly({ pr, repo, ghFiles: ['code.js'], run })).toBe(true);
    expect(run).toHaveBeenCalledTimes(15); // +1: the failed combined fetch before the fallback
  });
  it('a git non-card overrides even a GitHub all-card list', () => {
    expect(realFilesCardOnly({ pr, repo, ghFiles: [card], run: runner({ files: `${card}\0code.js\0` }) })).toBe(false);
  });
  it('preserves raw Unicode and space paths when verifying GitHub files', () => {
    const paths = ['docs/café ñ.md', 'docs/with space.md'];
    const run = runner({ files: [...paths, paths[0]].join('\0') + '\0' });
    expect(gitRealFiles({ pr, repo, run })).toEqual(paths);
    expect(resolveRealFiles({ pr, repo, ghFiles: paths.map(path => ({ path })), run }))
      .toEqual({ files: paths, source: 'git', disagreed: false, reason: 'git verified GitHub files' });
    expect(run).toHaveBeenCalledWith('git',
      ['diff', '-z', '--name-only', '--no-renames', `${pr.headRefOid}...${pr.headRefOid}`],
      { cwd: process.cwd() });
  });
  it('FETCH_HEAD mismatch returns null and falls back to GitHub', () => {
    const run = runner({ head: 'b'.repeat(40) });
    expect(gitRealFiles({ pr, repo, run })).toBeNull();
    expect(resolveRealFiles({ pr, repo, run, ghFiles: ['code.js'] })).toMatchObject({ files: ['code.js'], source: 'github', reason: 'git unverifiable' });
    expect(run.mock.calls.some(([, args]) => args[0] === 'diff')).toBe(false);
  });
  it('wrong clone never fetches', () => {
    const run = runner({ remote: 'https://github.com/another/repo.git' });
    expect(gitRealFiles({ pr, repo, run })).toBeNull(); expect(run).toHaveBeenCalledTimes(2);
  });
  it('disabled/ineligible routing does no git IO', () => {
    const run = runner();
    expect(resolveRealFiles({ pr, repo, run, enabled: false, ghFiles: [card] }).source).toBe('github');
    expect(gitRealFiles({ pr: { ...pr, baseRefName: 'release' }, repo, run })).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });
  it('cache is isolated by runner, clone and head and cannot be mutated by callers', () => {
    const run = runner();
    gitRealFiles({ pr, repo, run }).push('code.js');
    expect(gitRealFiles({ pr, repo, run })).toEqual([card]); expect(run).toHaveBeenCalledTimes(11);
    gitRealFiles({ pr, repo, run, cwd: '/other-clone' }); expect(run).toHaveBeenCalledTimes(20);
    const other = runner(); gitRealFiles({ pr, repo, run: other }); expect(other).toHaveBeenCalledTimes(9);
  });
  it.each(['fetch', 'diff'])('failed %s cannot prove card-only from a missing GitHub list', fail => {
    expect(realFilesCardOnly({ pr, repo, run: runner({ fail }), ghFiles: null })).toBe(false);
  });
});

it('cache checks local base and object without network, and recomputes after either changes', () => {
  let base = 'b'.repeat(40), present = true, files = `${card}\0`;
  const run = vi.fn((cmd, args) => {
    if (args[0] === 'rev-parse' && args.includes('--verify')) return { status: 0, stdout: base };
    if (args[0] === 'cat-file') return { status: present ? 0 : 1, stdout: '' };
    return runner({ files })(cmd, args);
  });
  expect(gitRealFiles({ pr, repo, run })).toEqual([card]);
  run.mockClear();
  expect(gitRealFiles({ pr, repo, run })).toEqual([card]);
  expect(run.mock.calls.map(([, a]) => a[0])).toEqual(['rev-parse', 'cat-file']);
  base = 'c'.repeat(40); files = 'code.js\0'; run.mockClear();
  expect(gitRealFiles({ pr, repo, run })).toEqual(['code.js']);
  expect(run.mock.calls.filter(([, a]) => a[0] === 'fetch')).toHaveLength(3); // failed combined + two
  present = false; files = 'other.js\0'; run.mockClear();
  expect(gitRealFiles({ pr, repo, run })).toEqual(['other.js']);
  expect(run.mock.calls.filter(([, a]) => a[0] === 'fetch')).toHaveLength(3); // failed combined + two
  base = ''; run.mockClear();
  expect(gitRealFiles({ pr, repo, run })).toBeNull();
  expect(run.mock.calls.map(([, a]) => a[0])).toEqual(['rev-parse']);
});
it('records the base read after fetch in the cache key', () => {
  let base = 'b'.repeat(40);
  const run = vi.fn((cmd, args) => {
    if (args[0] === 'rev-parse' && args.includes('--verify')) return { status: 0, stdout: base };
    if (args[0] === 'fetch') base = 'c'.repeat(40);
    return runner()(cmd, args);
  });
  expect(gitRealFiles({ pr, repo, run })).toEqual([card]); run.mockClear();
  expect(gitRealFiles({ pr, repo, run })).toEqual([card]);
  expect(run.mock.calls.map(([, a]) => a[0])).toEqual(['rev-parse', 'cat-file']);
});
it.each(['moved', 'missing', 'failed', 'throws'])('base %s during diff fails closed without caching the result', outcome => {
  const pinned = 'b'.repeat(40), moved = 'c'.repeat(40);
  let afterDiff = false, race = true;
  const run = vi.fn((cmd, args) => {
    if (args[0] === 'rev-parse' && args.includes('--verify')) {
      if (race && afterDiff) {
        if (outcome === 'throws') throw new Error('base unreadable');
        return { status: outcome === 'failed' ? 1 : 0, stdout: outcome === 'moved' ? moved : '' };
      }
      return { status: 0, stdout: pinned };
    }
    if (args[0] === 'diff') {
      expect(args).toEqual(['diff', '-z', '--name-only', '--no-renames', `${pinned}...${pr.headRefOid}`]);
      afterDiff = true;
    }
    return runner()(cmd, args);
  });
  expect(gitRealFiles({ pr, repo, run })).toBeNull();
  race = false;
  expect(gitRealFiles({ pr, repo, run })).toEqual([card]);
  expect(run.mock.calls.filter(([, args]) => args[0] === 'diff')).toHaveLength(2);
});
it('pins the post-fetch oid for the diff and checks the same oid before caching', () => {
  let base = 'b'.repeat(40);
  const pinned = 'c'.repeat(40);
  const run = vi.fn((cmd, args) => {
    if (args[0] === 'rev-parse' && args.includes('--verify')) return { status: 0, stdout: base };
    if (args[0] === 'fetch') base = pinned;
    return runner()(cmd, args);
  });
  expect(gitRealFiles({ pr, repo, run })).toEqual([card]);
  expect(run.mock.calls.map(([, args]) => args)).toEqual([
    ['rev-parse', '--verify', 'origin/main^{commit}'],
    ['remote', 'get-url', 'origin'], ['fetch', '--no-tags', 'origin', 'main', 'refs/heads/lane/cards'], ['fetch', 'origin', 'main'],
    ['fetch', '--no-tags', 'origin', 'refs/heads/lane/cards'],
    ['rev-parse', '--verify', 'origin/main^{commit}'], ['rev-parse', 'FETCH_HEAD'],
    ['diff', '-z', '--name-only', '--no-renames', `${pinned}...${pr.headRefOid}`],
    ['rev-parse', '--verify', 'origin/main^{commit}'],
  ]);
  run.mockClear();
  expect(gitRealFiles({ pr, repo, run })).toEqual([card]);
  expect(run.mock.calls.map(([, args]) => args[0])).toEqual(['rev-parse', 'cat-file']);
});

describe('single combined fetch for main and the PR branch', () => {
  const B = 'b'.repeat(40), H = pr.headRefOid;
  const fh = (main = B, head = H, branch = 'lane/cards') => `${main}\t\tbranch 'main' of github.com:x/y\n${head}\t\tbranch '${branch}' of github.com:x/y\n`;
  const setup = ({ fetchHead = fh(), combinedStatus = 0, gitPath = '.git/FETCH_HEAD' } = {}) => {
    const run = vi.fn((cmd, args) => {
      if (isCombined(args)) return { status: combinedStatus, stdout: '' };
      if (args[0] === 'rev-parse' && args[1] === '--git-path') return { status: 0, stdout: `${gitPath}\n` };
      if (args[0] === 'rev-parse' && args.includes('--verify')) return { status: 0, stdout: B };
      return runner()(cmd, args);
    });
    const readFile = vi.fn(() => { if (fetchHead instanceof Error) throw fetchHead; return fetchHead; });
    return { run, readFile, fetches: () => run.mock.calls.filter(([, a]) => a[0] === 'fetch').map(([, a]) => a) };
  };

  it('one fetch: reads the branch oid from FETCH_HEAD line 2 and diffs against post-fetch origin/main', () => {
    const { run, readFile, fetches } = setup();
    expect(gitRealFiles({ pr, repo, run, readFile, cwd: '/clone' })).toEqual([card]);
    expect(fetches()).toEqual([['fetch', '--no-tags', 'origin', 'main', 'refs/heads/lane/cards']]);
    expect(readFile).toHaveBeenCalledWith('/clone/.git/FETCH_HEAD', 'utf8');
    expect(run).toHaveBeenCalledWith('git', ['diff', '-z', '--name-only', '--no-renames', `${B}...${H}`], { cwd: '/clone' });
    expect(run.mock.calls.some(([, a]) => a[0] === 'rev-parse' && a[1] === 'FETCH_HEAD')).toBe(false);
  });

  it('a branch that moved off the pinned head is unverifiable (null), exactly like the two-fetch path', () => {
    const { run, readFile, fetches } = setup({ fetchHead: fh(B, 'd'.repeat(40)) });
    expect(gitRealFiles({ pr, repo, run, readFile })).toBeNull();
    expect(fetches()).toHaveLength(1);
    expect(run.mock.calls.some(([, a]) => a[0] === 'diff')).toBe(false);
  });

  it.each([
    ['combined fetch failed', { combinedStatus: 1 }],
    ['FETCH_HEAD unreadable', { fetchHead: new Error('ENOENT') }],
    ['one line only', { fetchHead: `${B}\t\tbranch 'main' of x\n` }],
    ['three lines', { fetchHead: fh() + `${B}\t\tbranch 'main' of x\n` }],
    ['lines out of order', { fetchHead: `${H}\t\tbranch 'lane/cards' of x\n${B}\t\tbranch 'main' of x\n` }],
    ['other branch named', { fetchHead: fh(B, H, 'lane/other') }],
    ['not-for-merge marker', { fetchHead: `${B}\tnot-for-merge\tbranch 'main' of x\n${H}\t\tbranch 'lane/cards' of x\n` }],
    ['short oid', { fetchHead: fh('b'.repeat(7)) }],
  ])('%s → the original two fetches run', (_name, opts) => {
    const { run, readFile, fetches } = setup(opts);
    expect(gitRealFiles({ pr, repo, run, readFile })).toEqual([card]);
    expect(fetches().slice(1)).toEqual([['fetch', 'origin', 'main'], ['fetch', '--no-tags', 'origin', 'refs/heads/lane/cards']]);
  });
});
