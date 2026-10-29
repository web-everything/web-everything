// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { proveHumanOnlyLicense, resolveApprovalLicensesEnqueue } from '../human-only-enqueue-license.mjs';

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'human-enqueue-')); roots.push(cwd);
  const git = args => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const write = (path, body) => { mkdirSync(dirname(join(cwd, path)), { recursive: true }); writeFileSync(join(cwd, path), body); };
  const commit = message => { git(['add', '-A']); git(['commit', '-qm', message]); return git(['rev-parse', 'HEAD']); };
  git(['init', '-q']); git(['config', 'user.email', 'test@example.com']); git(['config', 'user.name', 'test']);
  write('.github/workflows/ci.yml', 'approved workflow');
  write('backlog/xabc123-example.md', '---\nkind: story\n---\ncard\n');
  const approved = commit('approved'); git(['update-ref', 'refs/remotes/origin/main', approved]);
  let head = approved, labels = ['review:accepted'];
  const comments = [{ author: { login: 'chalbert' }, body: `<!-- reviewed-sha: ${approved} -->\n<!-- cleared-human: operator -->` }];
  const exec = (cmd, args, opts) => cmd === 'gh' ? JSON.stringify({ headRefOid: head, labels }) : execFileSync(cmd, args, opts);
  const prove = (options = {}) => proveHumanOnlyLicense({ repo: 'o/r', pr: 7, headSha: head, exec, cwd, readComments: () => comments, ...options });
  return { cwd, git, write, commit, approved, comments, exec, prove, setHead: sha => { head = sha; }, setLabels: v => { labels = v; } };
}

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
  it.each(['.github/workflows/ci.yml', '.github/actions/setup/action.yml', 'scripts/merge-ai-prs.mjs'])('refuses an unapproved sensitive successor: %s', path => {
    const r = fixture(); r.write(path, 'unapproved'); r.setHead(r.commit('author change'));
    expect(r.prove()).toMatchObject({ licensed: false });
  });
  it('licenses a main merge whose sensitive blobs came from main', () => {
    const r = fixture();
    r.git(['checkout', '-qb', 'main-change']); r.write('.github/workflows/ci.yml', 'from main');
    const main = r.commit('main workflow'); r.git(['update-ref', 'refs/remotes/origin/main', main]);
    r.git(['checkout', '-qb', 'pr', r.approved]); r.write('README.md', 'ordinary'); r.commit('docs');
    r.git(['merge', '--no-ff', '-m', 'merge main', main]); r.setHead(r.git(['rev-parse', 'HEAD']));
    expect(r.prove()).toMatchObject({ licensed: true, tier: 'mechanical' });
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
  it('refuses a humanRequired policy successor even in a main merge', () => {
    const r = fixture();
    r.git(['checkout', '-qb', 'main-change']); r.write('README.md', 'from main');
    const main = r.commit('main docs'); r.git(['update-ref', 'refs/remotes/origin/main', main]);
    r.git(['checkout', '-qb', 'pr', r.approved]); r.write('scripts/lib/required-status-checks.mjs', 'author policy'); r.commit('author policy');
    r.git(['merge', '--no-ff', '-m', 'merge main', main]); r.setHead(r.git(['rev-parse', 'HEAD']));
    expect(r.prove()).toMatchObject({ licensed: false });
  });
  it('refuses a main merge with more than 1024 paths and names the operator fallback', () => {
    const r = fixture();
    r.git(['checkout', '-qb', 'main-change']); r.write('README.md', 'from main');
    const main = r.commit('main docs'); r.git(['update-ref', 'refs/remotes/origin/main', main]);
    r.git(['checkout', '-qb', 'pr', r.approved]); r.write('ordinary.md', 'author docs'); r.commit('author docs');
    r.git(['merge', '--no-ff', '-m', 'merge main', main]); r.setHead(r.git(['rev-parse', 'HEAD']));
    expect(r.prove({ exec: (cmd, args, opts) => cmd === 'git' && args[0] === 'diff'
      ? Buffer.from(Array.from({ length: 1025 }, (_, i) => `docs/${i}.md\0`).join('')) : r.exec(cmd, args, opts) }))
      .toMatchObject({ licensed: false, reason: expect.stringMatching(/1024.*re-approve.*queue/) });
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
    const r = fixture(); r.write('README.md', 'safe'); r.setHead(r.commit('docs'));
    expect(r.prove({ exec: (cmd, args, opts) => { if (cmd === 'git') throw Error('unreadable'); return r.exec(cmd, args, opts); } })).toMatchObject({ licensed: false });
  });
  it('refuses oversized git evidence and directs the operator to re-approve or queue', () => {
    const r = fixture();
    r.git(['checkout', '-qb', 'main-change']); r.write('README.md', 'from main');
    const main = r.commit('main docs'); r.git(['update-ref', 'refs/remotes/origin/main', main]);
    r.git(['checkout', '-qb', 'pr', r.approved]); r.write('ordinary.md', 'author docs'); r.commit('author docs');
    r.git(['merge', '--no-ff', '-m', 'merge main', main]); r.setHead(r.git(['rev-parse', 'HEAD']));
    expect(r.prove({ exec: (cmd, args, opts) => {
      if (cmd === 'git' && args[0] === 'diff') return 'x'.repeat(8 * 1024 * 1024 + 1);
      return r.exec(cmd, args, opts);
    } })).toMatchObject({ licensed: false, reason: expect.stringMatching(/oversized.*re-approve.*queue/) });
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
