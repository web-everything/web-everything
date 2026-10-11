/**
 * @file scripts/lib/__tests__/daemon-edge.test.mjs
 * @description daemon-edge slice 1 (`../daemon-edge.mjs`, epic we:backlog/x59tqsg). Real temp git repos only: a
 *   bare `origin.git` standing in for GitHub, throwaway author clones that push branches / play the resolver,
 *   and the module's own scratch work repo under a per-test `WE_DAEMON_EDGE_DIR`. `prState` is always an
 *   injected fake — no `gh` call is ever made, and nothing here touches the real origin or `~/.claude`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  edgeEnabled, runEdgeTick, registerPr, readEdgeLedger, planEdgeTick, admissionCheck, defaultGitRunner,
  EDGE_BRANCH, EDGE_IDENTITY_ENV, EDGE_SOFT_CAP, edgeLedgerPath, owedId,
} from '../daemon-edge.mjs';
import { REBUILD_IDENTITY_ENV } from '../daemon-rebuild.mjs';

const REPO = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..');
const temps = [];
const mktemp = (p) => { const d = mkdtempSync(join(tmpdir(), p)); temps.push(d); return d; };

function git(cwd, args) {
  return spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    cwd, encoding: 'utf8', timeout: 20_000, killSignal: 'SIGKILL',
  });
}
function gitOk(cwd, args) {
  const r = git(cwd, args);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

let origin;
let env;
let states; // pr → OPEN/MERGED/CLOSED
const prState = (pr) => states[pr] ?? 'OPEN';

function author() {
  const dir = join(mktemp('daemon-edge-slice1-author-'), 'w');
  gitOk(tmpdir(), ['clone', '-q', origin, dir]);
  return dir;
}
function writeFiles(dir, files) {
  for (const [p, c] of Object.entries(files)) {
    const abs = join(dir, p);
    spawnSync('mkdir', ['-p', join(abs, '..')]);
    writeFileSync(abs, c);
  }
}
/** Push one commit onto `ref` (from `base`). */
function pushBranch(ref, files, { base = 'origin/main' } = {}) {
  const dir = author();
  gitOk(dir, ['checkout', '-q', '-B', ref, base]);
  writeFiles(dir, files);
  gitOk(dir, ['add', '-A']);
  gitOk(dir, ['commit', '-q', '-m', `change ${ref}`]);
  gitOk(dir, ['push', '-q', '-f', 'origin', `HEAD:refs/heads/${ref}`]);
  return gitOk(dir, ['rev-parse', 'HEAD']);
}
const advanceMain = (files) => pushBranch('main', files);
function show(ref, path) {
  const r = git(origin, ['show', `${ref}:${path}`]);
  return r.status === 0 ? r.stdout : null;
}
const tick = (o = {}) => runEdgeTick({ remoteUrl: origin, env, prState, ...o });

beforeEach(() => {
  const root = mktemp('daemon-edge-slice1-');
  origin = join(root, 'origin.git');
  gitOk(root, ['init', '-q', '--bare', '-b', 'main', origin]);
  const seed = join(root, 'seed');
  gitOk(root, ['clone', '-q', origin, seed]);
  gitOk(seed, ['checkout', '-q', '-b', 'main']);
  writeFiles(seed, { 'README.md': 'seed\n', 'scripts/daemon.mjs': 'line1\nline2\nline3\n' });
  gitOk(seed, ['add', '-A']);
  gitOk(seed, ['commit', '-q', '-m', 'seed']);
  gitOk(seed, ['push', '-q', 'origin', 'main']);
  env = { ...process.env, WE_DAEMON_EDGE: '1', WE_DAEMON_EDGE_DIR: join(root, 'edge-state') };
  states = {};
});
afterEach(() => { while (temps.length) rmSync(temps.pop(), { recursive: true, force: true }); });

