/**
 * @file Real-git proof for the `source-in-main` retire evidence (R512, live 2026-11-03).
 * A loader `-m<N>` ref of a branch that later landed in main stays kept when main then edits the same file
 * (the exact-tree compare says "not a no-op"). Its pinned source (second parent) is in main, so it retires.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { planRetirements } from '../prototype-retire.mjs';

const dirs = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true }); });

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'we-retire-sim-'));
  dirs.push(dir);
  const raw = (args) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' });
  const ok = (...args) => { const r = raw(args); if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };
  ok('init', '-q', '-b', 'main');
  const commit = (file, content) => { writeFileSync(join(dir, file), content); ok('add', '-A'); ok('commit', '-q', '-m', `edit ${file}`); return ok('rev-parse', 'HEAD'); };
  commit('a.txt', 'one\n');
  const mergeRef = (a, b) => ok('commit-tree', ok('merge-tree', '--write-tree', a, b).split('\n')[0], '-p', a, '-p', b, '-m', 'merge');
  return { ok, commit, mergeRef, git: (args) => { const r = raw(args); return { code: r.status, stdout: r.stdout }; } };
}
const noPr = () => ({ code: 0, stdout: '[]' });
/** Reproduce the live case: main moved tests between files, so `merge-tree main tip` is not main's tree. */
const notNoop = (git) => (args) => (args[0] === 'merge-tree' && args.includes('origin/main')
  ? { code: 0, stdout: `${'f'.repeat(40)}\n` } : git(args));
const run = (git, ref = 'lane/x-m2') => planRetirements({ rows: [{ ref }], git, gh: noPr, repo: 'o/r' })[0];

/** main(m0) -> branch `source` edits test-a; ref = merge(m0, source) */
function scenario() {
  const r = repo();
  const m0 = r.ok('rev-parse', 'HEAD');
  r.ok('checkout', '-q', '-b', 'src');
  const source = r.commit('t1.txt', 'moved-in\n');
  r.ok('checkout', '-q', 'main');
  const ref = r.mergeRef(m0, source);
  r.ok('update-ref', 'refs/remotes/origin/lane/x-m2', ref);
  return { r, m0, source };
}
const landOn = (r, source) => {
  r.ok('merge', '-q', '--no-ff', '-m', 'land', source);
  r.commit('t1.txt', 'edited-later\n'); // main later changes the same file: merging the ref is no longer a no-op
  r.ok('update-ref', 'refs/remotes/origin/main', 'HEAD');
};

describe('source-in-main retire evidence', () => {
  it('retires a -m ref whose source is in main even after main edits the same file', () => {
    const { r, source } = scenario();
    landOn(r, source);
    const d = run(notNoop(r.git));
    expect(d.action).toBe('retire');
    expect(d.reason).toBe('source-in-main');
    expect(d.evidence.source).toBe(source);
  });

  it('keeps a -m ref whose source is not in main', () => {
    const { r } = scenario();
    r.commit('other.txt', 'x\n');
    r.ok('update-ref', 'refs/remotes/origin/main', 'HEAD');
    const d = run(notNoop(r.git));
    expect(d.action).toBe('keep');
    expect(d.reason).toBe('unique-commits-not-on-main');
  });

  it('keeps when the source is in main but the ref carries another commit not in main', () => {
    const { r, source } = scenario();
    r.ok('checkout', '-q', '-b', 'extra', source);
    const extra = r.commit('extra.txt', 'y\n');
    r.ok('checkout', '-q', 'main');
    landOn(r, source);
    const m = r.ok('rev-parse', 'origin/main');
    const base = r.ok('merge-base', m, source);
    r.ok('update-ref', 'refs/remotes/origin/lane/x-m2', r.mergeRef(base, extra));
    const d = run(notNoop(r.git));
    expect(d.action).toBe('keep');
  });

  it('keeps when git cannot answer the ancestry question', () => {
    const { r, source } = scenario();
    landOn(r, source);
    const git = (args) => (args[0] === 'merge-base' ? { code: 128, stdout: '' } : notNoop(r.git)(args));
    const d = run(git);
    expect(d.action).toBe('keep');
  });

  it('never retires on a branch-name match alone (non -m ref with later main edit is kept)', () => {
    const { r, source } = scenario();
    landOn(r, source);
    r.ok('update-ref', 'refs/remotes/origin/lane/x', r.ok('rev-parse', 'refs/remotes/origin/lane/x-m2'));
    expect(run(notNoop(r.git), 'lane/x').action).toBe('keep');
  });
});
