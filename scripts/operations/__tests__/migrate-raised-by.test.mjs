/** Real local-git migration proofs; gh and approval writes never reach the network. */
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateRaisedBy, parseArgs, resolveMax, formatResult } from '../migrate-raised-by.mjs';
import { raisedByFile } from '../../lib/raised-by.mjs';

const LINE = '- Also raised by web-everything/web-everything#5710 (finding 1: `scripts/a.mjs` — Keep the guard)';
const CARD = '---\nstatus: open\n---\n\n# Card\n';
const PATH = 'backlog/123-card.md';
const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = fs.mkdtempSync(join(tmpdir(), 'migrate-test-')); roots.push(root);
  const origin = join(root, 'origin.git'), repo = join(root, 'repo');
  const git = (args, cwd = repo) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  git(['init', '--bare', origin], root); git(['init', '-b', 'main', repo], root);
  git(['config', 'user.email', 'test@example.com']); git(['config', 'user.name', 'Test']);
  git(['remote', 'add', 'origin', origin]);
  const write = (path, body) => { fs.mkdirSync(join(repo, path, '..'), { recursive: true }); fs.writeFileSync(join(repo, path), body); };
  const commit = () => { git(['add', '.']); git(['commit', '-m', 'fixture']); return git(['rev-parse', 'HEAD']); };
  write(PATH, CARD); commit(); git(['push', 'origin', 'main']);
  const prs = [], calls = [], spawns = [];
  const pr = (body = CARD + '\n## Also raised by\n\n' + LINE + '\n', extra, labels = []) => {
    const number = prs.length + 1, branch = `pr-${number}`;
    git(['checkout', '-B', branch, 'main']); write(PATH, body); extra?.(write);
    const headRefOid = commit(); git(['push', 'origin', branch]);
    const row = { number, headRefName: branch, headRefOid, labels: labels.map(name => ({ name })), isDraft: false,
      baseRefName: 'main', headRepositoryOwner: { login: 'web-everything' }, isCrossRepository: false };
    prs.push(row); return row;
  };
  const deps = { fs, env: {}, settings: () => ({ raisedByMigrate: { maxPrsPerRun: 10 } }),
    gh: args => { calls.push(['gh', ...args]); return JSON.stringify(prs); },
    exec: (cmd, args, opts) => { calls.push([cmd, ...args]); return execFileSync(cmd, args, opts); },
    spawn: (cmd, args) => { spawns.push([cmd, ...args]); return { status: 0 }; } };
  const run = (opts = {}, overrides = {}) => migrateRaisedBy({ root: repo, ...opts }, { ...deps, ...overrides });
  return { root, repo, origin, git, write, commit, pr, prs, run, calls, spawns };
}
const pushes = f => f.calls.filter(c => c[0] === 'git' && c[1] === 'push');

