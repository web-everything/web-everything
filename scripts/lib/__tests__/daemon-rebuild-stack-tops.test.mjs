/**
 * @file scripts/lib/__tests__/daemon-rebuild-stack-tops.test.mjs
 * @description Held item 212 — stacked overlay PRs are one stack, not independent overlays. Live 2026-10-10 on
 *   wev-fix-daemon: #4757 (lane/fixer-resume-ladder) is stacked on #4756 (lane/fixer-history-takeover), and #4792 /
 *   #4797 sit on a chain (#4779 → #4770 → #4759 → #4756) that carries #4757 too. #4756 was rebased (new head
 *   ae16d0c8b) and is the live one; its children still carry its OLD head. Every rebuild then parked #4792/#4797 as
 *   newcomers colliding with #4756 on fix-takeover.mjs / reconcile-core.mjs, so none of the stack's fixes went live.
 *   In `overlay.stackMode: tops` (the default) a rebuild applies only the stack tops; a base contained in a top is
 *   set aside (it is live through the top), and a base that MOVED away from its children is set aside too, keeping
 *   the children's tops until they are restacked. A PINNED base is never set aside, and an overlay already in main
 *   takes no part in a stack. These tests replay that shape through planRebuild and rebuildClone.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { planRebuild, rebuildClone } from '../daemon-rebuild.mjs';
import {
  addOverlay, resolveOverlayStackMode, OVERLAY_STACK_MODE_ENV, makePrBaseChain, persistStackBases, readOverlays, GH_TIMED_OUT,
} from '../daemon-overlays.mjs';
import { gitRun } from '../main-staleness.mjs';

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

const TAKEOVER = 'scripts/conveyor/fix-takeover.mjs';
const LADDER = 'scripts/conveyor/fixer-resume.mjs';
const lines = (over = {}) => `${Array.from({ length: 12 }, (_, i) => over[i + 1] ?? `line ${i + 1}`).join('\n')}\n`;

const BASE = 'lane/fixer-history-takeover'; // #4756
const LADDER_REF = 'lane/fixer-resume-ladder'; // #4757, PR base = #4756
const LAST = 'lane/last-takeover-review'; // #4792, PR base chain → #4779 → #4770 → #4759 → #4756
const RULING = 'lane/ruling-ends-dispute'; // #4797, same chain
/** The live PR base chains (nearest first), as gh reports them. */
const CHAINS = {
  4756: [],
  4757: [BASE],
  4792: ['lane/takeover-budget', 'lane/mechanical-round-cap', 'lane/takeover-review-attempt', BASE],
  4797: ['lane/takeover-budget', 'lane/mechanical-round-cap', 'lane/takeover-review-attempt', BASE],
};
const prBaseChain = async (pr) => CHAINS[pr] ?? null;
/** The live list order on wev-fix-daemon. */
const OVERLAYS = [
  { ref: BASE, pr: 4756 }, { ref: LAST, pr: 4792 }, { ref: RULING, pr: 4797 }, { ref: LADDER_REF, pr: 4757 },
];

/** `githubLike`: the origin path ends in github.com/o/r.git, so the real slug reader resolves `o/r` (no network involved). */
function fixture({ githubLike = false } = {}) {
  const base = mktemp('we-stack-tops-');
  const origin = githubLike ? join(base, 'github.com', 'o', 'r.git') : join(base, 'origin.git');
  const clone = join(base, 'clone');
  mkdirSync(dirname(origin), { recursive: true });
  gitOk(base, ['init', '--bare', '-q', origin]);
  mkdirSync(clone);
  gitOk(clone, ['init', '-q', '-b', 'main']);
  write(clone, TAKEOVER, lines());
  write(clone, LADDER, lines());
  gitOk(clone, ['add', '-A']);
  gitOk(clone, ['commit', '-q', '-m', 'init']);
  gitOk(clone, ['remote', 'add', 'origin', origin]);
  gitOk(clone, ['push', '-q', '-u', 'origin', 'main']);
  const author = join(base, 'author');
  gitOk(base, ['clone', '-q', origin, author]);
  const push = (ref, from, files) => {
    gitOk(author, ['fetch', '-q', 'origin']);
    gitOk(author, ['checkout', '-q', '-B', ref, from]);
    for (const [n, c] of Object.entries(files)) write(author, n, c);
    gitOk(author, ['add', '-A']);
    gitOk(author, ['commit', '-q', '-m', ref]);
    gitOk(author, ['push', '-q', '-f', 'origin', `HEAD:refs/heads/${ref}`]);
    return gitOk(author, ['rev-parse', 'HEAD']).trim();
  };
  const init = gitOk(clone, ['rev-parse', 'HEAD']).trim();
  // The stack as it was first built: #4756 → #4757 → (#4792, #4797).
  const bOld = push(BASE, init, { [TAKEOVER]: lines({ 2: 'history takeover v1' }) });
  const ladder = push(LADDER_REF, bOld, { [LADDER]: lines({ 3: 'resume ladder' }) });
  const last = push(LAST, ladder, { [TAKEOVER]: lines({ 2: 'history takeover v1', 6: 'last takeover review' }) });
  const ruling = push(RULING, ladder, { [TAKEOVER]: lines({ 2: 'history takeover v1', 10: 'ruling ends dispute' }) });
  /** #4756 is rebased: its new head rewrites the line its children carry in its OLD form. */
  const moveBase = () => push(BASE, init, { [TAKEOVER]: lines({ 2: 'history takeover v2 (restacked)' }) });
  gitOk(clone, ['fetch', '-q', 'origin']);
  const env = {
    ...process.env,
    WE_DAEMON_STATE_DIR: mktemp('we-stack-state-'),
    WE_DAEMON_CLONE_LOCK_ROOT: mktemp('we-stack-lock-'),
    WE_DAEMON_OVERLAY_DIR: mktemp('we-stack-overlay-'),
  };
  const runGit = (args, opts = {}) => gitRun(args, { cwd: clone, env: { ...env, ...opts.env } });
  const fetch = () => gitOk(clone, ['fetch', '-q', '-f', 'origin', '+refs/heads/*:refs/remotes/origin/*']);
  return { clone, author, env, init, bOld, ladder, last, ruling, moveBase, runGit, fetch, push };
}

