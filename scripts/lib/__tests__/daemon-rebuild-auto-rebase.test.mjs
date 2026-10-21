/**
 * @file scripts/lib/__tests__/daemon-rebuild-auto-rebase.test.mjs
 * @description overlay-rebase-on-merge — live 2026-10-21 14:57 ET (review clone): #5758 merged to main and the registered
 *   overlay containers conflicted with the new main in 7 files; x9diisp held the WHOLE clone (`established-overlay-hold`).
 *   With `overlay.autoRebase=on` an overlay that conflicts with main is rebased past a PROVEN merged-PR old head it carries
 *   (`overlay-auto-rebased`), or else set aside loudly (`overlay-set-aside`) while everything else keeps building and
 *   adopting. `shadow` (the standard) only says what it would do. Real git repos through the real rebuild path.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { rebuildClone, planRebuild } from '../daemon-rebuild.mjs';
import { addOverlay } from '../daemon-overlays.mjs';
import { gitRun } from '../main-staleness.mjs';
import { readRebuildState } from '../daemon-rebuild/state.mjs';

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

const GATE = 'scripts/lib/red-team-gate.mjs';
const lines = (over = {}) => `${Array.from({ length: 12 }, (_, i) => over[i + 1] ?? `line ${i + 1}`).join('\n')}\n`;
const PR = 5758;

function fixture({ mode = 'on' } = {}) {
  const base = mktemp('we-auto-rebase-');
  const origin = join(base, 'origin.git');
  const clone = join(base, 'clone');
  gitOk(base, ['init', '--bare', '-q', origin]);
  mkdirSync(clone);
  gitOk(clone, ['init', '-q', '-b', 'main']);
  write(clone, GATE, lines());
  gitOk(clone, ['add', '-A']);
  gitOk(clone, ['commit', '-q', '-m', 'init']);
  gitOk(clone, ['remote', 'add', 'origin', origin]);
  gitOk(clone, ['push', '-q', '-u', 'origin', 'main']);
  const author = join(base, 'author');
  gitOk(base, ['clone', '-q', origin, author]);
  const init = gitOk(clone, ['rev-parse', 'HEAD']).trim();
  const push = (ref, from, files, msg = ref) => {
    gitOk(author, ['fetch', '-q', 'origin']);
    gitOk(author, ['checkout', '-q', '-B', ref, from]);
    for (const [n, c] of Object.entries(files)) write(author, n, c);
    gitOk(author, ['add', '-A']);
    gitOk(author, ['commit', '-q', '-m', msg]);
    gitOk(author, ['push', '-q', 'origin', `+HEAD:refs/heads/${ref}`]);
    return gitOk(author, ['rev-parse', 'HEAD']).trim();
  };
  /** Merge `sha` into main the way GitHub does (`Merge pull request #N from …`). */
  const mergePr = (pr, sha, ref) => {
    gitOk(author, ['fetch', '-q', 'origin']);
    gitOk(author, ['checkout', '-q', '-B', 'main', 'origin/main']);
    gitOk(author, ['merge', '-q', '--no-ff', '-m', `Merge pull request #${pr} from web-everything/${ref}`, sha]);
    gitOk(author, ['push', '-q', 'origin', 'HEAD:refs/heads/main']);
    return gitOk(author, ['rev-parse', 'HEAD']).trim();
  };
  const env = {
    ...process.env,
    WE_DAEMON_STATE_DIR: mktemp('we-auto-rebase-state-'),
    WE_DAEMON_CLONE_LOCK_ROOT: mktemp('we-auto-rebase-lock-'),
    WE_DAEMON_OVERLAY_DIR: mktemp('we-auto-rebase-overlay-'),
    WE_DAEMON_OVERLAY_AUTO_REBASE: mode,
  };
  const merged = new Set();
  const prState = async (pr) => (merged.has(pr) ? 'MERGED' : 'OPEN');
  const logs = [];
  const smoke = vi.fn(async () => ({ verdict: 'pass', attempts: 1, smoke: { results: [{ name: 'reconcile-dry-run', ok: true, ms: 10 }] } }));
  const tick = () => rebuildClone({ root: clone, env, runSmoke: smoke, prState, log: { error: (m) => logs.push(m) } });
  const head = () => gitOk(clone, ['rev-parse', 'HEAD']).trim();
  const file = (f) => readFileSync(join(clone, f), 'utf8');
  const runGit = (args, opts = {}) => gitRun(args, { cwd: clone, env: { ...env, ...opts.env } });
  return { clone, env, init, push, mergePr, merged, prState, tick, head, file, logs, smoke, runGit };
}

