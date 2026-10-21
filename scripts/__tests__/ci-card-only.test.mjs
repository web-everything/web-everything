import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { classifyCardOnly, isCardPath, isCardOnlyDiff, resolveCardOnlyBase, SAFE_BASE_REF } from '../ci-card-only.mjs';
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
    write(cwd, 'scripts/lane-pool.mjs', 'b'); const tip = commit(cwd, 'main code 2');
    git(cwd, 'checkout', '-q', 'lane'); const head = merge(cwd, 'main');
    git(cwd, 'update-ref', 'refs/remotes/origin/main', 'main');
    return { cwd, staleBase, head, tip };
  }
  const run = (o) => resolveCardOnlyBase({ baseRef: 'main', ...o });
  it('replays the live shape: the stale event base reads main code as the PR\'s; fresh main sees only the card', () => {
    const { cwd, staleBase, head, tip } = fixture();
    try {
      expect(diff(cwd, staleBase, head)).toContain('scripts/lane-pool.mjs'); // the bug: full suite for a card PR
      const r = run({ exec: exec(cwd), base: staleBase, head, freshMainSha: tip });
      expect(r.basis).toBe('fresh-main-merge-base');
      expect(diff(cwd, r.diffBase, head)).toEqual(['backlog/x1-card.md']);
      expect(isCardOnlyDiff(diff(cwd, r.diffBase, head))).toBe(true);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
  it('a PR that really changes code still reads as code on the fresh basis', () => {
    const { cwd, staleBase, tip } = fixture();
    try {
      write(cwd, 'scripts/own.mjs', 'mine'); const head = commit(cwd, 'own code');
      const r = run({ exec: exec(cwd), base: staleBase, head, freshMainSha: tip });
      expect(diff(cwd, r.diffBase, head).sort()).toEqual(['backlog/x1-card.md', 'scripts/own.mjs']);
      expect(isCardOnlyDiff(diff(cwd, r.diffBase, head))).toBe(false);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
  it('any doubt about the fresh main is the FULL suite, never the light path', () => {
    const { cwd, staleBase, head, tip } = fixture();
    try {
      const e = exec(cwd);
      for (const freshMainSha of [undefined, '', 'true', tip.slice(0, 12), staleBase]) {
        expect(run({ exec: e, base: staleBase, head, freshMainSha }).diffBase).toBeNull(); // not fetched / not confirmed
      }
      expect(run({ exec: e, base: 'f6b5651', head, freshMainSha: tip }).diffBase).toBeNull(); // event base not a full sha
      git(cwd, 'checkout', '-q', '--orphan', 'other'); write(cwd, 'z.md', 'z'); const stranger = commit(cwd, 'unrelated');
      expect(run({ exec: e, base: stranger, head, freshMainSha: tip }).note).toMatch(/fresh main check failed/); // base not on main
      git(cwd, 'update-ref', '-d', 'refs/remotes/origin/main');
      expect(run({ exec: e, base: staleBase, head, freshMainSha: tip }).basis).toBe('full-suite'); // ref vanished
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
  it('more than one merge base (criss-cross history) is the FULL suite', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ci-card-only-x-'));
    try {
      git(cwd, 'init', '-q', '-b', 'main');
      write(cwd, 'README.md', 'x'); commit(cwd, 'm0');
      git(cwd, 'checkout', '-q', '-b', 'b'); write(cwd, 'scripts/b.mjs', 'b'); const b = commit(cwd, 'b');
      git(cwd, 'checkout', '-q', 'main'); git(cwd, 'checkout', '-q', '-b', 'c'); write(cwd, 'scripts/c.mjs', 'c'); commit(cwd, 'c');
      git(cwd, 'checkout', '-q', 'b'); git(cwd, 'checkout', '-q', '-b', 'm'); const tip = merge(cwd, 'c');
      git(cwd, 'checkout', '-q', 'c'); merge(cwd, 'b'); write(cwd, 'backlog/x1-card.md', 'card'); const head = commit(cwd, 'card');
      git(cwd, 'update-ref', 'refs/remotes/origin/main', tip);
      expect(git(cwd, 'merge-base', '--all', tip, head).split('\n').length).toBe(2);
      const r = run({ exec: exec(cwd), base: b, head, freshMainSha: tip });
      expect(r).toMatchObject({ diffBase: null, basis: 'full-suite' });
      expect(r.note).toMatch(/2 merge bases/);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
  it('base refs: plain branch names only; a stacked PR keeps the event base; no base ref keeps the old behaviour', () => {
    const { cwd, staleBase, head } = fixture();
    try {
      const e = exec(cwd);
      expect(run({ exec: e, base: staleBase, head, baseRef: 'lane/x' })).toEqual({ diffBase: staleBase, basis: 'event-base' });
      expect(resolveCardOnlyBase({ exec: e, base: staleBase, head })).toEqual({ diffBase: staleBase, basis: 'event-base' });
      for (const baseRef of ["lane/x';echo${IFS}light=true>>$GITHUB_OUTPUT;#", '', '-main', 'a b', 'a..b', 'x$(id)', 'a\nb']) {
        expect(SAFE_BASE_REF.test(baseRef)).toBe(false);
        expect(run({ exec: e, base: staleBase, head, baseRef }).diffBase).toBeNull();
      }
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
  it('CLI end to end: light only with a confirmed fresh main; an injection-shaped base ref is full', () => {
    const { cwd, staleBase, head, tip } = fixture();
    const cli = resolve(import.meta.dirname, '../ci-card-only.mjs');
    const out = (...args) => execFileSync(process.execPath, [cli, '--event=pull_request', `--base=${staleBase}`, `--head=${head}`, ...args],
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    try {
      expect(out('--base-ref=main', `--fresh-main-sha=${tip}`)).toBe('light=true');
      expect(out('--base-ref=main', '--fresh-main-sha=')).toBe('light=false');
      expect(out("--base-ref=lane/x';echo${IFS}light=true>>$GITHUB_OUTPUT;#", `--fresh-main-sha=${tip}`)).toBe('light=false');
      expect(out()).toBe('light=false'); // old call shape: stale event base, main's code counted
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
  it('ci.yml passes event values through env, quoted, and only a fresh fetch yields FRESH_MAIN_SHA', () => {
    const yml = readFileSync(resolve(import.meta.dirname, '../../.github/workflows/ci.yml'), 'utf8');
    const step = yml.slice(yml.indexOf('- name: Is this a card-only PR?'), yml.indexOf('# Sharded unit suite'));
    expect(step).toContain('BASE_REF: ${{ github.event.pull_request.base.ref }}');
    expect(step).toContain('BASE_SHA: ${{ github.event.pull_request.base.sha }}');
    expect(step.slice(step.indexOf('run: |'))).not.toContain('${{'); // no expression interpolated into the script
    expect(step).toContain("if git fetch --no-tags origin '+refs/heads/main:refs/remotes/origin/main'; then");
    expect(step).toContain('--base-ref="$BASE_REF" --fresh-main-sha="$FRESH_MAIN_SHA"');
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
