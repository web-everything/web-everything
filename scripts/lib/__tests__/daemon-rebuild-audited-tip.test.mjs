/** unaudited-tip — real Git plans and hermetic fix-ready evidence. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { planRebuild } from '../daemon-rebuild/plan.mjs';
import { makeGit } from '../daemon-rebuild/shared.mjs';
import { makeAuditedTipGate } from '../daemon-rebuild/audited-tip.mjs';
import { addOverlay, resolveOverlayFollowTip } from '../daemon-overlays.mjs';
import { rebuildClone } from '../daemon-rebuild.mjs';
import { readRebuildState } from '../daemon-rebuild/state.mjs';

// Same temp/Git helpers as overlay-pin; local tracking refs avoid network IO entirely.
const temps = [];
afterEach(() => { for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const mktemp = () => { const d = mkdtempSync(join(tmpdir(), 'we-unaudited-tip-')); temps.push(d); return d; };
const gitOk = (cwd, args) => {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8', timeout: 20_000 });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
};
const write = (dir, name, content) => { mkdirSync(dirname(join(dir, name)), { recursive: true }); writeFileSync(join(dir, name), content); };
const ref = 'lane/moving';
const record = (sha, extra = {}) => ({ ref, sha, tests: 'green', audit: 'NOT WEAKENED', ...extra });
function evidence() {
  const dir = mktemp();
  const path = join(dir, 'fix-ready.jsonl');
  const platform = join(dir, 'platform.json');
  writeFileSync(platform, '{}');
  return { path, dir, env: {
    WE_FIX_READY_PATH: path, WE_PLATFORM_PREFERENCES_FILE: platform,
    WE_DAEMON_OVERLAY_FOLLOW_TIP: 'audited-only',
  }, save: (...rows) => writeFileSync(path, rows.map(r => JSON.stringify(r)).join('\n')) };
}
async function fixture() {
  const e = evidence();
  const root = join(e.dir, 'repo');
  mkdirSync(root);
  gitOk(root, ['init', '-q', '-b', 'main']);
  const commit = (content) => {
    write(root, 'moving.txt', content);
    gitOk(root, ['add', '-A']);
    gitOk(root, ['commit', '-q', '-m', content]);
    return gitOk(root, ['rev-parse', 'HEAD']);
  };
  const base = commit('base');
  gitOk(root, ['update-ref', 'refs/remotes/origin/main', base]);
  write(root, 'a.txt', 'A extra'); // A also adds a file, so A's content is distinguishable from moving.txt alone
  const a = commit('audited A');
  gitOk(root, ['update-ref', `refs/remotes/origin/${ref}`, a]);
  const git = makeGit({
    cwd: root, env: process.env,
    run: (args, opts) => spawnSync('git', args, { ...opts, encoding: 'utf8' }),
  });
  const args = { git, mainRef: 'origin/main', overlays: [{ ref, pr: 42 }], edgeResolve: false };
  e.save(record(a));
  const adopted = await planRebuild({ ...args, headSha: base, auditedTip: makeAuditedTipGate(e.env) });
  expect(adopted.ok).toBe(true);
  const b = commit('clean unaudited B');
  gitOk(root, ['update-ref', `refs/remotes/origin/${ref}`, b]);
  const plan = (extra = {}) => planRebuild({ ...args, headSha: adopted.finalSha, auditedTip: makeAuditedTipGate(e.env), ...extra });
  return { ...e, root, a, b, base, adopted, plan };
}

describe('unaudited-tip plans', () => {
  it('keeps audited adopted A when clean B has no record, even with noPin', async () => {
    const f = await fixture();
    const p = await f.plan({ noPin: new Set([ref]) });
    expect(p.ok).toBe(true);
    expect(p.applied).toEqual([{ ref, pr: 42, sha: f.a, pinnedFrom: f.b }]);
    expect(p.alerts).toContainEqual({ kind: 'overlay-unaudited-tip', detail: {
      ref, pr: 42, adopted: f.a, newTip: f.b,
      message: `overlay ${ref} keeps its audited adopted head ${f.a.slice(0, 10)}: new tip ${f.b.slice(0, 10)} has no fix-ready + audit record (unaudited-tip)`,
    } });
  });
  it('applies B when B has an audited fix-ready record', async () => {
    const f = await fixture();
    f.save(record(f.a), record(f.b));
    const p = await f.plan();
    expect(p.applied).toEqual([{ ref, pr: 42, sha: f.b }]);
    expect(p.alerts.some(a => a.kind === 'overlay-unaudited-tip')).toBe(false);
  });
  it('follow returns a null gate and applies B without evidence', async () => {
    const f = await fixture();
    const gate = makeAuditedTipGate({ ...f.env, WE_DAEMON_OVERLAY_FOLLOW_TIP: 'follow' });
    expect(gate).toBeNull();
    expect((await f.plan({ auditedTip: gate })).applied).toEqual([{ ref, pr: 42, sha: f.b }]);
  });
  it('does not strand a new registration without an adopted head or record', async () => {
    const f = await fixture();
    f.save();
    const p = await f.plan({ headSha: f.base });
    expect(p.applied).toEqual([{ ref, pr: 42, sha: f.b }]);
    expect(p.alerts.some(a => a.kind === 'overlay-unaudited-tip')).toBe(false);
  });
  it('leaves an established overlay unaffected without reading evidence', async () => {
    const f = await fixture();
    const live = await f.plan({ auditedTip: null });
    const gate = vi.fn(() => false);
    const p = await f.plan({ headSha: live.finalSha, auditedTip: gate });
    expect(p.applied).toEqual([{ ref, pr: 42, sha: f.b }]);
    expect(gate).not.toHaveBeenCalled();
  });
  it('unreadable evidence fails closed to adopted A', async () => {
    const f = await fixture();
    rmSync(f.path);
    expect((await f.plan()).applied).toEqual([{ ref, pr: 42, sha: f.a, pinnedFrom: f.b }]);
  });
  it('leaves a merged moving tip unchanged without reading evidence', async () => {
    const f = await fixture();
    // B has since merged into main: no record is needed, and the gate must never be asked.
    gitOk(f.root, ['update-ref', 'refs/remotes/origin/main', f.b]);
    const followed = await f.plan({ auditedTip: null });
    const gate = vi.fn(() => false);
    const p = await f.plan({ auditedTip: gate });
    expect(gate).not.toHaveBeenCalled();
    expect(p.decisions).toEqual(followed.decisions);
    expect(p.decisions).toContainEqual({ ref, pr: 42, action: 'remove', reason: 'in-main', sha: f.b });
    expect(p.applied).toEqual(followed.applied);
    expect(p.alerts.some(a => a.kind === 'overlay-unaudited-tip')).toBe(false);
  });
  it('adopted A conflicts with advanced main while B has no record: B is not tried and the hold names the real remedy', async () => {
    const f = await fixture();
    // main advances onto A's file, so adopted A conflicts; the rebased tip B is a clean change on main.
    gitOk(f.root, ['checkout', '-q', '--detach', f.base]);
    write(f.root, 'moving.txt', 'main moved');
    gitOk(f.root, ['commit', '-qam', 'main moved']);
    const main2 = gitOk(f.root, ['rev-parse', 'HEAD']);
    gitOk(f.root, ['update-ref', 'refs/remotes/origin/main', main2]);
    write(f.root, 'other.txt', 'B only');
    gitOk(f.root, ['add', '-A']);
    gitOk(f.root, ['commit', '-q', '-m', 'rebased B']);
    const b2 = gitOk(f.root, ['rev-parse', 'HEAD']);
    gitOk(f.root, ['update-ref', `refs/remotes/origin/${ref}`, b2]);
    const p = await f.plan();
    expect(p.applied).toEqual([]);
    const drop = p.decisions.find(d => d.ref === ref);
    expect(drop).toMatchObject({ action: 'drop', reason: 'conflict', sha: f.a, unauditedTip: b2 });
    const dropped = p.alerts.find(a => a.kind === 'established-overlay-dropped');
    expect(dropped?.detail.message).toContain('unaudited-tip');
    expect(dropped.detail.message).toContain(b2.slice(0, 10));
    expect(dropped.detail.message).toContain('fix-ready');
    expect(dropped.detail.message).not.toContain('rebase its branch onto main');
    // Once B has a record, B itself applies and nothing is held.
    f.save(record(f.a), record(b2));
    const ok = await f.plan();
    expect(ok.applied).toEqual([{ ref, pr: 42, sha: b2 }]);
    expect(ok.alerts.some(a => a.kind === 'established-overlay-dropped')).toBe(false);
  });
  it('stack fallback never applies an unaudited tip: the set-aside base returns at its adopted head', async () => {
    const f = await fixture();
    // child C is built on unaudited B and conflicts with main, so the base (set aside as stack-contained) falls back.
    const child = 'lane/child';
    write(f.root, 'c.txt', 'child only');
    gitOk(f.root, ['add', '-A']);
    gitOk(f.root, ['commit', '-q', '-m', 'child on B']);
    gitOk(f.root, ['update-ref', `refs/remotes/origin/${child}`, gitOk(f.root, ['rev-parse', 'HEAD'])]);
    gitOk(f.root, ['checkout', '-q', '--detach', f.base]);
    write(f.root, 'c.txt', 'main c');
    gitOk(f.root, ['add', '-A']);
    gitOk(f.root, ['commit', '-q', '-m', 'main c']);
    gitOk(f.root, ['update-ref', 'refs/remotes/origin/main', gitOk(f.root, ['rev-parse', 'HEAD'])]);
    const stack = {
      overlays: [{ ref, pr: 42 }, { ref: child, pr: 43 }], stackMode: 'tops',
      prState: async () => 'OPEN', prBaseChain: async (pr) => (pr === 43 ? [ref] : []),
    };
    const gate = vi.fn(() => false);
    const p = await f.plan({ ...stack, auditedTip: gate });
    expect(p.decisions.find(d => d.ref === ref)).toMatchObject({ action: 'apply', reason: 'applied-stack-fallback', sha: f.a });
    expect(p.applied).toEqual([{ ref, pr: 42, sha: f.a, pinnedFrom: f.b }]);
    expect(p.alerts.some(a => a.kind === 'overlay-unaudited-tip')).toBe(true);
    // With a record for B the fallback applies B itself, exactly as before.
    f.save(record(f.a), record(f.b));
    const ok = await f.plan(stack);
    expect(ok.applied).toEqual([{ ref, pr: 42, sha: f.b }]);
  });
  it('a squash-merged unaudited tip (not an ancestor, adds nothing to main) is retired as in-main, never held', async () => {
    const f = await fixture();
    gitOk(f.root, ['checkout', '-q', '--detach', f.base]);
    write(f.root, 'moving.txt', 'clean unaudited B');
    write(f.root, 'a.txt', 'A extra'); // the whole PR (A then B) squashed into one main commit
    gitOk(f.root, ['add', '-A']);
    gitOk(f.root, ['commit', '-q', '-m', 'squash of B']);
    gitOk(f.root, ['update-ref', 'refs/remotes/origin/main', gitOk(f.root, ['rev-parse', 'HEAD'])]);
    const gate = vi.fn(() => false);
    const p = await f.plan({ auditedTip: gate });
    expect(gate).not.toHaveBeenCalled();
    expect(p.decisions.find(d => d.ref === ref)).toMatchObject({ action: 'remove', reason: 'in-main', sha: f.b });
    expect(p.alerts.some(a => a.kind === 'overlay-unaudited-tip')).toBe(false);
  });
  it('the retry pass records a held head as pinnedFrom, so it never counts as the applied tip', async () => {
    const f = await fixture();
    // main moves moving.txt so adopted A conflicts and drops; a later overlay Q then makes A merge cleanly.
    gitOk(f.root, ['checkout', '-q', '--detach', f.base]);
    write(f.root, 'moving.txt', 'main moved');
    gitOk(f.root, ['commit', '-qam', 'main moved']);
    const main2 = gitOk(f.root, ['rev-parse', 'HEAD']);
    gitOk(f.root, ['update-ref', 'refs/remotes/origin/main', main2]);
    write(f.root, 'moving.txt', 'audited A');
    gitOk(f.root, ['commit', '-qam', 'Q']);
    gitOk(f.root, ['update-ref', 'refs/remotes/origin/lane/q', gitOk(f.root, ['rev-parse', 'HEAD'])]);
    const p = await f.plan({ overlays: [{ ref, pr: 42 }, { ref: 'lane/q', pr: 44 }] });
    expect(p.decisions.find(d => d.ref === ref)).toMatchObject({ action: 'apply', reason: 'applied-retry', sha: f.a });
    expect(p.applied.find(a => a.ref === ref)).toEqual({ ref, pr: 42, sha: f.a, pinnedFrom: f.b });
  });
  it.each([
    ['upstream-equivalent (git cherry)', async (f) => {
      gitOk(f.root, ['checkout', '-q', '--detach', f.base]);
      // -x changes the message, so the copy is a different commit (not A itself) with the same patch-id.
      gitOk(f.root, ['cherry-pick', '-x', f.a]);
      return gitOk(f.root, ['rev-parse', 'HEAD']);
    }],
    ['same content on main (tree compare)', async (f) => {
      gitOk(f.root, ['checkout', '-q', '--detach', f.base]);
      write(f.root, 'moving.txt', 'audited A');
      write(f.root, 'a.txt', 'A extra');
      gitOk(f.root, ['add', '-A']);
      gitOk(f.root, ['commit', '-q', '-m', 'squash-like A']);
      return gitOk(f.root, ['rev-parse', 'HEAD']);
    }],
  ])('holding unaudited B keeps the registration when adopted A is %s on main', async (_name, advance) => {
    const f = await fixture();
    gitOk(f.root, ['update-ref', 'refs/remotes/origin/main', await advance(f)]);
    const held = await f.plan();
    const hd = held.decisions.find(d => d.ref === ref);
    expect(hd).toMatchObject({ action: 'skip', reason: 'unaudited-tip-held', sha: f.a });
    expect(held.decisions.some(d => d.action === 'remove')).toBe(false);
    expect(held.alerts.some(a => a.kind === 'overlay-unaudited-tip')).toBe(true);
    // B is audited: the real tip is judged on its own (still unmerged, so it is not treated as in-main).
    f.save(record(f.a), record(f.b));
    const ok = await f.plan();
    expect(ok.decisions.find(d => d.ref === ref)?.sha).toBe(f.b);
    expect(ok.decisions.find(d => d.ref === ref)?.reason).not.toBe('unaudited-tip-held');
  });
  it.each([
    ['squash-like content on main', async (f) => {
      gitOk(f.root, ['checkout', '-q', '--detach', f.base]);
      write(f.root, 'moving.txt', 'audited A');
      write(f.root, 'a.txt', 'A extra');
      gitOk(f.root, ['add', '-A']);
      gitOk(f.root, ['commit', '-q', '-m', 'squash-like A']);
      return gitOk(f.root, ['rev-parse', 'HEAD']);
    }],
    ['A merged into main itself (graduated ancestor)', async (f) => f.a],
  ])('a held build is byte-stable while the unaudited branch keeps moving: %s', async (_name, advance) => {
    const f = await fixture();
    gitOk(f.root, ['update-ref', 'refs/remotes/origin/main', await advance(f)]);
    const first = await f.plan();
    // The author pushes another unaudited commit B2; the held build must be the very same commit (no rebuild churn).
    gitOk(f.root, ['checkout', '-q', '--detach', f.b]);
    write(f.root, 'moving.txt', 'unaudited B2');
    gitOk(f.root, ['commit', '-qam', 'B2']);
    gitOk(f.root, ['update-ref', `refs/remotes/origin/${ref}`, gitOk(f.root, ['rev-parse', 'HEAD'])]);
    const second = await f.plan({ headSha: first.finalSha });
    expect(second.finalSha).toBe(first.finalSha);
    expect(second.upToDate).toBe(true);
  });
  it.each([
    ['squash-like content on main', async (f) => {
      gitOk(f.root, ['checkout', '-q', '--detach', f.base]);
      write(f.root, 'moving.txt', 'audited A');
      write(f.root, 'a.txt', 'A extra');
      gitOk(f.root, ['add', '-A']);
      gitOk(f.root, ['commit', '-q', '-m', 'squash-like A']);
      return gitOk(f.root, ['rev-parse', 'HEAD']);
    }],
    ['A merged into main itself (graduated ancestor)', async (f) => f.a],
  ])('the audit hold survives successive rebuilds after the adopted head reaches main: %s', async (_name, advance) => {
    const f = await fixture();
    gitOk(f.root, ['update-ref', 'refs/remotes/origin/main', await advance(f)]);
    const gate = vi.fn(() => false);
    const first = await f.plan({ auditedTip: gate });
    expect(first.decisions.find(d => d.ref === ref)).toMatchObject({ action: 'skip', reason: 'unaudited-tip-held', sha: f.a });
    // The held build is adopted; the next rebuild starts from it and must STILL hold B (and still ask the gate).
    const second = await f.plan({ auditedTip: gate, headSha: first.finalSha });
    expect(gate).toHaveBeenCalled();
    expect(second.decisions.find(d => d.ref === ref)).toMatchObject({ action: 'skip', reason: 'unaudited-tip-held', sha: f.a });
    expect(second.applied.some(a => a.sha === f.b)).toBe(false);
    expect(second.upToDate).toBe(true);
    // A third rebuild from the second build still holds; once B has a record it is judged on its own.
    const third = await f.plan({ auditedTip: gate, headSha: second.finalSha });
    expect(third.decisions.find(d => d.ref === ref)?.reason).toBe('unaudited-tip-held');
    f.save(record(f.a), record(f.b));
    const ok = await f.plan({ headSha: third.finalSha });
    expect(ok.decisions.find(d => d.ref === ref)?.sha).toBe(f.b);
    expect(ok.decisions.find(d => d.ref === ref)?.reason).not.toBe('unaudited-tip-held');
  });
});

describe('unaudited-tip across stack containment and mechanism-conflict retries', () => {
  const commitFiles = (root, files, msg) => {
    for (const [name, content] of Object.entries(files)) write(root, name, content);
    gitOk(root, ['add', '-A']);
    gitOk(root, ['commit', '-q', '-m', msg]);
    return gitOk(root, ['rev-parse', 'HEAD']);
  };
  const detach = (root, sha) => gitOk(root, ['checkout', '-q', '--detach', sha]);
  const track = (root, name, sha) => gitOk(root, ['update-ref', name, sha]);
  const gitFor = (root) => makeGit({
    cwd: root, env: process.env, run: (args, opts) => spawnSync('git', args, { ...opts, encoding: 'utf8' }),
  });
  const stackOpts = (top, topPr) => ({
    overlays: [{ ref, pr: 42 }, { ref: top, pr: topPr }], stackMode: 'tops',
    prState: async () => 'OPEN', prBaseChain: async (pr) => (pr === topPr ? [ref] : []),
  });

  it('a base set aside as stack-contained keeps its audit hold when it later advances to an unaudited tip', async () => {
    const f = await fixture();
    // Stack top T is built on adopted A; the registered base is still A, so it is stack-contained and only T is recorded.
    const top = 'lane/top';
    detach(f.root, f.a);
    const t = commitFiles(f.root, { 't.txt': 'top only' }, 'top on A');
    track(f.root, `refs/remotes/origin/${top}`, t);
    track(f.root, `refs/remotes/origin/${ref}`, f.a);
    const stack = stackOpts(top, 43);
    const contained = await f.plan(stack);
    expect(contained.decisions.find(d => d.ref === ref)).toMatchObject({ action: 'skip', reason: 'stack-contained', sha: f.a });
    expect(contained.applied.map(a => a.ref)).toEqual([top]);
    // The identity marker is byte-stable: re-planning from the adopted build changes nothing.
    expect((await f.plan({ ...stack, headSha: contained.finalSha })).upToDate).toBe(true);
    // The base now advances to unaudited B (a clean, non-clashing change): the gate must be asked and A kept.
    track(f.root, `refs/remotes/origin/${ref}`, f.b);
    const gate = vi.fn((r, sha) => !(r === ref && sha === f.b));
    const held = await f.plan({ ...stack, headSha: contained.finalSha, auditedTip: gate });
    expect(gate).toHaveBeenCalledWith(ref, f.b);
    expect(held.applied.some(a => a.sha === f.b)).toBe(false);
    expect(held.applied.find(a => a.ref === ref)).toEqual({ ref, pr: 42, sha: f.a, pinnedFrom: f.b });
    expect(held.alerts.some(a => a.kind === 'overlay-unaudited-tip' && a.detail.ref === ref && a.detail.newTip === f.b)).toBe(true);
    // The hold also survives the next rebuild, and lifts once B has a fix-ready + audit record.
    const again = await f.plan({ ...stack, headSha: held.finalSha, auditedTip: gate });
    expect(again.applied.some(a => a.sha === f.b)).toBe(false);
    f.save(record(f.a), record(f.b));
    const ok = await f.plan({ ...stack, headSha: again.finalSha });
    expect(ok.applied.find(a => a.ref === ref)).toEqual({ ref, pr: 42, sha: f.b });
  });

  it('a mechanism-conflict retry applies the held head with pinnedFrom, so the live stack base still falls back', async () => {
    const e = evidence();
    const root = join(e.dir, 'repo');
    mkdirSync(root);
    gitOk(root, ['init', '-q', '-b', 'main']);
    const m0 = commitFiles(root, { 'scripts/lib/daemon-rebuild.mjs': 'm0', 'scripts/lib/daemon-overlays.mjs': 'o' }, 'm0');
    track(root, 'refs/remotes/origin/main', m0);
    // A (adopted, touches mechanism paths + x.txt); S is a stack base; B is S + a new unaudited change to the moving overlay.
    const a = commitFiles(root, { 'scripts/lib/daemon-rebuild.mjs': 'A mech', 'x.txt': 'A x' }, 'audited A');
    track(root, `refs/remotes/origin/${ref}`, a);
    const git = gitFor(root);
    e.save(record(a));
    const args = { git, mainRef: 'origin/main', edgeResolve: false, auditedTip: makeAuditedTipGate(e.env) };
    const adopted = await planRebuild({ ...args, headSha: m0, overlays: [{ ref, pr: 42 }] });
    expect(adopted.applied).toEqual([{ ref, pr: 42, sha: a }]);
    detach(root, m0);
    const s = commitFiles(root, { 's.txt': 'S only' }, 'stack base S');
    track(root, 'refs/remotes/origin/lane/base', s);
    const b = commitFiles(root, { 'scripts/lib/daemon-rebuild.mjs': 'B mech', 'x.txt': 'B x' }, 'unaudited B on S');
    track(root, `refs/remotes/origin/${ref}`, b);
    // main moves the mechanism file (A now conflicts and is skip-able: main has the mechanism); Q makes A merge cleanly later.
    detach(root, m0);
    const m1 = commitFiles(root, { 'scripts/lib/daemon-rebuild.mjs': 'main moved' }, 'm1');
    track(root, 'refs/remotes/origin/main', m1);
    const q = commitFiles(root, { 'scripts/lib/daemon-rebuild.mjs': 'A mech' }, 'Q');
    track(root, 'refs/remotes/origin/lane/q', q);
    const plan = await planRebuild({
      ...args, headSha: adopted.finalSha, stackMode: 'tops', prState: async () => 'OPEN', prBaseChain: async () => [],
      overlays: [{ ref, pr: 42 }, { ref: 'lane/base', pr: 45 }, { ref: 'lane/q', pr: 44 }],
    });
    expect(plan.ok).toBe(true);
    expect(plan.decisions.find(d => d.ref === ref)).toMatchObject({ action: 'apply', reason: 'applied-retry', sha: a });
    // The retry applied A, not B: it must say so, and A must not count as the top that replaced base S.
    expect(plan.applied.find(x => x.ref === ref)).toEqual({ ref, pr: 42, sha: a, pinnedFrom: b });
    expect(plan.decisions.find(d => d.ref === 'lane/base')).toMatchObject({ action: 'apply', reason: 'applied-stack-fallback', sha: s });
    expect(plan.applied.some(x => x.ref === 'lane/base' && x.sha === s)).toBe(true);
  });
});

// The production entry points must hand the gate to the planner; the planner tests above inject their own.
describe('unaudited-tip wiring', () => {
  const sourceOf = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
  /** Text of every `planRebuild({ … })` call (brace-balanced), definitions excluded. */
  const planCalls = (src) => {
    const out = [];
    for (let at = src.indexOf('planRebuild({'); at !== -1; at = src.indexOf('planRebuild({', at + 1)) {
      if (/function\s+$/.test(src.slice(Math.max(0, at - 12), at))) continue;
      let depth = 0; let end = at + 'planRebuild('.length;
      for (; end < src.length; end++) {
        if (src[end] === '{') depth++;
        else if (src[end] === '}' && --depth === 0) break;
      }
      out.push(src.slice(at, end + 1));
    }
    return out;
  };
  it.each([
    ['prepare.mjs', 1], ['preview.mjs', 3], ['smoke.mjs', 2], ['plan.mjs', 2],
  ])('every planRebuild call in %s passes auditedTip (%i calls)', (file, count) => {
    const calls = planCalls(sourceOf(`../daemon-rebuild/${file}`));
    expect(calls).toHaveLength(count);
    for (const call of calls) expect(call).toMatch(/\bauditedTip\b/);
    if (file !== 'plan.mjs') for (const call of calls) expect(call).toContain('auditedTip: makeAuditedTipGate(env)');
  });

  it('prepareRebuild with explicit audited-only env keeps the adopted head, logs overlay-unaudited-tip once, then advances on a record', async () => {
    const base = mktemp('we-unaudited-prep-');
    const origin = join(base, 'origin.git');
    const clone = join(base, 'clone');
    gitOk(base, ['init', '--bare', '-q', origin]);
    mkdirSync(clone);
    gitOk(clone, ['init', '-q', '-b', 'main']);
    write(clone, 'README.md', 'init\n');
    gitOk(clone, ['add', '-A']);
    gitOk(clone, ['commit', '-q', '-m', 'init']);
    gitOk(clone, ['remote', 'add', 'origin', origin]);
    gitOk(clone, ['push', '-q', '-u', 'origin', 'main']);
    const author = join(base, 'author');
    gitOk(base, ['clone', '-q', origin, author]);
    const init = gitOk(clone, ['rev-parse', 'HEAD']);
    const push = (content) => {
      gitOk(author, ['fetch', '-q', 'origin']);
      gitOk(author, ['checkout', '-q', '-B', ref, content === 'A' ? init : `origin/${ref}`]);
      write(author, 'moving.txt', `${content}\n`);
      if (content === 'B') write(author, 'other.txt', 'B\n'); // adds a file main later changes: B (not A) then conflicts
      gitOk(author, ['add', '-A']);
      gitOk(author, ['commit', '-q', '-m', content]);
      gitOk(author, ['push', '-q', 'origin', `+HEAD:refs/heads/${ref}`]);
      return gitOk(author, ['rev-parse', 'HEAD']);
    };
    const e = evidence();
    const env = {
      ...process.env, ...e.env,
      WE_DAEMON_STATE_DIR: mktemp('we-unaudited-prep-state-'),
      WE_DAEMON_CLONE_LOCK_ROOT: mktemp('we-unaudited-prep-lock-'),
      WE_DAEMON_OVERLAY_DIR: mktemp('we-unaudited-prep-overlay-'),
    };
    addOverlay(clone, { ref, pr: 42 }, { env });
    const logs = [];
    const smoke = vi.fn(async () => ({ verdict: 'pass', attempts: 1, smoke: { results: [{ name: 'reconcile-dry-run', ok: true, ms: 10 }] } }));
    const tick = () => rebuildClone({ root: clone, env, runSmoke: smoke, prState: async () => 'OPEN', log: { error: (m) => logs.push(m) } });
    const a = push('A');
    e.save(record(a));
    expect(await tick()).toMatchObject({ adopted: true });
    const tree = (sha, name) => gitOk(clone, ['show', `${sha}:${name}`]).trim();
    expect(tree('HEAD', 'moving.txt')).toBe('A');

    const b = push('B'); // a fixer's new tip with no fix-ready record
    for (let i = 0; i < 3; i++) {
      await tick();
      expect(tree('HEAD', 'moving.txt')).toBe('A');
    }
    expect(logs.filter(m => m.startsWith('daemon-rebuild: overlay-unaudited-tip '))).toHaveLength(1);
    expect(logs.filter(m => m.startsWith('daemon-rebuild: overlay-pinned '))).toHaveLength(0);

    // Its record lands, but B now conflicts with main: the pin notice for the SAME tip must still be logged once.
    gitOk(author, ['checkout', '-q', 'main']);
    gitOk(author, ['pull', '-q', 'origin', 'main']);
    write(author, 'other.txt', 'main\n');
    gitOk(author, ['add', '-A']);
    gitOk(author, ['commit', '-q', '-m', 'main other']);
    gitOk(author, ['push', '-q', 'origin', 'main']);
    e.save(record(a), record(b));
    for (let i = 0; i < 2; i++) {
      await tick();
      expect(tree('HEAD', 'moving.txt')).toBe('A');
    }
    expect(logs.filter(m => m.startsWith('daemon-rebuild: overlay-pinned '))).toHaveLength(1);
    expect(logs.filter(m => m.startsWith('daemon-rebuild: overlay-unaudited-tip '))).toHaveLength(1);
  }, 60_000);
});

