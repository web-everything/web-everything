import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolvePinnedDiffBasis, requireScoredNetDiff, pinnedGit } from '../lib/pinned-diff-basis.mjs';
import { computeNetDiffSignals, readPinnedCarryDiff, carryHumanClearanceOnIdenticalDiff } from '../merge-ai-prs.mjs';
import { scanTestTampering } from '../lib/pr-merge-gate.mjs';

const dirs = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture({ realRemote = false } = {}) {
  const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'pinned-basis-'));
  dirs.push(dir);
  const git = args => execFileSync('git', args, { cwd: dir, encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.test',
      GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.test' }, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  git(['init', '-q']);
  writeFileSync(join(dir, 'file.txt'), 'base\n');
  git(['add', '.']);
  const tree = git(['write-tree']);
  const base = git(['commit-tree', tree, '-m', 'base']);
  git(['update-ref', 'refs/heads/main', base]);
  let remote;
  if (realRemote) {
    remote = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'pinned-remote-'));
    dirs.push(remote);
    git(['clone', '--bare', '--no-hardlinks', '.', remote]);
    git(['remote', 'add', 'origin', remote]);
  }
  writeFileSync(join(dir, 'file.txt'), 'changed\n');
  git(['add', '.']);
  const head = git(['commit-tree', git(['write-tree']), '-p', base, '-m', 'head']);
  git(['update-ref', 'refs/heads/lane', head]);
  const calls = [];
  let fetched = base;
  const exec = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    if (!realRemote && args.includes('fetch')) {
      // A local transport seam: exercise real object/ref reads without network access.
      git(['update-ref', 'refs/remotes/origin/main', fetched]);
      writeFileSync(join(dir, '.git/FETCH_HEAD'), `${fetched}\t\tbranch 'main' of fixture\n`);
      return '';
    }
    return execFileSync(cmd, args, { ...opts, cwd: dir });
  };
  return { dir, git, base, head, exec, calls, remote, setFetched: sha => { fetched = sha; } };
}
const resolve = f => resolvePinnedDiffBasis({ exec: f.exec, headSha: f.head });