/**
 * The PR's old head X1 is live on the clone (registered as its own overlay, PR #5758) and a container overlay is built ON
 * X1 plus its own change. Then the PR is rewritten (X2, lines 2-4 differently) and merged: the container now conflicts
 * with main exactly where it carries X1's older copy. `ownOnPrLines` makes the container ALSO edit inside that block.
 */
async function liveThenMerge(f, { ownOnPrLines = false, registerPr = true } = {}) {
  const x1 = f.push('lane/standing-ruling', f.init, { [GATE]: lines({ 2: 'grant v1', 3: 'scope v1', 4: 'read v1' }) });
  const own = { [GATE]: lines({ 2: 'grant v1', 3: ownOnPrLines ? 'scope v1 + container tweak' : 'scope v1', 4: 'read v1', 10: 'container own' }), 'container.txt': 'own\n' };
  const container = f.push('lane/container', x1, own);
  const u = f.push('lane/unrelated', f.init, { 'unrelated.txt': 'u\n' });
  if (registerPr) {
    // the clone runs the PR's head X1 as its own overlay first (its build records `merge overlay … (PR #5758)`)
    addOverlay(f.clone, { ref: 'lane/standing-ruling', pr: PR }, { env: f.env });
    expect(await f.tick()).toMatchObject({ adopted: true });
  }
  addOverlay(f.clone, { ref: 'lane/container', pr: 5801 }, { env: f.env });
  addOverlay(f.clone, { ref: 'lane/unrelated', pr: 5802 }, { env: f.env });
  const first = await f.tick();
  expect(first, JSON.stringify(first.alerts)).toMatchObject({ adopted: true });
  const live = f.head();
  // the PR is rewritten (force-push) and merged; its old head X1 is not on main
  const x2 = f.push('lane/standing-ruling', f.init, { [GATE]: lines({ 2: 'grant v2', 3: 'scope v2', 4: 'read v2' }) });
  const mainSha = f.mergePr(PR, x2, 'lane/standing-ruling');
  f.merged.add(PR);
  return { x1, x2, container, u, live, mainSha };
}