describe('unaudited-tip evidence and policy', () => {
  it('defaults and invalid values are audited-only; resolves platform/tool/env cascade', () => {
    const f = evidence();
    const settingsPath = join(f.dir, 'settings.json');
    const env = { WE_PLATFORM_PREFERENCES_FILE: f.env.WE_PLATFORM_PREFERENCES_FILE };
    const resolve = (e = env) => resolveOverlayFollowTip(e, { settingsPath });
    expect(resolve()).toBe('audited-only');
    writeFileSync(env.WE_PLATFORM_PREFERENCES_FILE, JSON.stringify({ overlay: { followTip: 'follow' } }));
    expect(resolve()).toBe('follow');
    writeFileSync(settingsPath, JSON.stringify({ overlay: { followTip: 'audited-only' } }));
    expect(resolve()).toBe('audited-only');
    expect(resolve({ ...env, WE_DAEMON_OVERLAY_FOLLOW_TIP: 'follow' })).toBe('follow');
    expect(resolve({ ...env, WE_DAEMON_OVERLAY_FOLLOW_TIP: 'invalid' })).toBe('audited-only');
  });
  it('parses JSONL past bad lines, matches exact ref and case-insensitive sha/audit', () => {
    const f = evidence();
    writeFileSync(f.path, 'bad JSON\nnull\n{}\n' + JSON.stringify(record('ABC', { audit: 'not weakened' })));
    const gate = makeAuditedTipGate(f.env);
    expect(gate(ref, 'abc')).toBe(true);
    expect(gate('LANE/moving', 'abc')).toBe(false);
    expect(gate(ref, 'abd')).toBe(false);
    expect(gate(ref, undefined)).toBe(false);
  });
  it.each([
    { tests: 'red' }, { tests: null }, { audit: null }, { audit: 'NOT WEAKENED extra' },
    { audit: 'WEAKENED' }, { audit: 'WEAKENED', auditRuling: '' },
    { audit: 'WEAKENED', auditRuling: '  ' }, { audit: 'WEAKENED', auditRuling: true },
  ])('rejects incomplete or failing evidence %j', (extra) => {
    const f = evidence();
    f.save(record('abc', extra));
    expect(makeAuditedTipGate(f.env)(ref, 'abc')).toBe(false);
  });
  describe('WEAKENED evidence is judged by the canonical readyEvidence allowlist', () => {
    const sha = 'b'.repeat(40);
    const weakened = (extra = {}) => record(sha, { audit: 'WEAKENED', auditRuling: 'R907', auditDisclosed: ['finding'], ...extra });
    const withAllowlist = (f, entries) => {
      const platform = join(f.dir, 'platform.json');
      writeFileSync(platform, JSON.stringify({ prototypeLoad: { ruledWeakened: entries } }));
      return { ...f.env, WE_PLATFORM_PREFERENCES_FILE: platform };
    };
    const entry = (extra = {}) => ({ ref, sha, ruling: 'R907', findings: ['finding'], ...extra });
    it('a self-declared ruling and disclosure with no operator allowlist entry stays held', () => {
      const f = evidence();
      f.save(weakened());
      expect(makeAuditedTipGate(f.env)(ref, sha)).toBe(false);
    });
    it.each([
      ['malformed ruling', { auditRuling: 'operator accepted' }, entry()],
      ['no disclosure', { auditDisclosed: undefined }, entry()],
      ['allowlist for another sha', {}, entry({ sha: 'c'.repeat(40) })],
      ['allowlist for another ref', {}, entry({ ref: 'lane/other' })],
      ['allowlist for another ruling', {}, entry({ ruling: 'R908' })],
      ['allowlist with different findings', {}, entry({ findings: ['other'] })],
    ])('%s stays held', (_name, extra, bound) => {
      const f = evidence();
      f.save(weakened(extra));
      expect(makeAuditedTipGate(withAllowlist(f, [bound]))(ref, sha)).toBe(false);
    });
    it('an allowlist entry binding exact ref, sha, ruling and findings authorizes it', () => {
      const f = evidence();
      f.save(weakened());
      expect(makeAuditedTipGate(withAllowlist(f, [entry()]))(ref, sha)).toBe(true);
    });
  });
  it('a later red record for the same sha revokes earlier green evidence', () => {
    const f = evidence();
    f.save(record('abc'), record('abc', { tests: 'red' }));
    expect(makeAuditedTipGate(f.env)(ref, 'abc')).toBe(false);
  });
  it('reads lazily once and fails closed on unreadable files', () => {
    const f = evidence();
    const gate = makeAuditedTipGate(f.env);
    f.save(record('abc'));
    expect(gate(ref, 'abc')).toBe(true);
    f.save(record('def'));
    expect(gate(ref, 'def')).toBe(false);
    const closed = makeAuditedTipGate({ ...f.env, WE_FIX_READY_PATH: f.dir });
    expect(closed(ref, 'abc')).toBe(false);
    expect(makeAuditedTipGate({ ...f.env, WE_FIX_READY_PATH: join(f.dir, 'missing') })(ref, 'abc')).toBe(false);
  });
});
