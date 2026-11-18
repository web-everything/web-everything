// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { proveNumberingOnlyMove, numberingGitRunner } from '../numbering-carry.mjs';
import { proveHumanOnlyLicense, proveHumanOnlyLicenseWithRunner, resolveApprovalLicensesEnqueue } from '../human-only-enqueue-license.mjs';

const roots = [];
const rawChange = path => `:100644 100644 ${'a'.repeat(40)} ${'b'.repeat(40)} M\0${path}\0`;
const removeTreeEntryTabs = entry => entry.replaceAll('\t', '');
// Config discovery also sees the command-line origin pin and appends its discovered override.
const GIT_PINS = ['-c', 'protocol.allow=never', '-c', 'extensions.partialClone=',
  '-c', 'remote.origin.promisor=false', '-c', 'remote.origin.promisor=false'];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'human-enqueue-')); roots.push(cwd);
  const git = args => execFileSync('git', ['-c', 'gc.auto=0', '-c', 'maintenance.auto=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const write = (path, body) => { mkdirSync(dirname(join(cwd, path)), { recursive: true }); writeFileSync(join(cwd, path), body); };
  const commit = message => { git(['add', '-A']); git(['commit', '-qm', message]); return git(['rev-parse', 'HEAD']); };
  git(['init', '-q']); git(['config', 'user.email', 'test@example.com']); git(['config', 'user.name', 'test']);
  write('.github/workflows/ci.yml', 'approved workflow');
  write('backlog/xabc123-example.md', '---\nkind: story\n---\ncard\n');
  const approved = commit('approved'); git(['update-ref', 'refs/remotes/origin/main', approved]);
  let head = approved, labels = ['review:accepted'];
  const comments = [{ author: { login: 'chalbert' }, body: `<!-- reviewed-sha: ${approved} -->\n<!-- cleared-human: operator -->` }];
  const exec = cmd => { expect(cmd).toBe('gh'); return JSON.stringify({ headRefOid: head, labels }); };
  const prove = ({ run, ...options } = {}) => {
    const inputs = { repo: 'o/r', pr: 7, headSha: head, exec, cwd, readComments: () => comments, ...options };
    return run ? proveHumanOnlyLicenseWithRunner(inputs, numberingGitRunner({ cwd, run })) : proveHumanOnlyLicense(inputs);
  };
  return { cwd, git, write, commit, approved, comments, exec, prove, setHead: sha => { head = sha; }, setLabels: v => { labels = v; } };
}

describe('missing-tab tree fixture', () => {
  it.each([
    ['', ''],
    ['README.md', 'README.md'],
    ['header\tREADME.md\0', 'headerREADME.md\0'],
    ['header\tREAD\tME.md\0', 'headerREADME.md\0'],
    ['header\tREADME.md\0header\tother.md\0', 'headerREADME.md\0headerother.md\0'],
  ])('removes every tab while preserving other bytes: %j', (entry, expected) => {
    expect(removeTreeEntryTabs(entry)).toBe(expected);
  });
});

describe('human-only enqueue license', () => {
  it('licenses the exact trusted approved current head', () => {
    expect(fixture().prove()).toMatchObject({ licensed: true, tier: 'exact' });
  });
  it('licenses numbering-only successors using the shared numbering proof', () => {
    const r = fixture();
    r.git(['mv', 'backlog/xabc123-example.md', 'backlog/7001-example.md']);
    r.write('backlog/7001-example.md', '---\nbornAs: xabc123\nkind: story\n---\ncard\n');
    r.setHead(r.commit('drain: JIT-number xabc123→#7001 at land (#2288)'));
    expect(r.prove()).toMatchObject({ licensed: true, tier: 'numbering' });
  });
  it.each(['numbering', 'mechanical'])('passes exact explicit bounds and hardened pins through the actual %s license proof', tier => {
    const r = fixture(), calls = [];
    r.git(['config', 'remote.secondary.promisor', 'true']);
    if (tier === 'numbering') {
      r.git(['mv', 'backlog/xabc123-example.md', 'backlog/7001-example.md']);
      r.write('backlog/7001-example.md', '---\nbornAs: xabc123\nkind: story\n---\ncard\n');
      r.setHead(r.commit('drain: JIT-number xabc123→#7001 at land (#2288)'));
    } else {
      r.git(['checkout', '-qb', 'main-change']); r.write('README.md', 'from main');
      const main = r.commit('main docs'); r.git(['update-ref', 'refs/remotes/origin/main', main]);
      r.git(['checkout', '-qb', 'pr', r.approved]); r.git(['commit', '--allow-empty', '-qm', 'retain approved tree']);
      r.git(['merge', '--no-ff', '-m', 'merge main', main]); r.setHead(r.git(['rev-parse', 'HEAD']));
    }
    expect(r.prove({ run: (cmd, args, options) => {
      calls.push({ cmd, args, options });
      return execFileSync(cmd, args, options);
    } })).toMatchObject({ licensed: true, tier });
    expect(calls.some(({ args }) => args.includes(tier === 'numbering' ? 'blob' : 'diff-tree'))).toBe(true);
    for (const { cmd, args, options } of calls) {
      expect(cmd).toBe('git');
      expect(options).toMatchObject({ cwd: r.cwd, encoding: null, timeout: 5000,
        maxBuffer: args.includes('blob') ? 1024 * 1024 : 8 * 1024 * 1024,
        env: { GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
      expect(args.slice(0, 6)).toEqual(['-c', 'protocol.allow=never', '-c', 'extensions.partialClone=', '-c', 'remote.origin.promisor=false']);
      if (!args.includes('--get-regexp')) expect(args.slice(6, 8)).toEqual(['-c', 'remote.secondary.promisor=false']);
    }
  });
  it.each(['missing main', 'failed alias grep'])('refuses unreadable owned numbering evidence: %s', failure => {
    const r = fixture();
    r.git(['mv', 'backlog/xabc123-example.md', 'backlog/7001-example.md']);
    r.write('backlog/7001-example.md', '---\nbornAs: xabc123\nkind: story\n---\ncard\n');
    const head = r.commit('drain: JIT-number xabc123→#7001 at land (#2288)');
    r.setHead(head);
    if (failure === 'missing main') r.git(['update-ref', '-d', 'refs/remotes/origin/main']);
    else r.git(['config', 'grep.threads', '-1']);
    expect(proveNumberingOnlyMove({ cwd: r.cwd, fromSha: r.approved, toSha: head }).readFailed).toBe(true);
    expect(r.prove()).toMatchObject({ licensed: false, reason: expect.stringContaining('numbering git evidence unreadable') });
  });
  it('keeps grep status 1 and absent promisor config readable and licenses numbering', () => {
    const r = fixture();
    r.git(['mv', 'backlog/xabc123-example.md', 'backlog/7001-example.md']);
    r.write('backlog/7001-example.md', '---\nbornAs: xabc123\nkind: story\n---\ncard\n');
    const head = r.commit('drain: JIT-number xabc123→#7001 at land (#2288)'); r.setHead(head);
    expect(() => r.git(['grep', '-E', '^bornAs: x[0-9a-z]{6}$', 'origin/main', '--', 'backlog/'])).toThrowError(expect.objectContaining({ status: 1 }));
    expect(proveNumberingOnlyMove({ cwd: r.cwd, fromSha: r.approved, toSha: head })).toMatchObject({ ok: true, readFailed: false });
    expect(r.prove()).toMatchObject({ licensed: true, tier: 'numbering' });
  });
  it.each(['.github/workflows/ci.yml', '.github/actions/setup/action.yml', 'scripts/merge-ai-prs.mjs'])('refuses an unapproved sensitive successor: %s', path => {
    const r = fixture(); r.write(path, 'unapproved'); r.setHead(r.commit('author change'));
    expect(r.prove()).toMatchObject({ licensed: false });
  });
  it('licenses a main merge whose changed paths match main using config-independent raw evidence', () => {
    const r = fixture();
    r.git(['checkout', '-qb', 'main-change']); r.write('.github/workflows/ci.yml', 'from main');
    const main = r.commit('main workflow'); r.git(['update-ref', 'refs/remotes/origin/main', main]);
    r.git(['checkout', '-qb', 'pr', r.approved]); r.git(['commit', '--allow-empty', '-qm', 'retain approved tree']);
    r.git(['merge', '--no-ff', '-m', 'merge main', main]); r.setHead(r.git(['rev-parse', 'HEAD']));
    let diffArgs;
    const treeReads = [];
    expect(r.prove({ run: (cmd, args, opts) => {
      if (cmd === 'git' && args.includes('diff-tree')) diffArgs = args;
      if (cmd === 'git' && args.includes('ls-tree')) treeReads.push(args);
      return execFileSync(cmd, args, opts);
    } })).toMatchObject({ licensed: true, tier: 'mechanical' });
    expect(diffArgs).toEqual([...GIT_PINS, '-c', 'core.precomposeUnicode=false', '-c', 'core.quotePath=false',
      '-c', 'diff.ignoreSubmodules=none', 'diff-tree', '-r', '-z', '--raw', '--no-abbrev',
      '--no-renames', '--ignore-submodules=none', '--no-ext-diff', '--no-textconv', r.approved, r.git(['rev-parse', 'HEAD'])]);
    expect(treeReads).toEqual([r.git(['rev-parse', 'HEAD']), main].map(ref => [
      ...GIT_PINS,
      '-c', 'core.precomposeUnicode=false', '-c', 'core.quotePath=false', 'ls-tree', '-r', '-z', '--full-tree', ref,
    ]));
  });
  it.each([
    ['diff.ignoreSubmodules', '.github/actions/vendor'],
    ['.gitmodules ignore', '.github/actions/vendor'],
    ['diff.ignoreSubmodules', 'vendor'],
  ])('refuses a gitlink update hidden by %s at %s but present in raw tree evidence', (ignore, path) => {
    const r = fixture();
    r.write('.gitmodules', `[submodule "vendor"]\n\tpath = ${path}\n\turl = ./vendor\n${ignore === '.gitmodules ignore' ? '\tignore = all\n' : ''}`);
    r.git(['add', '.gitmodules']);
    r.git(['update-index', '--add', '--cacheinfo', '160000', r.approved, path]);
    r.git(['commit', '-qm', 'approved gitlink']);
    const approved = r.git(['rev-parse', 'HEAD']);
    r.comments[0].body = `<!-- reviewed-sha: ${approved} -->\n<!-- cleared-human: operator -->`;
    r.git(['checkout', '-qb', 'main-change']); r.write('README.md', 'from main');
    r.git(['add', 'README.md']); r.git(['commit', '-qm', 'main docs']);
    const main = r.git(['rev-parse', 'HEAD']); r.git(['update-ref', 'refs/remotes/origin/main', main]);
    r.git(['checkout', '-qb', 'pr', approved]);
    r.git(['update-index', '--cacheinfo', '160000', main, path]);
    r.git(['commit', '-qm', 'author gitlink']);
    r.git(['merge', '--no-ff', '-m', 'merge main', main]);
    const head = r.git(['rev-parse', 'HEAD']); r.setHead(head);
    if (ignore === 'diff.ignoreSubmodules') r.git(['config', 'diff.ignoreSubmodules', 'all']);
    expect(r.git(['diff', '--name-only', '-z', '--no-renames', approved, head]).split('\0')).not.toContain(path);
    expect(r.git(['-c', 'diff.ignoreSubmodules=none', 'diff-tree', '-r', '-z', '--raw', '--no-renames', '--ignore-submodules=none', approved, head]))
      .toContain(`:160000 160000 ${r.approved} ${main} M\0${path}\0`);
    expect(r.prove()).toMatchObject({ licensed: false, reason: expect.stringMatching(/re-approve.*queue/) });
  });
  it.each(['deletion', 'replacement'])('refuses a non-sensitive gitlink %s inherited from main (old-side mode)', change => {
    const r = fixture(), path = 'vendor';
    r.git(['update-index', '--add', '--cacheinfo', '160000', r.approved, path]);
    r.git(['commit', '-qm', 'approved gitlink']);
    const approved = r.git(['rev-parse', 'HEAD']);
    r.comments[0].body = `<!-- reviewed-sha: ${approved} -->\n<!-- cleared-human: operator -->`;
    r.git(['checkout', '-qb', 'main-change']);
    r.git(['update-index', '--force-remove', path]);
    if (change === 'replacement') { r.write(path, 'regular file'); r.git(['add', path]); }
    r.git(['commit', '-qm', 'main gitlink removal']);
    const main = r.git(['rev-parse', 'HEAD']); r.git(['update-ref', 'refs/remotes/origin/main', main]);
    r.git(['checkout', '-fqb', 'pr', approved]);
    r.write('ordinary.md', 'author docs'); r.git(['add', 'ordinary.md']); r.git(['commit', '-qm', 'author docs']);
    r.git(['merge', '--no-ff', '-m', 'merge main', main]); r.setHead(r.git(['rev-parse', 'HEAD']));
    expect(r.prove()).toMatchObject({ licensed: false, reason: expect.stringMatching(/gitlink.*re-approve.*queue/) });
  });
  it.each([
    ['regular-file-to-symlink change with the same blob id', '100644', '120000', false],
    ['exec-bit change with the same blob id', '100644', '100755', false],
    ['symlink inherited from main', '120000', '120000', false],
    ['submodule inherited from main', '160000', '160000', false],
    ['executable regular file inherited from main', '100755', '100755', true],
    ['deletion inherited from main', null, null, true],
  ])('checks path modes in a main merge: %s', (_name, mainMode, headMode, licensed) => {
    const r = fixture(), path = '.github/workflows/ci.yml';
    const id = mainMode === '160000' ? r.approved : r.git(['rev-parse', `${r.approved}:${path}`]);
    const stageMode = mode => r.git(mode === null ? ['update-index', '--force-remove', path]
      : ['update-index', '--cacheinfo', mode, id, path]);
    r.git(['checkout', '-qb', 'main-change']); r.write('README.md', 'from main');
    r.git(['add', 'README.md']); stageMode(mainMode); r.git(['commit', '-qm', 'main mode']);
    const main = r.git(['rev-parse', 'HEAD']); r.git(['update-ref', 'refs/remotes/origin/main', main]);
    r.git(['checkout', '-fqb', 'pr', r.approved]);
    stageMode(headMode); r.git(['commit', '-qm', 'author mode']);
    r.git(['reset', '--hard', 'HEAD']);
    r.git(['merge', '--no-ff', '-m', 'merge main', main]);
    const head = r.git(['rev-parse', 'HEAD']); r.setHead(head);
    const type = mainMode === '160000' ? 'commit' : 'blob';
    expect(r.git(['ls-tree', main, '--', path])).toBe(mainMode === null ? '' : `${mainMode} ${type} ${id}\t${path}`);
    expect(r.git(['ls-tree', head, '--', path])).toBe(headMode === null ? '' : `${headMode} ${type} ${id}\t${path}`);
    expect(r.prove()).toMatchObject(licensed ? { licensed: true, tier: 'mechanical' }
      : { licensed: false, reason: expect.stringMatching(/re-approve.*queue/) });
  });
  it('refuses an ordinary author successor without a main merge', () => {
    const r = fixture(); r.write('README.md', 'ordinary'); r.setHead(r.commit('author docs'));
    expect(r.prove()).toMatchObject({ licensed: false, reason: expect.stringMatching(/re-approve.*queue/) });
  });
  it('refuses a main merge that also carries an unapproved workflow change', () => {
    const r = fixture();
    r.git(['checkout', '-qb', 'main-change']); r.write('README.md', 'from main');
    const main = r.commit('main docs'); r.git(['update-ref', 'refs/remotes/origin/main', main]);
    r.git(['checkout', '-qb', 'pr', r.approved]); r.write('.github/workflows/ci.yml', 'author workflow'); r.commit('author workflow');
    r.git(['merge', '--no-ff', '-m', 'merge main', main]); r.setHead(r.git(['rev-parse', 'HEAD']));
    expect(r.prove()).toMatchObject({ licensed: false });
  });
  it('refuses an NFD-named workflow whose precomposed pathspec lookups are both empty', () => {
    const r = fixture(), path = '.github/workflows/cafe\u0301.yml';
    r.git(['checkout', '-qb', 'main-change']); r.write('README.md', 'from main');
    const main = r.commit('main docs'); r.git(['update-ref', 'refs/remotes/origin/main', main]);
    r.git(['checkout', '-qb', 'pr', r.approved]);
    const id = r.git(['rev-parse', `${r.approved}:.github/workflows/ci.yml`]);
    // Stage the raw name directly so filesystem normalization cannot change the fixture.
    r.git(['-c', 'core.precomposeUnicode=false', 'update-index', '--add', '--cacheinfo', '100644', id, path]);
    r.git(['commit', '-qm', 'author NFD workflow']);
    r.git(['merge', '--no-ff', '-m', 'merge main', main]);
    const head = r.git(['rev-parse', 'HEAD']); r.setHead(head);
    r.git(['config', 'core.precomposeUnicode', 'true']);
    expect(r.git(['-c', 'core.precomposeUnicode=false', '-c', 'core.quotePath=false', 'ls-tree', '-r', '-z', '--full-tree', head]))
      .toContain(`\t${path}\0`);
    // Model Git's macOS pathspec precomposition on every host, including Linux.
    const emptyLookups = [head, main].map(ref => r.git(['ls-tree', '-z', ref, '--', path.normalize('NFC')]));
    expect(emptyLookups).toEqual(['', '']);
    expect(r.prove()).toMatchObject({ licensed: false, reason: expect.stringMatching(/re-approve.*queue/) });
  });
  it('refuses a policy successor differing from main even in a main merge', () => {
    const r = fixture();
    r.git(['checkout', '-qb', 'main-change']); r.write('README.md', 'from main');
    const main = r.commit('main docs'); r.git(['update-ref', 'refs/remotes/origin/main', main]);
    r.git(['checkout', '-qb', 'pr', r.approved]); r.write('scripts/lib/required-status-checks.mjs', 'author policy'); r.commit('author policy');
    r.git(['merge', '--no-ff', '-m', 'merge main', main]); r.setHead(r.git(['rev-parse', 'HEAD']));
    expect(r.prove()).toMatchObject({ licensed: false });
  });
  it.each([
    ['ordinary text', 'ordinary.md', 'author docs'],
    ['binary', 'asset.bin', Buffer.from([0, 1, 2, 255])],
    ['non-UTF8', 'legacy.txt', Buffer.from([0xff, 0xfe, 0x61])],
  ])('refuses a %s changed file differing from main', (_name, path, body) => {
    const r = fixture();
    r.git(['checkout', '-qb', 'main-change']); r.write('README.md', 'from main');
    const main = r.commit('main docs'); r.git(['update-ref', 'refs/remotes/origin/main', main]);
    r.git(['checkout', '-qb', 'pr', r.approved]); r.write(path, body); r.commit('author content');
    r.git(['merge', '--no-ff', '-m', 'merge main', main]); r.setHead(r.git(['rev-parse', 'HEAD']));
    expect(r.prove()).toMatchObject({ licensed: false, reason: expect.stringMatching(/differing from main.*re-approve.*queue/) });
  });
  it.each([
    ['ordinary.md', 'identical content'],
    ['asset.bin', Buffer.from([0, 1, 2, 255])],
    ['legacy[1].txt', Buffer.from([0xff, 0xfe, 0x61])],
  ])('licenses a changed path identical to main without reading content: %s', (path, body) => {
    const r = fixture();
    r.git(['checkout', '-qb', 'main-change']); r.write(path, body);
    const main = r.commit('main content'); r.git(['update-ref', 'refs/remotes/origin/main', main]);
    r.git(['checkout', '-qb', 'pr', r.approved]); r.write(path, body); r.commit('identical author content');
    r.git(['merge', '--no-ff', '-m', 'merge main', main]); r.setHead(r.git(['rev-parse', 'HEAD']));
    const reads = [];
    expect(r.prove({ run: (cmd, args, opts) => {
      if (cmd === 'git') reads.push(args);
      return execFileSync(cmd, args, opts);
    } })).toMatchObject({ licensed: true, tier: 'mechanical' });
    expect(reads.some(args => args.includes('diff') || args.includes('show')
      || (args.includes('cat-file') && !args.includes('-e')))).toBe(false);
  });
  it('refuses a PR-touched file merged with main changes even when the merge is clean', () => {
    const r = fixture(), path = 'ordinary.md';
    const baseText = 'base author line\n' + 'unchanged\n'.repeat(10) + 'base main line\n';
    r.write(path, baseText); const base = r.commit('shared file');
    r.git(['checkout', '-qb', 'main-change']); r.write(path, baseText.replace('base main line', 'main change'));
    const main = r.commit('main edits shared file'); r.git(['update-ref', 'refs/remotes/origin/main', main]);
    r.git(['checkout', '-qb', 'pr', base]); r.write(path, baseText.replace('base author line', 'approved PR change'));
    const approved = r.commit('approved PR edit');
    r.comments[0].body = `<!-- reviewed-sha: ${approved} -->\n<!-- cleared-human: operator -->`;
    r.git(['merge', '--no-ff', '-m', 'merge main', main]);
    const head = r.git(['rev-parse', 'HEAD']); r.setHead(head);
    expect(r.git(['show', `${head}:${path}`])).toContain('approved PR change');
    expect(r.git(['show', `${head}:${path}`])).toContain('main change');
    expect(r.git(['diff-tree', '-r', '--name-only', approved, head])).toBe(path);
    expect(r.prove()).toMatchObject({ licensed: false, reason: expect.stringMatching(/differing from main.*re-approve.*queue/) });
  });
  it.each(['deletion', 'replacement'])('refuses a symlink %s inherited from main (old-side mode)', change => {
    const r = fixture(), path = 'ordinary-link';
    const id = r.git(['rev-parse', `${r.approved}:.github/workflows/ci.yml`]);
    r.git(['update-index', '--add', '--cacheinfo', '120000', id, path]);
    r.git(['commit', '-qm', 'approved symlink']);
    const approved = r.git(['rev-parse', 'HEAD']);
    r.comments[0].body = `<!-- reviewed-sha: ${approved} -->\n<!-- cleared-human: operator -->`;
    r.git(['checkout', '-qb', 'main-change']);
    r.git(['update-index', '--force-remove', path]);
    if (change === 'replacement') r.git(['update-index', '--add', '--cacheinfo', '100644', id, path]);
    r.git(['commit', '-qm', 'main symlink removal']);
    const main = r.git(['rev-parse', 'HEAD']); r.git(['update-ref', 'refs/remotes/origin/main', main]);
    r.git(['checkout', '-fqb', 'pr', approved]); r.git(['commit', '--allow-empty', '-qm', 'retain approved tree']);
    r.git(['merge', '--no-ff', '-m', 'merge main', main]); r.setHead(r.git(['rev-parse', 'HEAD']));
    expect(r.prove()).toMatchObject({ licensed: false, reason: expect.stringMatching(/symlink.*re-approve.*queue/) });
  });
  it.each(['scripts/ordinary.mjs', 'scripts/ordinary[1].mjs', 'scripts/工作.mjs'])('refuses a changed path differing from main using complete bounded tree reads at %s', path => {
    const r = fixture();
    r.git(['checkout', '-qb', 'main-change']); r.write('README.md', 'from main');
    const main = r.commit('main docs'); r.git(['update-ref', 'refs/remotes/origin/main', main]);
    r.git(['checkout', '-qb', 'pr', r.approved]);
    r.write(path, 'export const writableRoots = [".", "../shared"];\n'); r.commit('author sandbox grant');
    r.git(['merge', '--no-ff', '-m', 'merge main', main]);
    const head = r.git(['rev-parse', 'HEAD']); r.setHead(head);
    expect(r.git(['ls-tree', head, '--', path])).not.toBe(r.git(['ls-tree', main, '--', path]));
    const reads = [];
    expect(r.prove({ run: (cmd, args, opts) => {
      if (cmd === 'git' && args.includes('diff')) throw Error('content diff must not be read');
      if (cmd === 'git' && args.includes('ls-tree')) reads.push({ args, opts });
      return execFileSync(cmd, args, opts);
    } })).toMatchObject({ licensed: false, reason: expect.stringMatching(/unapproved.*re-approve.*queue/) });
    expect(reads).toEqual([head, main].map(ref => ({
      args: [...GIT_PINS, '-c', 'core.precomposeUnicode=false', '-c', 'core.quotePath=false', 'ls-tree', '-r', '-z', '--full-tree', ref],
      opts: expect.objectContaining({ cwd: r.cwd, timeout: 5000, maxBuffer: 8 * 1024 * 1024 }),
    })));
  });
  it.each(['head', 'main'].flatMap(ref => ['unreadable', 'oversized', 'non-UTF8', 'malformed', 'truncated',
    'duplicate', 'wrong type', 'missing tab', 'empty path', 'unknown mode', 'unicode path', 'control path'].map(failure => [ref, failure])))(
    'refuses %s complete-tree evidence that is %s and names the operator fallback', (ref, failure) => {
    const r = fixture();
    r.git(['checkout', '-qb', 'main-change']); r.write('README.md', 'from main');
    const main = r.commit('main docs'); r.git(['update-ref', 'refs/remotes/origin/main', main]);
    r.git(['checkout', '-qb', 'pr', r.approved]); r.git(['commit', '--allow-empty', '-qm', 'retain approved tree']);
    r.git(['merge', '--no-ff', '-m', 'merge main', main]);
    const head = r.git(['rev-parse', 'HEAD']); r.setHead(head);
    let injected = false;
    expect(r.prove({ run: (cmd, args, opts) => {
      if (cmd === 'git' && args.includes('ls-tree') && args.at(-1) === (ref === 'head' ? head : main)) {
        injected = true;
        if (failure === 'unreadable') throw Error('tree unavailable');
        if (failure === 'oversized') return Buffer.alloc(8 * 1024 * 1024 + 1);
        if (failure === 'non-UTF8') return Buffer.from([0xff]);
        if (failure === 'malformed') return Buffer.from('unreadable\0');
        const entry = `100644 blob ${'a'.repeat(40)}\tREADME.md\0`;
        if (failure === 'truncated') return Buffer.from(entry.slice(0, -1));
        if (failure === 'duplicate') return Buffer.from(entry.repeat(2));
        if (failure === 'wrong type') return Buffer.from(entry.replace('blob', 'commit'));
        if (failure === 'missing tab') return Buffer.from(removeTreeEntryTabs(entry));
        if (failure === 'empty path') return Buffer.from(entry.replace('README.md', ''));
        if (failure === 'unknown mode') return Buffer.from(entry.replace('100644', '170000'));
        if (failure === 'unicode path') return Buffer.from(entry.replace('README.md', 'caf\u00e9.md'));
        if (failure === 'control path') return Buffer.from(entry.replace('README.md', 'bad\u0085.md'));
      }
      return execFileSync(cmd, args, opts);
    } })).toMatchObject({ licensed: false, reason: 'approval or git evidence unreadable or oversized; operator must re-approve the current head or queue it' });
    expect(injected).toBe(true);
  });
  it.each(['A', 'M', 'D'])('requires a deletion record for a path absent from both complete trees: %s', status => {
    const r = fixture();
    r.git(['checkout', '-qb', 'main-change']); r.write('README.md', 'from main');
    const main = r.commit('main docs'); r.git(['update-ref', 'refs/remotes/origin/main', main]);
    r.git(['checkout', '-qb', 'pr', r.approved]); r.git(['commit', '--allow-empty', '-qm', 'retain approved tree']);
    r.git(['merge', '--no-ff', '-m', 'merge main', main]); r.setHead(r.git(['rev-parse', 'HEAD']));
    const oldMode = status === 'A' ? '000000' : '100644';
    const newMode = status === 'D' ? '000000' : '100644';
    const oldId = (status === 'A' ? '0' : 'a').repeat(40);
    const newId = (status === 'D' ? '0' : 'b').repeat(40);
    let injected = false;
    const result = r.prove({ run: (cmd, args, opts) => {
      if (cmd === 'git' && args.includes('diff-tree')) {
        injected = true;
        return Buffer.from(`:${oldMode} ${newMode} ${oldId} ${newId} ${status}\0missing.md\0`);
      }
      return execFileSync(cmd, args, opts);
    } });
    expect(injected).toBe(true);
    expect(result).toMatchObject(status === 'D' ? { licensed: true, tier: 'mechanical' }
      : { licensed: false, reason: 'successor changes an unapproved path differing from main; operator must re-approve the current head or queue it' });
  });
  it.each([
    ['missing terminator', rawChange('docs.md').slice(0, -1), 'successor diff incomplete'],
    ['missing path', rawChange('docs.md').split('\0')[0] + '\0', 'successor diff incomplete'],
    ['malformed header', 'unreadable\0docs.md\0', 'successor tree evidence unreadable'],
    ['unknown mode', rawChange('docs.md').replace('100644', '170000'), 'successor tree evidence unreadable'],
    ['empty path', rawChange(''), 'successor path unreadable'],
  ])('refuses incomplete or unreadable raw tree evidence: %s', (_name, output, reason) => {
    const r = fixture();
    r.git(['checkout', '-qb', 'main-change']); r.write('README.md', 'from main');
    const main = r.commit('main docs'); r.git(['update-ref', 'refs/remotes/origin/main', main]);
    r.git(['checkout', '-qb', 'pr', r.approved]); r.write('ordinary.md', 'author docs'); r.commit('author docs');
    r.git(['merge', '--no-ff', '-m', 'merge main', main]); r.setHead(r.git(['rev-parse', 'HEAD']));
    let injected = false;
    expect(r.prove({ run: (cmd, args, opts) => {
      if (cmd === 'git' && args.includes('diff-tree')) {
        injected = true;
        return Buffer.from(output);
      }
      return execFileSync(cmd, args, opts);
    } }))
      .toMatchObject({ licensed: false, reason: `${reason}; operator must re-approve the current head or queue it` });
    expect(injected).toBe(true);
  });
  it('refuses oversized git evidence and directs the operator to re-approve or queue', () => {
    const r = fixture();
    r.git(['checkout', '-qb', 'main-change']); r.write('README.md', 'from main');
    const main = r.commit('main docs'); r.git(['update-ref', 'refs/remotes/origin/main', main]);
    r.git(['checkout', '-qb', 'pr', r.approved]); r.write('ordinary.md', 'author docs'); r.commit('author docs');
    r.git(['merge', '--no-ff', '-m', 'merge main', main]); r.setHead(r.git(['rev-parse', 'HEAD']));
    expect(r.prove({ run: (cmd, args, opts) => {
      if (cmd === 'git' && args.includes('diff-tree')) return Buffer.alloc(8 * 1024 * 1024 + 1);
      return execFileSync(cmd, args, opts);
    } })).toMatchObject({ licensed: false, reason: 'approval or git evidence unreadable or oversized; operator must re-approve the current head or queue it' });
  });
  it.each(['head', 'main'].flatMap(ref => ['missing', 'corrupt'].map(failure => [ref, failure])))(
    'refuses %s tree objects that are %s and names the operator fallback', (ref, failure) => {
    const r = fixture();
    r.git(['checkout', '-qb', 'main-change']); r.write('README.md', 'from main');
    const main = r.commit('main docs'); r.git(['update-ref', 'refs/remotes/origin/main', main]);
    r.git(['checkout', '-qb', 'pr', r.approved]); r.write('ordinary.md', 'author docs'); r.commit('author docs');
    r.git(['merge', '--no-ff', '-m', 'merge main', main]);
    const head = r.git(['rev-parse', 'HEAD']); r.setHead(head);
    const oid = r.git(['rev-parse', `${ref === 'head' ? head : main}^{tree}`]);
    const object = join(r.cwd, '.git', 'objects', oid.slice(0, 2), oid.slice(2));
    rmSync(object);
    if (failure === 'corrupt') writeFileSync(object, 'corrupt object');
    expect(r.prove()).toMatchObject({ licensed: false, reason: expect.stringMatching(/re-approve.*queue/) });
  });
  it.each(['non-UTF8 path', 'duplicate', 'empty path', 'unknown mode', 'truncated'])(
    'refuses real malformed Git tree evidence: %s', failure => {
    const r = fixture();
    r.git(['checkout', '-qb', 'main-change']); r.write('README.md', 'from main');
    const main = r.commit('main docs'); r.git(['update-ref', 'refs/remotes/origin/main', main]);
    const blob = Buffer.from(r.git(['rev-parse', `${main}:README.md`]), 'hex');
    const entry = (mode, path) => Buffer.concat([Buffer.from(`${mode} `), Buffer.from(path), Buffer.from([0]), blob]);
    let tree = entry('100644', 'README.md');
    if (failure === 'non-UTF8 path') tree = entry('100644', Buffer.from([0xff]));
    if (failure === 'duplicate') tree = Buffer.concat([tree, tree]);
    if (failure === 'empty path') tree = entry('100644', '');
    if (failure === 'unknown mode') tree = entry('170000', 'README.md');
    if (failure === 'truncated') tree = tree.subarray(0, -10);
    // --literally stores adversarial object bytes; every proof read still runs real Git.
    const oid = execFileSync('git', ['hash-object', '-w', '--literally', '-t', 'tree', '--stdin'],
      { cwd: r.cwd, input: tree, encoding: 'utf8' }).trim();
    const head = r.git(['commit-tree', oid, '-p', r.approved, '-p', main, '-m', 'merge main']);
    r.setHead(head);
    expect(r.prove()).toMatchObject({ licensed: false, reason: expect.stringMatching(/re-approve.*queue/) });
  });
  it.each(['cafe\u0301.md', 'caf\u00e9.md', 'bad\n.md', 'bad\t.md', 'bad\u007f.md', 'bad\u0085.md'])(
    'refuses ambiguous Unicode or control characters in raw diff paths: %j', path => {
      const r = fixture();
      r.git(['checkout', '-qb', 'main-change']);
      const oid = r.git(['rev-parse', `${r.approved}:.github/workflows/ci.yml`]);
      r.git(['-c', 'core.precomposeUnicode=false', 'update-index', '--add', '--cacheinfo', '100644', oid, path]);
      r.git(['commit', '-qm', 'main ambiguous path']);
      const main = r.git(['rev-parse', 'HEAD']); r.git(['update-ref', 'refs/remotes/origin/main', main]);
      r.git(['checkout', '-qb', 'pr', r.approved]); r.git(['commit', '--allow-empty', '-qm', 'retain approved tree']);
      r.git(['merge', '--no-ff', '-m', 'merge main', main]); r.setHead(r.git(['rev-parse', 'HEAD']));
      expect(r.prove()).toMatchObject({ licensed: false, reason: expect.stringMatching(/re-approve.*queue/) });
    });
  it('refuses a main merge with more than 1024 paths and names the operator fallback', () => {
    const r = fixture();
    r.git(['checkout', '-qb', 'main-change']);
    for (let i = 0; i < 1025; i++) r.write(`docs/${i}.md`, 'main docs');
    const main = r.commit('main docs'); r.git(['update-ref', 'refs/remotes/origin/main', main]);
    r.git(['checkout', '-qb', 'pr', r.approved]); r.git(['commit', '--allow-empty', '-qm', 'retain approved tree']);
    r.git(['merge', '--no-ff', '-m', 'merge main', main]); r.setHead(r.git(['rev-parse', 'HEAD']));
    expect(r.prove()).toMatchObject({ licensed: false, reason: expect.stringMatching(/1024.*re-approve.*queue/) });
  });
  it('refuses a head that is not a descendant of approval', () => {
    const r = fixture(); r.git(['checkout', '--orphan', 'unrelated']); r.write('README.md', 'new root');
    r.setHead(r.commit('unrelated'));
    expect(r.prove()).toMatchObject({ licensed: false });
  });
  it.each(['missing label', 'no clearance', 'untrusted clearance', 'unreadable comments', 'unreadable live approval', 'moved live head'])('refuses %s', failure => {
    const r = fixture();
    if (failure === 'missing label') r.setLabels([]);
    if (failure === 'no clearance') r.comments.length = 0;
    if (failure === 'untrusted clearance') r.comments[0].author.login = 'stranger';
    const options = failure === 'unreadable comments' ? { readComments: () => { throw Error('unreadable'); } }
      : failure === 'unreadable live approval' ? { exec: () => { throw Error('unreadable'); } }
      : failure === 'moved live head' ? { headSha: 'f'.repeat(40) } : {};
    expect(r.prove(options)).toMatchObject({ licensed: false });
  });
  it('refuses unreadable git evidence', () => {
    const r = fixture(); r.write('README.md', 'safe'); const head = r.commit('docs'); r.setHead(head);
    rmSync(join(r.cwd, '.git', 'objects', head.slice(0, 2), head.slice(2)));
    expect(r.prove()).toMatchObject({ licensed: false });
  });
  it.each(['origin', 'secondary'].flatMap(remote => ['approved', 'head'].map(side => [remote, side])))(
    'never lazy-fetches missing license objects from partial clone promisor %s (%s)', (remote, side) => {
    const r = fixture();
    r.write('README.md', 'ordinary'); r.setHead(r.commit('author docs'));
    const marker = join(r.cwd, 'helper-ran'), helper = join(r.cwd, 'upload-pack-helper');
    writeFileSync(helper, '#!/bin/sh\nprintf ran > "' + marker + '"\nexit 1\n', { mode: 0o755 });
    r.git(['config', 'extensions.partialClone', remote]);
    r.git(['config', `remote.${remote}.promisor`, 'true']);
    r.git(['config', `remote.${remote}.url`, r.cwd]);
    r.git(['config', `remote.${remote}.uploadpack`, helper]);
    r.git(['config', 'protocol.file.allow', 'always']);
    const missing = 'abcdef0123456789abcdef0123456789abcdef0123';
    if (side === 'head') r.setHead(missing);
    else r.comments[0].body = `<!-- reviewed-sha: ${missing} -->\n<!-- cleared-human: operator -->`;
    expect(r.prove()).toMatchObject({ licensed: false, reason: expect.stringMatching(/re-approve.*queue/) });
    expect(existsSync(marker)).toBe(false);
  });
  it('refuses real Git output over 8 MiB and directs the operator to re-approve or queue', () => {
    const r = fixture();
    r.write('README.md', 'ordinary'); r.setHead(r.commit('author docs'));
    // Config discovery is a bounded Git read too; one large value exceeds its output cap.
    r.git(['config', '--add', 'remote.huge.promisor', 'false']);
    const config = join(r.cwd, '.git', 'config');
    writeFileSync(config, readFileSync(config, 'utf8') + '\n[remote "oversized"]\n promisor = ' + 'x'.repeat(8 * 1024 * 1024) + '\n');
    expect(r.prove()).toMatchObject({ licensed: false, reason: expect.stringMatching(/oversized.*re-approve.*queue/) });
  });
});

describe('approvalLicensesEnqueue setting', () => {
  const envKey = 'WE_MERGE_QUEUE_HUMAN_ONLY_APPROVAL_LICENSES_ENQUEUE';
  it('resolves env then file then default true with provenance', () => {
    const readFile = () => JSON.stringify({ mergeQueue: { humanOnly: { approvalLicensesEnqueue: false } } });
    expect(resolveApprovalLicensesEnqueue({ env: {}, readFile })).toEqual({ value: false, source: 'settings' });
    expect(resolveApprovalLicensesEnqueue({ env: { [envKey]: 'true' }, readFile })).toEqual({ value: true, source: 'env' });
    expect(resolveApprovalLicensesEnqueue({ env: { [envKey]: 'off' }, readFile })).toEqual({ value: false, source: 'env' });
    expect(resolveApprovalLicensesEnqueue({ env: { [envKey]: 'invalid' }, readFile })).toEqual({ value: false, source: 'settings' });
    expect(resolveApprovalLicensesEnqueue({ env: {}, readFile: () => { throw Error(); } })).toEqual({ value: true, source: 'default' });
    expect(resolveApprovalLicensesEnqueue({ env: {} })).toEqual({ value: true, source: 'settings' });
  });
});
