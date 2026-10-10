/**
 * @file scripts/lib/__tests__/daemon-rebuild-keep-established.test.mjs
 * @description x5059uu — a rebuild keeps the overlays already in the running build ("established") and parks the
 *   newcomer that conflicts with them. Live 2026-10-09 19:54:32Z on wev-control: #4643 (registered FIRST) pushed a
 *   new commit that conflicted on skills-src/conveyor/build-dispatch-daemon.mjs with the live, proven overlays #4658
 *   and #4663; the rebuild applied #4643 first (list order) and conflict-dropped #4658/#4663, so prepares stopped
 *   until they were re-adopted at 20:19Z. These tests replay that sequence through the real rebuild path.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { planRebuild, rebuildClone } from '../daemon-rebuild.mjs';
import { addOverlay } from '../daemon-overlays.mjs';
import { gitRun } from '../main-staleness.mjs';
import { readOverlayConflictWakes } from '../overlay-conflict-wake.mjs';

process.env.WE_DAEMON_REBUILD_SKIP_UNRELATED = '0';

const temps = [];
afterEach(() => { while (temps.length) rmSync(temps.pop(), { recursive: true, force: true }); });
const mktemp = (p) => { const d = mkdtempSync(join(tmpdir(), p)); temps.push(d); return d; };
const gitOk = (cwd, args) => {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8', timeout: 20_000 });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  return r.stdout;
};
const write = (dir, name, content) => { mkdirSync(dirname(join(dir, name)), { recursive: true }); writeFileSync(join(dir, name), content); };
const isAncestor = (cwd, a, b) => spawnSync('git', ['merge-base', '--is-ancestor', a, b], { cwd }).status === 0;

const DAEMON = 'skills-src/conveyor/build-dispatch-daemon.mjs';
const lines = (over = {}) => `${Array.from({ length: 9 }, (_, i) => over[i + 1] ?? `line ${i + 1}`).join('\n')}\n`;

function fixture() {
  const base = mktemp('we-keep-established-');
  const origin = join(base, 'origin.git');
  const clone = join(base, 'clone');
  gitOk(base, ['init', '--bare', '-q', origin]);
  mkdirSync(clone);
  gitOk(clone, ['init', '-q', '-b', 'main']);
  write(clone, DAEMON, lines());
  gitOk(clone, ['add', '-A']);
  gitOk(clone, ['commit', '-q', '-m', 'init']);
  gitOk(clone, ['remote', 'add', 'origin', origin]);
  gitOk(clone, ['push', '-q', '-u', 'origin', 'main']);
  gitOk(clone, ['fetch', '-q', 'origin']);
  const author = join(base, 'author');
  gitOk(base, ['clone', '-q', origin, author]);
  const push = (ref, from, files) => {
    gitOk(author, ['fetch', '-q', 'origin']);
    gitOk(author, ['checkout', '-q', '-B', ref, from]);
    for (const [n, c] of Object.entries(files)) write(author, n, c);
    gitOk(author, ['add', '-A']);
    gitOk(author, ['commit', '-q', '-m', ref]);
    gitOk(author, ['push', '-q', 'origin', `HEAD:refs/heads/${ref}`]);
    return gitOk(author, ['rev-parse', 'HEAD']).trim();
  };
  const env = {
    ...process.env,
    WE_DAEMON_STATE_DIR: mktemp('we-keep-est-state-'),
    WE_DAEMON_CLONE_LOCK_ROOT: mktemp('we-keep-est-lock-'),
    WE_DAEMON_OVERLAY_DIR: mktemp('we-keep-est-overlay-'),
  };
  const init = gitOk(clone, ['rev-parse', 'HEAD']).trim();
  // Registration order is the live order: #4643 first, then #4658, then #4663.
  const cOld = push('lane/c', init, { 'other.txt': 'c\n' });
  const p = push('lane/prepare-launch-stall', init, { [DAEMON]: lines({ 2: 'prepare launches' }) });
  const h = push('lane/ruled-hold-release', init, { [DAEMON]: lines({ 8: 'ruled hold release' }) });
  const overlays = [
    { ref: 'lane/c', pr: 4643 }, { ref: 'lane/prepare-launch-stall', pr: 4658 }, { ref: 'lane/ruled-hold-release', pr: 4663 },
  ];
  /** #4643's new commit rewrites the block both established overlays touch. */
  const pushNewcomer = () => push('lane/c', 'origin/lane/c', { [DAEMON]: lines({ 2: 'c2', 5: 'c5', 8: 'c8' }) });
  gitOk(clone, ['fetch', '-q', 'origin']);
  const runGit = (args, opts = {}) => gitRun(args, { cwd: clone, env: { ...env, ...opts.env } });
  return { clone, env, init, cOld, p, h, overlays, pushNewcomer, runGit };
}

