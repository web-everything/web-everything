/**
 * @file scripts/lib/__tests__/daemon-rebuild-stack-tops.test.mjs
 * @description Held item 212 — stacked overlay PRs are one stack, not independent overlays. Live 2026-10-10 on
 *   wev-fix-daemon: #4757 (lane/fixer-resume-ladder) is stacked on #4756 (lane/fixer-history-takeover), and #4792 /
 *   #4797 sit on a chain (#4779 → #4770 → #4759 → #4756) that carries #4757 too. #4756 was rebased (new head
 *   ae16d0c8b) and is the live one; its children still carry its OLD head. Every rebuild then parked #4792/#4797 as
 *   newcomers colliding with #4756 on fix-takeover.mjs / reconcile-core.mjs, so none of the stack's fixes went live.
 *   In `overlay.stackMode: tops` (the default) a rebuild applies only the stack tops; a base contained in a top is
 *   set aside (it is live through the top), and a base that MOVED away from its children is set aside too, keeping
 *   the children's tops until they are restacked. These tests replay that shape through planRebuild and rebuildClone.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { planRebuild, rebuildClone } from '../daemon-rebuild.mjs';
import { addOverlay, resolveOverlayStackMode, OVERLAY_STACK_MODE_ENV } from '../daemon-overlays.mjs';
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

function fixture() {
  const base = mktemp('we-stack-tops-');
  const origin = join(base, 'origin.git');
  const clone = join(base, 'clone');
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
    // so it is mechanism-pinned too) conflicts with it — the pin refuses the build instead of dropping either.
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

  it('addOverlay records only safe branch names as stackBases', async () => {
    const f = fixture();
    const { readOverlays } = await import('../daemon-overlays.mjs');
    addOverlay(f.clone, { ref: LAST, pr: 4792, stackBases: ['lane/ok-base', '../escape', '--upload-pack=x', 'has space', ''] }, { env: f.env });
    expect(readOverlays(f.clone, { env: f.env }).find((o) => o.ref === LAST).stackBases).toEqual(['lane/ok-base']);
  });
});