describe('resolvePinnedDiffBasis real Git boundary', () => {
  it('fetches the base exactly once and returns only three full commit identities', () => {
    const f = fixture();
    expect(resolve(f)).toEqual({ ok: true, baseSha: f.base, headSha: f.head, mergeBaseSha: f.base });
    const fetches = f.calls.filter(c => c.args.includes('fetch'));
    expect(fetches).toHaveLength(1);
    expect(fetches[0].args).toContain('+refs/heads/main:refs/remotes/origin/main');
  });
  it('producer resolves an unpublished local head against a real local remote before publication', () => {
    const f = fixture({ realRemote: true });
    // The remote was cloned before this head existed, with no hardlinks or alternate object store.
    expect(() => f.git(['--git-dir', f.remote, 'cat-file', '-e', `${f.head}^{commit}`])).toThrow();
    const basis = resolve(f);
    expect(basis).toEqual({ ok: true, baseSha: f.base, headSha: f.head, mergeBaseSha: f.base });
    const fetches = f.calls.filter(c => c.args.includes('fetch'));
    expect(fetches).toHaveLength(1);
    expect(fetches[0].args).not.toContain(f.head);
    const sig = computeNetDiffSignals({ exec: f.exec, basis });
    expect(requireScoredNetDiff(sig, f.head)).toBe(sig);
    expect(sig.netDiffText.text).toContain('+changed');
  });
  it('consumer fetches a missing exact head separately without re-fetching the base or overwriting FETCH_HEAD', () => {
    const f = fixture({ realRemote: true });
    const consumer = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'pinned-consumer-'));
    const published = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'pinned-published-'));
    dirs.push(consumer, published);
    f.git(['clone', '--no-local', '--no-checkout', f.remote, consumer]);
    expect(() => f.git(['-C', consumer, 'cat-file', '-e', `${f.head}^{commit}`])).toThrow();
    // Model a published head without any push: copy the producer into a second local bare remote.
    f.git(['clone', '--bare', '--no-hardlinks', '.', published]);
    f.git(['-C', consumer, 'remote', 'set-url', 'origin', published]);
    const calls = [];
    const exec = (cmd, args, opts) => {
      calls.push(args);
      return execFileSync(cmd, args, { ...opts, cwd: consumer });
    };
    const basis = resolvePinnedDiffBasis({ exec, headSha: f.head });
    expect(basis).toEqual({ ok: true, baseSha: f.base, headSha: f.head, mergeBaseSha: f.base });
    const fetches = calls.filter(args => args.includes('fetch'));
    expect(fetches).toHaveLength(2);
    expect(fetches[0].at(-1)).toBe('+refs/heads/main:refs/remotes/origin/main');
    expect(fetches[1].at(-1)).toBe(f.head);
    expect(fetches[1]).toContain('--no-write-fetch-head');
    expect(f.git(['-C', consumer, 'rev-parse', 'FETCH_HEAD'])).toBe(f.base);
    expect(requireScoredNetDiff(computeNetDiffSignals({ exec, basis }), f.head).scored).toBe(true);
  });
  it('missing head retrieval failure stays unscored after a successful real base fetch', () => {
    const f = fixture({ realRemote: true });
    expect(resolvePinnedDiffBasis({ exec: f.exec, headSha: 'f'.repeat(40) }))
      .toEqual({ ok: false, reason: 'ref-unresolved' });
    const fetches = f.calls.filter(c => c.args.includes('fetch'));
    expect(fetches).toHaveLength(2);
    expect(fetches[0].args.at(-1)).toBe('+refs/heads/main:refs/remotes/origin/main');
    expect(fetches[1].args.at(-1)).toBe('f'.repeat(40));
    expect(f.calls.some(c => c.args.includes('diff'))).toBe(false);
  });
  it('fetch failure is unscored base-fetch-failed even with a cached base', () => {
    const f = fixture(); resolve(f);
    const calls = [];
    const result = resolvePinnedDiffBasis({ headSha: f.head, exec: (cmd, args) => {
      calls.push(args); throw new Error('offline');
    } });
    expect(result).toEqual({ ok: false, reason: 'base-fetch-failed' });
    expect(calls).toHaveLength(1);
  });
  it('FETCH_HEAD mismatch refuses cached or concurrently moved base evidence', () => {
    const f = fixture();
    const exec = (cmd, args, opts) => {
      const out = f.exec(cmd, args, opts);
      if (args.includes('fetch')) f.git(['update-ref', 'refs/remotes/origin/main', f.head]);
      return out;
    };
    expect(resolvePinnedDiffBasis({ exec, headSha: f.head })).toEqual({ ok: false, reason: 'base-fetch-failed' });
  });
  it('ignores a shadow branch and tag named origin/main', () => {
    const f = fixture();
    f.git(['update-ref', 'refs/heads/origin/main', f.head]);
    f.git(['update-ref', 'refs/tags/origin/main', f.head]);
    expect(resolve(f).baseSha).toBe(f.base);
  });
  it('rejects unreachable/missing heads and abbreviated or symbolic head identities', () => {
    const f = fixture();
    expect(resolvePinnedDiffBasis({ exec: f.exec, headSha: 'f'.repeat(40) }).ok).toBe(false);
    for (const headSha of ['lane', f.head.slice(0, 12), 'a'.repeat(41), `${f.head}\n`]) {
      const before = f.calls.length;
      expect(resolvePinnedDiffBasis({ exec: f.exec, headSha }).ok).toBe(false);
      expect(f.calls).toHaveLength(before);
    }
  });
  it('ignores replace objects for ancestry AND diff evidence', () => {
    const f = fixture();
    f.git(['replace', f.head, f.base]);
    const basis = resolve(f);
    const sig = computeNetDiffSignals({ exec: f.exec, basis });
    expect(sig.scored).toBe(true);
    expect(sig.changedFiles).toEqual(['file.txt']);
    expect(sig.netDiffText.text).toContain('+changed');
    for (const { opts } of f.calls) expect(opts.env.GIT_NO_REPLACE_OBJECTS).toBe('1');
  });
  it('passes exact SHA-256 identities through commit and merge-base verification', () => {
    const base = 'a'.repeat(64), head = 'b'.repeat(64);
    const exec = (_cmd, args) => {
      if (args.includes('fetch')) return '';
      if (args.includes('merge-base')) return base;
      return args.at(-1) === `${head}^{commit}` ? head : base;
    };
    expect(resolvePinnedDiffBasis({ exec, headSha: head })).toEqual({ ok: true, baseSha: base, headSha: head, mergeBaseSha: base });
  });
  it('isolates global/system config and disables rendering drivers and renames', () => {
    const f = fixture();
    const basis = resolve(f);
    computeNetDiffSignals({ exec: f.exec, basis });
    for (const { args, opts } of f.calls) {
      expect(opts.env.GIT_CONFIG_NOSYSTEM).toBe('1');
      expect(opts.env.GIT_CONFIG_GLOBAL).toBe('/dev/null');
      expect(args.slice(0, 2)).toEqual(['-c', 'core.attributesFile=/dev/null']);
      if (args.includes('diff')) for (const flag of ['--no-textconv', '--no-ext-diff', '--no-renames']) expect(args).toContain(flag);
    }
    expect(() => pinnedGit(() => { throw new Error('oversized output'); }, ['diff', basis.mergeBaseSha, basis.headSha])).toThrow('oversized output');
  });
});