const passSmoke = () => vi.fn(async () => ({
  verdict: 'pass', attempts: 1, smoke: { results: [{ name: 'reconcile-dry-run', ok: true, ms: 148_000 }, { name: 'lane-acquire-release', ok: true, ms: 32_000 }] },
}));

describe('x5059uu — rebuild keeps established overlays and parks the conflicting newcomer', () => {
  it('replays 19:54:32Z: #4658/#4663 stay in HEAD, #4643\'s new head is parked with the conflicting file named', async () => {
    const f = fixture();
    for (const o of f.overlays) addOverlay(f.clone, o, { env: f.env });
    const first = await rebuildClone({ root: f.clone, env: f.env, runSmoke: passSmoke(), prState: async () => 'OPEN' });
    expect(first, JSON.stringify(first.alerts)).toMatchObject({ adopted: true });
    const liveHead = gitOk(f.clone, ['rev-parse', 'HEAD']).trim();
    for (const sha of [f.cOld, f.p, f.h]) expect(isAncestor(f.clone, sha, liveHead)).toBe(true);

    const cNew = f.pushNewcomer();
    const logs = [];
    const second = await rebuildClone({
      root: f.clone, env: f.env, runSmoke: passSmoke(), prState: async () => 'OPEN', log: { error: (m) => logs.push(m) },
    });
    const head = gitOk(f.clone, ['rev-parse', 'HEAD']).trim();
    expect(isAncestor(f.clone, f.p, head)).toBe(true);
    expect(isAncestor(f.clone, f.h, head)).toBe(true);
    expect(isAncestor(f.clone, cNew, head)).toBe(false);
    const kinds = second.alerts.map((a) => a.kind);
    expect(kinds).not.toContain('established-overlay-dropped');
    const parked = second.alerts.find((a) => a.kind === 'overlay-newcomer-parked');
    expect(parked?.detail).toMatchObject({ ref: 'lane/c', pr: 4643, sha: cNew, files: [DAEMON] });
    expect(parked.detail.collidesWith.map((c) => c.ref)).toEqual(['lane/prepare-launch-stall', 'lane/ruled-hold-release']);
    // the newcomer's PR is woken so its author resolves the conflict (merge the established branches in)
    expect(readOverlayConflictWakes(f.env, { maxAgeMs: Infinity }).get(4643)).toMatchObject({ ref: 'lane/c', files: [DAEMON] });
    // per-step smoke timings are logged on every smoke, fast or slow
    expect(logs.some((m) => m.includes('smoke-timings') && m.includes('reconcile-dry-run:148000ms'))).toBe(true);
  });

  it('planRebuild: an overlay already in the running HEAD applies before a changed one, whatever the list order', async () => {
    const f = fixture();
    const established = await planRebuild({ git: f.runGit, headSha: f.init, mainRef: 'origin/main', overlays: f.overlays });
    expect(established.applied.map((a) => a.ref)).toEqual(f.overlays.map((o) => o.ref));
    f.pushNewcomer();
    gitOk(f.clone, ['fetch', '-q', 'origin']);
    const plan = await planRebuild({ git: f.runGit, headSha: established.finalSha, mainRef: 'origin/main', overlays: f.overlays });
    expect(plan.ok).toBe(true);
    expect(plan.applied.map((a) => a.ref)).toEqual(['lane/prepare-launch-stall', 'lane/ruled-hold-release']);
    expect(plan.decisions.find((d) => d.ref === 'lane/c')).toMatchObject({ action: 'drop', reason: 'conflict' });
    expect(plan.alerts.find((a) => a.kind === 'overlay-newcomer-parked')?.detail).toMatchObject({ ref: 'lane/c', files: [DAEMON] });
  });

  it('dropping an ESTABLISHED overlay is never silent: it raises established-overlay-dropped', async () => {
    const f = fixture();
    const live = await planRebuild({ git: f.runGit, headSha: f.init, mainRef: 'origin/main', overlays: f.overlays.slice(1) });
    // main itself moves onto the block #4658 edits — nobody to park, so the established overlay must drop loudly
    const author = join(dirname(f.clone), 'author');
    gitOk(author, ['fetch', '-q', 'origin']);
    gitOk(author, ['checkout', '-q', '-B', 'main', 'origin/main']);
    write(author, DAEMON, lines({ 2: 'main moved' }));
    gitOk(author, ['commit', '-q', '-am', 'main']);
    gitOk(author, ['push', '-q', 'origin', 'HEAD:refs/heads/main']);
    gitOk(f.clone, ['fetch', '-q', 'origin']);
    const plan = await planRebuild({ git: f.runGit, headSha: live.finalSha, mainRef: 'origin/main', overlays: f.overlays.slice(1) });
    const loud = plan.alerts.find((a) => a.kind === 'established-overlay-dropped');
    expect(loud?.detail).toMatchObject({ ref: 'lane/prepare-launch-stall', pr: 4658, files: [DAEMON] });
    expect(plan.applied.map((a) => a.ref)).toEqual(['lane/ruled-hold-release']);
  });
});
