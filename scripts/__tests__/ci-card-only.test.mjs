import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { classifyCardOnly, isCardPath, isCardOnlyDiff, resolveCardOnlyBase } from '../ci-card-only.mjs';
import { REVIEW_HOLD_LABELS } from '../lib/review-escalation.mjs';

describe('ci-card-only detection', () => {
  it('card-only PR is light', () => {
    expect(classifyCardOnly({ event: 'pull_request', files: ['backlog/001-x.md', 'backlog/zz9.md'] }).light).toBe(true);
  });
  it('any code file makes a PR full', () => {
    for (const f of ['scripts/foo.mjs', '.github/workflows/ci.yml', 'package.json', 'docs/a.md']) {
      expect(classifyCardOnly({ event: 'pull_request', files: ['backlog/001-x.md', f] }).light).toBe(false);
    }
  });
  it('a push is always full, even for card-only files', () => {
    expect(classifyCardOnly({ event: 'push', files: ['backlog/001-x.md'] }).light).toBe(false);
    expect(classifyCardOnly({ event: 'workflow_dispatch', files: ['backlog/001-x.md'] }).light).toBe(false);
  });
  it('fails closed on empty or missing file lists and path tricks', () => {
    expect(classifyCardOnly({ event: 'pull_request', files: [] }).light).toBe(false);
    expect(classifyCardOnly({ event: 'pull_request' }).light).toBe(false);
    expect(isCardPath('backlog-tools/x.mjs')).toBe(false);
    expect(isCardPath('backlog/../scripts/x.mjs')).toBe(false);
    expect(isCardPath('backlog/')).toBe(false);
    expect(isCardPath('backlog/tool.mjs')).toBe(false);
    expect(isCardPath('backlog/nested/card.md')).toBe(false);
  });
});

describe('fresh main basis (#5619: frozen event base.sha after the drain merged newer main in)', () => {
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const exec = (cwd) => (cmd, args) => execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const write = (cwd, rel, body) => { mkdirSync(dirname(join(cwd, rel)), { recursive: true }); writeFileSync(join(cwd, rel), body); };
  const commit = (cwd, msg) => { git(cwd, 'add', '-A'); git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', msg); return git(cwd, 'rev-parse', 'HEAD'); };
  const merge = (cwd, ref) => { git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', 'merge', '-q', '--no-ff', '--no-edit', ref); return git(cwd, 'rev-parse', 'HEAD'); };
  const diff = (cwd, base, head) => git(cwd, 'diff', '--name-only', '--no-renames', base, head).split('\n').filter(Boolean);
  // main: m0 → staleBase (event base.sha) → code change; lane: card, merges staleBase, later merges newer main.
  function fixture() {
    const cwd = mkdtempSync(join(tmpdir(), 'ci-card-only-'));
    git(cwd, 'init', '-q', '-b', 'main');
    write(cwd, 'README.md', 'x'); commit(cwd, 'm0');
    git(cwd, 'checkout', '-q', '-b', 'lane');
    write(cwd, 'backlog/x1-card.md', 'card'); commit(cwd, 'card');
    git(cwd, 'checkout', '-q', 'main');
    write(cwd, 'scripts/a.mjs', 'a'); const staleBase = commit(cwd, 'main code 1');
    git(cwd, 'checkout', '-q', 'lane'); merge(cwd, 'main');
    git(cwd, 'checkout', '-q', 'main');
    write(cwd, 'scripts/lane-pool.mjs', 'b'); commit(cwd, 'main code 2');
    git(cwd, 'checkout', '-q', 'lane'); const head = merge(cwd, 'main');
    git(cwd, 'update-ref', 'refs/remotes/origin/main', 'main');
    return { cwd, staleBase, head };
  }
  it('replays the live shape: the stale event base reads main code as the PR\'s; fresh main sees only the card', () => {
    const { cwd, staleBase, head } = fixture();
    try {
      expect(diff(cwd, staleBase, head)).toContain('scripts/lane-pool.mjs'); // the bug: full suite for a card PR
      const r = resolveCardOnlyBase({ exec: exec(cwd), base: staleBase, head, baseRef: 'main' });
      expect(r.basis).toBe('fresh-main-merge-base');
      expect(diff(cwd, r.diffBase, head)).toEqual(['backlog/x1-card.md']);
      expect(isCardOnlyDiff(diff(cwd, r.diffBase, head))).toBe(true);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
  it('a PR that really changes code still reads as code on the fresh basis', () => {
    const { cwd, staleBase } = fixture();
    try {
      write(cwd, 'scripts/own.mjs', 'mine'); const head = commit(cwd, 'own code');
      const r = resolveCardOnlyBase({ exec: exec(cwd), base: staleBase, head, baseRef: 'main' });
      expect(diff(cwd, r.diffBase, head).sort()).toEqual(['backlog/x1-card.md', 'scripts/own.mjs']);
      expect(isCardOnlyDiff(diff(cwd, r.diffBase, head))).toBe(false);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
  it('falls back to the event base (wider diff) when fresh main is missing or the PR is not main-targeted', () => {
    const { cwd, staleBase, head } = fixture();
    try {
      expect(resolveCardOnlyBase({ exec: exec(cwd), base: staleBase, head, baseRef: 'lane/x' })).toEqual({ diffBase: staleBase, basis: 'event-base' });
      expect(resolveCardOnlyBase({ exec: exec(cwd), base: staleBase, head })).toEqual({ diffBase: staleBase, basis: 'event-base' });
      git(cwd, 'update-ref', '-d', 'refs/remotes/origin/main');
      const r = resolveCardOnlyBase({ exec: exec(cwd), base: staleBase, head, baseRef: 'main' });
      expect(r.basis).toBe('event-base');
      expect(r.diffBase).toBe(staleBase);
      expect(r.note).toMatch(/fresh main unavailable/);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
  it('ci.yml refreshes main and passes the base ref to the detector', () => {
    const yml = readFileSync(resolve(import.meta.dirname, '../../.github/workflows/ci.yml'), 'utf8');
    expect(yml).toContain("git fetch --no-tags origin '+refs/heads/main:refs/remotes/origin/main'");
    expect(yml).toMatch(/ci-card-only\.mjs[^\n]*--base-ref='\$\{\{ github\.event\.pull_request\.base\.ref \}\}'/);
  });
});

describe('isCardOnlyDiff — the one definition shared with the local verify gate', () => {
  it('is exactly the light verdict of a pull_request classification', () => {
    const cases = [['backlog/a.md'], ['backlog/a.md', 'scripts/x.mjs'], [], null, undefined, ['backlog/../x'], ['backlog-tools/x.mjs'], ['backlog/a.md', 'src/old.ts']];
    for (const files of cases) expect(isCardOnlyDiff(files)).toBe(classifyCardOnly({ event: 'pull_request', files: files ?? undefined }).light);
    expect(isCardOnlyDiff(['backlog/a.md'])).toBe(true);
    expect(isCardOnlyDiff([])).toBe(false);
  });
});

describe('review-gate workflow label fast path', () => {
  it('its shell hold-label list matches REVIEW_HOLD_LABELS', () => {
    const yml = readFileSync(resolve(process.cwd(), '.github/workflows/review-gate.yml'), 'utf8');
    const m = yml.match(/HOLD_LABELS_LIST='([^']*)'/);
    expect(m).toBeTruthy();
    expect(m[1].split(',').sort()).toEqual([...REVIEW_HOLD_LABELS].sort());
  });
});