describe('flag', () => {
  it('is off by default and only 1/true/on turns it on', () => {
    expect(edgeEnabled({})).toBe(false);
    expect(edgeEnabled({ WE_DAEMON_EDGE: '0' })).toBe(false);
    expect(edgeEnabled({ WE_DAEMON_EDGE: 'yes please' })).toBe(false);
    expect(edgeEnabled({ WE_DAEMON_EDGE: '1' })).toBe(true);
    expect(edgeEnabled({ WE_DAEMON_EDGE: 'on' })).toBe(true);
  });

  it('flag off: a real tick and a real register refuse, write nothing, push nothing', async () => {
    const off = { ...env, WE_DAEMON_EDGE: '' };
    pushBranch('lane/fix-a', { 'a.txt': 'a\n' });
    expect(await runEdgeTick({ remoteUrl: origin, env: off, prState })).toEqual({ ok: false, reason: 'flag-off' });
    expect(registerPr({ pr: 1, ref: 'lane/fix-a', remoteUrl: origin, env: off })).toEqual({ ok: false, reason: 'flag-off' });
    expect(existsSync(edgeLedgerPath(off))).toBe(false);
    expect(git(origin, ['rev-parse', '--verify', `refs/heads/${EDGE_BRANCH}`]).status).not.toBe(0);
  });

  it('flag off: a dry run still plans (bootstrap) without pushing', async () => {
    const off = { ...env, WE_DAEMON_EDGE: '' };
    const r = await runEdgeTick({ remoteUrl: origin, env: off, prState, dryRun: true });
    expect(r.ok).toBe(true);
    expect(r.decisions[0]).toMatchObject({ step: 'bootstrap' });
    expect(git(origin, ['rev-parse', '--verify', `refs/heads/${EDGE_BRANCH}`]).status).not.toBe(0);
  });

  it('daemon-overlay add with the flag off never touches the edge ledger', () => {
    // The overlay-conflict guard (epic #3383/#4075) resolves `--ref` for real now — a plain empty directory no
    // longer suffices, so this is a real clone of the shared `origin` fixture with the ref actually pushed.
    pushBranch('lane/fix-a', { 'a.txt': 'a\n' });
    const clone = join(mktemp('daemon-edge-slice1-clone-'), 'w');
    gitOk(tmpdir(), ['clone', '-q', origin, clone]);
    const offEnv = { ...env, WE_DAEMON_EDGE: '', WE_DAEMON_OVERLAY_DIR: join(dirname(clone), 'ov'), WE_DAEMON_OVERLAY_STACK_BASES: '{}' };
    const r = spawnSync(process.execPath, [join(REPO, 'scripts/daemon-overlay.mjs'), 'add', `--clone=${clone}`, '--ref=lane/fix-a', '--pr=7', '--json'], {
      encoding: 'utf8', env: offEnv, timeout: 20_000,
    });
    expect(r.status).toBe(0);
    const outJson = JSON.parse(r.stdout);
    expect(outJson.edge).toBeUndefined();
    expect(existsSync(edgeLedgerPath(offEnv))).toBe(false);
  });

  it('commit identity matches the rebuild identity', () => {
    expect(EDGE_IDENTITY_ENV).toEqual(REBUILD_IDENTITY_ENV);
  });
});

