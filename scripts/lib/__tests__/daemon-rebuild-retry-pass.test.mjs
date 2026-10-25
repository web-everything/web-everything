/**
 * @file scripts/lib/__tests__/daemon-rebuild-retry-pass.test.mjs
 * @description Held item 168 — `planRebuild`'s retry pass (we:scripts/lib/daemon-rebuild/plan.mjs step 7). Live
 *   2026-10-09: overlay lane/main-red-owner (#4527, listed earlier) conflicted with main on the shared settings file;
 *   the overlay that fixes that (moves main's new keys out, restoring the file) was registered LATER, so in list
 *   order it could never help. The retry pass re-tries a conflict-dropped overlay once on the final tip.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { planRebuild } from '../daemon-rebuild.mjs';
import { readyBuildVerified } from '../daemon-rebuild/adopt.mjs';
import { gitRun } from '../main-staleness.mjs';

const temps = [];
afterEach(() => { while (temps.length) rmSync(temps.pop(), { recursive: true, force: true }); });
const mktemp = (p) => { const d = mkdtempSync(join(tmpdir(), p)); temps.push(d); return d; };
const gitOk = (cwd, args) => {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8', timeout: 20_000 });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  return r.stdout;
};
const write = (dir, name, content) => { mkdirSync(dirname(join(dir, name)), { recursive: true }); writeFileSync(join(dir, name), content); };

const BASE = '{\n  "a": 1,\n  "fix": {\n    "x": "on"\n  }\n}\n';

const MECH = ['scripts/lib/daemon-rebuild.mjs', 'scripts/lib/daemon-overlays.mjs', 'scripts/lib/daemon-rebuild/x.mjs'];

/** `pinnedA`: main already runs the rebuild mechanism, and overlay A changes one of its files (pinned by derivation). */
function fixture({ pinnedA = false } = {}) {
  const base = mktemp('we-retry-pass-');
  const origin = join(base, 'origin.git');
  const clone = join(base, 'clone');
  gitOk(base, ['init', '--bare', '-q', origin]);
  mkdirSync(clone);
  gitOk(clone, ['init', '-q', '-b', 'main']);
  write(clone, 'settings.json', BASE);
  if (pinnedA) for (const p of MECH) write(clone, p, '// mechanism\n');
  gitOk(clone, ['add', '-A']);
  gitOk(clone, ['commit', '-q', '-m', 'init']);
  gitOk(clone, ['remote', 'add', 'origin', origin]);
  gitOk(clone, ['push', '-q', '-u', 'origin', 'main']);
  const author = join(base, 'author');
  gitOk(base, ['clone', '-q', origin, author]);
  const push = (ref, from, files, mergeParent = null) => {
    gitOk(author, ['fetch', '-q', 'origin']);
    gitOk(author, ['checkout', '-q', '-B', ref, from]);
    if (mergeParent) gitOk(author, ['merge', '--no-ff', '--no-commit', mergeParent]);
    for (const [n, c] of Object.entries(files)) write(author, n, c);
    gitOk(author, ['add', '-A']);
    gitOk(author, ['commit', '-q', '-m', ref]);
    gitOk(author, ['push', '-q', '-f', 'origin', `HEAD:refs/heads/${ref}`]);
    return gitOk(author, ['rev-parse', 'HEAD']).trim();
  };
  const init = gitOk(clone, ['rev-parse', 'HEAD']).trim();
  // overlay A branched from the old main: appends a key at the end of the shared file
  const a = push('lane/a', init, {
    'settings.json': BASE.replace('  }\n}', '  },\n  "freeze": { "red": "on" }\n}'),
    ...(pinnedA ? { 'scripts/lib/daemon-rebuild/x.mjs': '// mechanism, changed by overlay A\n' } : {}),
  });
  // main moved: appended keys inside the same closing block → A now conflicts with main
  const mainSha = push('main', init, { 'settings.json': BASE.replace('"x": "on"', '"x": "on",\n    "y": 15') });
  // overlay B (from new main) moves main's new key to its own file, restoring the shared file
  const b = push('lane/b', mainSha, { 'settings.json': BASE, 'settings/b.json': '{ "fix": { "y": 15 } }\n' });
  gitOk(clone, ['fetch', '-q', 'origin']);
  const runGit = (args, opts = {}) => gitRun(args, { cwd: clone, ...opts });
  return { clone, runGit, a, b, mainSha, push };
}