describe('pinned caller evidence', () => {
  it.each(['café.test.mjs', 'quote"slash\\.test.mjs'])('deleted test %s raises tamper hold or stays unscored', name => {
    const f = fixture();
    writeFileSync(join(f.dir, name), 'test("guard", () => expect(true).toBe(true));\n');
    f.git(['add', '.']);
    const base = f.git(['commit-tree', f.git(['write-tree']), '-p', f.base, '-m', 'test base']);
    f.setFetched(base);
    f.git(['rm', '-f', '--', name]);
    const head = f.git(['commit-tree', f.git(['write-tree']), '-p', base, '-m', 'delete test']);
    const basis = resolvePinnedDiffBasis({ exec: f.exec, headSha: head });
    const sig = computeNetDiffSignals({ exec: f.exec, basis });
    if (name.startsWith('café')) {
      expect(sig.scored).toBe(true);
      expect(scanTestTampering({ diffText: sig.netDiffText.text }).tampered).toBe(true);
    } else {
      expect(sig.scored).toBe(false);
      expect(sig.netDiffText.reason).toBe('unparseable-diff');
      expect(() => requireScoredNetDiff(sig, head)).toThrow('retry or request human review');
    }
  });
  it.each(['diff --git "a/quoted.test.mjs" "b/quoted.test.mjs"', 'diff --git unsupported'])('rejects unsupported headers at both scoring boundaries: %s', header => {
    const f = fixture(); const basis = resolve(f);
    const good = computeNetDiffSignals({ exec: f.exec, basis });
    const text = `${good.netDiffText.text}${header}\ndeleted file mode 100644\n`;
    const exec = (cmd, args, opts) => args.includes('diff') && !args.includes('--numstat') ? text : f.exec(cmd, args, opts);
    expect(computeNetDiffSignals({ exec, basis }).scored).toBe(false);
    expect(() => requireScoredNetDiff({ ...good, netDiffText: { ...good.netDiffText, text } }, f.head)).toThrow('unscored');
  });
  it('drain carry ignores real replacement objects that make changed content look cleared', () => {
    const f = fixture(); const basis = resolve(f);
    const expected = computeNetDiffSignals({ exec: f.exec, basis }).netDiffText;
    // The recorded head had the base tree; replacing it with the live head forges identical legacy diffs.
    const old = f.git(['commit-tree', f.git(['rev-parse', `${f.base}^{tree}`]), '-p', f.base, '-m', 'cleared']);
    f.git(['replace', old, f.head]);
    expect(f.git(['diff', f.base, old])).toBe(f.git(['diff', f.base, f.head]));
    expect(readPinnedCarryDiff({ exec: f.exec, headSha: f.head, carriedHeadSha: old, expected })).toBeNull();
    const carry = carryHumanClearanceOnIdenticalDiff({ setting: 'on', humanClearedSha: old,
      headSha: f.head, pinnedHeadSha: f.head,
      readHeadDiff: sha => readPinnedCarryDiff({ exec: f.exec, headSha: sha, carriedHeadSha: old, expected }) });
    expect(carry).toMatchObject({ carried: false, humanClearedSha: old, retryable: true });
    // Real identical content can carry; any field drifting from the scored basis refuses.
    const identical = f.git(['commit-tree', f.git(['rev-parse', `${f.head}^{tree}`]), '-p', f.base, '-m', 'same']);
    expect(readPinnedCarryDiff({ exec: f.exec, headSha: f.head, carriedHeadSha: identical, expected })).toEqual(expected);
    for (const key of ['baseSha', 'headSha', 'mergeBaseSha']) {
      expect(readPinnedCarryDiff({ exec: f.exec, headSha: f.head, carriedHeadSha: identical,
        expected: { ...expected, [key]: 'f'.repeat(40) } })).toBeNull();
    }
    expect(readPinnedCarryDiff({ exec: f.exec, headSha: f.head, carriedHeadSha: 'f'.repeat(40), expected })).toBeNull();
  });
  it('drain moved refs retain original evidence and a different decided head keeps the tamper hold', () => {
    const f = fixture();
    const basis = resolve(f);
    f.git(['update-ref', 'refs/remotes/origin/main', f.head]);
    f.git(['update-ref', 'refs/heads/lane', f.base]);
    const sig = computeNetDiffSignals({ exec: f.exec, basis });
    expect(sig.netDiffText.text).toContain('+changed');
    expect(requireScoredNetDiff(sig, f.head)).toBe(sig);
    expect(() => requireScoredNetDiff(sig, f.base)).toThrow('mismatched');
    // The actual drain call refuses before any label mutation, and before its gh-files fallback.
    const src = readFileSync('scripts/merge-ai-prs.mjs', 'utf8');
    expect(src).toMatch(/requireScoredNetDiff\(sig, v.listedHeadSha\);[\s\S]*?catch \{[\s\S]*?continue; \/\/ Preserve existing review\/tamper holds/);
    expect(src).toMatch(/netDiffText.headSha !== tamperHeadSha[\s\S]*?continue;/);
  });
  it('pr-land mismatched live head refuses before certification or drain trigger', () => {
    const f = fixture();
    const sig = computeNetDiffSignals({ exec: f.exec, basis: resolve(f) });
    expect(() => requireScoredNetDiff(sig, f.base)).toThrow('mismatched');
    const src = readFileSync('scripts/pr-land.mjs', 'utf8');
    expect(src).toContain("forge.viewPr(prNum, 'headRefOid').headRefOid");
    expect(src).toContain('requireScoredNetDiff(sig, liveHead)');
    expect(src.indexOf('reviewVerdict = applyReviewEscalationLabel()')).toBeLessThan(src.indexOf('      applyLabel();'));
    expect(src).toContain('if (!held) {\n      applyLabel();');
  });
  it('unscored/failed text and corrupted paired stamps cannot clear a hold', () => {
    const f = fixture(); const basis = resolve(f);
    const exec = (cmd, args, opts) => {
      if (args.includes('diff') && !args.includes('--numstat')) throw new Error('overflow');
      return f.exec(cmd, args, opts);
    };
    const sig = computeNetDiffSignals({ exec, basis });
    expect(sig.scored).toBe(false);
    expect(sig.diffHunks).toBeNull();
    expect(() => requireScoredNetDiff(sig, f.head)).toThrow('retry or request human review');
    const good = computeNetDiffSignals({ exec: f.exec, basis });
    expect(() => requireScoredNetDiff({ ...good, netDiffText: { ...good.netDiffText, baseSha: f.head } }, f.head)).toThrow('mismatched');
  });
  it('repo-local color.diff=always cannot colour pinned diffs past the tamper parser', () => {
    const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'pinned-color-'));
    dirs.push(dir);
    const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@e.test', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@e.test' };
    const git = args => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    git(['init', '-q']);
    git(['config', 'color.diff', 'always']);
    git(['config', 'color.ui', 'always']);
    git(['config', 'diff.noprefix', 'true']);
    git(['config', 'diff.mnemonicPrefix', 'true']);
    writeFileSync(join(dir, 'a.txt'), 'one\n');
    git(['add', '.']); git(['commit', '-q', '-m', 'one']);
    const first = git(['rev-parse', 'HEAD']);
    writeFileSync(join(dir, 'a.txt'), 'two\n');
    git(['commit', '-qam', 'two']);
    const text = pinnedGit((cmd, args, opts) => execFileSync(cmd, args, { ...opts, cwd: dir }), ['diff', '--end-of-options', first, 'HEAD']);
    expect(text).toContain('+two');
    expect(text).not.toContain('\u001b[');
    expect(text).toContain('diff --git a/a.txt b/a.txt');
  });
  it('pr-land soak precheck fails closed when the pinned diff is unavailable', () => {
    const source = readFileSync('scripts/pr-land.mjs', 'utf8');
    const start = source.indexOf('function soakCreatePrecheck');
    const block = source.slice(start, source.indexOf('if (DRY_RUN)', start));
    expect(block).toContain('ok: false');
    expect(block).not.toMatch(/ok: true, skipped: 'diff unavailable/);
  });
  it('repo-local info/grafts cannot rewrite ancestry seen by pinned reads', () => {
    const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'pinned-grafts-'));
    dirs.push(dir);
    const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@e.test', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@e.test' };
    const git = args => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    git(['init', '-q']);
    for (const n of ['one', 'two', 'three']) { writeFileSync(join(dir, 'a.txt'), n + '\n'); git(['add', '.']); git(['commit', '-q', '-m', n]); }
    const tip = git(['rev-parse', 'HEAD']);
    mkdirSync(join(dir, '.git', 'info'), { recursive: true });
    writeFileSync(join(dir, '.git', 'info', 'grafts'), tip + '\n');
    expect(git(['rev-list', '--count', tip])).toBe('1');
    const run = (cmd, args, opts) => execFileSync(cmd, args, { ...opts, cwd: dir });
    expect(pinnedGit(run, ['rev-list', '--count', tip]).trim()).toBe('3');
  });
  it('repo-local diff.submodule=log cannot render gitlink changes as opaque log text', () => {
    const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'pinned-submodule-'));
    dirs.push(dir);
    const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@e.test', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@e.test' };
    const git = args => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    git(['init', '-q']);
    git(['config', 'diff.submodule', 'log']);
    writeFileSync(join(dir, 'a.txt'), 'one\n');
    git(['add', '.']);
    git(['update-index', '--add', '--cacheinfo', `160000,${'1'.repeat(40)},sub`]);
    git(['commit', '-q', '-m', 'one']);
    const first = git(['rev-parse', 'HEAD']);
    git(['update-index', '--cacheinfo', `160000,${'2'.repeat(40)},sub`]);
    git(['commit', '-q', '-m', 'two']);
    const text = pinnedGit((cmd, args, opts) => execFileSync(cmd, args, { ...opts, cwd: dir }), ['diff', '--end-of-options', first, 'HEAD']);
    expect(text).toContain('-Subproject commit ' + '1'.repeat(40));
    expect(text).toContain('+Subproject commit ' + '2'.repeat(40));
  });
});
