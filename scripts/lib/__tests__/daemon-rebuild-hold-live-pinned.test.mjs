/**
 * @file scripts/lib/__tests__/daemon-rebuild-hold-live-pinned.test.mjs
 * @description Live 2026-10-21 ~17:12 ET (review clone): after #5771 merged, the registered top
 *   lane/unfreeze-review-top-1021c — mechanism-pinned (it changes rebuild files) and APPLIED in the running build —
 *   conflicted with the new main. xpinskip skipped it and the plan queued main + lane/overlay-pin ONLY (0a5f029030),
 *   dropping the whole review stack; the `superseded` ready rule would then have adopted such a build. Now: a live
 *   overlay that cannot be included (and has no mergeable pinned head) HOLDS the clone; no candidate without it is built
 *   or adopted. Real git repos through the real rebuild path.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { rebuildClone } from '../daemon-rebuild.mjs';
import { addOverlay } from '../daemon-overlays.mjs';
import { readRebuildState } from '../daemon-rebuild/state.mjs';
import { matchReadyCandidate } from '../daemon-rebuild/adopt.mjs';

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

// main already runs the rebuild mechanism, so xpinskip WOULD skip a conflicting mechanism-pinned overlay
const MECH = ['scripts/lib/daemon-rebuild.mjs', 'scripts/lib/daemon-overlays.mjs', 'scripts/lib/daemon-rebuild/plan.mjs', 'scripts/lib/daemon-rebuild/prepare.mjs'];
const REVIEW = 'scripts/conveyor/review-referral-hold.mjs';
const lines = (over = {}) => `${Array.from({ length: 9 }, (_, i) => over[i + 1] ?? `line ${i + 1}`).join('\n')}\n`;

function fixture() {
  const base = mktemp('we-hold-live-pinned-');
  const origin = join(base, 'origin.git');
  const clone = join(base, 'clone');
  gitOk(base, ['init', '--bare', '-q', origin]);
  mkdirSync(clone);
  gitOk(clone, ['init', '-q', '-b', 'main']);
  for (const p of MECH) write(clone, p, '// mechanism\n');
  write(clone, REVIEW, lines());
  gitOk(clone, ['add', '-A']);
  gitOk(clone, ['commit', '-q', '-m', 'init']);
  gitOk(clone, ['remote', 'add', 'origin', origin]);
  gitOk(clone, ['push', '-q', '-u', 'origin', 'main']);
  const author = join(base, 'author');
  gitOk(base, ['clone', '-q', origin, author]);
  const init = gitOk(clone, ['rev-parse', 'HEAD']).trim();
  const push = (ref, from, files) => {
    gitOk(author, ['fetch', '-q', 'origin']);
    gitOk(author, ['checkout', '-q', '-B', ref, from]);
    for (const [n, c] of Object.entries(files)) write(author, n, c);
    gitOk(author, ['add', '-A']);
    gitOk(author, ['commit', '-q', '-m', ref]);
    gitOk(author, ['push', '-q', 'origin', `+HEAD:refs/heads/${ref}`]);
    return gitOk(author, ['rev-parse', 'HEAD']).trim();
  };
  const env = {
    ...process.env,
    WE_DAEMON_STATE_DIR: mktemp('we-hold-live-state-'),
    WE_DAEMON_CLONE_LOCK_ROOT: mktemp('we-hold-live-lock-'),
    WE_DAEMON_OVERLAY_DIR: mktemp('we-hold-live-overlay-'),
  };
  const smoke = vi.fn(async () => ({ verdict: 'pass', attempts: 1, smoke: { results: [{ name: 'reconcile-dry-run', ok: true, ms: 10 }] } }));
  const tick = () => rebuildClone({ root: clone, env, runSmoke: smoke, prState: async () => 'OPEN', log: { error: () => {} } });
  const head = () => gitOk(clone, ['rev-parse', 'HEAD']).trim();
  return { clone, env, init, push, tick, head, smoke };
}

describe('a LIVE overlay that cannot be included holds the clone — never a candidate without it', () => {
  it('replays ~17:12 ET: the live mechanism-pinned stack top conflicts with the new main → hold, no stack-less candidate', async () => {
    const f = fixture();
    // the review stack top: changes rebuild mechanism files (pinned by derivation) AND review code
    const top = f.push('lane/unfreeze-review-top-1021c', f.init, {
      'scripts/lib/daemon-rebuild/plan.mjs': '// mechanism + stack change\n', [REVIEW]: lines({ 3: 'stack hold rule' }),
    });
    const pin = f.push('lane/overlay-pin', f.init, { 'scripts/lib/daemon-rebuild/prepare.mjs': '// mechanism + pin\n' });
    addOverlay(f.clone, { ref: 'lane/overlay-pin', pr: 5809 }, { env: f.env });
    addOverlay(f.clone, { ref: 'lane/unfreeze-review-top-1021c' }, { env: f.env });
    expect(await f.tick()).toMatchObject({ adopted: true });
    const live = f.head();
    expect(isAncestor(f.clone, top, live)).toBe(true);
    // #5771 merges: main rewrites the same review block
    f.push('main', 'origin/main', { [REVIEW]: lines({ 3: 'main referral hold' }) });
    const smokesBefore = f.smoke.mock.calls.length;
    const r = await f.tick();
    expect(r).toMatchObject({ moved: false, reason: 'established-overlay-conflict' });
    const kinds = r.alerts.map((a) => a.kind);
    expect(kinds).toContain('established-overlay-hold');
    expect(r.alerts.find((a) => a.kind === 'established-overlay-hold').detail.lost)
      .toEqual([expect.objectContaining({ ref: 'lane/unfreeze-review-top-1021c', reason: 'pinned-conflict-skipped' })]);
    expect(f.head()).toBe(live);
    expect(f.smoke.mock.calls.length).toBe(smokesBefore); // no candidate of main + overlay-pin only was built/smoked
    expect(readRebuildState(f.clone, f.env).building ?? null).toBeNull();
    expect(readRebuildState(f.clone, f.env).held).toMatchObject({ reason: 'established-overlay-conflict', lastGood: live });
    void pin;
  });

  it('a mechanism-pinned overlay that is NOT live yet is still skipped as before (xpinskip keeps the fleet moving)', async () => {
    const f = fixture();
    addOverlay(f.clone, { ref: 'lane/overlay-pin', pr: 5809 }, { env: f.env });
    f.push('lane/overlay-pin', f.init, { 'scripts/lib/daemon-rebuild/prepare.mjs': '// mechanism + pin\n' });
    expect(await f.tick()).toMatchObject({ adopted: true });
    f.push('main', 'origin/main', { [REVIEW]: lines({ 3: 'main referral hold' }) });
    f.push('lane/new-top', f.init, { 'scripts/lib/daemon-rebuild/plan.mjs': '// mech\n', [REVIEW]: lines({ 3: 'new' }) });
    addOverlay(f.clone, { ref: 'lane/new-top' }, { env: f.env });
    const r = await f.tick();
    expect(r.alerts.map((a) => a.kind)).toContain('pinned-overlay-conflict-skipped');
    expect(r.alerts.map((a) => a.kind)).not.toContain('established-overlay-hold');
    expect(r).toMatchObject({ adopted: true });
  });
});

describe('matchReadyCandidate — superseded never drops a live overlay (fail closed)', () => {
  const base = {
    prevHead: 'h0', treeOf: () => 'tree-plan', stillWanted: () => true, verifyBuilt: () => true, nowMs: 1_000, maxAgeMs: 10_000,
    plan: { finalSha: 'plan', inputsKey: 'k2', mainSha: 'm2', applied: [] },
  };
  const ready = (applied) => ({ prevHead: 'h0', passedAt: new Date(500).toISOString(), tree: 'tree-ready', adopt: { finalSha: 'cand', inputsKey: 'k1', applied } });
  it('refuses a superseded build that omits an overlay the running build applies', () => {
    const m = matchReadyCandidate({
      ...base, ready: ready([{ ref: 'lane/overlay-pin', sha: 'p' }]),
      liveApplied: [{ ref: 'lane/overlay-pin', sha: 'p' }, { ref: 'lane/unfreeze-review-top-1021c', sha: 't' }],
      carries: (sha) => sha === 'p',
    });
    expect(m.adopt).toBeNull();
    expect(m.reason).toMatch(/superseded-omits-live-overlay: lane\/unfreeze-review-top-1021c/);
  });
  it('the same ref at an OLDER head is not carrying it (content, not labels)', () => {
    const m = matchReadyCandidate({
      ...base, ready: ready([{ ref: 'lane/overlay-pin', sha: 'p-old' }]), liveApplied: [{ ref: 'lane/overlay-pin', sha: 'p-new' }],
      carries: (sha) => sha === 'p-old',
    });
    expect(m.adopt).toBeNull();
  });
  it('refuses when the live set is unknown; accepts when every live overlay is carried, by ref or by content', () => {
    expect(matchReadyCandidate({ ...base, ready: ready([]) }).reason).toBe('superseded-live-set-unknown');
    const ok = matchReadyCandidate({
      ...base, ready: ready([{ ref: 'lane/overlay-pin', sha: 'p' }, { ref: 'lane/1021d', sha: 'd' }]),
      liveApplied: [{ ref: 'lane/overlay-pin', sha: 'p' }, { ref: 'lane/1021c', sha: 't' }],
      carries: (sha) => sha === 't' || sha === 'p', // 1021c's live head is inside the candidate (1021d was built on it)
    });
    expect(ok.match).toBe('superseded');
    // landed on the CURRENT main is no excuse: the record itself must contain it (Codex round 2)
    const left = matchReadyCandidate({
      ...base, ready: ready([]), liveApplied: [{ ref: 'lane/landed', sha: 'x' }], leftForMain: (ref) => ref === 'lane/landed',
    });
    expect(left.adopt).toBeNull();
    const inside = matchReadyCandidate({ ...base, ready: ready([]), liveApplied: [{ ref: 'lane/landed', sha: 'x' }], carries: () => true });
    expect(inside.match).toBe('superseded');
  });
});