describe('planRebuild retry pass', () => {
  it.each([
    { repair: true, explicitA: false, label: 'retries a pin-induced refusal and keeps explicit P (A,P,R)' },
    { repair: false, explicitA: false, label: 'returns the original pin-induced refusal when retries lose carried A' },
    { repair: true, explicitA: true, label: 'never disables an explicit pin to escape a refusal' },
  ])('$label', async ({ repair, explicitA }) => {
    const f = fixture();
    const base = f.push('main', f.mainSha, { 'a.txt': 'BASE\n', 'p.txt': 'BASE\n', 'shared.txt': 'BASE\n' });
    const a0 = f.push('lane/a', base, { 'a.txt': 'OLD-A\n' });
    const p0 = f.push('lane/p', base, { 'p.txt': 'OLD-P\n' });
    const overlays = [{ ref: 'lane/a', pinned: explicitA }, { ref: 'lane/p', pinned: true }];
    gitOk(f.clone, ['fetch', '-q', 'origin']);
    const args = { git: f.runGit, mainRef: 'origin/main', overlays, edgeResolve: false, stackMode: 'independent' };
    const live = await planRebuild({ ...args, headSha: base });
    expect(live.applied.map(a => a.sha)).toEqual([a0, p0]);
    const main = f.push('main', base, { 'p.txt': 'MAIN\n', 'shared.txt': 'MAIN\n' });
    const a1 = f.push('lane/a', a0, { 'a.txt': 'NEW-A\n', 'shared.txt': 'NEW-A\n' });
    const p1 = f.push('lane/p', p0, { 'p.txt': 'MAIN\n', 'a.txt': 'NEW-A\n' });
    if (repair) {
      f.push('lane/repair', main, { 'shared.txt': 'BASE\n' });
      overlays.push({ ref: 'lane/repair' });
    }
    gitOk(f.clone, ['fetch', '-q', 'origin']);

    const plan = await planRebuild({ ...args, headSha: live.finalSha });
    if (!repair || explicitA) {
      expect(plan).toMatchObject({ ok: false, reason: 'pinned-overlay-conflict',
        detail: { ref: 'lane/p', sha: p1, dropReason: 'conflict', pinnedBy: 'flag' } });
      expect(plan.alerts).toEqual([expect.objectContaining({ kind: 'overlay-pinned',
        detail: expect.objectContaining({ ref: 'lane/a', adopted: a0, newTip: a1 }) })]);
      return;
    }
    expect(plan.ok).toBe(true);
    expect(plan.establishedLost).toEqual([]);
    expect(plan.applied.find(a => a.ref === 'lane/a')).toMatchObject({ sha: a1 });
    expect(plan.applied.find(a => a.ref === 'lane/a').pinnedFrom).toBeUndefined();
    expect(plan.applied.find(a => a.ref === 'lane/p')).toMatchObject({ sha: p1 });
    expect(plan.applied.find(a => a.ref === 'lane/p').pinnedFrom).toBeUndefined();
    expect(plan.applied.map(a => a.ref)).toContain('lane/repair');
    for (const sha of [a0, p0, a1, p1]) {
      expect(f.runGit(['merge-base', '--is-ancestor', sha, plan.finalSha]).status).toBe(0);
    }
  }, 60_000);

  it.each([
    { movedBase: false, label: 'accepts a pin retry whose stack top carries the originally applied base (B,A,C,R)' },
    { movedBase: true, label: 'rejects a pin retry that genuinely drops the originally applied base tip' },
  ])('$label', async ({ movedBase }) => {
    const f = fixture();
    const base = f.push('main', f.mainSha, { 'shared.txt': 'base\n', 'c.txt': 'base\n' });
    const b0 = f.push('lane/b', base, { 'b.txt': 'B\n' });
    const a0 = f.push('lane/a', base, { 'a.txt': 'old-A\n' });
    const c0 = f.push('lane/c', base, { 'c.txt': 'old-C\n' });
    const overlays = ['b', 'a', 'c'].map(name => ({ ref: `lane/${name}` }));
    gitOk(f.clone, ['fetch', '-q', 'origin']);
    const args = { git: f.runGit, mainRef: 'origin/main', overlays, edgeResolve: false, stackMode: 'tops' };
    const live = await planRebuild({ ...args, headSha: base });
    expect(live.applied.map(a => a.sha)).toEqual([b0, a0, c0]);
    const main = f.push('main', base, { 'shared.txt': 'main\n', 'c.txt': 'main-C\n' });
    const a1 = f.push('lane/a', a0, {
      'a.txt': 'new-A\n', 'shared.txt': 'new-A\n', ...(movedBase ? { 'b.txt': 'top-B\n' } : {}),
    }, b0);
    const b1 = movedBase ? f.push('lane/b', b0, { 'b.txt': 'new-B\n' }) : b0;
    // A declares B as its base even when B advances beyond the head carried by A.
    overlays[1].stackBases = ['lane/b'];
    const c1 = f.push('lane/c', c0, { 'c.txt': 'main-C\n', 'a.txt': 'new-A\n' });
    const repair = f.push('lane/repair', main, { 'shared.txt': 'base\n', 'repair.txt': 'R\n' });
    overlays.push({ ref: 'lane/repair' });
    gitOk(f.clone, ['fetch', '-q', 'origin']);

    const retry = await planRebuild({ ...args, headSha: live.finalSha, noPin: new Set(['lane/a']) });
    expect(retry.ok).toBe(true);
    expect(retry.establishedLost).toEqual([]);
    expect(retry.applied.some(a => a.ref === 'lane/b')).toBe(false);
    expect(f.runGit(['merge-base', '--is-ancestor', b1, retry.finalSha]).status).toBe(movedBase ? 1 : 0);
    const plan = await planRebuild({ ...args, headSha: live.finalSha });
    if (movedBase) {
      // B0 survives through A1, so establishedLost is empty in the retry, but B1 would really be lost.
      expect(plan.applied).toContainEqual(expect.objectContaining({ ref: 'lane/b', sha: b1 }));
      expect(plan.applied.find(a => a.ref === 'lane/a')).toMatchObject({ sha: a0, pinnedFrom: a1 });
      expect(plan.establishedLost.map(a => a.ref)).toContain('lane/c');
      expect(plan.finalSha).not.toBe(retry.finalSha);
      return;
    }
    expect(plan.ok).toBe(true);
    expect(plan.establishedLost).toEqual([]);
    expect(plan.alerts.map(a => a.kind)).not.toContain('established-overlay-hold');
    expect(plan.applied).toContainEqual(expect.objectContaining({ ref: 'lane/repair', sha: repair }));
    expect(plan.applied.find(a => a.ref === 'lane/a')).toMatchObject({ sha: a1 });
    expect(plan.applied.find(a => a.ref === 'lane/a').pinnedFrom).toBeUndefined();
    expect(plan.applied.some(a => a.ref === 'lane/b')).toBe(false);
    for (const sha of [b0, a1, c1, repair]) {
      expect(f.runGit(['merge-base', '--is-ancestor', sha, plan.finalSha]).status).toBe(0);
    }
  }, 60_000);

  it.each([
    { count: 6, label: 'tries every subset for six pins', jointRetries: 56 },
    { count: 7, label: 'caps extra joint retries at 64', jointRetries: 64 },
  ])('$label', async ({ count, jointRetries }) => {
    const f = fixture();
    const refs = Array.from({ length: count }, (_, i) => `lane/pin-${i}`);
    const conflicts = (value) => Object.fromEntries(refs.map((_, i) => [`conflict-${i}.txt`, `${value}\n`]));
    const base = f.push('main', f.mainSha, conflicts('base'));
    const old = refs.map((ref, i) => f.push(ref, base, { [`old-${i}.txt`]: 'carried\n' }));
    const overlays = refs.map((ref) => ({ ref }));
    gitOk(f.clone, ['fetch', '-q', 'origin']);
    const live = await planRebuild({ git: f.runGit, headSha: base, mainRef: 'origin/main', overlays });
    expect(live.applied).toHaveLength(count);
    f.push('main', base, conflicts('main'));
    refs.forEach((ref, i) => f.push(ref, old[i], { [`conflict-${i}.txt`]: 'new tip\n' }));
    gitOk(f.clone, ['fetch', '-q', 'origin']);

    // Observe the actual recursive planner entries and which old heads they attempt to pin. Cache identical
    // deterministic Git queries so the boundary cases spend time on distinct plans rather than child startup.
    const passes = [];
    const cache = new Map();
    const observedGit = (args, opts) => {
      if (args[0] === 'rev-parse' && args.at(-1) === 'origin/main^{commit}') passes.push(new Set());
      if (args[0] === 'merge-tree' && old.includes(args.at(-1))) passes.at(-1).add(refs[old.indexOf(args.at(-1))]);
      const key = JSON.stringify([args, opts]);
      if (!cache.has(key)) cache.set(key, f.runGit(args, opts));
      return cache.get(key);
    };
    const plan = await planRebuild({ git: observedGit, headSha: live.finalSha, mainRef: 'origin/main', overlays, edgeResolve: false });
    expect(plan.applied).toHaveLength(count);
    expect(plan.applied.every((a) => a.pinnedFrom)).toBe(true);
    const groups = passes.slice(1).map((pinned) => refs.filter((ref) => !pinned.has(ref)));
    expect([...passes[0]]).toEqual(refs);
    expect(groups).toHaveLength(1 + count + jointRetries);
    expect(groups[0]).toEqual(refs);
    expect(groups.slice(1, count + 1)).toEqual(refs.map((ref) => [ref]));
    expect(new Set(groups.map((group) => group.join(','))).size).toBe(groups.length);
    // Independent bit-mask oracle, ordered by subset size then lexicographic ref order.
    const expected = Array.from({ length: (1 << count) - 1 }, (_, i) =>
      refs.filter((_, bit) => (i + 1) & (1 << bit)))
      .filter((group) => group.length > 1 && group.length < count)
      .sort((a, b) => a.length - b.length || a.join(',').localeCompare(b.join(',')))
      .slice(0, 64);
    expect(groups.slice(count + 1)).toEqual(expected);
    if (count === 6) expect(groups).toHaveLength((1 << count) - 1);
  }, 120_000);

  it('overlay-pin never costs a carried overlay its retry: a new tip a later overlay makes clean beats the pin (Codex audit)', async () => {
    const base = mktemp('we-retry-pin-');
    const origin = join(base, 'origin.git');
    const clone = join(base, 'clone');
    gitOk(base, ['init', '--bare', '-q', origin]);
    mkdirSync(clone);
    gitOk(clone, ['init', '-q', '-b', 'main']);
    write(clone, 'settings.json', BASE);
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
    const runGit = (args, opts = {}) => gitRun(args, { cwd: clone, ...opts });
    const init = gitOk(clone, ['rev-parse', 'HEAD']).trim();
    const a0 = push('lane/a', init, { 'a.txt': 'a0\n' });
    gitOk(clone, ['fetch', '-q', 'origin']);
    const live = await planRebuild({ git: runGit, headSha: init, mainRef: 'origin/main', overlays: [{ ref: 'lane/a', pr: 1 }] });
    // A's new head conflicts with main's move; B (registered later) restores the shared file so A merges again
    const aNew = push('lane/a', a0, { 'settings.json': BASE.replace('  }\n}', '  },\n  "freeze": { "red": "on" }\n}') });
    const mainSha = push('main', init, { 'settings.json': BASE.replace('"x": "on"', '"x": "on",\n    "y": 15') });
    push('lane/b', mainSha, { 'settings.json': BASE, 'settings/b.json': '{ "fix": { "y": 15 } }\n' });
    gitOk(clone, ['fetch', '-q', 'origin']);
    const plan = await planRebuild({
      git: runGit, headSha: live.finalSha, mainRef: 'origin/main', overlays: [{ ref: 'lane/a', pr: 1 }, { ref: 'lane/b', pr: 2 }],
    });
    expect(plan.ok).toBe(true);
    expect(plan.decisions.find((d) => d.ref === 'lane/a')).toMatchObject({ action: 'apply', reason: 'applied-retry', sha: aNew });
    expect(plan.applied.find((x) => x.ref === 'lane/a').pinnedFrom).toBeUndefined();
    expect(plan.establishedLost).toEqual([]);
  });


  it('re-applies an overlay dropped for a conflict once a later overlay made it merge cleanly', async () => {
    const f = fixture();
    const plan = await planRebuild({
      git: f.runGit, headSha: f.mainSha, mainRef: 'origin/main', overlays: [{ ref: 'lane/a', pr: 1 }, { ref: 'lane/b', pr: 2 }],
    });
    expect(plan.ok).toBe(true);
    expect(plan.decisions.map((d) => [d.ref, d.action, d.reason])).toEqual([
      ['lane/a', 'apply', 'applied-retry'], ['lane/b', 'apply', 'applied'],
    ]);
    expect(plan.applied.map((x) => x.ref)).toEqual(['lane/b', 'lane/a']);
    expect(plan.alerts.map((x) => x.kind)).toContain('overlay-conflict-retried');
    for (const sha of [f.a, f.b]) {
      expect(spawnSync('git', ['merge-base', '--is-ancestor', sha, plan.finalSha], { cwd: f.clone }).status).toBe(0);
    }
    const merged = JSON.parse(gitOk(f.clone, ['show', `${plan.finalSha}:settings.json`]));
    expect(merged).toEqual({ a: 1, fix: { x: 'on' }, freeze: { red: 'on' } });
    // deterministic, and the adoption verifier accepts the retried chain
    const again = await planRebuild({
      git: f.runGit, headSha: f.mainSha, mainRef: 'origin/main', overlays: [{ ref: 'lane/a', pr: 1 }, { ref: 'lane/b', pr: 2 }],
    });
    expect(again.finalSha).toBe(plan.finalSha);
    expect(readyBuildVerified({ git: f.runGit, adopt: plan, mainTip: f.mainSha, prevHead: f.mainSha })).toBe(true);
  });

  it('retries a PINNED overlay that was skipped for a conflict, and shows it applied (not skipped)', async () => {
    const f = fixture({ pinnedA: true });
    const plan = await planRebuild({
      git: f.runGit, headSha: f.mainSha, mainRef: 'origin/main', overlays: [{ ref: 'lane/a', pr: 1 }, { ref: 'lane/b', pr: 2 }],
    });
    expect(plan.ok).toBe(true);
    // lane/a touches the rebuild mechanism → pinned by derivation; main already has the mechanism → skippable
    expect(plan.alerts.map((x) => x.kind)).toContain('pinned-overlay-conflict-skipped');
    expect(plan.decisions.map((d) => [d.ref, d.action, d.reason])).toEqual([
      ['lane/a', 'apply', 'applied-retry'], ['lane/b', 'apply', 'applied'],
    ]);
    expect(plan.applied.map((x) => x.ref)).toEqual(['lane/b', 'lane/a']);
    expect(spawnSync('git', ['merge-base', '--is-ancestor', f.a, plan.finalSha], { cwd: f.clone }).status).toBe(0);
    expect(readyBuildVerified({ git: f.runGit, adopt: plan, mainTip: f.mainSha, prevHead: f.mainSha })).toBe(true);
  });

  it('a pinned overlay that still conflicts after the retry stays skipped', async () => {
    const f = fixture({ pinnedA: true });
    const plan = await planRebuild({
      git: f.runGit, headSha: f.mainSha, mainRef: 'origin/main', overlays: [{ ref: 'lane/a', pr: 1 }],
    });
    expect(plan.ok).toBe(true);
    expect(plan.decisions).toEqual([expect.objectContaining({ ref: 'lane/a', action: 'skip', reason: 'pinned-overlay-conflict-skipped' })]);
    expect(plan.applied).toEqual([]);
    expect(plan.finalSha).toBe(f.mainSha);
  });

  it('a still-conflicting overlay stays dropped', async () => {
    const f = fixture();
    const plan = await planRebuild({
      git: f.runGit, headSha: f.mainSha, mainRef: 'origin/main', overlays: [{ ref: 'lane/a', pr: 1 }],
    });
    expect(plan.decisions).toEqual([expect.objectContaining({ ref: 'lane/a', action: 'drop', reason: 'conflict' })]);
    expect(plan.finalSha).toBe(f.mainSha);
  });
});
