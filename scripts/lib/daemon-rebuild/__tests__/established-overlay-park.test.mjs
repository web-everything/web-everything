import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { gitRun } from '../../main-staleness.mjs';
import { rebuildClone } from '../rebuild.mjs';
import { prepareRebuild, readOverlayEventLog } from '../prepare.mjs';
import { readRebuildState, writeRebuildState } from '../state.mjs';
import * as planner from '../plan.mjs';
import * as edgeFetch from '../edge-fetch.mjs';
import * as localState from '../local-state.mjs';
import * as lease from '../lease.mjs';
import * as repair from '../../lane-repair.mjs';
import { addOverlay, readOverlays } from '../../daemon-overlays.mjs';
import { revokedAppliedTips } from '../audited-tip.mjs';

const ref = 'lane/live', sha = 'a'.repeat(40), head = 'b'.repeat(40), main = 'c'.repeat(40);
const start = Date.parse('2026-11-18T10:00:00Z');
const planRebuild = planner.planRebuild;
describe('bounded established overlay hold', () => {
  let root, env, plan, time, mechanismFiles, classification;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'established-park-'));
    const prefs = join(root, 'prefs.json');
    writeFileSync(prefs, '{}');
    env = { WE_DAEMON_STATE_DIR: join(root, 'state'), WE_DAEMON_OVERLAY_DIR: join(root, 'overlays'),
      WE_DAEMON_EVENTS: join(root, 'events.jsonl'), WE_PLATFORM_PREFERENCES_FILE: prefs,
      WE_DAEMON_AUTO_REBASE: '0', WE_DAEMON_REBUILD_SKIP_UNRELATED: '0' };
    addOverlay(root, { ref }, { env });
    plan = { ok: true, mainSha: main, finalSha: main, inputsKey: 'main', applied: [], alerts: [],
      establishedLost: [{ ref, sha, reason: 'conflict' }],
      decisions: [{ ref, sha, action: 'drop', reason: 'conflict' }] };
    writeRebuildState(root, { adopted: { head, applied: [{ ref, sha }] },
      held: { reason: 'established-overlay-conflict', since: new Date(start).toISOString(), lastGood: head } }, env);
    time = start + 31 * 60_000;
    mechanismFiles = '';
    classification = 'available';
    vi.spyOn(localState, 'ensureSafeToMove').mockReturnValue({ safe: true, untracked: [] });
    vi.spyOn(repair, 'repairCloneRefs').mockReturnValue({ ok: true, pruned: [], reportedNew: [] });
    vi.spyOn(edgeFetch, 'fetchMainAndOverlays').mockReturnValue({ ok: true, goneRefs: [] });
    vi.spyOn(planner, 'planRebuild').mockImplementation(async () => plan);
    vi.spyOn(lease, 'claimBuildLease').mockReturnValue({ token: 'test' });
  });
  afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });
  const run = (args) => {
    const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
    if (args[0] === 'symbolic-ref') return ok('main');
    if (args[0] === 'rev-parse') return ok(args.at(-1) === 'HEAD' ? head : main);
    if (args[0] === 'ls-files' || args[0] === 'log') return ok();
    if (args[0] === 'merge-base' && args[1] !== '--is-ancestor') {
      if (classification === 'throws') throw new Error('classification unavailable');
      return classification === 'unavailable' ? { status: 1, stdout: '', stderr: '' } : ok(main);
    }
    if (args[0] === 'diff') {
      expect(args).toEqual(['diff', '--name-only', main, expect.any(String), '--', ...planner.REBUILD_MECHANISM_PATHS]);
      if (classification === 'incomplete') return { status: 0 };
      if (args[3] !== sha || !mechanismFiles) return ok();
      const matched = args.slice(5).some(path => path.endsWith('*')
        ? mechanismFiles.startsWith(path.slice(0, -1))
        : path.endsWith('/') ? mechanismFiles.startsWith(path) : mechanismFiles === path);
      return ok(matched ? mechanismFiles : '');
    }
    if (args[0] === 'merge-base') return { status: 1, stdout: '', stderr: '' };
    throw new Error(`unexpected Git: ${args.join(' ')}`);
  };
  const tick = () => prepareRebuild({ root, env, run, now: () => time, prBaseChain: () => [] });
  const held = () => readRebuildState(root, env).held;
  const parked = (r) => r.alerts.filter(a => a.kind === 'established-overlay-parked');
  const needsYou = (r) => r.alerts.filter(a => a.kind === 'established-overlay-needs-you');
  // A conflicts with main; the registered B would merge cleanly, but has no exact-tip audit.
  const movingTipScenario = ({ markerFails = false } = {}) => {
    const tip = 'e'.repeat(40), base = 'f'.repeat(40), tree = '1'.repeat(40), marker = 'd'.repeat(40);
    let current = head;
    const parents = new Map([[head, [base, sha]], [sha, [base]], [tip, [sha]], [main, [base]]]);
    const records = new Map([[head, `${base} ${sha}\tdaemon-rebuild@localhost\tdaemon-rebuild: merge overlay ${ref} onto ${base}`]]);
    const ancestor = (a, b) => a === b || (parents.get(b) ?? []).some(p => ancestor(a, p));
    const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
    const git = (args) => {
      if (args[0] === 'rev-parse') {
        const rev = args.at(-1);
        return ok(rev === 'HEAD' ? current : rev.endsWith('^{tree}') ? tree
          : rev === `refs/remotes/origin/${ref}^{commit}` ? tip : main);
      }
      if (args[0] === 'log') {
        if (args[1] === '-1') return ok('1');
        const lines = [];
        for (let at = args[3]; at && at !== main; at = parents.get(at)?.[0]) {
          if (records.has(at)) lines.push(records.get(at));
        }
        return ok(lines.join('\n'));
      }
      if (args[0] === 'merge-base' && args[1] === '--is-ancestor') {
        return { ...ok(), status: ancestor(args[2], args[3]) ? 0 : 1 };
      }
      if (args[0] === 'merge-base') return ok(base);
      if (args[0] === 'diff') return ok();
      if (args[0] === 'cherry') return ok(`+ ${args[2]}`);
      if (args[0] === 'merge-tree') return args.at(-1) === sha
        ? { ...ok(), status: 1 } : ok('2'.repeat(40));
      if (args[0] === 'commit-tree') {
        if (markerFails) return { ...ok(), status: 1, stderr: 'object database unavailable' };
        expect(args[1]).toBe(tree);
        const ps = args.flatMap((arg, i) => arg === '-p' ? [args[i + 1]] : []);
        const subject = args.at(-1);
        expect(subject).toContain('(identity marker)');
        parents.set(marker, ps);
        records.set(marker, `${ps.join(' ')}\tdaemon-rebuild@localhost\t${subject}`);
        return ok(marker);
      }
      if (args[0] === 'commit-graph') return ok();
      return run(args);
    };
    const audit = vi.fn(() => false);
    planner.planRebuild.mockImplementation(o => planRebuild({ ...o, auditedTip: audit, edgeResolve: false, stackMode: 'independent' }));
    vi.spyOn(localState, 'findUnsafeLocalState').mockReturnValue({ safe: true, untracked: [] });
    vi.spyOn(repair, 'probeBrokenRefs').mockReturnValue({ probeFailed: false, broken: [] });
    vi.spyOn(repair, 'diagnoseLane').mockReturnValue({ ok: true, problems: [] });
    return { tip, marker, audit, git,
      advance: (next) => { current = next; },
      prepare: (mode) => prepareRebuild({ root, env, run: git, now: () => time, prBaseChain: () => [], ...mode }),
    };
  };
  it('parking preserves adopted identity across advanced HEAD and still revokes an unaudited registered tip', async () => {
    const s = movingTipScenario();
    const parkedBuild = await s.prepare({ adoptOnly: true });
    expect(parked(parkedBuild)).toHaveLength(1);
    expect(parkedBuild.plan.applied).toEqual([]);
    expect(parkedBuild.plan.finalSha).toBe(s.marker);
    expect(held()).toBeNull();
    // Model adoption of the main-tree build, with no overlay content in adopted.applied.
    writeRebuildState(root, { ...readRebuildState(root, env), adopted: { head: s.marker, applied: [] } }, env);
    s.advance(s.marker);
    s.audit.mockClear();
    const next = await planRebuild({ git: s.git, headSha: s.marker, mainRef: 'origin/main',
      overlays: [{ ref }], auditedTip: s.audit, edgeResolve: false, stackMode: 'independent' });
    expect(s.audit).toHaveBeenCalledWith(ref, s.tip);
    expect(next.applied).toEqual([]);
    expect(next.alerts).toContainEqual(expect.objectContaining({ kind: 'overlay-unaudited-tip' }));
    expect(next.auditAdopted).toContain(ref);
    expect(revokedAppliedTips({ applied: [{ ref, sha: s.tip }], auditedTip: s.audit,
      auditAdopted: next.auditAdopted })).toEqual([ref]);
  });
  it('adopt-only then ready-only twice parks once without restarting the hold on audit notices', async () => {
    const s = movingTipScenario();
    const results = [];
    for (const mode of [{ adoptOnly: true }, { readyOnly: true }, { adoptOnly: true }, { readyOnly: true }]) {
      const r = await s.prepare(mode);
      results.push(r);
      expect(r.terminal).toBe(false);
      expect(held()).toBeNull();
      expect(readRebuildState(root, env).pinnedNotified[ref]).toBe(`established-overlay-parked:${sha}`);
      time += 31 * 60_000;
    }
    expect(results.flatMap(parked)).toHaveLength(1);
    expect(results.flatMap(r => r.alerts).filter(a => a.kind === 'established-overlay-hold')).toEqual([]);
    expect(results.flatMap(r => r.alerts).filter(a => a.kind === 'overlay-unaudited-tip')).toHaveLength(1);
    expect(readOverlayEventLog(root, env).filter(e => e.kind === 'established-overlay-parked')).toHaveLength(1);
  });
  it('refuses the build when the parked adopted identity marker cannot be written', async () => {
    const s = movingTipScenario({ markerFails: true });
    const r = await s.prepare({ adoptOnly: true });
    expect(r.terminal).toBe(true);
    expect(r.result.reason).toBe('pinned-overlay-hold-marker-failed');
    expect(parked(r)).toEqual([]);
    expect(readRebuildState(root, env).adopted.head).toBe(head);
  });
  it('migrates a persisted audit notice to its namespace without repeating it or erasing the park', async () => {
    const tip = 'e'.repeat(40);
    const state = readRebuildState(root, env);
    state.pinnedNotified = { [ref]: `unaudited-tip:${tip}` };
    writeRebuildState(root, state, env);
    plan.alerts = [{ kind: 'overlay-unaudited-tip', detail: { ref, newTip: tip, adopted: sha } }];
    const r = await tick();
    expect(r.alerts.some(a => a.kind === 'overlay-unaudited-tip')).toBe(false);
    expect(readRebuildState(root, env).pinnedNotified).toEqual({
      [ref]: `established-overlay-parked:${sha}`, [`unaudited-tip:${ref}`]: `unaudited-tip:${tip}`,
    });
  });
  const expectProtectedHold = async () => {
    const r = await tick();
    expect(r.result.reason).toBe('established-overlay-conflict');
    expect(r.alerts.map(a => a.kind)).toContain('established-overlay-hold');
    expect(held()).toMatchObject({ reason: 'established-overlay-conflict', lastGood: head });
    expect(parked(r)).toEqual([]);
    expect(needsYou(r)).toEqual([expect.objectContaining({ detail: expect.objectContaining({ ref, sha, need: 'needs-you' }) })]);
    time += 365 * 24 * 3_600_000;
    const again = await tick();
    expect(again.result.reason).toBe('established-overlay-conflict');
    expect(parked(again)).toEqual([]);
    expect(needsYou(again)).toEqual([]);
    expect(readOverlayEventLog(root, env).filter(e => e.kind === 'established-overlay-parked')).toEqual([]);
  };
  it.each(['scripts/lib/daemon-rebuild/prepare.mjs', 'scripts/lib/daemon-self-sync-state.mjs',
    'scripts/conveyor/pass-daemons/daemon-review.mjs'])('mechanism overlay %s holds forever and alerts needs-you once', async (file) => {
    mechanismFiles = file;
    await expectProtectedHold();
  });
  it('pinned conflict-skipped overlay holds past the threshold', async () => {
    plan.establishedLost[0].reason = 'pinned-conflict-skipped';
    await expectProtectedHold();
  });
  it('explicitly pinned overlay holds past the threshold', async () => {
    addOverlay(root, { ref, pinned: true }, { env });
    await expectProtectedHold();
  });
  it.each(['unavailable', 'throws', 'incomplete'])('classification %s fails closed to mechanism and alerts needs-you', async (mode) => {
    classification = mode;
    await expectProtectedHold();
  });
  it('mixed feature and mechanism set holds every overlay', async () => {
    const feature = { ref: 'lane/gh-per-app-pools', sha: 'e'.repeat(40), reason: 'conflict' };
    addOverlay(root, { ref: feature.ref }, { env });
    plan.establishedLost.unshift(feature);
    mechanismFiles = 'scripts/lib/daemon-rebuild/prepare.mjs';
    await expectProtectedHold();
    expect(held().lost).toEqual(plan.establishedLost.map(({ ref, sha }) => ({ ref, sha })));
  });
  it('a historical park notice cannot authorize losing a mechanism overlay', async () => {
    const state = readRebuildState(root, env);
    state.pinnedNotified = { [ref]: `established-overlay-parked:${sha}` };
    writeRebuildState(root, state, env);
    mechanismFiles = 'scripts/lib/daemon-rebuild/prepare.mjs';
    await expectProtectedHold();
  });
  it('missing main evidence fails closed to mechanism', async () => {
    delete plan.mainSha;
    await expectProtectedHold();
  });
  it('pure feature set parks after its hold expires', async () => {
    const feature = { ref: 'lane/gh-per-app-pools', sha: 'e'.repeat(40), reason: 'conflict' };
    addOverlay(root, { ref: feature.ref }, { env });
    plan.establishedLost.push(feature);
    await tick();
    time += 31 * 60_000;
    const r = await tick();
    expect(r.terminal).toBe(false);
    expect(parked(r).map(a => a.detail.ref)).toEqual([ref, feature.ref]);
    expect(held()).toBeNull();
  });
  it('holds under the threshold, including the exact boundary', async () => {
    time = start + 30 * 60_000;
    const r = await tick();
    expect(r.result.reason).toBe('established-overlay-conflict');
    expect(r.alerts.map(a => a.kind)).toContain('established-overlay-hold');
    expect(held().since).toBe(new Date(start).toISOString());
    expect(parked(r)).toEqual([]);
  });
  it('parks beyond the threshold, keeps registration and clears held before building', async () => {
    const r = await tick();
    expect(r.terminal).toBe(false);
    expect(r.plan).toBe(plan);
    expect(readOverlays(root, { env }).map(o => o.ref)).toEqual([ref]);
    expect(held()).toBeNull();
    expect(parked(r)).toEqual([{ kind: 'established-overlay-parked', detail: expect.objectContaining({ ref, sha, need: 'needs-you' }) }]);
    expect(r.alerts.map(a => a.kind)).not.toContain('established-overlay-hold');
    expect(readOverlayEventLog(root, env).filter(e => e.kind === 'established-overlay-parked'))
      .toEqual([expect.objectContaining({ ref, sha })]);
  });
  it('does not repeat the alert or re-hold the same SHA on subsequent rebuilds', async () => {
    expect(parked(await tick())).toHaveLength(1);
    for (let i = 0; i < 2; i++) {
      const r = await tick();
      expect(r.terminal).toBe(false);
      expect(parked(r)).toEqual([]);
      expect(held()).toBeNull();
    }
  });
  it('a clean reapplication clears the park notice and a recurring conflict gets a fresh hold', async () => {
    expect(parked(await tick())).toHaveLength(1);
    const lost = plan.establishedLost;
    plan.establishedLost = [];
    plan.applied = [{ ref, sha }];
    plan.decisions = [{ ref, sha, action: 'apply' }];
    time += 60_000;
    expect((await tick()).terminal).toBe(false);
    expect(readRebuildState(root, env).pinnedNotified).toBeNull();

    plan.establishedLost = lost;
    plan.applied = [];
    plan.decisions = [{ ref, sha, action: 'drop', reason: 'conflict' }];
    time += 60_000;
    const since = new Date(time).toISOString();
    const conflict = await tick();
    expect(conflict.result.reason).toBe('established-overlay-conflict');
    expect(parked(conflict)).toEqual([]);
    expect(held()).toMatchObject({ since, lost: [{ ref, sha }] });

    time += 30 * 60_000;
    const boundary = await tick();
    expect(boundary.result.reason).toBe('established-overlay-conflict');
    expect(parked(boundary)).toEqual([]);
    expect(held().since).toBe(since);

    time += 1;
    const expired = await tick();
    expect(expired.terminal).toBe(false);
    expect(parked(expired)).toEqual([expect.objectContaining({ detail: expect.objectContaining({ ref, sha, since }) })]);
    expect(held()).toBeNull();
    expect(parked(await tick())).toEqual([]);
    expect(readOverlayEventLog(root, env).filter(e => e.kind === 'established-overlay-parked')).toHaveLength(2);
  });
  it('setting zero disables parking', async () => {
    env.WE_DAEMON_ESTABLISHED_OVERLAY_PARK_MINUTES = '0';
    time += 24 * 3_600_000;
    expect((await tick()).result.reason).toBe('established-overlay-conflict');
    expect(held()).not.toBeNull();
  });
  it('a changed tip starts a fresh clock, then gets its own single alert', async () => {
    expect(parked(await tick())).toHaveLength(1);
    const next = 'd'.repeat(40);
    plan.establishedLost[0].sha = next;
    plan.decisions[0].sha = next;
    time += 60_000;
    expect((await tick()).result.reason).toBe('established-overlay-conflict');
    expect(held().since).toBe(new Date(time).toISOString());
    time += 31 * 60_000;
    expect(parked(await tick())[0].detail.sha).toBe(next);
  });
  it.each([undefined, 'unreadable'])('missing or invalid hold time %s cannot authorize parking', async (since) => {
    const state = readRebuildState(root, env);
    state.held.since = since;
    writeRebuildState(root, state, env);
    expect((await tick()).result.reason).toBe('established-overlay-conflict');
    expect(held().since).toBe(new Date(time).toISOString());
  });
  it('a changed tip during an existing hold restarts its clock', async () => {
    plan.establishedLost[0].sha = 'd'.repeat(40);
    expect((await tick()).result.reason).toBe('established-overlay-conflict');
    expect(held().since).toBe(new Date(time).toISOString());
  });
  it('pinned-overlay refusals are unchanged even after the threshold', async () => {
    plan = { ok: false, reason: 'pinned-overlay-conflict', detail: { ref }, alerts: [] };
    const r = await tick();
    expect(r.result.reason).toBe('pinned-overlay-conflict');
    expect(parked(r)).toEqual([]);
  });

  // PR #7104 round 4 — an identity marker is bookkeeping, but a registered clean repair that really carries the lost
  // tip is content. The marker must not erase that carrier proof (nor fabricate one for a sibling it does not carry).
  describe('real Git: identity markers versus a carrier repair', () => {
    const MECH = 'scripts/daemon-overlay.mjs';
    const text = (two) => `line 1\n${two}\nline 3\n`;
    const gitOk = (cwd, args) => {
      const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8', timeout: 20_000 });
      if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
      return r.stdout.trim();
    };
    const fixture = async ({ stacked = false, rebasedBase = false, movedTip = false } = {}) => {
      // Real clone, real fetch and real planner: only the rebuild's own Git and state, no injected plan.
      vi.restoreAllMocks();
      const origin = join(root, 'origin.git'), clone = join(root, 'clone'), author = join(root, 'author');
      gitOk(root, ['init', '--bare', '-q', origin]);
      gitOk(root, ['init', '-q', '-b', 'main', clone]);
      mkdirSync(join(clone, 'scripts/lib'), { recursive: true });
      writeFileSync(join(clone, MECH), text('line 2'));
      // main runs the rebuild mechanism itself, so the conflicting pinned base may be skipped (xpinskip), not refused.
      for (const m of ['scripts/lib/daemon-rebuild.mjs', 'scripts/lib/daemon-overlays.mjs']) writeFileSync(join(clone, m), 'export {};\n');
      gitOk(clone, ['add', '-A']);
      gitOk(clone, ['commit', '-q', '-m', 'init']);
      gitOk(clone, ['remote', 'add', 'origin', origin]);
      gitOk(clone, ['push', '-q', '-u', 'origin', 'main']);
      gitOk(root, ['clone', '-q', origin, author]);
      const init = gitOk(clone, ['rev-parse', 'HEAD']);
      const commitFiles = (branch, from, files, { force = false } = {}) => {
        gitOk(author, ['fetch', '-q', 'origin']);
        gitOk(author, ['checkout', '-q', '-B', branch, from]);
        for (const [p, body] of Object.entries(files)) writeFileSync(join(author, p), body);
        gitOk(author, ['add', '-A']);
        gitOk(author, ['commit', '-q', '-m', branch]);
        gitOk(author, ['push', '-q', ...(force ? ['--force'] : []), 'origin', `HEAD:refs/heads/${branch}`]);
        return gitOk(author, ['rev-parse', 'HEAD']);
      };
      const commit = (branch, from, body, extra = []) => {
        gitOk(author, ['fetch', '-q', 'origin']);
        gitOk(author, ['checkout', '-q', '-B', branch, from]);
        for (const m of extra) spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'merge', '-q', m], { cwd: author });
        writeFileSync(join(author, MECH), text(body));
        gitOk(author, ['add', '-A']);
        gitOk(author, ['commit', '-q', '-m', branch]);
        gitOk(author, ['push', '-q', 'origin', `HEAD:refs/heads/${branch}`]);
        return gitOk(author, ['rev-parse', 'HEAD']);
      };
      const e = { ...process.env, ...env, WE_DAEMON_OVERLAY_FOLLOW_TIP: 'audited-only', WE_FIX_READY_PATH: join(root, 'no-ready-records.jsonl'),
        WE_DAEMON_OVERLAY_DIR: join(root, 'clone-overlays'), WE_DAEMON_STATE_DIR: join(root, 'clone-state'),
        WE_DAEMON_CLONE_LOCK_ROOT: join(root, 'clone-lock') };
      const top = 'lane/live-top';
      // A — a mechanism-pinned overlay, adopted into the running build through a real rebuild merge record. Stacked
      // variant: top C builds on A, so C's adopted head descends from A's tip; nothing else carries either.
      const a = commit(ref, 'origin/main', 'live mechanism fix');
      const listed = [{ ref, pr: 7001 }];
      if (stacked) {
        gitOk(author, ['checkout', '-q', '-B', top, `origin/${ref}`]);
        writeFileSync(join(author, MECH), 'line 1\nlive mechanism fix\nlive top\n');
        gitOk(author, ['commit', '-q', '-am', top]);
        gitOk(author, ['push', '-q', 'origin', `HEAD:refs/heads/${top}`]);
        listed.push({ ref: top, pr: 7002 });
      }
      // Rebased-base variant: base P was adopted at P1, built on A's tip, so P1's history contains A1.
      const base = 'lane/base', newTop = 'lane/base-top';
      if (rebasedBase) {
        commitFiles(base, `origin/${ref}`, { 'other.txt': 'p1\n' });
        listed.push({ ref: base, pr: 7003 });
      }
      for (const o of listed) addOverlay(clone, o, { env: e });
      gitOk(clone, ['fetch', '-q', 'origin']);
      const first = await planRebuild({ git: (args, o = {}) => gitRun(args, { ...o, cwd: clone, env: { ...e, ...o.env } }), headSha: gitOk(clone, ['rev-parse', 'HEAD']),
        mainRef: 'origin/main', overlays: listed, prState: async () => 'OPEN', stackMode: 'independent' });
      expect(first.applied?.map(x => x.ref), JSON.stringify(first)).toEqual(listed.map(o => o.ref));
      gitOk(clone, ['checkout', '-q', '-B', 'main', first.finalSha]);
      writeRebuildState(clone, { adopted: { head: first.finalSha, applied: first.applied } }, e);
      // main rewrites the same line: A (and C) now conflict. B is the clean repair carrying both A and main.
      commit('main', 'origin/main', 'main rewrite');
      const repaired = !stacked && !rebasedBase;
      const b = repaired ? commit('lane/live-rebased', `origin/${ref}`, 'live mechanism fix + main rewrite', ['origin/main']) : null;
      if (repaired) addOverlay(clone, { ref: 'lane/live-rebased', pr: 7001, reason: `auto-rebase of ${ref}` }, { env: e });
      if (rebasedBase) {
        // P is rebased off A (P2 drops A1) and a new top T2 carries P2: P is set aside as stack-contained, and with
        // P2 unaudited its identity marker names the adopted P1 — whose history, not content, contains A1.
        commitFiles(base, init, { 'other.txt': 'p2\n' }, { force: true });
        commitFiles(newTop, `origin/${base}`, { 'top.txt': 't2\n' });
        addOverlay(clone, { ref: newTop, pr: 7004 }, { env: e });
        // Moved-tip variant: A itself advances (docs only), so it is carried but no longer established.
        if (movedTip) commitFiles(ref, `origin/${ref}`, { 'README.md': 'docs\n' });
      }
      gitOk(clone, ['fetch', '-q', 'origin']);
      const args = { root: clone, env: e, run: (argv, o = {}) => gitRun(argv, { ...o, env: { ...e, ...o.env } }), now: () => time, prBaseChain: () => [], prState: async () => 'OPEN' };
      return { clone, e, a, b, top, liveHead: first.finalSha,
        prepare: () => prepareRebuild(args),
        rebuild: () => rebuildClone({ ...args, runSmoke: async () => ({ verdict: 'pass', attempts: 1, smoke: { results: [] } }) }) };
    };

    it('a clean registered repair carrying the lost mechanism tip proceeds instead of holding', async () => {
      const f = await fixture();
      const r = await f.prepare();
      expect(r.result?.reason, JSON.stringify(r.result)).not.toBe('established-overlay-conflict');
      expect(r.plan?.applied.map(x => x.ref), JSON.stringify(r)).toContain('lane/live-rebased');
      const lost = r.plan.establishedLost.find(l => l.ref === ref);
      expect(lost).toMatchObject({ sha: f.a });
      expect(lost.identityOnly).not.toBe(true);
      expect(r.alerts.filter(x => x.kind === 'established-overlay-needs-you')).toEqual([]);
      expect(readRebuildState(f.clone, f.e).held ?? null).toBeNull();
    }, 60_000);

    it('the carrier repair smokes and is adopted, so a pending swap can retire the original', async () => {
      const f = await fixture();
      const r = await f.rebuild();
      expect(r, JSON.stringify(r)).toMatchObject({ adopted: true });
      const adopted = readRebuildState(f.clone, f.e);
      expect(adopted.held ?? null).toBeNull();
      // finishPendingSwaps retires the original once the repair's sha is an ancestor of the adopted HEAD.
      expect(spawnSync('git', ['merge-base', '--is-ancestor', f.b, 'HEAD'], { cwd: f.clone }).status).toBe(0);
      expect(adopted.adopted.applied.map(x => x.ref)).toContain('lane/live-rebased');
    }, 60_000);

    it('markers never fabricate carrier proof: a stacked base and top that both conflict still hold', async () => {
      const f = await fixture({ stacked: true });
      const r = await f.prepare();
      expect(r.result?.reason, JSON.stringify(r.result)).toBe('established-overlay-conflict');
      const lost = r.result.detail.lost;
      expect(lost.map(l => l.ref).sort()).toEqual([ref, f.top].sort());
      // Each lost tip is an ancestor of the build only through this pass's markers (the top's marker descends from
      // the base's tip), so none counts as carried.
      expect(lost.every(l => l.identityOnly === true)).toBe(true);
      expect(spawnSync('git', ['rev-parse', 'HEAD'], { cwd: f.clone, encoding: 'utf8' }).stdout.trim()).toBe(f.liveHead);
    }, 60_000);

    // Self-review of round 4: markers minted EARLIER in the same plan (a set-aside base kept at its adopted head)
    // gave a lost tip bookkeeping ancestry. Carrier proof must come from main or a real overlay merge only.
    it.each([
      ['established', { rebasedBase: true }],
      ['carried with a moved tip', { rebasedBase: true, movedTip: true }],
    ])('an earlier stack-base marker never excuses a lost %s mechanism overlay', async (_label, opts) => {
      const f = await fixture(opts);
      const r = await f.prepare();
      expect(r.result?.reason, JSON.stringify(r.result ?? r.plan?.decisions)).toBe('established-overlay-conflict');
      expect(r.result.detail.lost.map(l => l.ref)).toContain(ref);
      expect(spawnSync('git', ['rev-parse', 'HEAD'], { cwd: f.clone, encoding: 'utf8' }).stdout.trim()).toBe(f.liveHead);
    }, 60_000);
  });
});