describe('edge tick', () => {
  it('bootstraps daemon-edge at main, merges a registered PR once, and merges main in every tick', async () => {
    const t0 = await tick();
    expect(t0.pushed).toBe(true);
    expect(gitOk(origin, ['rev-parse', EDGE_BRANCH])).toBe(gitOk(origin, ['rev-parse', 'main']));

    pushBranch('lane/fix-a', { 'a.txt': 'fix a\n' });
    expect(registerPr({ pr: 1, ref: 'lane/fix-a', remoteUrl: origin, env }).ok).toBe(true);
    const t1 = await tick();
    expect(t1.decisions.find((d) => d.pr === 1)).toMatchObject({ action: 'merge', reason: 'registered' });
    expect(show(EDGE_BRANCH, 'a.txt')).toBe('fix a\n');
    const edgeAfterA = gitOk(origin, ['rev-parse', EDGE_BRANCH]);

    const t2 = await tick(); // nothing changed ⇒ nothing re-merged
    expect(t2.moved).toBe(false);
    expect(gitOk(origin, ['rev-parse', EDGE_BRANCH])).toBe(edgeAfterA);

    advanceMain({ 'm.txt': 'main moved\n' });
    const t3 = await tick();
    expect(t3.decisions.find((d) => d.step === 'main')).toMatchObject({ action: 'merge' });
    expect(show(EDGE_BRANCH, 'm.txt')).toBe('main moved\n');
    expect(show(EDGE_BRANCH, 'a.txt')).toBe('fix a\n');
    // fast-forward only: the old tip is an ancestor of the new one
    expect(git(origin, ['merge-base', '--is-ancestor', edgeAfterA, EDGE_BRANCH]).status).toBe(0);
    expect(readEdgeLedger(env).entries[0].state).toBe('merged');
  });

  it('a PR whose head moves gets its new commits merged in', async () => {
    await tick();
    pushBranch('lane/fix-a', { 'a.txt': 'v1\n' });
    registerPr({ pr: 1, ref: 'lane/fix-a', remoteUrl: origin, env });
    await tick();
    pushBranch('lane/fix-a', { 'a.txt': 'v2\n' }, { base: 'origin/lane/fix-a' });
    const t = await tick();
    expect(t.decisions.find((d) => d.pr === 1)).toMatchObject({ action: 'merge', reason: 'head-moved' });
    expect(show(EDGE_BRANCH, 'a.txt')).toBe('v2\n');
  });

  it('TWO CLASHING FIXES: the second is recorded as owed (never dropped), and after a resolver push both stay in edge', async () => {
    await tick();
    pushBranch('lane/fix-a', { 'scripts/daemon.mjs': 'line1\nA-intent\nline3\n' });
    pushBranch('lane/fix-b', { 'scripts/daemon.mjs': 'line1\nB-intent\nline3\n' });
    registerPr({ pr: 1, ref: 'lane/fix-a', remoteUrl: origin, env });
    const adm = registerPr({ pr: 2, ref: 'lane/fix-b', remoteUrl: origin, env });
    expect(adm.ok).toBe(true); // clean vs main ⇒ admitted even though it will clash with A in edge
    expect(adm.admission.main.status).toBe('clean');

    const t1 = await tick();
    expect(t1.decisions.find((d) => d.pr === 1)).toMatchObject({ action: 'merge' });
    expect(t1.decisions.find((d) => d.pr === 2)).toMatchObject({ action: 'owed', reason: 'conflict', paths: ['scripts/daemon.mjs'] });
    expect(t1.owed).toHaveLength(1);
    const owed = t1.owed[0];
    expect(owed).toMatchObject({ kind: 'pr-merge', pr: 2, paths: ['scripts/daemon.mjs'] });
    let ledger = readEdgeLedger(env);
    expect(ledger.entries.map((e) => [e.pr, e.state])).toEqual([[1, 'merged'], [2, 'owed-resolution']]);

    // Re-ticking keeps the SAME debt (same id, same since) — it neither drops B nor duplicates the record.
    const t2 = await tick();
    expect(t2.owed.map((o) => o.id)).toEqual([owed.id]);
    expect(readEdgeLedger(env).owed[0].since).toBe(ledger.owed[0].since);

    // The resolver (slice 2 will dispatch it): merge B into edge preserving both intents, push to daemon-edge.
    const r = author();
    gitOk(r, ['checkout', '-q', '-B', 'work', `origin/${EDGE_BRANCH}`]);
    git(r, ['merge', '--no-edit', 'origin/lane/fix-b']); // conflicts
    writeFileSync(join(r, 'scripts/daemon.mjs'), 'line1\nA-intent\nB-intent\nline3\n');
    gitOk(r, ['add', 'scripts/daemon.mjs']);
    gitOk(r, ['commit', '-q', '--no-edit']);
    gitOk(r, ['push', '-q', 'origin', `HEAD:refs/heads/${EDGE_BRANCH}`]);

    const t3 = await tick();
    expect(t3.decisions.find((d) => d.pr === 2)).toMatchObject({ action: 'noop', reason: 'head-already-in-edge' });
    expect(t3.owed).toEqual([]);
    expect(t3.clearedOwed).toEqual([owed.id]);
    ledger = readEdgeLedger(env);
    expect(ledger.entries.map((e) => [e.pr, e.state])).toEqual([[1, 'merged'], [2, 'merged']]);

    // …and the resolution is KEPT: main moving on does not re-open the clash.
    advanceMain({ 'm.txt': 'later main\n' });
    const t4 = await tick();
    expect(t4.owed).toEqual([]);
    expect(show(EDGE_BRANCH, 'scripts/daemon.mjs')).toBe('line1\nA-intent\nB-intent\nline3\n');
    expect(show(EDGE_BRANCH, 'm.txt')).toBe('later main\n');
  });

  it('a PR closed unmerged is reverted out of edge; the other fix stays', async () => {
    await tick();
    pushBranch('lane/fix-a', { 'a.txt': 'fix a\n' });
    pushBranch('lane/fix-b', { 'b.txt': 'fix b\n' });
    registerPr({ pr: 1, ref: 'lane/fix-a', remoteUrl: origin, env });
    registerPr({ pr: 2, ref: 'lane/fix-b', remoteUrl: origin, env });
    await tick();
    expect(show(EDGE_BRANCH, 'a.txt')).toBe('fix a\n');

    states[1] = 'CLOSED';
    const t = await tick();
    expect(t.decisions.find((d) => d.pr === 1)).toMatchObject({ action: 'revert', reason: 'pr-closed' });
    expect(show(EDGE_BRANCH, 'a.txt')).toBeNull();
    expect(show(EDGE_BRANCH, 'b.txt')).toBe('fix b\n');
    expect(readEdgeLedger(env).entries.find((e) => e.pr === 1).state).toBe('reverted');
    const again = await tick(); // idempotent
    expect(again.moved).toBe(false);
  });

  it('a PR closed before it ever reached edge is just retired', async () => {
    await tick();
    pushBranch('lane/fix-a', { 'scripts/daemon.mjs': 'line1\nA\nline3\n' });
    pushBranch('lane/fix-b', { 'scripts/daemon.mjs': 'line1\nB\nline3\n' });
    registerPr({ pr: 1, ref: 'lane/fix-a', remoteUrl: origin, env });
    registerPr({ pr: 2, ref: 'lane/fix-b', remoteUrl: origin, env });
    const t1 = await tick();
    expect(t1.owed).toHaveLength(1);
    states[2] = 'CLOSED';
    const t2 = await tick();
    expect(t2.decisions.find((d) => d.pr === 2)).toMatchObject({ action: 'retire', reason: 'pr-closed-never-in-edge' });
    expect(t2.owed).toEqual([]); // the debt is moot
  });

  it('a PR landed on main becomes a no-op and is retired', async () => {
    await tick();
    pushBranch('lane/fix-a', { 'a.txt': 'fix a\n' });
    registerPr({ pr: 1, ref: 'lane/fix-a', remoteUrl: origin, env });
    await tick();
    advanceMain({ 'a.txt': 'fix a\n' }); // squash-landed
    states[1] = 'MERGED';
    const t = await tick();
    expect(t.decisions.find((d) => d.step === 'main')).toMatchObject({ action: 'merge' });
    expect(t.decisions.find((d) => d.pr === 1)).toMatchObject({ action: 'retire', reason: 'pr-merged' });
    expect(t.owed).toEqual([]);
  });

  it('a main→edge clash is owed (not dropped) and PR merges still proceed', async () => {
    await tick();
    pushBranch('lane/fix-a', { 'scripts/daemon.mjs': 'line1\nA\nline3\n' });
    registerPr({ pr: 1, ref: 'lane/fix-a', remoteUrl: origin, env });
    await tick();
    advanceMain({ 'scripts/daemon.mjs': 'line1\nMAIN\nline3\n' });
    // fix-c branched BEFORE the clashing main move (a branch cut from the new main would carry the clash itself)
    pushBranch('lane/fix-c', { 'c.txt': 'c\n' }, { base: 'origin/main~1' });
    expect(registerPr({ pr: 3, ref: 'lane/fix-c', remoteUrl: origin, env }).ok).toBe(true);
    const t = await tick();
    expect(t.decisions.find((d) => d.step === 'main')).toMatchObject({ action: 'owed', reason: 'conflict' });
    expect(t.owed.map((o) => o.kind)).toEqual(['main-merge']);
    expect(t.decisions.find((d) => d.pr === 3)).toMatchObject({ action: 'merge' });
    expect(show(EDGE_BRANCH, 'c.txt')).toBe('c\n');
  });

  it('warns (never refuses) above the soft cap of unlanded PRs', async () => {
    await tick();
    const n = EDGE_SOFT_CAP + 1;
    for (let i = 1; i <= n; i++) {
      pushBranch(`lane/fix-${i}`, { [`f${i}.txt`]: `${i}\n` });
      expect(registerPr({ pr: i, ref: `lane/fix-${i}`, remoteUrl: origin, env }).ok).toBe(true);
    }
    const t = await tick();
    expect(t.warnings).toEqual([expect.objectContaining({ kind: 'edge-soft-cap', count: n, cap: EDGE_SOFT_CAP })]);
    expect(t.entries.every((e) => e.state === 'merged')).toBe(true);
  });
});

