// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { gitRealFiles, resolveRealFiles, realFilesCardOnly } from '../pr-real-files.mjs';
const repo = 'web-everything/web-everything';
const pr = { headRefName: 'lane/cards', headRefOid: 'a'.repeat(40), baseRefName: 'main' };
const card = 'backlog/123-card.md';
function runner({ head = pr.headRefOid, remote = `https://github.com/${repo}.git`, files = `${card}\0`, fail = '' } = {}) {
  return vi.fn((_cmd, args) => ({ status: args[0] === fail ? 1 : 0,
    stdout: args[0] === 'remote' ? remote : args[0] === 'rev-parse' ? head : args[0] === 'diff' ? files : '' }));
}
describe('PR real files', () => {
  it('git wins disagreement and missing/capped GitHub evidence', () => {
    const run = runner();
    for (const ghFiles of [['scripts/stale.mjs'], null, Array.from({ length: 100 }, () => card)]) {
      expect(resolveRealFiles({ pr, repo, ghFiles, run })).toMatchObject({ files: [card], source: 'git', disagreed: true });
    }
    expect(realFilesCardOnly({ pr, repo, ghFiles: ['code.js'], run })).toBe(true);
    expect(run).toHaveBeenCalledTimes(14);
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
    expect(gitRealFiles({ pr, repo, run })).toEqual([card]); expect(run).toHaveBeenCalledTimes(10);
    // +1: a proven answer exists for another clone, so one ls-remote is tried first (and misses).
    gitRealFiles({ pr, repo, run, cwd: '/other-clone' }); expect(run).toHaveBeenCalledTimes(19);
    const other = runner(); gitRealFiles({ pr, repo, run: other }); expect(other).toHaveBeenCalledTimes(8);
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
  expect(run.mock.calls.filter(([, a]) => a[0] === 'fetch')).toHaveLength(2);
  present = false; files = 'other.js\0'; run.mockClear();
  expect(gitRealFiles({ pr, repo, run })).toEqual(['other.js']);
  expect(run.mock.calls.filter(([, a]) => a[0] === 'fetch')).toHaveLength(2);
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
    ['remote', 'get-url', 'origin'], ['fetch', 'origin', 'main'],
    ['fetch', '--no-tags', 'origin', 'refs/heads/lane/cards'],
    ['rev-parse', '--verify', 'origin/main^{commit}'], ['rev-parse', 'FETCH_HEAD'],
    ['diff', '-z', '--name-only', '--no-renames', `${pinned}...${pr.headRefOid}`],
    ['rev-parse', '--verify', 'origin/main^{commit}'],
  ]);
  run.mockClear();
  expect(gitRealFiles({ pr, repo, run })).toEqual([card]);
  expect(run.mock.calls.map(([, args]) => args[0])).toEqual(['rev-parse', 'cat-file']);
});

describe('proven answers keyed by immutable remote tips (no time expiry)', () => {
  const B = 'b'.repeat(40);
  const setup = ({ lsRemote }) => {
    let files = `${card}\0`;
    const run = vi.fn((cmd, args) => {
      if (args[0] === 'rev-parse' && args.includes('--verify')) return { status: 0, stdout: B };
      if (args[0] === 'ls-remote') return lsRemote();
      return runner({ files })(cmd, args);
    });
    return { run, setFiles: f => { files = f; } };
  };
  const tips = (main, branch, extra = '') => ({ status: 0, stdout: `${main}\trefs/heads/main\n${branch}\trefs/heads/lane/cards\n${extra}` });
  const fetches = run => run.mock.calls.filter(([, a]) => a[0] === 'fetch').length;
  const later = fn => { vi.useFakeTimers(); try { vi.setSystemTime(Date.now() + 3_600_000); return fn(); } finally { vi.useRealTimers(); } };

  it('reuses the proven answer without fetching when remote main and branch equal its key, past any TTL', () => {
    const { run, setFiles } = setup({ lsRemote: () => tips(B, pr.headRefOid) });
    expect(gitRealFiles({ pr, repo, run })).toEqual([card]);
    setFiles('code.js\0'); run.mockClear();
    expect(later(() => gitRealFiles({ pr, repo, run }))).toEqual([card]);
    expect(fetches(run)).toBe(0);
    expect(run.mock.calls.map(([, a]) => a[0])).toContain('ls-remote');
  });

  it.each([
    ['remote main moved', () => tips('c'.repeat(40), 'a'.repeat(40))],
    ['branch tip moved', () => tips(B, 'd'.repeat(40))],
    ['ambiguous duplicate ref', () => tips(B, 'a'.repeat(40), `${B}\trefs/heads/main\n`)],
    ['branch missing', () => ({ status: 0, stdout: `${B}\trefs/heads/main\n` })],
    ['ls-remote failed', () => ({ status: 128, stdout: '' })],
    ['ls-remote threw', () => { throw new Error('timeout'); }],
  ])('%s → fetches as today', (_name, lsRemote) => {
    let mode = 'ok';
    const { run, setFiles } = setup({ lsRemote: () => (mode === 'ok' ? tips(B, pr.headRefOid) : lsRemote()) });
    gitRealFiles({ pr, repo, run });
    mode = 'test'; setFiles('code.js\0'); run.mockClear();
    later(() => gitRealFiles({ pr, repo, run }));
    expect(fetches(run)).toBe(2);
  });

  it('a null (unverified) answer is never proven or reused', () => {
    let head = 'b'.repeat(40);
    const run = vi.fn((cmd, args) => {
      if (args[0] === 'rev-parse' && args.includes('--verify')) return { status: 0, stdout: B };
      if (args[0] === 'ls-remote') return tips(B, pr.headRefOid);
      return runner({ head })(cmd, args);
    });
    expect(gitRealFiles({ pr, repo, run })).toBeNull(); // FETCH_HEAD mismatch
    run.mockClear();
    later(() => gitRealFiles({ pr, repo, run }));
    expect(fetches(run)).toBe(2);
    expect(run.mock.calls.some(([, a]) => a[0] === 'ls-remote')).toBe(false);
  });
});