describe('overlay-rebase-on-merge — an overlay that conflicts with a NEW main never freezes the clone', () => {
  it('auto-rebases a container past the merged PR\'s old head it carries: main\'s side for that PR, every own change kept', async () => {
    const f = fixture({ mode: 'on' });
    const s = await liveThenMerge(f);
    const second = await f.tick();
    expect(second, JSON.stringify(second.alerts)).toMatchObject({ adopted: true });
    const kinds = second.alerts.map((a) => a.kind);
    expect(kinds).not.toContain('established-overlay-hold');
    expect(second.alerts.find((a) => a.kind === 'overlay-auto-rebased')?.detail).toMatchObject({
      ref: 'lane/container', pr: 5801, hunks: [GATE], mode: 'on', source: 'env',
      base: { sha: s.x1, pr: PR, evidence: 'adopted-head' },
    });
    expect(f.file(GATE)).toBe(lines({ 2: 'grant v2', 3: 'scope v2', 4: 'read v2', 10: 'container own' }));
    expect(f.file('container.txt')).toBe('own\n');
    expect(isAncestor(f.clone, s.container, f.head())).toBe(true);
    expect(isAncestor(f.clone, s.u, f.head())).toBe(true);
    expect(f.smoke).toHaveBeenCalledTimes(3); // the rebased build was smoked like any other
    // next tick: same inputs, up to date, the verdict not logged again
    const third = await f.tick();
    expect(third.reason).toBe('up-to-date');
    expect(f.logs.filter((m) => m.startsWith('daemon-rebuild: overlay-auto-rebased '))).toHaveLength(1);
  });

  it('replay of 14:57 ET (#5758): the container\'s conflict is its OWN change, unattributable → set aside, everything else adopts', async () => {
    const f = fixture({ mode: 'on' });
    const s = await liveThenMerge(f, { ownOnPrLines: true });
    const second = await f.tick();
    expect(second, JSON.stringify(second.alerts)).toMatchObject({ adopted: true });
    const kinds = second.alerts.map((a) => a.kind);
    expect(kinds).not.toContain('established-overlay-hold');
    expect(kinds).not.toContain('overlay-auto-rebased');
    expect(second.alerts.find((a) => a.kind === 'overlay-set-aside')?.detail).toMatchObject({
      ref: 'lane/container', pr: 5801, hunks: [GATE], live: true,
    });
    // main's PR content is in; the container is NOT (its own edit inside the PR's block is never resolved by picking a side)
    expect(f.file(GATE)).toBe(lines({ 2: 'grant v2', 3: 'scope v2', 4: 'read v2' }));
    expect(isAncestor(f.clone, s.container, f.head())).toBe(false);
    expect(isAncestor(f.clone, s.u, f.head())).toBe(true);
    expect(readRebuildState(f.clone, f.env).held ?? null).toBeNull();
    const third = await f.tick();
    expect(third.reason).toBe('up-to-date');
    expect(f.logs.filter((m) => m.startsWith('daemon-rebuild: overlay-set-aside '))).toHaveLength(1);
  });

  it('with no proof the container carries the merged PR (never registered here, no force-push read) it is set aside, not rebased', async () => {
    const f = fixture({ mode: 'on' });
    const s = await liveThenMerge(f, { registerPr: false });
    const second = await f.tick();
    expect(second, JSON.stringify(second.alerts)).toMatchObject({ adopted: true });
    expect(second.alerts.map((a) => a.kind)).toContain('overlay-set-aside');
    expect(isAncestor(f.clone, s.container, f.head())).toBe(false);
  });

  it('shadow (the standard): today\'s hold stands, and it logs what it WOULD do', async () => {
    const f = fixture({ mode: 'shadow' });
    const s = await liveThenMerge(f);
    const second = await f.tick();
    expect(second).toMatchObject({ moved: false, reason: 'established-overlay-conflict' });
    expect(f.head()).toBe(s.live);
    expect(second.alerts.find((a) => a.kind === 'overlay-auto-rebase-shadow')?.detail).toMatchObject({
      ref: 'lane/container', wouldDo: 'auto-rebase', mode: 'shadow', base: { sha: s.x1, pr: PR },
    });
  });

  it('off (kill switch): exactly today\'s behaviour, no auto-rebase alert of any kind', async () => {
    const f = fixture({ mode: 'off' });
    await liveThenMerge(f);
    const second = await f.tick();
    expect(second).toMatchObject({ moved: false, reason: 'established-overlay-conflict' });
    expect(second.alerts.map((a) => a.kind).filter((k) => /auto-rebase|set-aside/.test(k))).toEqual([]);
  });

  it('planRebuild: a GitHub force-push `before` of a merged PR is proof too (the clone never ran that head)', async () => {
    const f = fixture({ mode: 'on' });
    const x1 = f.push('lane/standing-ruling', f.init, { [GATE]: lines({ 2: 'grant v1' }) });
    const container = f.push('lane/container', x1, { 'container.txt': 'own\n', [GATE]: lines({ 2: 'grant v1', 10: 'own' }) });
    const x2 = f.push('lane/standing-ruling', f.init, { [GATE]: lines({ 2: 'grant v2' }) });
    const mainSha = f.mergePr(PR, x2, 'lane/standing-ruling');
    gitOk(f.clone, ['fetch', '-q', 'origin']);
    const plan = await planRebuild({
      git: f.runGit, headSha: f.init, mainRef: 'origin/main', overlays: [{ ref: 'lane/container', pr: 5801 }],
      prState: async (pr) => (pr === PR ? 'MERGED' : 'OPEN'), prForcePushes: async (pr) => (pr === PR ? [{ before: x1, after: x2 }] : []),
      autoRebase: { mode: 'on', source: 'test' },
    });
    expect(plan.ok).toBe(true);
    expect(plan.decisions[0]).toMatchObject({ ref: 'lane/container', action: 'apply', reason: 'applied-auto-rebased' });
    expect(plan.alerts.find((a) => a.kind === 'overlay-auto-rebased')?.detail.base).toMatchObject({ sha: x1, pr: PR, evidence: 'force-pushed' });
    expect(gitOk(f.clone, ['show', `${plan.finalSha}:${GATE}`])).toBe(lines({ 2: 'grant v2', 10: 'own' }));
    expect(isAncestor(f.clone, container, plan.finalSha)).toBe(true);
    expect(isAncestor(f.clone, mainSha, plan.finalSha)).toBe(true);
  });

  it('a fallback re-plan with the plan\'s autoRebaseCtx keeps the rebase (never silently back to off) — Codex audit', async () => {
    const f = fixture({ mode: 'on' });
    const x1 = f.push('lane/standing-ruling', f.init, { [GATE]: lines({ 2: 'grant v1' }) });
    f.push('lane/container', x1, { [GATE]: lines({ 2: 'grant v1', 10: 'own' }) });
    const x2 = f.push('lane/standing-ruling', f.init, { [GATE]: lines({ 2: 'grant v2' }) });
    f.mergePr(PR, x2, 'lane/standing-ruling');
    gitOk(f.clone, ['fetch', '-q', 'origin']);
    const overlays = [{ ref: 'lane/container', pr: 5801 }];
    const plan = await planRebuild({
      git: f.runGit, headSha: f.init, mainRef: 'origin/main', overlays, prState: async (pr) => (pr === PR ? 'MERGED' : 'OPEN'),
      prForcePushes: async (pr) => (pr === PR ? [{ before: x1 }] : []), autoRebase: { mode: 'on', source: 'test' },
    });
    expect(plan.autoRebaseCtx.adoptedHeads).toEqual([expect.objectContaining({ pr: PR, sha: x1, proven: true })]);
    // a smoke fallback has no prState / force-push reader: the ctx alone must reproduce the same rebased build
    const fallback = await planRebuild({ git: f.runGit, headSha: f.init, mainRef: 'origin/main', overlays, ...plan.autoRebaseCtx });
    expect(fallback.decisions[0]).toMatchObject({ action: 'apply', reason: 'applied-auto-rebased' });
    expect(fallback.finalSha).toBe(plan.finalSha);
  });

  it('a merged-PR head that merged ANOTHER branch in is never a base: its foreign content could be dropped — Codex audit', async () => {
    const f = fixture({ mode: 'on' });
    const hotfix = f.push('lane/hotfix', f.init, { 'hotfix.txt': 'live hotfix\n' });
    const x1 = f.push('lane/standing-ruling', f.init, { [GATE]: lines({ 2: 'grant v1' }) });
    gitOk(dirname(f.clone) + '/author', ['merge', '-q', '--no-edit', hotfix]); // the PR branch merges the hotfix branch
    gitOk(dirname(f.clone) + '/author', ['push', '-q', 'origin', '+HEAD:refs/heads/lane/standing-ruling']);
    const x1h = gitOk(dirname(f.clone) + '/author', ['rev-parse', 'HEAD']).trim();
    const container = f.push('lane/container', x1h, { [GATE]: lines({ 2: 'grant v1', 10: 'own' }) });
    const x2 = f.push('lane/standing-ruling', f.init, { [GATE]: lines({ 2: 'grant v2' }) }); // final PR: no hotfix
    f.mergePr(PR, x2, 'lane/standing-ruling');
    gitOk(f.clone, ['fetch', '-q', 'origin']);
    const plan = await planRebuild({
      git: f.runGit, headSha: f.init, mainRef: 'origin/main', overlays: [{ ref: 'lane/container', pr: 5801 }],
      prState: async (pr) => (pr === PR ? 'MERGED' : 'OPEN'), prForcePushes: async (pr) => (pr === PR ? [{ before: x1h }, { before: x1 }] : []),
      autoRebase: { mode: 'on', source: 'test' },
    });
    expect(plan.ok).toBe(true);
    // x1h is refused (it merged a foreign branch); x1 is a valid PR-own head, and with x1 as base the hotfix is the
    // container's own content after x1, so it is KEPT (with x1h as base it would have been dropped)
    expect(plan.decisions[0]).toMatchObject({ action: 'apply', reason: 'applied-auto-rebased' });
    expect(plan.alerts.find((a) => a.kind === 'overlay-auto-rebased')?.detail.base.sha).toBe(x1);
    expect(gitOk(f.clone, ['show', `${plan.finalSha}:hotfix.txt`])).toBe('live hotfix\n');
    expect(gitOk(f.clone, ['show', `${plan.finalSha}:${GATE}`])).toBe(lines({ 2: 'grant v2', 10: 'own' }));
    expect(isAncestor(f.clone, container, plan.finalSha)).toBe(true);
    expect(plan.alerts.find((a) => a.kind === 'overlay-auto-rebased')?.detail.base.sha).not.toBe(x1h);
  });

  it('another registered overlay\'s work linearly inside the PR head is never treated as the PR\'s — set aside (Codex round 2)', async () => {
    const f = fixture({ mode: 'on' });
    const foreign = f.push('lane/foreign', f.init, { 'foreign.txt': 'foreign behaviour\n' });
    const x1 = f.push('lane/standing-ruling', foreign, { [GATE]: lines({ 2: 'grant v1' }) }); // PR built ON the foreign overlay
    f.push('lane/container', x1, { [GATE]: lines({ 2: 'grant v1', 10: 'own' }) });
    const x2 = f.push('lane/standing-ruling', f.init, { [GATE]: lines({ 2: 'grant v2' }) }); // final PR without it
    f.mergePr(PR, x2, 'lane/standing-ruling');
    gitOk(f.clone, ['fetch', '-q', 'origin']);
    const plan = await planRebuild({
      git: f.runGit, headSha: f.init, mainRef: 'origin/main',
      overlays: [{ ref: 'lane/foreign', pr: 5790 }, { ref: 'lane/container', pr: 5801 }], stackMode: 'independent',
      prState: async (pr) => (pr === PR ? 'MERGED' : 'OPEN'), prForcePushes: async (pr) => (pr === PR ? [{ before: x1 }] : []),
      autoRebase: { mode: 'on', source: 'test' },
    });
    expect(plan.decisions.find((d) => d.ref === 'lane/container')).toMatchObject({ action: 'drop', reason: 'conflict' });
    expect(plan.alerts.map((a) => a.kind)).not.toContain('overlay-auto-rebased');
    expect(plan.alerts.find((a) => a.kind === 'overlay-set-aside')?.detail).toMatchObject({ ref: 'lane/container' });
    expect(plan.setAside).toEqual(['lane/container']);
    expect(gitOk(f.clone, ['show', `${plan.finalSha}:foreign.txt`])).toBe('foreign behaviour\n');
  });

  it('a force-push of a PR GitHub does not say is MERGED is no proof, whatever main\'s merge subjects claim (Codex round 2)', async () => {
    const f = fixture({ mode: 'on' });
    const x1 = f.push('lane/standing-ruling', f.init, { [GATE]: lines({ 2: 'grant v1' }) });
    f.push('lane/container', x1, { [GATE]: lines({ 2: 'grant v1', 10: 'own' }) });
    const x2 = f.push('lane/standing-ruling', f.init, { [GATE]: lines({ 2: 'grant v2' }) });
    f.mergePr(PR, x2, 'lane/standing-ruling'); // a merge commit NAMING the PR — but GitHub says it is still OPEN
    gitOk(f.clone, ['fetch', '-q', 'origin']);
    const plan = await planRebuild({
      git: f.runGit, headSha: f.init, mainRef: 'origin/main', overlays: [{ ref: 'lane/container', pr: 5801 }],
      prState: async () => 'OPEN', prForcePushes: async () => [{ before: x1 }], autoRebase: { mode: 'on', source: 'test' },
    });
    expect(plan.decisions[0]).toMatchObject({ action: 'drop', reason: 'conflict' });
    expect(plan.alerts.map((a) => a.kind)).toContain('overlay-set-aside');
  });

  it('a PR head that --no-ff merged a foreign branch onto a main-based parent is refused too (Codex round 3)', async () => {
    const f = fixture({ mode: 'on' });
    const author = `${dirname(f.clone)}/author`;
    const hotfix = f.push('lane/hotfix', f.init, { 'hotfix.txt': 'live hotfix\n' });
    gitOk(author, ['checkout', '-q', '-B', 'lane/standing-ruling', f.init]);
    gitOk(author, ['merge', '-q', '--no-ff', '-m', 'merge hotfix', hotfix]); // first parent is ON main, second is foreign
    const x1 = f.push('lane/standing-ruling', 'HEAD', { [GATE]: lines({ 2: 'grant v1' }) });
    f.push('lane/container', x1, { [GATE]: lines({ 2: 'grant v1', 10: 'own' }) });
    const x2 = f.push('lane/standing-ruling', f.init, { [GATE]: lines({ 2: 'grant v2' }) });
    f.mergePr(PR, x2, 'lane/standing-ruling');
    gitOk(f.clone, ['fetch', '-q', 'origin']);
    const plan = await planRebuild({
      git: f.runGit, headSha: f.init, mainRef: 'origin/main', overlays: [{ ref: 'lane/container', pr: 5801 }],
      prState: async (pr) => (pr === PR ? 'MERGED' : 'OPEN'), prForcePushes: async (pr) => (pr === PR ? [{ before: x1 }] : []),
      autoRebase: { mode: 'on', source: 'test' },
    });
    expect(plan.decisions[0]).toMatchObject({ action: 'drop', reason: 'conflict' });
    expect(plan.alerts.map((a) => a.kind)).not.toContain('overlay-auto-rebased');
    expect(plan.alerts.find((a) => a.kind === 'overlay-set-aside')?.detail).toMatchObject({ ref: 'lane/container' });
  });

  it('a remembered head git can no longer read counts as foreign: set aside, never rebased (fail closed, Codex round 4)', async () => {
    const f = fixture({ mode: 'on' });
    const x1 = f.push('lane/standing-ruling', f.init, { [GATE]: lines({ 2: 'grant v1' }) });
    f.push('lane/container', x1, { [GATE]: lines({ 2: 'grant v1', 10: 'own' }) });
    const x2 = f.push('lane/standing-ruling', f.init, { [GATE]: lines({ 2: 'grant v2' }) });
    f.mergePr(PR, x2, 'lane/standing-ruling');
    gitOk(f.clone, ['fetch', '-q', 'origin']);
    const base = {
      git: f.runGit, headSha: f.init, mainRef: 'origin/main', overlays: [{ ref: 'lane/container', pr: 5801 }],
      prState: async (pr) => (pr === PR ? 'MERGED' : 'OPEN'), prForcePushes: async (pr) => (pr === PR ? [{ before: x1 }] : []),
      autoRebase: { mode: 'on', source: 'test' },
    };
    expect((await planRebuild(base)).decisions[0]).toMatchObject({ reason: 'applied-auto-rebased' });
    const gone = await planRebuild({ ...base, adoptedHeads: [{ pr: 4242, sha: 'deadbeef'.repeat(5) }] });
    expect(gone.decisions[0]).toMatchObject({ action: 'drop', reason: 'conflict' });
    expect(gone.alerts.map((a) => a.kind)).toContain('overlay-set-aside');
  });
});