describe('raised-by migration', () => {
  it('dry-run lists moved lines and files without pushes or label work', () => {
    const f = fixture(), p = f.pr(); const r = f.run();
    expect(r.prs[0]).toMatchObject({ number: p.number, branch: p.headRefName, head: p.headRefOid, status: 'migratable',
      moved: [{ card: PATH, line: LINE, disposition: 'create' }], files: [raisedByFile('123', LINE)] });
    expect(pushes(f)).toEqual([]); expect(f.spawns).toEqual([]);
    expect(f.git(['rev-parse', 'refs/heads/pr-1'], f.origin)).toBe(p.headRefOid);
    expect(f.calls.find(c => c[0] === 'gh')).toContain('number,headRefName,headRefOid,labels,isDraft,baseRefName,headRepositoryOwner,isCrossRepository');
    expect(formatResult(r)).toContain(`${PATH} -> ${LINE}`);
    expect(formatResult(r)).toContain(`would create ${raisedByFile('123', LINE).path}`);
    expect(JSON.parse(JSON.stringify(r)).prs[0].head).toBe(p.headRefOid);
  });
  it('skips non-backlog files', () => {
    const f = fixture(); f.pr(undefined, write => write('extra.txt', 'hello'));
    expect(f.run().prs[0].reasons).toContain('other-files');
  });
  it('skips removed or changed lines', () => {
    const f = fixture(); f.pr(CARD.replace('# Card', '# Changed') + LINE + '\n');
    expect(f.run().prs[0].reasons).toContain('removed-lines');
  });
  it('builds one commit on current main, preserves cards and uses an exact expect-head lease', () => {
    const f = fixture(), p = f.pr(), r = f.run({ apply: true }), sha = r.prs[0].newHead;
    const main = f.git(['rev-parse', 'main'], f.origin);
    expect(r.prs[0].status).toBe('migrated');
    expect(f.git(['rev-list', '--parents', '-n', '1', sha], f.origin)).toBe(`${sha} ${main}`);
    expect(f.git(['diff', '--name-status', main, sha], f.origin)).toBe(`A\t${raisedByFile('123', LINE).path}`);
    expect(execFileSync('git', ['show', `${sha}:${PATH}`], { cwd: f.origin, encoding: 'utf8' })).toBe(CARD);
    expect(f.git(['show', `${sha}:${raisedByFile('123', LINE).path}`], f.origin)).toBe(LINE);
    expect(pushes(f)).toEqual([['git', 'push', `--force-with-lease=refs/heads/pr-1:${p.headRefOid}`, f.origin, `${sha}:refs/heads/pr-1`]]);
    expect(f.calls.flat()).not.toContain('--force');
    expect(f.git(['log', '-1', '--format=%B', sha], f.origin)).toContain('Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>');
  });
  it.each([0, 1])('restamps accepted heads and rolls back failed restamps (exit %s)', status => {
    const f = fixture(), p = f.pr(undefined, undefined, ['review:accepted']);
    const r = f.run({ apply: true }, { spawn: (cmd, args) => { f.spawns.push([cmd, ...args]); return { status }; } });
    const row = r.prs[0], args = f.spawns[0];
    expect(args).toEqual(expect.arrayContaining(['1', '--repo=web-everything/web-everything', '--to=restamp', '--actor=drain', '--channel=drain-rebase', `--new-head=${row.newHead}`]));
    expect(args.some(a => a.startsWith('--body-file'))).toBe(false);
    if (status === 0) { expect(row.restamped).toBe(true); expect(pushes(f)).toHaveLength(1); }
    else {
      expect(row.status).toBe('refused: approval could not be carried');
      expect(pushes(f)[1]).toEqual(['git', 'push', `--force-with-lease=refs/heads/pr-1:${row.newHead}`, f.origin, `${p.headRefOid}:refs/heads/pr-1`]);
      expect(f.git(['rev-parse', 'refs/heads/pr-1'], f.origin)).toBe(p.headRefOid);
    }
  });
  it.each(['legacy', 'file'])('drops mentions already known on main (%s)', mode => {
    const f = fixture();
    f.git(['checkout', 'main']);
    if (mode === 'legacy') f.write(PATH, CARD + LINE + '\n');
    else { const file = raisedByFile('123', LINE); f.write(file.path, file.content); }
    f.commit(); f.git(['push', 'origin', 'main']);
    f.pr(CARD + LINE + '\n' + LINE + '\n');
    const row = f.run({ apply: true }).prs[0];
    expect(row.files).toEqual([]); expect(row.moved.every(m => m.disposition === 'already-present')).toBe(true);
    expect(f.git(['diff', '--name-only', 'main', 'pr-1'], f.origin)).toBe('');
  });
  it('caps migratable PRs, without charging skipped candidates', () => {
    const f = fixture(); f.pr(undefined, w => w('other', 'x')); f.pr(); const last = f.pr();
    expect(f.run({ apply: true, max: 1 }).prs.map(p => p.status)).toEqual(['skipped', 'migrated', 'max-reached']);
    expect(pushes(f)).toHaveLength(1);
    expect(f.git(['rev-parse', 'pr-3'], f.origin)).toBe(last.headRefOid);
  });
  it('uses three-dot diff when main advanced on another card', () => {
    const f = fixture(); f.pr(); f.git(['checkout', 'main']); f.write('backlog/124-other.md', CARD); f.commit(); f.git(['push', 'origin', 'main']);
    const row = f.run({ apply: true }).prs[0];
    expect(row.status).toBe('migrated');
    expect(f.git(['show', `${row.newHead}:backlog/124-other.md`], f.origin)).toBe(CARD.trim());
    expect(f.calls.some(c => c[1] === 'diff' && c.includes('--unified=0') && c.some(a => a.includes('...')))).toBe(true);
  });
  it.each([
    ['hold', 'has-hold-label review:human'], ['cross', 'cross-repository'], ['base', 'non-main-base'],
    ['closed', 'card-not-open'], ['missing', 'card-missing-on-main'], ['added', 'other-files'], ['text', 'other-added-lines'],
  ])('refuses %s candidates', (kind, reason) => {
    const f = fixture(), p = f.pr(undefined, kind === 'added' ? w => w('backlog/125-new.md', CARD + LINE + '\n') : undefined,
      kind === 'hold' ? ['review:human'] : []);
    if (kind === 'cross') p.isCrossRepository = true;
    if (kind === 'base') p.baseRefName = 'dev';
    if (['closed', 'missing'].includes(kind)) {
      f.git(['checkout', 'main']);
      if (kind === 'closed') f.write(PATH, CARD.replace('open', 'resolved')); else fs.unlinkSync(join(f.repo, PATH));
      f.commit(); f.git(['push', 'origin', 'main']);
    }
    if (kind === 'text') { f.git(['checkout', p.headRefName]); f.write(PATH, CARD + LINE + '\nArbitrary addition\n'); p.headRefOid = f.commit(); f.git(['push', 'origin', p.headRefName]); }
    expect(f.run({ apply: true }).prs[0].reasons).toContain(reason); expect(pushes(f)).toEqual([]);
  });
  it('reports rejected leases and continues', () => {
    const f = fixture(); f.pr(); f.pr();
    const row = f.run({ apply: true }, { exec: (cmd, args, opts) => {
      if (args[0] === 'push' && args.at(-1).endsWith(':refs/heads/pr-1')) throw new Error('stale info');
      return execFileSync(cmd, args, opts);
    } }).prs;
    expect(row.map(p => p.status)).toEqual(['push-rejected', 'migrated']);
  });
  it('refuses a mode change even with otherwise valid additions', () => {
    const f = fixture(), p = f.pr();
    f.git(['update-index', '--chmod=+x', PATH]);
    f.git(['commit', '-m', 'mode change']);
    p.headRefOid = f.git(['rev-parse', 'HEAD']); f.git(['push', 'origin', p.headRefName]);
    expect(f.run({ apply: true }).prs[0].reasons).toContain('other-files');
    expect(pushes(f)).toEqual([]);
  });
  it('deduplicates repeated new mentions within a PR', () => {
    const f = fixture(); f.pr(CARD + LINE + '\n' + LINE + '\n');
    const row = f.run().prs[0];
    expect(row.files).toEqual([raisedByFile('123', LINE)]);
    expect(row.moved.map(m => m.disposition)).toEqual(['create', 'already-present']);
  });
  it('applies the PR filter and refuses a head that changed since listing', () => {
    const f = fixture(); f.pr(); const second = f.pr(); second.headRefOid = '0'.repeat(40);
    expect(f.run({ apply: true, prs: [2] }).prs).toMatchObject([{ number: 2, reasons: ['head-changed'] }]);
    expect(pushes(f)).toEqual([]);
  });
  it('parses CLI filters and resolves max with source', () => {
    expect(parseArgs(['--apply', '--max=2', '--pr=1,3', '--json'])).toEqual({ apply: true, max: 2, prs: [1, 3], json: true });
    expect(resolveMax({}, { env: {}, settings: () => ({}) })).toEqual({ value: 10, source: 'default' });
    expect(resolveMax({}, { env: {}, settings: () => ({ raisedByMigrate: { maxPrsPerRun: 3 } }) })).toEqual({ value: 3, source: 'settings' });
    expect(resolveMax({}, { env: { WE_RAISED_BY_MIGRATE_MAX_PRS: '4' } })).toEqual({ value: 4, source: 'env' });
    expect(resolveMax({ max: 2 }, { env: { WE_RAISED_BY_MIGRATE_MAX_PRS: '4' } })).toEqual({ value: 2, source: '--max' });
    expect(() => parseArgs(['--max=0'])).toThrow();
  });
});
