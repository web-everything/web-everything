/** Registration evidence must never cross a same-ref replacement, even with identical metadata. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import * as overlays from '../daemon-overlays.mjs';
import { prepareRebuild } from '../daemon-rebuild/prepare.mjs';
import { finalizeRebuild, dropSuspectOverlays } from '../daemon-rebuild/adopt.mjs';
import { smokeAndAdopt } from '../daemon-rebuild/smoke.mjs';
import { readRebuildState, writeRebuildState } from '../daemon-rebuild/state.mjs';
import { REBUILD_IDENTITY_ENV } from '../daemon-rebuild/shared.mjs';

// Spy after initialization: a partial importOriginal mock loads prepare through the
// overlays → self-sync → rebuild cycle before that mock exists, bypassing its read seam.
const seams = { visit: null };
beforeEach(() => {
  const read = overlays.readOverlayState;
  vi.spyOn(overlays, 'readOverlayState').mockImplementation((...args) => {
    seams.visit?.('readOverlayState:before');
    const result = read(...args);
    seams.visit?.('readOverlayState:after');
    return result;
  });
});
// Preparation's repair helper uses its own subprocess runner. Keep this unrelated repair inert.
vi.mock('../lane-repair.mjs', () => ({
  repairCloneRefs: () => ({ ok: true, pruned: [], reportedNew: [] }),
  holdsCloneWriteLock: () => true,
}));

const REF = 'lane/generation';
const NOW = '2026-10-21T12:00:00.000Z';
const SHA = 'a'.repeat(40);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const temps = [];
afterEach(() => {
  seams.visit = null;
  vi.restoreAllMocks();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(ref = REF) {
  const root = mkdtempSync(join(tmpdir(), 'overlay-generation-'));
  temps.push(root);
  const env = {
    PATH: process.env.PATH, HOME: root, TMPDIR: root,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(root, 'no-gitconfig'),
    GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
    WE_DAEMON_OVERLAY_DIR: join(root, 'overlays'),
    WE_DAEMON_STATE_DIR: join(root, 'state'),
    WE_DAEMON_CLONE_LOCK_ROOT: join(root, 'locks'),
    WE_DAEMON_EVENTS: join(root, 'events'),
    WE_PLATFORM_PREFERENCES_FILE: join(root, 'preferences.json'),
    WE_DAEMON_AUTO_REBASE: '0', WE_DAEMON_OVERLAY_AUTO_RETIRE: 'off',
    WE_DAEMON_OVERLAY_EDGE_RESOLVE: '0', WE_DAEMON_OVERLAY_STACK_MODE: 'independent',
    WE_DAEMON_REBUILD_SKIP_UNRELATED: '0',
  };
  const file = overlays.overlayFilePath(root, env);
  const list = () => overlays.readOverlays(root, { env });
  const add = () => overlays.addOverlay(root, { ref, pr: 17, now: NOW }, { env })[0];
  const seed = (entries) => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ clone: root, overlays: entries }));
  };
  const bytes = () => readFileSync(file, 'utf8');
  return { root, env, file, list, add, seed, bytes };
}

function gitFixture(ref = REF) {
  const f = fixture(ref);
  const git = (args, options = {}) => spawnSync('git', args, {
    cwd: f.root, env: f.env, encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024,
    ...options,
  });
  const ok = (args) => {
    const result = git(args);
    if (result.status !== 0) throw new Error(`fixture git ${args.join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
  };
  ok(['init', '-q', '-b', 'main']);
  writeFileSync(join(f.root, 'README.md'), 'base\n');
  ok(['add', '.']);
  ok(['commit', '-qm', 'base']);
  const mainSha = ok(['rev-parse', 'HEAD']);
  ok(['update-ref', 'refs/remotes/origin/main', mainSha]);
  mkdirSync(join(f.root, 'scripts/lib'), { recursive: true });
  writeFileSync(join(f.root, 'scripts/lib/daemon-rebuild.mjs'), '// mechanism supplied by overlay\n');
  ok(['add', 'scripts']);
  ok(['commit', '-qm', 'overlay mechanism']);
  const head = ok(['rev-parse', 'HEAD']);
  ok(['update-ref', `refs/remotes/origin/${ref}`, head]);
  const old = f.add();
  const adopted = { head, mainSha, applied: [{ ref, pr: 17, sha: head, registrationId: old.registrationId }], at: NOW };
  const save = (value = adopted) => writeRebuildState(f.root, { adopted: value }, f.env);
  save();
  const prepare = async ({ available = false, now = Date.parse(NOW), visit = () => {} } = {}) => {
    seams.visit = visit;
    try {
      return await prepareRebuild({ root: f.root, env: f.env, log: {}, now: () => now,
        mainOnly: false, entries: [],
        run: (args, options) => {
          visit(`git:${args[0]}:before`);
          // All remote IO is injected; no fetch, push, or network subprocess is launched.
          let result;
          if (args[0] === 'fetch') {
            result = { status: available || !args.some(a => a.includes(`heads/${ref}:`)) ? 0 : 1, stdout: '', stderr: '' };
          } else if (args[0] === 'ls-remote') result = { status: 2, stdout: '', stderr: '' };
          else result = git(args, options);
          visit(`git:${args[0]}:after`);
          return result;
        },
        prState: async () => {
          visit('prState:before-await');
          await Promise.resolve();
          visit('prState:after-await');
          return 'OPEN';
        },
        prBaseChain: async () => {
          visit('prBaseChain:before-await');
          await Promise.resolve();
          visit('prBaseChain:after-await');
          return [];
        },
      });
    } finally { seams.visit = null; }
  };
  return { ...f, old, adopted, save, prepare, git, ok };
}

function expectNoBorrowedPin(result) {
  expect(result.result?.reason).not.toBe('pinned-overlay-unavailable');
  expect(result.alerts.map(a => a.kind)).not.toContain('pinned-overlay-unavailable');
  expect(result.alerts.map(a => a.kind)).not.toContain('overlay-auto-dropped');
}

describe('overlay registration generations', () => {
  it.each([false, true])('T12 historical pin belongs only to its registration (replaced=%s)', async (replaced) => {
    const ref = 'lane/reused';
    const f = gitFixture(ref);
    const b = f.adopted.head;
    // Main and rewritten C conflict, while the already adopted B still merges cleanly.
    f.ok(['reset', '--hard', f.adopted.mainSha]);
    writeFileSync(join(f.root, 'README.md'), 'main change\n');
    f.ok(['add', 'README.md']);
    f.ok(['commit', '-qm', 'main advances']);
    const mainSha = f.ok(['rev-parse', 'HEAD']);
    f.ok(['update-ref', 'refs/remotes/origin/main', mainSha]);
    const merged = f.git(['merge', '--no-ff', b, '-m', `daemon-rebuild: merge overlay ${ref} (PR #17) onto ${mainSha}`],
      { env: { ...f.env, ...REBUILD_IDENTITY_ENV } });
    expect(merged.status).toBe(0);
    const running = f.ok(['rev-parse', 'HEAD']);
    const adopted = { ...f.adopted, head: running, mainSha };
    f.save(adopted);
    f.ok(['reset', '--hard', b]);
    writeFileSync(join(f.root, 'README.md'), 'rewritten conflicting C\n');
    f.ok(['add', 'README.md']);
    f.ok(['commit', '-qm', 'rewrite reused branch']);
    const c = f.ok(['rev-parse', 'HEAD']);
    f.ok(['update-ref', `refs/remotes/origin/${ref}`, c]);
    f.ok(['reset', '--hard', running]);
    const registration = replaced ? f.add() : f.old;
    expect(registration.registrationId === f.old.registrationId).toBe(!replaced);

    const result = await f.prepare({ available: true });
    const persisted = readRebuildState(f.root, f.env).adopted.applied;
    if (replaced) {
      expect(persisted).not.toContainEqual(expect.objectContaining({ sha: b, registrationId: registration.registrationId }));
      expect(result.plan?.applied ?? result.result?.plan?.applied ?? []).not.toContainEqual(
        expect.objectContaining({ sha: b, registrationId: registration.registrationId }));
      expect(result.alerts.map(a => a.kind)).not.toContain('overlay-pinned');
      expect(persisted).toEqual(adopted.applied);
    } else {
      expect(result.alerts.map(a => a.kind)).toContain('overlay-pinned');
      expect(persisted).toContainEqual(expect.objectContaining({ ref, sha: b, registrationId: f.old.registrationId }));
    }
    expect(f.list()).toEqual([expect.objectContaining({ ref, registrationId: registration.registrationId })]);
  });

  it.each(['distinct-ids', 'same-id', 'legacy'])('T13 duplicate refs refuse deterministically across ticks: %s', async (kind) => {
    const f = gitFixture();
    const first = kind === 'legacy' ? { ref: REF, pr: 17 } : f.old;
    const second = kind === 'legacy' ? { ref: REF, pr: 18 }
      : { ...first, registrationId: kind === 'same-id' ? first.registrationId : 'another-registration' };
    f.seed([first, second]);
    const before = f.bytes();
    for (let tick = 0; tick < 2; tick++) {
      const visits = [];
      const result = await f.prepare({ available: true, visit: point => visits.push(point) });
      expect(result).toMatchObject({ terminal: true, result: { moved: false, reason: 'overlay-registration-duplicate' } });
      expect(result.alerts).toContainEqual({ kind: 'overlay-registration-duplicate', detail: { refs: [REF] } });
      expect(result.alerts.map(a => a.kind)).not.toContain('overlay-registration-changed');
      expect(visits).not.toContain('git:fetch:before');
      expect(f.bytes()).toBe(before);
      expect(readRebuildState(f.root, f.env).adopted).toEqual(f.adopted);
    }
  });

  it('T1 property: inject addOverlay(root,{ref}) at each point prepareRebuild reads the list or awaits', async () => {
    // Discover every read/run/await boundary on both the unavailable-pin and refreshed-plan paths.
    // Each replay starts from the same old evidence; never reuse a mutated fixture between points.
    for (const available of [false, true]) {
      const control = gitFixture();
      const points = [];
      const baseline = await control.prepare({ available, visit: label => points.push(label) });
      if (!available) expect(baseline.result?.reason).toBe('pinned-overlay-unavailable');
      else { expect(baseline.terminal).toBe(false); expect(baseline.plan?.ok).toBe(true); }
      expect(points).toContain('readOverlayState:after');
      if (available) expect(points).toContain('prState:after-await');
      for (let point = 0; point < points.length; point++) {
        const f = gitFixture();
        let cursor = 0;
        let replacement;
        let snapshotSeen = false;
        let changedAfterSnapshot = false;
        const result = await f.prepare({ available, visit: label => {
          if (cursor++ === point) {
            changedAfterSnapshot = snapshotSeen;
            replacement = f.add();
          }
          if (label === 'readOverlayState:after') snapshotSeen = true;
        } });
        const context = `${available ? 'refreshed' : 'missing'} point ${point}: ${points[point]}`;
        expect.soft(replacement, context).toBeDefined();
        expect.soft(result.result?.reason, context).not.toBe('pinned-overlay-unavailable');
        expect.soft(result.alerts.map(a => a.kind), context).not.toContain('pinned-overlay-unavailable');
        expect.soft(result.alerts.map(a => a.kind), context).not.toContain('overlay-auto-dropped');
        expect.soft(f.list(), context).toEqual([expect.objectContaining({ ref: REF, registrationId: replacement.registrationId })]);
        expect.soft(f.list()[0]?.tipSha, context).toBeUndefined();
        if (changedAfterSnapshot || points[point] === 'readOverlayState:after') {
          expect.soft(result.terminal, context).toBe(true);
          expect.soft(result.result?.moved, context).toBe(false);
          expect.soft(result.alerts.map(a => a.kind), context).toContain('overlay-registration-changed');
        }
      }
    }
  }, 60_000);

  it('T2 re-register same ref/pr/frozen now -> new registrationId different from the old, tipSha cleared, appliedRowFor(adopted, ref, newId) is null', () => {
    const f = fixture();
    const old = f.add();
    f.seed([{ ...old, tipSha: SHA }]);
    const row = { ref: REF, sha: SHA, registrationId: old.registrationId };
    const adopted = { applied: [row] };
    const next = f.add();
    expect(next.registrationId).toMatch(UUID);
    expect(next.registrationId).not.toBe(old.registrationId);
    expect(next.addedAt).toBe(old.addedAt);
    expect(next.tipSha).toBeUndefined();
    expect(overlays.appliedRowFor(adopted, REF, old.registrationId)).toEqual(row);
    expect(overlays.appliedRowFor(adopted, REF, next.registrationId)).toBeNull();
    expect(overlays.appliedRowFor(null, REF, next.registrationId)).toBeNull();
  });

  it('T2 generation defaults to zero and addOverlay/removeOverlay increment it on each write', () => {
    const f = fixture();
    expect(overlays.readOverlayState(f.root, { env: f.env }).generation).toBe(0);
    f.add();
    expect(overlays.readOverlayState(f.root, { env: f.env }).generation).toBe(1);
    const next = f.add();
    expect(overlays.readOverlayState(f.root, { env: f.env }).generation).toBe(2);
    overlays.removeOverlay(f.root, REF, { env: f.env, expectRegistrationId: next.registrationId });
    expect(overlays.readOverlayState(f.root, { env: f.env }).generation).toBe(3);
    expect(JSON.parse(f.bytes()).generation).toBe(3);
  });

  it('T3 remove + re-add between snapshot and persistTipShas -> persistTipShas with the old registrationId writes nothing (written: 0)', () => {
    const f = fixture();
    const old = f.add();
    overlays.removeOverlay(f.root, REF, { env: f.env, expectRegistrationId: old.registrationId });
    const next = f.add();
    const before = f.bytes();
    const tips = new Map([[REF, { sha: SHA, reg: overlays.registrationIdentity(old), registrationId: old.registrationId }]]);
    expect(overlays.persistTipShas(f.root, tips, { env: f.env })).toEqual({ written: 0 });
    expect(f.bytes()).toBe(before);
    // The explicit id must be checked independently, even if a later read supplied current metadata.
    tips.set(REF, { sha: SHA, reg: overlays.registrationIdentity(next), registrationId: old.registrationId });
    expect(overlays.persistTipShas(f.root, tips, { env: f.env })).toEqual({ written: 0 });
    expect(f.bytes()).toBe(before);
  });

  it('T4 re-register between classification and removeOverlay -> removeOverlay with expectRegistrationId=old throws /registration changed/, entry stays', () => {
    const f = fixture();
    const old = f.add();
    const next = f.add();
    const before = f.bytes();
    expect(() => overlays.removeOverlay(f.root, REF, { env: f.env, expectRegistrationId: old.registrationId })).toThrow(/registration changed/);
    expect(f.bytes()).toBe(before);
    expect(f.list()).toEqual([next]);
    f.seed([{ ref: REF, pr: 17 }]);
    expect(() => overlays.removeOverlay(f.root, REF, { env: f.env, expectRegistrationId: old.registrationId })).toThrow(/registration changed/);
    expect(f.list()).toEqual([{ ref: REF, pr: 17 }]);
  });

  // A caller that asks for the CAS but has no token (a snapshot miss, a ref it already dropped and deleted from
  // its snapshot, a legacy record) must never fall through to an unconditional removal.
  it.each([undefined, null, '', 7])('T4b an explicit but unusable expectRegistrationId (%s) refuses removal, entry stays', (token) => {
    const f = fixture();
    const current = f.add();
    const before = f.bytes();
    expect(() => overlays.removeOverlay(f.root, REF, { env: f.env, expectRegistrationId: token })).toThrow(/registration changed/);
    expect(f.bytes()).toBe(before);
    expect(f.list()).toEqual([current]);
    f.seed([{ ref: REF, pr: 17 }]);
    expect(() => overlays.removeOverlay(f.root, REF, { env: f.env, expectRegistrationId: token })).toThrow(/registration changed/);
    expect(f.list()).toEqual([{ ref: REF, pr: 17 }]);
  });

  it('T4c removal without the CAS option keeps its unconditional operator semantics', () => {
    const f = fixture();
    f.add();
    expect(overlays.removeOverlay(f.root, REF, { env: f.env }).removed).toBe(true);
    expect(f.list()).toEqual([]);
  });

  it('T5 migration idempotent + shared id: legacy entry and legacy applied row get the SAME id', () => {
    const f = fixture();
    f.seed([{ ref: REF, pr: 17 }]);
    const adopted = { head: SHA, applied: [{ ref: REF, pr: 17, sha: SHA }] };
    const original = structuredClone(adopted);
    const first = overlays.migrateRegistrationIds(f.root, { env: f.env, adopted });
    const id = first.list[0].registrationId;
    expect(id).toMatch(UUID);
    expect(first.stamped).toEqual([{ ref: REF, registrationId: id }]);
    expect(first.unprovable).toEqual([]);
    expect(first.adopted.applied[0]).toEqual({ ...adopted.applied[0], registrationId: id });
    expect(adopted).toEqual(original);
    expect(overlays.readOverlayState(f.root, { env: f.env }).generation).toBe(1);
    const before = f.bytes();
    const second = overlays.migrateRegistrationIds(f.root, { env: f.env, adopted: first.adopted });
    expect(second).toMatchObject({ list: first.list, stamped: [], unprovable: [], adopted: first.adopted });
    expect(f.bytes()).toBe(before);
    expect(overlays.readOverlayState(f.root, { env: f.env }).generation).toBe(1);
  });

  it.each(['duplicate-ref', 'pr-mismatch'])('T5 migration idempotent + shared id: %s -> unprovable, row unstamped, prepareRebuild alerts and inherits no pin', async (kind) => {
    const f = gitFixture();
    const entries = kind === 'duplicate-ref' ? [{ ref: REF, pr: 17 }, { ref: REF, pr: 17 }] : [{ ref: REF, pr: 18 }];
    const adopted = { ...f.adopted, applied: [{ ref: REF, pr: 17, sha: f.adopted.head }] };
    f.seed(entries);
    const migrated = overlays.migrateRegistrationIds(f.root, { env: f.env, adopted });
    expect(migrated.unprovable).toContainEqual({ ref: REF });
    expect(migrated.adopted.applied[0].registrationId).toBeUndefined();
    expect(new Set(migrated.list.map(o => o.registrationId)).size).toBe(entries.length);
    for (const entry of migrated.list) expect(entry.registrationId).toMatch(UUID);
    // Preparation refuses ambiguous registries before migration; unique entries still report
    // unprovable legacy adopted evidence through the migration path.
    f.seed(entries);
    f.save(adopted);
    const result = await f.prepare();
    expectNoBorrowedPin(result);
    if (kind === 'duplicate-ref') {
      expect(result).toMatchObject({ terminal: true, result: { reason: 'overlay-registration-duplicate' } });
      expect(result.alerts.map(a => a.kind)).toContain('overlay-registration-duplicate');
      expect(f.list()).toEqual(entries);
      expect(readRebuildState(f.root, f.env).adopted).toEqual(adopted);
    } else expect(result.alerts.map(a => a.kind)).toContain('overlay-registration-unprovable');
    expect(f.list()).toHaveLength(entries.length);
  });

  it('T5 migration with null adopted stamps only legacy entries; missing row pr does not prevent a unique match', () => {
    const f = fixture();
    const current = f.add();
    f.seed([current, { ref: 'lane/legacy', pr: 19 }]);
    const result = overlays.migrateRegistrationIds(f.root, { env: f.env, adopted: null });
    expect(result.adopted).toBeNull();
    expect(result.list[0]).toEqual(current);
    expect(result.stamped).toEqual([{ ref: 'lane/legacy', registrationId: result.list[1].registrationId }]);
    f.seed([{ ref: REF, pr: 17 }]);
    const matched = overlays.migrateRegistrationIds(f.root, { env: f.env, adopted: { applied: [{ ref: REF, sha: SHA }] } });
    expect(matched.adopted.applied[0].registrationId).toBe(matched.list[0].registrationId);
  });

  it('T6 stale-broken lock: writer B re-registers after holder died; writer A removeOverlay({expectRegistrationId: X}) fails and entry stays', () => {
    const f = fixture();
    const writerASnapshot = f.add();
    const lock = `${f.file}.lock`;
    // Model the dead holder's abandoned mutex without sleeps or a live blocked subprocess.
    mkdirSync(lock);
    const stale = new Date(Date.now() - 120_000);
    utimesSync(lock, stale, stale);
    const writerB = f.add();
    expect(writerB.registrationId).not.toBe(writerASnapshot.registrationId);
    const before = f.bytes();
    expect(() => overlays.removeOverlay(f.root, REF, { env: f.env,
      expectRegistrationId: writerASnapshot.registrationId })).toThrow(/registration changed/);
    expect(f.bytes()).toBe(before);
    expect(f.list()).toEqual([writerB]);
  });

  it('T8 clock sweep: running the same snapshot decision with now varied across 3 values yields identical decisions', async () => {
    const f = gitFixture();
    f.add();
    const decisions = [];
    for (const now of [Date.parse(NOW) - 86_400_000, Date.parse(NOW), Date.parse(NOW) + 86_400_000]) {
      f.save();
      const result = await f.prepare({ now });
      expectNoBorrowedPin(result);
      decisions.push({ terminal: result.terminal, reason: result.result?.reason,
        alerts: result.alerts.map(a => a.kind), ids: f.list().map(o => o.registrationId) });
    }
    expect(decisions[1]).toEqual(decisions[0]);
    expect(decisions[2]).toEqual(decisions[0]);
  });

  it('T9 after migration an adopted.applied row WITHOUT registrationId is rejected: appliedRowFor returns null and prepareRebuild does not raise pinned-overlay-unavailable from it', async () => {
    const f = gitFixture();
    f.seed([{ ref: REF, pr: 17 }]);
    const migrated = overlays.migrateRegistrationIds(f.root, { env: f.env, adopted: null });
    const adopted = { ...f.adopted, applied: [{ ref: REF, pr: 17, sha: f.adopted.head }] };
    expect(overlays.appliedRowFor(adopted, REF, migrated.list[0].registrationId)).toBeNull();
    // Equality of two absent ids cannot prove membership either.
    expect(overlays.appliedRowFor(adopted, REF, undefined)).toBeNull();
    f.save(adopted);
    const result = await f.prepare();
    expectNoBorrowedPin(result);
    expect(f.list()[0].registrationId).toBe(migrated.list[0].registrationId);
  });

  it('T11 a re-registered ref whose RUNNING content changes the mechanism holds as pinned-overlay-unbound when its branch is missing', async () => {
    const f = gitFixture();
    const replacement = f.add();
    const result = await f.prepare();
    // No borrowed pin: the refusal names the running row's content, never the old registration's evidence.
    expectNoBorrowedPin(result);
    expect(result).toMatchObject({ terminal: true, result: { moved: false, reason: 'pinned-overlay-unbound',
      detail: { ref: REF, registrationId: replacement.registrationId, sha: f.adopted.head, pinnedBy: 'mechanism' } } });
    expect(result.alerts.map(a => a.kind)).toContain('pinned-overlay-unbound');
    expect(f.list()).toEqual([expect.objectContaining({ ref: REF, registrationId: replacement.registrationId })]);
    expect(f.list()[0].tipSha).toBeUndefined();
    expect(readRebuildState(f.root, f.env).held).toMatchObject({ reason: 'pinned-overlay-unbound', lastGood: f.adopted.head });
  });

  it.each(['main-content', 'malformed-sha'])('T11 unbound running row: %s', async (kind) => {
    const f = gitFixture();
    f.add();
    const sha = kind === 'main-content' ? f.adopted.mainSha : 'not-a-sha';
    f.save({ ...f.adopted, applied: [{ ...f.adopted.applied[0], sha }] });
    const result = await f.prepare();
    expectNoBorrowedPin(result);
    if (kind === 'main-content') {
      // Running content main already has changes no mechanism: the replacement is skipped, never held.
      expect(result.result?.reason).not.toBe('pinned-overlay-unbound');
      expect(result.alerts.map(a => a.kind)).toContain('overlay-fetch-unverifiable');
    } else {
      // Unreadable running evidence cannot prove the content harmless: fail closed.
      expect(result).toMatchObject({ terminal: true, result: { reason: 'pinned-overlay-unbound',
        detail: { sha: null, pinnedBy: 'unknown' } } });
    }
  });

  it.each(['own-harmless-tip', 'harmless-duplicate-row-first'])('T11 running mechanism row still holds: %s', async (kind) => {
    const f = gitFixture();
    const replacement = f.add();
    const mechanismRow = f.adopted.applied[0];
    if (kind === 'own-harmless-tip') {
      // The replacement refreshed to a tip with no mechanism change, then its branch went missing again.
      f.seed(f.list().map(o => (o.ref === REF ? { ...o, tipSha: f.adopted.mainSha } : o)));
    } else {
      f.save({ ...f.adopted, applied: [{ ...mechanismRow, sha: f.adopted.mainSha }, mechanismRow] });
    }
    const result = await f.prepare();
    expectNoBorrowedPin(result);
    expect(result).toMatchObject({ terminal: true, result: { moved: false, reason: 'pinned-overlay-unbound',
      detail: { ref: REF, registrationId: replacement.registrationId, sha: f.adopted.head, pinnedBy: 'mechanism' } } });
    expect(result.alerts.map(a => a.kind)).not.toContain('overlay-fetch-unverifiable');
    expect(readRebuildState(f.root, f.env).held).toMatchObject({ reason: 'pinned-overlay-unbound', lastGood: f.adopted.head });
  });

  it.each(['already-adopted', 'moved'])('T10 adopt CAS: %s strips replaced ids and preserves matching evidence', async (branch) => {
    const f = gitFixture();
    const kept = overlays.addOverlay(f.root, { ref: 'lane/kept' }, { env: f.env }).find(o => o.ref === 'lane/kept');
    const replacement = f.add();
    const applied = [...f.adopted.applied, { ref: kept.ref, sha: SHA, registrationId: kept.registrationId },
      { ref: 'lane/legacy', sha: SHA }];
    const finalSha = branch === 'already-adopted' ? f.adopted.head : f.adopted.mainSha;
    const result = await finalizeRebuild({ root: f.root, env: f.env, log: {}, now: () => Date.parse(NOW),
      lease: { token: 'cas-test' }, prevHead: f.adopted.head, plan: { finalSha, mainSha: f.adopted.mainSha, inputsKey: 'cas', applied },
      run: (args, options) => spawnSync('git', args, { ...options, env: f.env, cwd: f.root, encoding: 'utf8' }),
    });
    expect(result.adopted).toBe(true);
    expect(result.moved).toBe(branch === 'moved');
    expect(result.alerts.map(a => a.kind)).toContain('overlay-registration-changed');
    const { registrationId, ...unbound } = applied[0];
    expect(readRebuildState(f.root, f.env).adopted.applied).toEqual([unbound, ...applied.slice(1)]);
    expect(overlays.appliedRowFor(readRebuildState(f.root, f.env).adopted, REF, replacement.registrationId)).toBeNull();
    expect(f.list()).toContainEqual(replacement);
  });

  it.each([
    { branch: 'already-adopted', guard: 'default' },
    { branch: 'moved', guard: 'default' },
    { branch: 'already-adopted', guard: 'explicit true' },
    { branch: 'moved', guard: 'explicit true' },
  ])('T10 archive guard $guard: corrupt registry refuses $branch and preserves HEAD and adopted state', async ({ branch, guard }) => {
    const f = gitFixture();
    const before = readRebuildState(f.root, f.env).adopted;
    writeFileSync(f.file, '{broken');
    const onAdopted = vi.fn();
    const run = vi.fn((args, options) => spawnSync('git', args, { ...options, env: f.env, cwd: f.root, encoding: 'utf8' }));
    const result = await finalizeRebuild({ root: f.root, env: f.env, log: {}, now: () => Date.parse(NOW),
      lease: { token: 'cas-test' }, prevHead: f.adopted.head,
      plan: { finalSha: branch === 'already-adopted' ? f.adopted.head : f.adopted.mainSha,
        mainSha: f.adopted.mainSha, inputsKey: 'unreadable', applied: f.adopted.applied },
      run, onAdopted,
      ...(guard === 'explicit true' ? { archiveGuard: true } : {}),
    });
    expect(f.ok(['rev-parse', 'HEAD'])).toBe(f.adopted.head);
    expect(result).toMatchObject({ moved: false, reason: 'overlay-source-unverifiable' });
    expect(result.adopted).not.toBe(true);
    expect(result.alerts).toContainEqual(expect.objectContaining({ kind: 'overlay-source-unavailable',
      detail: expect.objectContaining({ error: 'overlay registry unreadable' }) }));
    expect(run.mock.calls.some(([args]) => args[0] === 'reset')).toBe(false);
    expect(onAdopted).not.toHaveBeenCalled();
    expect(readRebuildState(f.root, f.env).adopted).toEqual(before);
    expect(f.bytes()).toBe('{broken');
  });

  it.each(['already-adopted', 'moved'])('T10 archiveGuard false mainOnly bypass: corrupt registry permits %s adoption but cannot establish registration evidence', async (branch) => {
    const f = gitFixture();
    writeFileSync(f.file, '{broken');
    // mainOnly deliberately skips archive checks; its adoption CAS must still strip unprovable ids.
    const finalSha = branch === 'already-adopted' ? f.adopted.head : f.adopted.mainSha;
    const onAdopted = vi.fn();
    const result = await finalizeRebuild({ root: f.root, env: f.env, log: {}, now: () => Date.parse(NOW),
      archiveGuard: false, onAdopted,
      lease: { token: 'cas-test' }, prevHead: f.adopted.head, plan: { finalSha, mainSha: f.adopted.mainSha,
        inputsKey: 'unreadable', applied: f.adopted.applied },
      run: (args, options) => spawnSync('git', args, { ...options, env: f.env, cwd: f.root, encoding: 'utf8' }),
    });
    expect(result.adopted).toBe(true);
    expect(result.moved).toBe(branch === 'moved');
    expect(f.ok(['rev-parse', 'HEAD'])).toBe(finalSha);
    expect(onAdopted).toHaveBeenCalledTimes(1);
    expect(result.alerts.map(a => a.kind)).not.toContain('overlay-source-unavailable');
    expect(result.alerts.map(a => a.kind)).toContain('overlay-registration-changed');
    expect(readRebuildState(f.root, f.env).adopted).toMatchObject({ head: finalSha, inputsKey: 'unreadable' });
    const { registrationId, ...unbound } = f.adopted.applied[0];
    expect(readRebuildState(f.root, f.env).adopted.applied).toEqual([unbound]);
    expect(f.bytes()).toBe('{broken');
  });

  it('T10 adopt CAS: suspect replacement is kept without a drop event', () => {
    const f = fixture();
    const suspect = f.add();
    const replacement = f.add();
    const alert = vi.fn();
    const before = f.bytes();
    dropSuspectOverlays({ root: f.root, env: f.env, suspects: [suspect], failed: 'smoke', alert });
    expect(f.bytes()).toBe(before);
    expect(f.list()).toEqual([replacement]);
    expect(alert.mock.calls).toEqual([['overlay-registration-changed', { ref: REF }]]);
    expect(() => readFileSync(f.file.replace(/\.json$/, '.events.jsonl'), 'utf8')).toThrow(/ENOENT/);
  });

  it.each([undefined, null, ''])('T11 suspect without a usable registrationId (%s) is kept without a drop event', (registrationId) => {
    const f = fixture();
    const suspect = { ...f.add(), registrationId };
    const replacement = f.add();
    const alert = vi.fn();
    const before = f.bytes();
    dropSuspectOverlays({ root: f.root, env: f.env, suspects: [suspect], failed: 'smoke', alert });
    expect(f.bytes()).toBe(before);
    expect(f.list()).toEqual([replacement]);
    expect(alert.mock.calls).toEqual([['overlay-registration-changed', { ref: REF }]]);
    expect(() => readFileSync(f.file.replace(/\.json$/, '.events.jsonl'), 'utf8')).toThrow(/ENOENT/);
  });

  it('T11 suspect with a matching registrationId is dropped', () => {
    const f = fixture();
    const suspect = f.add();
    const alert = vi.fn();
    dropSuspectOverlays({ root: f.root, env: f.env, suspects: [suspect], failed: 'smoke', alert });
    expect(f.list()).toEqual([]);
    expect(alert.mock.calls.map(([kind]) => kind)).toEqual(['overlay-dropped-smoke-failed']);
    const events = readFileSync(f.file.replace(/\.json$/, '.events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    expect(events).toContainEqual(expect.objectContaining({ kind: 'dropped-smoke-failed', ref: REF }));
  });
});


describe.each(['dispatch failure', 'plain-main fallback'])('T14 smoke removal CAS: %s', (path) => {
  it.each([
    { name: 'keeps a replacement registered during smoke', identity: 'replaced' },
    { name: 'keeps a replacement when smoke evidence has no registration ID', identity: 'missing' },
    { name: 'keeps a replacement when smoke evidence has a null registration ID', identity: 'null' },
    { name: 'keeps a replacement when smoke evidence has an empty registration ID', identity: 'empty' },
    { name: 'removes the original registration when its smoke evidence matches', identity: 'original' },
  ])('$name', async ({ identity }) => {
    const f = gitFixture();
    const mainSha = f.adopted.mainSha;
    f.ok(['reset', '--hard', mainSha]);
    f.save(null);
    // This overlay changes the dispatch path, but none of the rebuild mechanism.
    const dispatchPath = 'scripts/operations/dispatch-lane-io.mjs';
    mkdirSync(dirname(join(f.root, dispatchPath)), { recursive: true });
    writeFileSync(join(f.root, dispatchPath), 'export const broken = true;\n');
    f.ok(['add', dispatchPath]);
    f.ok(['commit', '-qm', 'overlay dispatch change']);
    const sha = f.ok(['rev-parse', 'HEAD']);
    f.ok(['update-ref', `refs/remotes/origin/${REF}`, sha]);
    f.ok(['reset', '--hard', mainSha]);
    const applied = { ref: REF, pr: 17, sha };
    if (identity !== 'missing') applied.registrationId = identity === 'null' ? null
      : identity === 'empty' ? '' : f.old.registrationId;
    const plan = { ok: true, finalSha: sha, mainSha, inputsKey: 'smoke-cas', applied: [applied] };
    const pass = { verdict: 'pass', smoke: { results: [] } };
    const fail = { verdict: 'code', smoke: { results: [{ name: 'fixture-check', ok: false, detail: 'broken code' }] } };
    let replacement;
    const replaceDuringSmoke = () => {
      if (identity !== 'original') replacement = f.add();
    };
    const dispatch = vi.fn(async () => {
      replaceDuringSmoke();
      return { ok: false, reason: 'launch-failed' };
    });
    let smokeCalls = 0;
    const runSmoke = vi.fn(async () => {
      smokeCalls += 1;
      if (path === 'dispatch failure') return pass;
      if (smokeCalls === 1) return fail;
      // Re-register after the fallback captured the failing candidate's suspects,
      // while its passing smoke is running and before adoption drops those suspects.
      replaceDuringSmoke();
      return pass;
    });
    const result = await smokeAndAdopt({
      root: f.root, env: f.env, stEnv: f.env, log: {}, run: f.git, runSmoke,
      now: () => Date.parse(NOW), plan, prevHead: mainSha,
      lease: { token: null, path: join(f.env.WE_DAEMON_STATE_DIR, 'smoke-cas-candidate') },
      overlaysBefore: [f.old], prepAlerts: [], mainOnly: false,
      finalLockOpts: { waitMs: 1500, pollMs: 20 },
      dispatchSmoke: { settings: { dispatchSmoke: path === 'dispatch failure' ? 'on' : 'off',
        dispatchPaths: [dispatchPath], noPr: 'warn', smokeTimeoutMs: 60_000, smokeKind: 'ci-heal' }, run: dispatch },
    });
    expect(result.reason).toBe(path === 'dispatch failure' ? 'dispatch-smoke-failed' : 'fallback-plain-main');
    expect(runSmoke).toHaveBeenCalledTimes(path === 'dispatch failure' ? 1 : 2);
    expect(dispatch).toHaveBeenCalledTimes(path === 'dispatch failure' ? 1 : 0);
    expect(!!result.adopted).toBe(path === 'plain-main fallback');
    expect(f.ok(['rev-parse', 'HEAD'])).toBe(mainSha);
    const kinds = result.alerts.map(a => a.kind);
    const dropKind = path === 'dispatch failure' ? 'dropped-dispatch-smoke-failed' : 'dropped-smoke-failed';
    const eventFile = f.file.replace(/\.json$/, '.events.jsonl');
    let events = [];
    try { events = readFileSync(eventFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (identity === 'original') {
      expect(f.list()).toEqual([]);
      expect(kinds).not.toContain('overlay-registration-changed');
      expect(events.filter(e => e.kind === dropKind)).toEqual([expect.objectContaining({ ref: REF })]);
    } else {
      expect(replacement.registrationId).not.toBe(f.old.registrationId);
      expect(f.list()).toEqual([replacement]);
      expect(kinds).toContain('overlay-registration-changed');
      expect(events.filter(e => e.kind.startsWith('dropped-'))).toEqual([]);
    }
  });
});