describe('admission check', () => {
  it('refuses a PR that clashes with MAIN unless forced; admits one that only clashes with edge', async () => {
    await tick();
    advanceMain({ 'scripts/daemon.mjs': 'line1\nMAIN\nline3\n' });
    pushBranch('lane/stale', { 'scripts/daemon.mjs': 'line1\nSTALE\nline3\n' }, { base: 'origin/main~1' });
    const refused = registerPr({ pr: 9, ref: 'lane/stale', remoteUrl: origin, env });
    expect(refused).toMatchObject({ ok: false, reason: 'admission-refused' });
    expect(refused.admission.main).toMatchObject({ status: 'conflict', paths: ['scripts/daemon.mjs'] });
    expect(readEdgeLedger(env).entries).toEqual([]);
    expect(registerPr({ pr: 9, ref: 'lane/stale', remoteUrl: origin, env, force: true }).ok).toBe(true);
  });

  it('is pure over the injected runner (plan with a fake git that reports main unresolved)', async () => {
    const fake = () => ({ status: 128, stdout: '', stderr: 'nope' });
    expect(await planEdgeTick({ git: fake, mainRef: 'm', edgeRef: 'e' })).toEqual({ ok: false, reason: 'main-unresolved' });
    const a = admissionCheck({ git: fake, headSha: 'x', mainRef: 'm', edgeRef: 'e' });
    expect(a.main.status).toBe('absent');
  });

  it('owed ids are stable for the same clash even when edge moves', () => {
    const a = owedId({ kind: 'pr-merge', pr: 2, ours: 'a'.repeat(40), theirs: 'b'.repeat(40) });
    expect(a).toBe(owedId({ kind: 'pr-merge', pr: 2, ours: 'c'.repeat(40), theirs: 'b'.repeat(40) }));
    expect(typeof defaultGitRunner).toBe('function');
  });
});