const passSmoke = () => vi.fn(async () => ({ verdict: 'pass', attempts: 1, smoke: { results: [] } }));

describe('held item 212 — stacked overlays apply as stack tops', () => {
  it('live 2026-10-10: #4756 moved and is live; #4792/#4797/#4757 go live as tops, #4756 is set aside and logged', async () => {
    const f = fixture();
    const bNew = f.moveBase();
    f.fetch();
    // The running build carries #4756's NEW head only (as on wev-fix-daemon before the fix).
    const live = await planRebuild({ git: f.runGit, headSha: f.init, mainRef: 'origin/main', overlays: [{ ref: BASE, pr: 4756 }] });
    expect(live.applied.map((a) => a.ref)).toEqual([BASE]);

    const plan = await planRebuild({
      git: f.runGit, headSha: live.finalSha, mainRef: 'origin/main', overlays: OVERLAYS, prBaseChain, stackMode: 'tops',
    });
    expect(plan.ok).toBe(true);
    for (const sha of [f.last, f.ruling, f.ladder]) expect(isAncestor(f.clone, sha, plan.finalSha)).toBe(true);
    expect(isAncestor(f.clone, bNew, plan.finalSha)).toBe(false);
    expect(plan.applied.map((a) => a.ref).sort()).toEqual([LAST, RULING].sort());
    expect(plan.decisions.find((d) => d.ref === BASE)).toMatchObject({ action: 'skip', reason: 'stack-base-moved' });
    expect(plan.decisions.find((d) => d.ref === LADDER_REF)).toMatchObject({ action: 'skip', reason: 'stack-contained' });
    const kinds = plan.alerts.map((a) => a.kind);
    for (const k of ['overlay-newcomer-parked', 'established-overlay-dropped', 'overlay-conflict-unresolved']) expect(kinds).not.toContain(k);
    expect(plan.decisions.some((d) => d.action === 'drop' || d.action === 'remove')).toBe(false);
    const moved = plan.alerts.find((a) => a.kind === 'overlay-stack-base-moved');
    expect(moved?.detail.message).toBe('stack base moved: #4756 set aside, tops #4792 #4797 kept until restacked');
    const tops = plan.alerts.filter((a) => a.kind === 'overlay-stack-tops');
    expect(tops).toHaveLength(1);
    expect(tops[0].detail).toMatchObject({ mode: 'tops', tops: ['#4792', '#4797'] });
    expect(tops[0].detail.message).toMatch(/tops #4792 #4797/);
  });

  it('stackMode independent keeps the old behaviour: the children are parked against the live base', async () => {
    const f = fixture();
    f.moveBase();
    f.fetch();
    const live = await planRebuild({ git: f.runGit, headSha: f.init, mainRef: 'origin/main', overlays: [{ ref: BASE, pr: 4756 }] });
    const plan = await planRebuild({
      git: f.runGit, headSha: live.finalSha, mainRef: 'origin/main', overlays: OVERLAYS, prBaseChain, stackMode: 'independent',
    });
    expect(plan.applied.map((a) => a.ref)).toContain(BASE);
    expect(plan.decisions.find((d) => d.ref === LAST)).toMatchObject({ action: 'drop', reason: 'conflict' });
    expect(plan.alerts.map((a) => a.kind)).toContain('overlay-newcomer-parked');
    expect(plan.alerts.map((a) => a.kind)).not.toContain('overlay-stack-tops');
  });

  it('a base contained in a top is never removed as in-main, whatever the list order (ancestry alone, no gh)', async () => {
    const f = fixture();
    const childFirst = [{ ref: LAST, pr: 4792 }, { ref: LADDER_REF, pr: 4757 }, { ref: BASE, pr: 4756 }];
    const plan = await planRebuild({ git: f.runGit, headSha: f.init, mainRef: 'origin/main', overlays: childFirst });
    expect(plan.ok).toBe(true);
    expect(plan.applied.map((a) => a.ref)).toEqual([LAST]);
    expect(plan.decisions.find((d) => d.ref === BASE)).toMatchObject({ action: 'skip', reason: 'stack-contained' });
    expect(plan.decisions.find((d) => d.ref === LADDER_REF)).toMatchObject({ action: 'skip', reason: 'stack-contained' });
    expect(plan.decisions.some((d) => d.action === 'remove')).toBe(false);
    for (const sha of [f.bOld, f.ladder, f.last]) expect(isAncestor(f.clone, sha, plan.finalSha)).toBe(true);
  });

  it('a moved base comes back when none of its tops can apply (the stack never loses both)', async () => {
    const f = fixture();
    const bNew = f.moveBase();
    // main moves onto the line #4792 edits, so the only top conflicts with main
    gitOk(f.author, ['fetch', '-q', 'origin']);
    gitOk(f.author, ['checkout', '-q', '-B', 'main', 'origin/main']);
    write(f.author, TAKEOVER, lines({ 6: 'main moved' }));
    gitOk(f.author, ['commit', '-q', '-am', 'main']);
    gitOk(f.author, ['push', '-q', 'origin', 'HEAD:refs/heads/main']);
    f.fetch();
    const plan = await planRebuild({
      git: f.runGit, headSha: null, mainRef: 'origin/main', overlays: [{ ref: BASE, pr: 4756 }, { ref: LAST, pr: 4792 }], prBaseChain,
    });
    expect(plan.decisions.find((d) => d.ref === LAST)).toMatchObject({ action: 'drop', reason: 'conflict' });
    expect(plan.decisions.find((d) => d.ref === BASE)).toMatchObject({ action: 'apply', reason: 'applied-stack-fallback' });
    expect(isAncestor(f.clone, bNew, plan.finalSha)).toBe(true);
  });

  it('rebuildClone adopts the stack tops end to end (base chains recorded on the entries, no gh) and logs the one stack line', async () => {
    const f = fixture();
    f.moveBase();
    f.fetch();
    for (const o of OVERLAYS) addOverlay(f.clone, { ...o, stackBases: CHAINS[o.pr] }, { env: f.env });
    const logs = [];
    const r = await rebuildClone({
      root: f.clone, env: f.env, runSmoke: passSmoke(), prState: async () => 'OPEN', log: { error: (m) => logs.push(m) },
    });
    expect(r, JSON.stringify(r.alerts)).toMatchObject({ adopted: true });
    const head = gitOk(f.clone, ['rev-parse', 'HEAD']).trim();
    for (const sha of [f.last, f.ruling, f.ladder]) expect(isAncestor(f.clone, sha, head)).toBe(true);
    expect(logs.filter((m) => m.includes('overlay-stack-tops'))).toHaveLength(1);
    expect(logs.some((m) => m.includes('stack base moved: #4756 set aside, tops #4792 #4797 kept until restacked'))).toBe(true);
  });
});

describe('overlay.stackMode cascade', () => {
  it('defaults to tops (standard) and an env override wins, with its source named', () => {
    const empty = mktemp('we-stack-settings-');
    const settingsPath = join(empty, 'none.json');
    expect(resolveOverlayStackMode({}, { settingsPath })).toMatchObject({ mode: 'tops', source: 'standard' });
    expect(resolveOverlayStackMode({ [OVERLAY_STACK_MODE_ENV]: 'independent' }, { settingsPath }))
      .toMatchObject({ mode: 'independent', source: 'env' });
    write(empty, 'tool.json', JSON.stringify({ overlay: { stackMode: 'independent' } }));
    expect(resolveOverlayStackMode({}, { settingsPath: join(empty, 'tool.json') })).toMatchObject({ mode: 'independent', source: 'tool' });
    expect(resolveOverlayStackMode({ [OVERLAY_STACK_MODE_ENV]: 'bogus' }, { settingsPath })).toMatchObject({ mode: 'tops' });
  });
});

describe('held item 212 review round 1 — landed overlays and pinned bases', () => {
  const MECH = 'scripts/lib/daemon-overlays.mjs';
  const advanceMain = (f, sha) => { gitOk(f.author, ['push', '-q', '-f', 'origin', `${sha}:refs/heads/main`]); f.fetch(); };

  it('a base already in main is removed as in-main even when a newer overlay branched from main contains it', async () => {
    const f = fixture();
    const landed = f.push('lane/landed-a', f.init, { [LADDER]: lines({ 4: 'landed a' }) });
    advanceMain(f, landed); // A reached main by ancestry (fast-forward / merge commit); gh says nothing (pr null)
    f.push('lane/after-c', landed, { [TAKEOVER]: lines({ 8: 'c after a' }) });
    f.fetch();
    const plan = await planRebuild({
      git: f.runGit, headSha: null, mainRef: 'origin/main', overlays: [{ ref: 'lane/landed-a' }, { ref: 'lane/after-c' }],
    });
    expect(plan.ok).toBe(true);
    expect(plan.decisions.find((d) => d.ref === 'lane/landed-a')).toMatchObject({ action: 'remove', reason: 'in-main' });
    expect(plan.decisions.find((d) => d.ref === 'lane/after-c')).toMatchObject({ action: 'apply' });
    expect(plan.alerts.map((a) => a.kind)).not.toContain('overlay-stack-tops');
  });

  it('an explicitly pinned base contained in a top that conflicts with main refuses the rebuild (never built without it)', async () => {
    const f = fixture();
    const p = f.push('lane/pinned-base', f.init, { [TAKEOVER]: lines({ 2: 'pinned base' }) });
    f.push('lane/pinned-top', p, { [LADDER]: lines({ 3: 'top' }) });
    gitOk(f.author, ['fetch', '-q', 'origin']);
    gitOk(f.author, ['checkout', '-q', '-B', 'main', 'origin/main']);
    write(f.author, TAKEOVER, lines({ 2: 'main moved onto the same line' }));
    gitOk(f.author, ['commit', '-q', '-am', 'main']);
    gitOk(f.author, ['push', '-q', 'origin', 'HEAD:refs/heads/main']);
    f.fetch();
    const plan = await planRebuild({
      git: f.runGit, headSha: null, mainRef: 'origin/main', overlays: [{ ref: 'lane/pinned-base', pinned: true }, { ref: 'lane/pinned-top' }],
    });
    expect(plan).toMatchObject({ ok: false, reason: 'pinned-overlay-conflict', detail: { ref: 'lane/pinned-base', pinnedBy: 'flag' } });
  });

  it('an explicitly pinned MOVED base stays an independent overlay (never stack-base-moved)', async () => {
    const f = fixture();
    f.moveBase();
    f.fetch();
    const plan = await planRebuild({
      git: f.runGit, headSha: null, mainRef: 'origin/main', prBaseChain,
      overlays: [{ ref: BASE, pr: 4756, pinned: true }, { ref: LAST, pr: 4792 }],
    });
    expect(plan.decisions.find((d) => d.ref === BASE)).toMatchObject({ action: 'apply' });
    expect(plan.decisions.find((d) => d.ref === BASE).reason).not.toBe('stack-base-moved');
    expect(plan.alerts.map((a) => a.kind)).not.toContain('overlay-stack-base-moved');
  });

  it('a mechanism-pinned MOVED base stays an independent overlay', async () => {
    const f = fixture();
    const old = f.push('lane/mech-base', f.init, { [MECH]: lines({ 2: 'mech v1' }) });
    f.push('lane/mech-top', old, { [LADDER]: lines({ 3: 'mech top' }) });
    f.push('lane/mech-base', f.init, { [MECH]: lines({ 2: 'mech v2' }) }); // rebased: the top keeps the OLD head
    f.fetch();
    const plan = await planRebuild({
      git: f.runGit, headSha: null, mainRef: 'origin/main', prBaseChain: async (pr) => (pr === 9002 ? ['lane/mech-base'] : []),
      overlays: [{ ref: 'lane/mech-base', pr: 9001 }, { ref: 'lane/mech-top', pr: 9002 }],
    });
    // The base is NOT set aside: it applies on its own, and the top (which carries the base's OLD mechanism change,
    // so it is mechanism-pinned too) conflicts with it. In this fixture main lacks the mechanism files, so the pin
    // refuses the build (with them in main the top would be conflict-skipped with an alert) — never dropped silently.
    expect(plan.alerts?.map((a) => a.kind) ?? []).not.toContain('overlay-stack-base-moved');
    expect(plan).toMatchObject({ ok: false, reason: 'pinned-overlay-conflict', detail: { ref: 'lane/mech-top', pinnedBy: 'mechanism' } });
  });

  it('a mechanism-pinned base contained in a top stays an independent overlay too', async () => {
    const f = fixture();
    const p = f.push('lane/mech-base', f.init, { [MECH]: lines({ 2: 'mech v1' }) });
    f.push('lane/mech-top', p, { [LADDER]: lines({ 3: 'mech top' }) });
    f.fetch();
    const plan = await planRebuild({
      git: f.runGit, headSha: null, mainRef: 'origin/main', overlays: [{ ref: 'lane/mech-base' }, { ref: 'lane/mech-top' }],
    });
    expect(plan.ok).toBe(true);
    expect(plan.decisions.find((d) => d.ref === 'lane/mech-base')).toMatchObject({ action: 'apply' });
    expect(plan.decisions.find((d) => d.ref === 'lane/mech-base').reason).not.toBe('stack-contained');
  });

  it.each([
    ['flag', { pinned: true }, 'lane/pin-base-flag', { [LADDER]: lines({ 3: 'flag base' }) }],
    ['mechanism', {}, 'lane/pin-base-mech', { [MECH]: lines({ 2: 'mech base' }) }],
  ])('a %s-pinned base listed AFTER the top that contains it is skipped, never removed as in-main', async (_k, flag, baseRef, files) => {
    const f = fixture();
    const p = f.push(baseRef, f.init, files);
    f.push('lane/pin-top', p, { [TAKEOVER]: lines({ 8: 'top' }) });
    f.fetch();
    const plan = await planRebuild({
      git: f.runGit, headSha: null, mainRef: 'origin/main', overlays: [{ ref: 'lane/pin-top' }, { ref: baseRef, ...flag }],
    });
    expect(plan.ok).toBe(true);
    expect(plan.decisions.find((d) => d.ref === 'lane/pin-top')).toMatchObject({ action: 'apply' });
    expect(plan.decisions.find((d) => d.ref === baseRef)).toMatchObject({ action: 'skip', reason: 'pinned-contained-in-applied' });
    expect(plan.decisions.some((d) => d.action === 'remove')).toBe(false);
  });

  it('a pinned REBASED base listed after the top that carries its old head is skipped, never removed as in-main (list order cannot deregister it)', async () => {
    const f = fixture();
    const old = f.push('lane/rb-old', f.init, { [LADDER]: lines({ 3: 'rebased base' }) });
    f.push('lane/rb-top', old, { [TAKEOVER]: lines({ 8: 'top' }) });
    f.push('lane/rb-base', f.init, { [LADDER]: lines({ 3: 'rebased base' }) }); // same content, new head: not an ancestor of the top
    f.fetch();
    const plan = await planRebuild({
      git: f.runGit, headSha: null, mainRef: 'origin/main', prBaseChain: async (pr) => (pr === 9102 ? ['lane/rb-base'] : []),
      overlays: [{ ref: 'lane/rb-top', pr: 9102 }, { ref: 'lane/rb-base', pr: 9101, pinned: true }],
    });
    expect(plan.ok).toBe(true);
    expect(plan.decisions.find((d) => d.ref === 'lane/rb-top')).toMatchObject({ action: 'apply' });
    expect(plan.decisions.find((d) => d.ref === 'lane/rb-base')).toMatchObject({ action: 'skip', reason: 'pinned-contained-in-applied' });
    expect(plan.decisions.some((d) => d.action === 'remove')).toBe(false);
  });

  it('a pinned base whose content main already has (squash-merged) is still removed as in-main', async () => {
    const f = fixture();
    f.push('lane/sq-base', f.init, { [LADDER]: lines({ 3: 'squashed' }) });
    const m = f.push('lane/sq-main', f.init, { [LADDER]: lines({ 3: 'squashed' }) });
    gitOk(f.author, ['push', '-q', '-f', 'origin', `${m}:refs/heads/main`]);
    f.fetch();
    const plan = await planRebuild({
      git: f.runGit, headSha: null, mainRef: 'origin/main', overlays: [{ ref: 'lane/sq-base', pinned: true }],
    });
    expect(plan.ok).toBe(true);
    expect(plan.decisions.find((d) => d.ref === 'lane/sq-base')).toMatchObject({ action: 'remove', reason: 'in-main' });
  });

  it('addOverlay records only safe branch names as stackBases', async () => {
    const f = fixture();
    const { readOverlays } = await import('../daemon-overlays.mjs');
    addOverlay(f.clone, { ref: LAST, pr: 4792, stackBases: ['lane/ok-base', '../escape', '--upload-pack=x', 'has space', ''] }, { env: f.env });
    expect(readOverlays(f.clone, { env: f.env }).find((o) => o.ref === LAST).stackBases).toEqual(['lane/ok-base']);
  });
});

describe('held item 212 review round 2 — stack fallback, claim confirmation, gh budget, stackBases writer', () => {
  const mainMoves = (f, over) => {
    gitOk(f.author, ['fetch', '-q', 'origin']);
    gitOk(f.author, ['checkout', '-q', '-B', 'main', 'origin/main']);
    write(f.author, TAKEOVER, lines(over));
    gitOk(f.author, ['commit', '-q', '-am', 'main']);
    gitOk(f.author, ['push', '-q', 'origin', 'HEAD:refs/heads/main']);
  };

  it('a live moved base survives a newcomer that blocks the fallback while every top fails (never silently lost)', async () => {
    const f = fixture();
    const bNew = f.moveBase();
    f.fetch();
    const live = await planRebuild({ git: f.runGit, headSha: f.init, mainRef: 'origin/main', overlays: [{ ref: BASE, pr: 4756 }] });
    mainMoves(f, { 6: 'main moved' }); // the only top (#4792) now conflicts with main
    f.push('lane/newcomer', f.init, { [TAKEOVER]: lines({ 2: 'newcomer edit' }) }); // clashes with the live base, not with main
    f.fetch();
    const plan = await planRebuild({
      git: f.runGit, headSha: live.finalSha, mainRef: 'origin/main', prBaseChain,
      overlays: [{ ref: BASE, pr: 4756 }, { ref: LAST, pr: 4792 }, { ref: 'lane/newcomer', pr: 9301 }],
    });
    expect(plan.ok).toBe(true);
    expect(plan.decisions.find((d) => d.ref === BASE)).toMatchObject({ action: 'apply' });
    expect(plan.decisions.find((d) => d.ref === 'lane/newcomer')).toMatchObject({ action: 'drop', reason: 'conflict' });
    expect(plan.decisions.some((d) => String(d.reason).startsWith('stack-'))).toBe(false);
    expect(plan.alerts.map((a) => a.kind)).toContain('overlay-newcomer-parked');
    expect(plan.alerts.map((a) => a.kind)).toContain('overlay-stack-base-restored');
    expect(isAncestor(f.clone, bNew, plan.finalSha)).toBe(true);
  });

  it('a PR base chain naming an unrelated overlay does not set that overlay aside (no shared history)', async () => {
    const f = fixture();
    f.push('lane/unrelated', f.init, { [TAKEOVER]: lines({ 9: 'unrelated' }) });
    f.push('lane/claimer', f.init, { [LADDER]: lines({ 9: 'claimer' }) });
    f.fetch();
    const plan = await planRebuild({
      git: f.runGit, headSha: null, mainRef: 'origin/main', prBaseChain: async (pr) => (pr === 9202 ? ['lane/unrelated'] : []),
      overlays: [{ ref: 'lane/unrelated', pr: 9201 }, { ref: 'lane/claimer', pr: 9202 }],
    });
    expect(plan.ok).toBe(true);
    expect(plan.decisions.map((d) => [d.ref, d.action])).toEqual([['lane/unrelated', 'apply'], ['lane/claimer', 'apply']]);
    expect(plan.alerts.map((a) => a.kind)).not.toContain('overlay-stack-tops');
    expect(plan.alerts.map((a) => a.kind)).toContain('overlay-stack-claim-unconfirmed');
  });

  it('an unconfirmed chain claim that also clashes with the named overlay still leaves that overlay live (the claimer is parked)', async () => {
    const f = fixture();
    f.push('lane/unrelated', f.init, { [TAKEOVER]: lines({ 9: 'unrelated' }) });
    f.push('lane/claimer', f.init, { [TAKEOVER]: lines({ 9: 'claimer wants the same line' }) });
    f.fetch();
    const plan = await planRebuild({
      git: f.runGit, headSha: null, mainRef: 'origin/main', prBaseChain: async (pr) => (pr === 9202 ? ['lane/unrelated'] : []),
      overlays: [{ ref: 'lane/unrelated', pr: 9201 }, { ref: 'lane/claimer', pr: 9202 }],
    });
    expect(plan.decisions.find((d) => d.ref === 'lane/unrelated')).toMatchObject({ action: 'apply' });
    expect(plan.decisions.find((d) => d.ref === 'lane/claimer')).toMatchObject({ action: 'drop', reason: 'conflict' });
  });

  it('a moved base that merges cleanly with its top stays an independent overlay (nothing to set aside)', async () => {
    const f = fixture();
    const old = f.push('lane/cm-base', f.init, { [LADDER]: lines({ 4: 'v1' }) });
    f.push('lane/cm-top', old, { [TAKEOVER]: lines({ 7: 'top' }) });
    f.push('lane/cm-base', f.init, { [LADDER]: lines({ 9: 'v2' }) }); // rebased far from the top's lines
    f.fetch();
    const plan = await planRebuild({
      git: f.runGit, headSha: null, mainRef: 'origin/main', prBaseChain: async (pr) => (pr === 9402 ? ['lane/cm-base'] : []),
      overlays: [{ ref: 'lane/cm-base', pr: 9401 }, { ref: 'lane/cm-top', pr: 9402 }],
    });
    expect(plan.ok).toBe(true);
    expect(plan.decisions.find((d) => d.ref === 'lane/cm-base')).toMatchObject({ action: 'apply' });
    expect(plan.decisions.find((d) => d.ref === 'lane/cm-top')).toMatchObject({ action: 'apply' });
    expect(plan.alerts.map((a) => a.kind)).not.toContain('overlay-stack-base-moved');
  });

  describe('chain claim evidence', () => {
    /** The base is rebased with a REWORDED subject and a clashing line: author+subject and patch evidence are both gone. */
    const rewordedBase = () => {
      const f = fixture();
      gitOk(f.author, ['fetch', '-q', 'origin']);
      gitOk(f.author, ['checkout', '-q', '-B', BASE, f.init]);
      write(f.author, TAKEOVER, lines({ 2: 'history takeover v2 (restacked)' }));
      gitOk(f.author, ['commit', '-q', '-am', 'a completely different subject']);
      gitOk(f.author, ['push', '-q', '-f', 'origin', `HEAD:refs/heads/${BASE}`]);
      f.fetch();
      return f;
    };

    it('a reworded, conflict-resolved rebase leaves a bare chain claim unconfirmed (the top stays parked, loudly)', async () => {
      const f = rewordedBase();
      const plan = await planRebuild({
        git: f.runGit, headSha: null, mainRef: 'origin/main', prBaseChain,
        overlays: [{ ref: BASE, pr: 4756 }, { ref: LAST, pr: 4792 }],
      });
      expect(plan.decisions.find((d) => d.ref === BASE)).toMatchObject({ action: 'apply' });
      expect(plan.alerts.map((a) => a.kind)).toContain('overlay-stack-claim-unconfirmed');
    });

    it('…but a chain recorded on the entry by an earlier rebuild still identifies the stack after that rebase', async () => {
      const f = rewordedBase();
      const plan = await planRebuild({
        git: f.runGit, headSha: null, mainRef: 'origin/main', prBaseChain,
        overlays: [{ ref: BASE, pr: 4756 }, { ref: LAST, pr: 4792, stackBases: CHAINS[4792] }],
      });
      expect(plan.decisions.find((d) => d.ref === BASE)).toMatchObject({ action: 'skip', reason: 'stack-base-moved' });
      expect(plan.decisions.find((d) => d.ref === LAST)).toMatchObject({ action: 'apply' });
      expect(plan.alerts.map((a) => a.kind)).not.toContain('overlay-stack-claim-unconfirmed');
    });

    it('a patch-equivalent commit confirms the claim even when the subject was reworded', async () => {
      const f = fixture();
      gitOk(f.author, ['fetch', '-q', 'origin']);
      gitOk(f.author, ['checkout', '-q', '-B', BASE, f.init]);
      write(f.author, TAKEOVER, lines({ 2: 'history takeover v1' })); // the very change the children carry
      gitOk(f.author, ['commit', '-q', '-am', 'same change, other words']);
      gitOk(f.author, ['push', '-q', '-f', 'origin', `HEAD:refs/heads/${BASE}`]);
      f.fetch();
      const plan = await planRebuild({
        git: f.runGit, headSha: null, mainRef: 'origin/main', prBaseChain,
        overlays: [{ ref: BASE, pr: 4756 }, { ref: LAST, pr: 4792 }],
      });
      expect(plan.alerts.map((a) => a.kind)).not.toContain('overlay-stack-claim-unconfirmed');
    });
  });

  describe('makePrBaseChain gh budget', () => {
    const SLUG = 'o/r';

    it('ignores cross-repository (fork) PRs that merely share the head branch name', async () => {
      const gh = (args) => {
        if (args[1] === 'view') return { baseRefName: 'lane/b' };
        expect(args).toContain('baseRefName,isCrossRepository');
        return [{ baseRefName: 'lane/forged', isCrossRepository: true }, { baseRefName: 'main', isCrossRepository: false }];
      };
      const chain = makePrBaseChain({ root: '/nonexistent', overlays: [], gh, slug: SLUG });
      expect(await chain(1)).toEqual(['lane/b']);
      const onlyFork = makePrBaseChain({ root: '/nonexistent', overlays: [], slug: SLUG, gh: (args) => (args[1] === 'view' ? { baseRefName: 'lane/b' } : [{ baseRefName: 'lane/forged', isCrossRepository: true }]) });
      expect(await onlyFork(1)).toEqual(['lane/b']);
    });

    it('a walk cut short (depth limit, cycle, unsafe name) is returned but never recorded as complete', async () => {
      const cyc = (args) => (args[1] === 'view' ? { baseRefName: 'lane/a' } : [{ baseRefName: args.includes('lane/a') ? 'lane/b' : 'lane/a' }]);
      const loop = makePrBaseChain({ root: '/nonexistent', overlays: [], gh: cyc, slug: SLUG });
      expect(await loop(1)).toEqual(['lane/a', 'lane/b']);
      const shallow = makePrBaseChain({ root: '/nonexistent', overlays: [], gh: cyc, slug: SLUG, maxDepth: 1 });
      expect(await shallow(1)).toEqual(['lane/a']);
      const evil = makePrBaseChain({ root: '/nonexistent', overlays: [], slug: SLUG, gh: () => ({ baseRefName: '--upload-pack=x' }) });
      expect(await evil(1)).toEqual([]);
      for (const c of [loop, shallow, evil]) expect(c.fresh.size).toBe(0);
    });
    it('a gh that always times out costs one call in total, then every PR falls back to its recorded chain', async () => {
      const calls = [];
      const gh = (args) => { calls.push(args); return GH_TIMED_OUT; };
      const overlays = [1, 2, 3, 4, 5, 6].map((pr) => ({ ref: `lane/p${pr}`, pr, ...(pr === 3 ? { stackBases: ['lane/b', 'lane/a'] } : {}) }));
      const chain = makePrBaseChain({ root: '/nonexistent', overlays, gh, slug: SLUG });
      const out = [];
      for (const o of overlays) out.push(await chain(o.pr));
      expect(calls).toHaveLength(1);
      expect(out[2]).toEqual(['lane/b', 'lane/a']);
      expect(out.filter((_, i) => i !== 2).every((c) => c === null)).toBe(true);
      expect(chain.fresh.size).toBe(0);
    });

    it('a timeout part-way through a chain returns the recorded chain, never the partial walk', async () => {
      const gh = (args) => (args[1] === 'view' ? { baseRefName: 'lane/b' } : GH_TIMED_OUT);
      const chain = makePrBaseChain({ root: '/nonexistent', overlays: [{ ref: 'lane/c', pr: 1, stackBases: ['lane/b', 'lane/a'] }], gh, slug: SLUG });
      expect(await chain(1)).toEqual(['lane/b', 'lane/a']);
      expect(chain.fresh.size).toBe(0);
    });

    it('a total time budget stops further gh calls', async () => {
      let t = 0;
      let n = 0;
      const gh = () => { n += 1; t += 40_000; return { baseRefName: 'main' }; };
      const chain = makePrBaseChain({ root: '/nonexistent', overlays: [], gh, slug: SLUG, budgetMs: 60_000, now: () => t });
      for (const pr of [1, 2, 3, 4, 5]) await chain(pr);
      expect(n).toBe(2);
      expect([...chain.fresh.keys()]).toEqual([1, 2]);
    });

    it('chains gh answered completely are exposed as fresh; an unanswered intermediate lookup is not', async () => {
      const gh = (args) => {
        if (args[1] === 'view') return { baseRefName: args[2] === '1' ? 'lane/b' : 'lane/x' };
        return args.includes('lane/b') ? [{ baseRefName: 'main' }] : undefined; // lane/x's lookup fails
      };
      const chain = makePrBaseChain({ root: '/nonexistent', overlays: [{ ref: 'lane/q', pr: 2, stackBases: ['lane/rec'] }], gh, slug: SLUG });
      expect(await chain(1)).toEqual(['lane/b']);
      expect(await chain(2)).toEqual(['lane/rec']);
      expect([...chain.fresh.entries()]).toEqual([[1, ['lane/b']]]);
    });
  });

  describe('stackBases writer', () => {
    it('persistStackBases records only changed chains, keeps pr/reason, skips a vanished entry and unsafe names', async () => {
      const f = fixture();
      addOverlay(f.clone, { ref: LAST, pr: 4792, reason: 'keep me' }, { env: f.env });
      addOverlay(f.clone, { ref: RULING, pr: 4797, reason: 'other' }, { env: f.env });
      const read = (ref) => readOverlays(f.clone, { env: f.env }).find((o) => o.ref === ref);
      const fresh = new Map([[4792, ['lane/a', '--evil']], [4797, []], [9999, ['lane/gone']]]);
      expect(persistStackBases(f.clone, fresh, { env: f.env })).toEqual({ written: 1 });
      expect(read(LAST)).toMatchObject({ pr: 4792, reason: 'keep me', stackBases: ['lane/a'] });
      expect(read(RULING)).not.toHaveProperty('stackBases');
      expect(persistStackBases(f.clone, fresh, { env: f.env })).toEqual({ written: 0 });
      expect(persistStackBases(f.clone, new Map([[4792, []]]), { env: f.env })).toEqual({ written: 1 });
      expect(read(LAST)).not.toHaveProperty('stackBases');
    });

    it('a real rebuild records the chains gh answered; a later gh-less pass still sees the stack through them', async () => {
      const f = fixture({ githubLike: true });
      f.moveBase();
      f.fetch();
      for (const o of OVERLAYS) addOverlay(f.clone, { ...o, reason: 'stack' }, { env: f.env });
      const bin = mktemp('we-fake-gh-');
      const map = join(bin, 'map.json');
      const HEAD_BASE = {
        'lane/takeover-budget': 'lane/mechanical-round-cap', 'lane/mechanical-round-cap': 'lane/takeover-review-attempt',
        'lane/takeover-review-attempt': BASE, [BASE]: 'main',
      };
      write(bin, 'map.json', JSON.stringify({ prBase: { 4756: 'main', 4757: BASE, 4792: 'lane/takeover-budget', 4797: 'lane/takeover-budget' }, headBase: HEAD_BASE }));
      write(bin, 'gh', [
        '#!/usr/bin/env node', "const m = JSON.parse(require('fs').readFileSync(process.env.FAKE_GH_JSON, 'utf8'));",
        'const a = process.argv.slice(2);',
        "if (a[1] === 'view') { const b = m.prBase[a[2]]; if (!b) process.exit(1); console.log(JSON.stringify({ baseRefName: b })); }",
        "else { const b = m.headBase[a[a.indexOf('--head') + 1]]; console.log(JSON.stringify(b ? [{ baseRefName: b }] : [])); }", '',
      ].join('\n'));
      chmodSync(join(bin, 'gh'), 0o755);
      const env = { ...f.env, PATH: `${bin}:${process.env.PATH}`, FAKE_GH_JSON: map };
      const r = await rebuildClone({ root: f.clone, env, runSmoke: passSmoke(), prState: async () => 'OPEN', log: { error: () => {} } });
      expect(r, JSON.stringify(r.alerts)).toMatchObject({ adopted: true });
      const stored = readOverlays(f.clone, { env: f.env });
      expect(stored.find((o) => o.ref === LAST)).toMatchObject({ pr: 4792, reason: 'stack', stackBases: CHAINS[4792] });
      expect(stored.find((o) => o.ref === LADDER_REF).stackBases).toEqual([BASE]);
      expect(stored.find((o) => o.ref === BASE)).not.toHaveProperty('stackBases');
      // gh gone: the recorded chains alone still describe the stack.
      const chain = makePrBaseChain({ root: f.clone, overlays: stored, gh: () => GH_TIMED_OUT, slug: 'o/r' });
      expect(await chain(4797)).toEqual(CHAINS[4797]);
    }, 30_000);
  });
});

describe('held item 212 red team — shared prerequisites are not evidence of a stack', () => {
  const siblingsPlan = (f, chains) => planRebuild({
    git: f.runGit, headSha: null, mainRef: 'origin/main', prBaseChain: async (pr) => chains[pr] ?? [],
    overlays: [{ ref: 'lane/p', pr: 9501 }, { ref: 'lane/c', pr: 9502 }],
  });

  it('siblings on one unmerged prerequisite: a retargeted claim does not evict the live sibling (the claimer is parked)', async () => {
    const f = fixture();
    const h = f.push('lane/h', f.init, { [LADDER]: lines({ 5: 'prerequisite' }) });
    f.push('lane/p', h, { [TAKEOVER]: lines({ 2: 'p edit' }) });
    f.push('lane/c', h, { [TAKEOVER]: lines({ 2: 'c edit' }) });
    f.fetch();
    const plan = await siblingsPlan(f, { 9502: ['lane/p'] });
    expect(plan.decisions.find((d) => d.ref === 'lane/p')).toMatchObject({ action: 'apply' });
    expect(plan.decisions.find((d) => d.ref === 'lane/c')).toMatchObject({ action: 'drop', reason: 'conflict' });
    expect(plan.alerts.map((a) => a.kind)).toContain('overlay-stack-claim-unconfirmed');
  });

  it('…nor when each sibling carries its own copy of the prerequisite and P names its branch as its PR base', async () => {
    const f = fixture();
    const h = f.push('lane/h', f.init, { [LADDER]: lines({ 5: 'prerequisite' }) });
    f.push('lane/c', h, { [TAKEOVER]: lines({ 2: 'c edit' }) });
    const h2 = f.push('lane/h', f.init, { [LADDER]: lines({ 5: 'prerequisite', 11: 'restacked' }) }); // same subject, new patch
    f.push('lane/p', h2, { [TAKEOVER]: lines({ 2: 'p edit' }) });
    f.fetch();
    const plan = await siblingsPlan(f, { 9501: ['lane/h'], 9502: ['lane/p', 'lane/h'] });
    expect(plan.decisions.find((d) => d.ref === 'lane/p')).toMatchObject({ action: 'apply' });
    expect(plan.decisions.find((d) => d.ref === 'lane/c')).toMatchObject({ action: 'drop', reason: 'conflict' });
    expect(plan.alerts.map((a) => a.kind)).toContain('overlay-stack-claim-unconfirmed');
  });

  it('…nor when the prerequisite branch moved again after P was built on an older copy of it', async () => {
    const f = fixture();
    const h = f.push('lane/h', f.init, { [LADDER]: lines({ 5: 'prerequisite' }) });
    f.push('lane/c', h, { [TAKEOVER]: lines({ 2: 'c edit' }) });
    const h1 = f.push('lane/h', f.init, { [LADDER]: lines({ 5: 'prerequisite', 11: 'restacked' }) });
    f.push('lane/p', h1, { [TAKEOVER]: lines({ 2: 'p edit' }) });
    f.push('lane/h', f.init, { [LADDER]: lines({ 5: 'prerequisite', 12: 'restacked again' }) }); // H2: P's copy is no tip
    f.fetch();
    const plan = await siblingsPlan(f, { 9501: ['lane/h'], 9502: ['lane/p', 'lane/h'] });
    expect(plan.decisions.find((d) => d.ref === 'lane/p')).toMatchObject({ action: 'apply' });
    expect(plan.decisions.find((d) => d.ref === 'lane/c')).toMatchObject({ action: 'drop', reason: 'conflict' });
    expect(plan.alerts.map((a) => a.kind)).toContain('overlay-stack-claim-unconfirmed');
  });

  it('…nor when both siblings cherry-picked the same registered hotfix', async () => {
    const f = fixture();
    const HOTFIX = 'scripts/ci-hotfix.mjs';
    f.push('lane/x', f.init, { [HOTFIX]: 'fix\n' });
    const px = f.push('lane/p', f.init, { [HOTFIX]: 'fix\n' }); // the same patch, under P's own subject
    f.push('lane/p', px, { [TAKEOVER]: lines({ 2: 'p edit' }) });
    const cx = f.push('lane/c', f.init, { [HOTFIX]: 'fix\n' });
    f.push('lane/c', cx, { [TAKEOVER]: lines({ 2: 'c edit' }) });
    f.fetch();
    const plan = await planRebuild({
      git: f.runGit, headSha: null, mainRef: 'origin/main', prBaseChain: async (pr) => (pr === 9502 ? ['lane/p'] : []),
      overlays: [{ ref: 'lane/x', pr: 9500 }, { ref: 'lane/p', pr: 9501 }, { ref: 'lane/c', pr: 9502 }],
    });
    expect(plan.decisions.find((d) => d.ref === 'lane/p')).toMatchObject({ action: 'apply' });
    expect(plan.decisions.find((d) => d.ref === 'lane/c')).toMatchObject({ action: 'drop', reason: 'conflict' });
    expect(plan.alerts.map((a) => a.kind)).toContain('overlay-stack-claim-unconfirmed');
  });

  it('live shape with the intermediate chain refs pushed and registered: their content still counts as the base\'s work', async () => {
    const f = fixture();
    const mids = CHAINS[4792].slice(0, 3);
    for (const m of mids) gitOk(f.author, ['push', '-q', '-f', 'origin', `${f.ladder}:refs/heads/${m}`]);
    f.moveBase();
    f.fetch();
    const plan = await planRebuild({
      git: f.runGit, headSha: null, mainRef: 'origin/main', prBaseChain,
      overlays: [{ ref: BASE, pr: 4756 }, ...mids.map((ref, i) => ({ ref, pr: 9601 + i })), { ref: LAST, pr: 4792 }],
    });
    expect(plan.decisions.find((d) => d.ref === BASE)).toMatchObject({ action: 'skip', reason: 'stack-base-moved' });
    expect(plan.decisions.find((d) => d.ref === LAST)).toMatchObject({ action: 'apply' });
    expect(plan.alerts.map((a) => a.kind)).not.toContain('overlay-stack-claim-unconfirmed');
  });

  it('a real child of a rebased base that shares a prerequisite with it is still recognised (its own work matches)', async () => {
    const f = fixture();
    const h = f.push('lane/h', f.init, { [LADDER]: lines({ 5: 'prerequisite' }) });
    const pOld = f.push('lane/p', h, { [TAKEOVER]: lines({ 2: 'p v1' }) });
    f.push('lane/c', pOld, { [TAKEOVER]: lines({ 2: 'p v1', 9: 'c edit' }) });
    f.push('lane/p', h, { [TAKEOVER]: lines({ 2: 'p v2' }) }); // P rebased in place: same subject, clashing line
    f.fetch();
    const plan = await siblingsPlan(f, { 9502: ['lane/p'] });
    expect(plan.decisions.find((d) => d.ref === 'lane/p')).toMatchObject({ action: 'skip', reason: 'stack-base-moved' });
    expect(plan.decisions.find((d) => d.ref === 'lane/c')).toMatchObject({ action: 'apply' });
    expect(plan.alerts.map((a) => a.kind)).not.toContain('overlay-stack-claim-unconfirmed');
  });
});
