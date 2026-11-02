import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareRebuild } from '../daemon-rebuild/prepare.mjs';
import { autoRetireOverlays } from '../daemon-overlay-auto-retire.mjs';
import { addOverlay, appendOverlayEvent, migrateRegistrationIds, overlayFilePath, persistTipShas, readOverlayState, registrationIdentity,
  reinstateOverlaySources, removeOverlay, writeOverlays } from '../daemon-overlays.mjs';
import { readReadyCandidate, writeReadyCandidate, writeRebuildState } from '../daemon-rebuild/state.mjs';
import { finalizeRebuild } from '../daemon-rebuild/adopt.mjs';

// Exercise preparation and real registry storage without network or .git writes.
vi.mock('../lane-repair.mjs', () => ({ repairCloneRefs: () => ({ ok: true, pruned: [], reportedNew: [] }), holdsCloneWriteLock: () => true }));
vi.mock('../daemon-rebuild/local-state.mjs', async (original) => ({
  ...await original(), ensureSafeToMove: () => ({ safe: true, untracked: [] }),
  pruneLandedBacklogSidecars: () => {}, collectUntrackedPaths: () => [],
}));
const model = vi.hoisted(() => ({ plans: [], rewritten: false, closed: false, missing: false, gitError: false }));
vi.mock('../daemon-overlays.mjs', async (original) => {
  const actual = await original();
  return { ...actual,
    persistTipShas: (...args) => {
      model.persisted.push(args[1]);
      model.onPersist?.();
      if (model.failTips) throw new Error('tip disk full');
      return actual.persistTipShas(...args);
    },
    appendOverlayEvent: (...args) => {
      if (model.failAudit && args[1].kind === 'removed') throw new Error('audit disk full');
      return actual.appendOverlayEvent(...args);
    },
  };
});
vi.mock('../daemon-rebuild/plan.mjs', async (original) => ({
  ...await original(),
  planRebuild: async ({ overlays }) => {
    model.onPlan?.();
    model.plans.push(overlays.map((o) => o.ref));
    const applied = overlays.filter((o) => !(model.closed && o.ref === 'top'));
    const carries = applied.some((o) => o.ref === 'lower' || (o.ref === 'top' && !model.rewritten));
    return { ok: true, upToDate: model.upToDate ?? true, mainSha: '1'.repeat(40), finalSha: (carries ? '4' : '5').repeat(40),
      applied: applied.map((o) => ({ ref: o.ref, sha: (o.ref === 'lower' ? model.lowerTip : '3').repeat(40) })),
      decisions: overlays.map((o) => ({ ref: o.ref, pr: o.pr,
        action: model.closed && o.ref === 'top' ? 'remove' : 'apply', reason: 'pr-closed' })),
      alerts: [], establishedLost: [], inputsKey: 'test' };
  },
}));

// The saved-candidate matcher and finalize are stubbed per test so preparation's own archive guard is what decides.
vi.mock('../daemon-rebuild/adopt.mjs', async (original) => {
  const actual = await original();
  return { ...actual,
    matchReadyCandidate: (args) => (model.readyMatch ? model.readyMatch(args) : actual.matchReadyCandidate(args)),
    finalizeRebuild: (args) => (model.finalize ? model.finalize(args) : actual.finalizeRebuild(args)),
  };
});

let root;
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  root = mkdtempSync(join(tmpdir(), 'retired-sources-'));
  Object.assign(model, { plans: [], rewritten: false, closed: false, missing: false, gitError: false,
    lowerTip: '2', persisted: [], failTips: false, failAudit: false, onPersist: null, onPlan: null,
    upToDate: undefined, readyMatch: null, finalize: null, gitErrorTarget: null });
  const env = { WE_DAEMON_OVERLAY_DIR: join(root, 'overlays'), WE_DAEMON_STATE_DIR: join(root, 'state'),
    WE_DAEMON_EVENTS: join(root, 'events'), WE_PLATFORM_PREFERENCES_FILE: join(root, 'preferences'),
    WE_DAEMON_AUTO_REBASE: '0', WE_DAEMON_OVERLAY_AUTO_RETIRE: 'on', WE_DAEMON_OVERLAY_EDGE_RESOLVE: '0' };
  const result = (stdout = '', status = 0) => ({ stdout, status });
  const git = (args) => {
    const [cmd, ...rest] = args;
    if (cmd === 'symbolic-ref') return result('main');
    if (cmd === 'fetch') return result('', model.missing && args.some((a) => a.includes('heads/lower:')) ? 1 : 0);
    if (cmd === 'ls-remote') return result('', 2);
    if (cmd === 'update-ref') return result();
    if (cmd === 'rev-parse') {
      const ref = rest.at(-1).replace(/\^\{(?:commit|tree)\}$/, '');
      return result(/^[0-9a-f]{40}$/.test(ref) ? ref : (ref.endsWith('/lower') ? model.lowerTip : ref.endsWith('/top') ? (model.rewritten ? '6' : '3') : '1').repeat(40));
    }
    if (cmd === 'for-each-ref') {
      const ref = rest.at(-1);
      return result(`${ref} ${(ref.endsWith('/lower') ? model.lowerTip : model.rewritten ? '6' : '3').repeat(40)}`);
    }
    if (cmd === 'merge-base') {
      if (rest[0] !== '--is-ancestor') return result('1'.repeat(40));
      const [, a, b] = rest;
      if (model.gitError && a === '2'.repeat(40)) return result('', 128);
      if (model.gitErrorTarget && b === model.gitErrorTarget) return result('', 128);
      return result('', a === b || (a === '2'.repeat(40) && ['3'.repeat(40), '4'.repeat(40)].includes(b)) ? 0 : 1);
    }
    if (cmd === 'diff') return result();
    if (cmd === 'log') return result();
    if (cmd === 'cherry') return result(`+ ${'2'.repeat(40)}`);
    if (cmd === 'merge-tree') return result('7'.repeat(40));
    throw new Error(`Unexpected Git command: ${args.join(' ')}`);
  };
  const entries = [{ ref: 'lower', pr: 1 }, { ref: 'top', pr: 2 }];
  writeOverlays(root, entries, { env });
  const retire = () => autoRetireOverlays({ root, env, overlays: readOverlayState(root, { env }).overlays, git, mainSha: '1'.repeat(40),
    refEvidence: new Map(entries.map((o) => [o.ref, 'refreshed'])) });
  const prepare = (options = {}) => prepareRebuild({ root, env, run: git, now: Date.now, mainOnly: false,
    prState: async () => 'OPEN', prBaseChain: async () => [], ...options });
  return { env, git, retire, prepare, refs: () => readOverlayState(root, { env }).overlays.map((o) => o.ref) };
}

describe('archived sources remain represented in preparation', () => {
  it.each(['fetch', 'planning', 'persistence'])('generation-only change during %s aborts preparation', async (stage) => {
    const f = fixture();
    // Start with stamped registrations so the transient writer is the only generation change.
    f.env.WE_DAEMON_OVERLAY_AUTO_RETIRE = 'shadow';
    migrateRegistrationIds(root, { env: f.env });
    const before = readOverlayState(root, { env: f.env });
    let injected = false;
    const mutate = () => {
      if (injected) return;
      injected = true;
      const transient = addOverlay(root, { ref: 'transient' }, { env: f.env }).find(o => o.ref === 'transient');
      removeOverlay(root, transient.ref, { env: f.env, expectRegistrationId: transient.registrationId });
    };
    if (stage === 'planning') model.onPlan = mutate;
    if (stage === 'persistence') model.onPersist = mutate;
    const next = await f.prepare({ run: (args) => {
      if (stage === 'fetch' && args[0] === 'fetch') mutate();
      return f.git(args);
    } });
    expect(injected).toBe(true);
    expect(next).toMatchObject({ terminal: true, result: { moved: false, reason: 'overlay-registration-changed' } });
    const after = readOverlayState(root, { env: f.env });
    expect(after.generation).toBe(before.generation + 2);
    expect(after.overlays.map(registrationIdentity)).toEqual(before.overlays.map(registrationIdentity));
    expect(next.alerts.map(a => a.kind)).toContain('overlay-registration-changed');
    expect(model.persisted).toHaveLength(stage === 'persistence' ? 1 : 0);
  });

  it.each(['absent', undefined, null, '', 42])('tip persistence refuses an unusable token (%s) after re-registration', (token) => {
    const f = fixture();
    const old = addOverlay(root, { ref: 'tip', pr: 17 }, { env: f.env }).find(o => o.ref === 'tip');
    removeOverlay(root, old.ref, { env: f.env, expectRegistrationId: old.registrationId });
    const replacement = addOverlay(root, { ref: 'tip', pr: 17 }, { env: f.env }).find(o => o.ref === 'tip');
    // Metadata from a later read is insufficient: the refresh itself must carry an explicit token.
    const evidence = { sha: 'a'.repeat(40), reg: registrationIdentity(replacement) };
    if (token !== 'absent') evidence.registrationId = token;
    const file = overlayFilePath(root, f.env);
    const before = readFileSync(file, 'utf8');
    expect(persistTipShas(root, new Map([['tip', evidence]]), { env: f.env })).toEqual({ written: 0 });
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('refreshed tips carry registration tokens and matching tokens still persist', async () => {
    const f = fixture();
    migrateRegistrationIds(root, { env: f.env });
    const before = readOverlayState(root, { env: f.env });
    await f.prepare();
    const tips = model.persisted.at(-1);
    expect(tips.size).toBeGreaterThan(0);
    for (const [ref, evidence] of tips) {
      expect(evidence.registrationId).toBe(before.overlays.find(o => o.ref === ref).registrationId);
      expect(readOverlayState(root, { env: f.env }).overlays.find(o => o.ref === ref).tipSha).toBe(evidence.sha);
    }
  });

  it('restored sources discard pre-restoration tips and refresh only on the next tick', async () => {
    const f = fixture();
    migrateRegistrationIds(root, { env: f.env });
    const original = readOverlayState(root, { env: f.env }).overlays.find(o => o.ref === 'lower');
    await f.retire();
    model.rewritten = true;
    const restored = await f.prepare();
    expect(restored.result.plan.applied).toContainEqual(expect.objectContaining({ ref: 'lower', registrationId: original.registrationId }));
    expect(model.persisted.at(-1).size).toBe(0);
    await f.prepare();
    expect(model.persisted.at(-1).get('lower').registrationId).toBe(original.registrationId);
  });

  it('re-registering a previously restored source before tip persistence cannot receive its old tip', async () => {
    const f = fixture();
    migrateRegistrationIds(root, { env: f.env });
    await f.retire();
    model.rewritten = true;
    await f.prepare();
    let replacement;
    model.onPersist = () => {
      const restored = readOverlayState(root, { env: f.env }).overlays.find(o => o.ref === 'lower');
      removeOverlay(root, restored.ref, { env: f.env, expectRegistrationId: restored.registrationId });
      replacement = addOverlay(root, restored, { env: f.env }).find(o => o.ref === restored.ref);
    };
    const next = await f.prepare();
    expect(replacement).toBeDefined();
    expect(readOverlayState(root, { env: f.env }).overlays.find(o => o.ref === 'lower')).toEqual(replacement);
    expect(replacement.tipSha).toBeUndefined();
    expect(next.result.reason).toBe('overlay-registration-changed');
  });

  it('source restoration advances generation once and preserves existing registration ids', () => {
    const f = fixture();
    const source = { ref: 'archived', registrationId: 'archived-registration' };
    const carrier = { ref: 'carrier', registrationId: 'carrier-registration', retiredSources: [{ entry: source, sha: '2'.repeat(40) }] };
    writeOverlays(root, [carrier], { env: f.env, generation: 7 });
    reinstateOverlaySources(root, carrier.ref, { env: f.env, expectedOverlay: carrier });
    expect(readOverlayState(root, { env: f.env })).toMatchObject({ generation: 8,
      overlays: [{ ...source, tipSha: '2'.repeat(40) }, carrier] });
    reinstateOverlaySources(root, carrier.ref, { env: f.env, expectedOverlay: carrier });
    expect(readOverlayState(root, { env: f.env }).generation).toBe(8);
  });

  it.each([undefined, null, new Map(), new Map([['lower', 'unverifiable']])])('on mode fails closed without complete per-ref freshness evidence (%j)', async (refEvidence) => {
    const f = fixture();
    const overlays = readOverlayState(root, { env: f.env }).overlays;
    const result = await autoRetireOverlays({ root, env: f.env, overlays,
      git: f.git, mainSha: '1'.repeat(40), refEvidence });
    expect(result.retired).toEqual([]);
    expect(result.kept).toEqual(overlays.map((o) => expect.objectContaining({ ref: o.ref, reason: 'git-unverifiable' })));
    expect(f.refs()).toEqual(['lower', 'top']);
  });

  it('restored sources with advanced live tips cover their archived ancestor in the proposed build', async () => {
    const f = fixture();
    await f.retire();
    model.rewritten = true;
    model.lowerTip = '8';
    const ancestry = [];
    const next = await f.prepare({ run: (args) => {
      if (args[0] === 'merge-base' && args[1] === '--is-ancestor') ancestry.push(args.slice(2));
      return f.git(args);
    } });
    expect(next.result.reason).toBe('up-to-date');
    expect(next.result.plan.applied).toContainEqual({ ref: 'lower', sha: '8'.repeat(40) });
    expect(ancestry).toContainEqual(['2'.repeat(40), '4'.repeat(40)]);
    expect(model.plans).toEqual([['top'], ['lower', 'top']]);
    expect(f.refs()).toEqual(['lower', 'top']);
  });

  it('protectedRefs retains a landed archived carrier until preparation validates and restores its source', async () => {
    const f = fixture();
    await f.retire();
    model.rewritten = true;
    const next = await f.prepare({ run: (args) => {
      // The rewritten top has landed, but the archived lower commit has not.
      if (args.join(' ') === `merge-base --is-ancestor ${'6'.repeat(40)} ${'1'.repeat(40)}`) return { status: 0, stdout: '' };
      return f.git(args);
    } });
    expect(next.result.reason).toBe('up-to-date');
    expect(model.plans).toEqual([['top'], ['lower', 'top']]);
    expect(next.result.plan.applied.map((o) => o.ref)).toContain('lower');
    expect(f.refs()).toEqual(['lower', 'top']);
    expect(next.alerts.some((a) => a.kind === 'overlay-auto-dropped' && a.detail.ref === 'top')).toBe(false);
  });

  it.each([undefined, 'edge-ref', 'replay'])('edge-resolved adopted commits are excluded from retirement evidence (resolvedVia=%s)', async (resolvedVia) => {
    const f = fixture();
    writeOverlays(root, [{ ref: 'lower', pr: 1 }], { env: f.env });
    writeRebuildState(root, { adopted: { head: '1'.repeat(40), mainSha: '1'.repeat(40),
      applied: [{ ref: 'lower', sha: '1'.repeat(40), ...(resolvedVia ? { resolvedVia } : {}) }] } }, f.env);
    model.missing = true;
    const next = await f.prepare();
    expect(next.result.reason).toBe('up-to-date');
    expect(f.refs()).toEqual(resolvedVia ? ['lower'] : []);
    expect(next.alerts.filter((a) => a.kind === 'overlay-auto-dropped').map((a) => a.detail.ref))
      .toEqual(resolvedVia ? [] : ['lower']);
  });

  it.each([
    { outer: true, nested: false }, { outer: false, nested: true }, { outer: true, nested: true },
  ])('preparation independently requires outer=$outer and nested=$nested archived content', async ({ outer, nested }) => {
    const f = fixture();
    f.env.WE_DAEMON_OVERLAY_AUTO_RETIRE = 'off';
    writeOverlays(root, [{ ref: 'lower' }, { ref: 'nested' }, { ref: 'top', retiredSources: [
      { entry: { ref: 'lower', retiredSources: [{ entry: { ref: 'nested' }, sha: '8'.repeat(40) }] }, sha: '2'.repeat(40) },
    ] }], { env: f.env });
    const checked = [];
    const next = await f.prepare({ run: (args) => {
      if (args[0] === 'merge-base' && args[1] === '--is-ancestor' && args[3] === '4'.repeat(40)) {
        checked.push(args[2]);
        return { status: (args[2] === '2'.repeat(40) ? outer : nested) ? 0 : 1, stdout: '' };
      }
      return f.git(args);
    } });
    expect(checked).toEqual(expect.arrayContaining(['2'.repeat(40), '8'.repeat(40)]));
    expect(next.result.reason).toBe(outer && nested ? 'up-to-date' : 'overlay-source-unavailable');
    expect(readOverlayState(root, { env: f.env }).overlays.find((o) => o.ref === 'top').retiredSources[0].entry.retiredSources)
      .toEqual([{ entry: { ref: 'nested' }, sha: '8'.repeat(40) }]);
  });

  it('preparation reports deferred persistTipShas failure and preserves registrations', async () => {
    const f = fixture();
    writeOverlays(root, [{ ref: 'top', pr: 2 }], { env: f.env });
    model.failTips = true;
    const next = await f.prepare();
    expect(next.result.reason).toBe('up-to-date');
    expect(model.persisted).toHaveLength(1);
    expect(model.persisted[0].get('top')).toMatchObject({ sha: '3'.repeat(40), reg: { ref: 'top', pr: 2 } });
    expect(next.alerts).toContainEqual({ kind: 'overlay-auto-retire-audit-failed',
      detail: { failures: [{ ref: null, kind: 'tip-sha', error: 'tip disk full' }] } });
    expect(readOverlayState(root, { env: f.env }).overlays).toEqual([{ ref: 'top', pr: 2, registrationId: expect.any(String) }]);
  });

  it('preparation forwards retirement auditFailures to overlay-auto-retire-audit-failed', async () => {
    const f = fixture();
    writeOverlays(root, [{ ref: 'lower', sha: '1'.repeat(40) }], { env: f.env });
    model.missing = true;
    model.failAudit = true;
    const next = await f.prepare();
    expect(next.result.reason).toBe('up-to-date');
    expect(f.refs()).toEqual([]);
    expect(next.alerts).toContainEqual({ kind: 'overlay-auto-retire-audit-failed',
      detail: { failures: [{ ref: 'lower', kind: 'removed', error: 'audit disk full' }] } });
  });

  it.each(['on', 'shadow', 'off'])('force-pushed container restores sources it no longer carries (%s)', async (mode) => {
    const f = fixture();
    await f.retire();
    expect(f.refs()).toEqual(['top']);
    f.env.WE_DAEMON_OVERLAY_AUTO_RETIRE = mode;
    model.rewritten = true;
    const next = await f.prepare();
    expect(next.result.plan.applied.map((o) => o.ref)).toContain('lower');
    expect(f.refs()).toEqual(['lower', 'top']);
    expect(model.plans).toEqual([['top'], ['lower', 'top']]);
  });

  it('the plan removing a closed container includes its restored source', async () => {
    const f = fixture();
    await f.retire();
    model.closed = true;
    const next = await f.prepare();
    expect(next.result.plan.applied.map((o) => o.ref)).toEqual(['lower']);
    expect(f.refs()).toEqual(['lower']);
  });

  it('an unavailable restored source holds the build and retains its archive for retry', async () => {
    const f = fixture();
    await f.retire();
    model.rewritten = true;
    model.missing = true;
    const next = await f.prepare();
    expect(next.result.reason).toBe('overlay-source-unavailable');
    expect(readOverlayState(root, { env: f.env }).overlays.find((o) => o.ref === 'top').retiredSources).toHaveLength(1);
    // The durable archive also refuses a later tick after restoration is no longer new progress.
    expect((await f.prepare()).result.reason).toBe('overlay-source-unavailable');
  });

  it('unverifiable archive containment refuses the proposed build', async () => {
    const f = fixture();
    await f.retire();
    model.gitError = true;
    const next = await f.prepare();
    expect(next.result.reason).toBe('overlay-source-unverifiable');
  });

  it('a still-carrying container needs no source restoration or second plan', async () => {
    const f = fixture();
    await f.retire();
    const next = await f.prepare();
    expect(next.result.plan.applied.map((o) => o.ref)).toEqual(['top']);
    expect(model.plans).toEqual([['top']]);
    expect(f.refs()).toEqual(['top']);
  });

  it('reinstatement refuses a concurrently replaced carrier under the registry lock', async () => {
    const f = fixture();
    await f.retire();
    const [carrier] = readOverlayState(root, { env: f.env }).overlays;
    const replacement = { ...carrier, registeredAt: 'replacement' };
    writeOverlays(root, [replacement], { env: f.env });
    expect(() => reinstateOverlaySources(root, 'top', { env: f.env, expectedOverlay: carrier })).toThrow('carrier changed');
    expect(readOverlayState(root, { env: f.env }).overlays).toEqual([replacement]);
  });

  it('a failed reinstatement audit preserves the carrier and archive for retry', async () => {
    const f = fixture();
    await f.retire();
    const before = readOverlayState(root, { env: f.env }).overlays;
    const audit = overlayFilePath(root, f.env).replace(/\.json$/, '.events.jsonl');
    rmSync(audit);
    mkdirSync(audit);
    expect(() => reinstateOverlaySources(root, 'top', { env: f.env, expectedOverlay: before[0] })).toThrow();
    expect(readOverlayState(root, { env: f.env }).overlays).toEqual(before);
  });

  it('restoration preserves duplicate snapshots and recovers older nested sources', () => {
    const f = fixture();
    const source = (ref, extra = {}) => ({ entry: { ref, ...extra }, sha: '2'.repeat(40) });
    const carrier = { ref: 'top', retiredSources: [
      source('lower', { retiredSources: [source('nested')] }), source('lower', { registeredAt: 'latest' }),
    ] };
    writeOverlays(root, [carrier], { env: f.env });
    const restored = reinstateOverlaySources(root, 'top', { env: f.env, expectedOverlay: carrier });
    expect(restored.reinstated).toEqual(['nested', 'lower']);
    expect(restored.list[1].registeredAt).toBe('latest');
    expect(restored.list[2]).toEqual(carrier);
  });
});

describe('a saved ready candidate is held to the archived-source rule (PR #6033 red team)', () => {
  it.each(['graduated', 'missing-event', 'invalid-event', 'registered-unrefreshed'])(
    'wires persisted graduation proof into the ready matcher (%s)', async (mode) => {
      const f = fixture();
      f.env.WE_DAEMON_OVERLAY_AUTO_RETIRE = 'shadow';
      model.upToDate = false;
      model.missing = mode === 'registered-unrefreshed';
      if (model.missing) writeOverlays(root, [
        { ref: 'lower', pr: 1, tipSha: '2'.repeat(40) }, { ref: 'top', pr: 2 },
      ], { env: f.env }); // Known harmless tip avoids the unrelated unavailable-pin hold.
      const applied = { ref: model.missing ? 'lower' : 'graduated', sha: '8'.repeat(40) };
      const target = '7'.repeat(40);
      const merged = '1'.repeat(40);
      if (mode !== 'missing-event') appendOverlayEvent(root, {
        kind: 'removed', ref: applied.ref,
        reason: mode === 'invalid-event' ? 'operator removed' : `graduated #6011 (merged ${merged})`,
      }, { env: f.env });
      writeReadyCandidate(root, { kind: 'candidate', prevHead: merged, passedAt: new Date().toISOString(),
        adopt: { finalSha: target, mainSha: merged, applied: [] } }, f.env);
      // Probe the production evidence hook; matcher decisions are covered by daemon-rebuild-graduated.
      model.readyMatch = vi.fn((args) => {
        expect(args.leftForMain(applied, args.ready.adopt.finalSha)).toBe(mode === 'graduated');
        expect(args.removedForMain(applied.ref)).toBe(false);
        return { adopt: null, reason: 'graduation-proof-probed' };
      });
      await f.prepare({ run: (args) => {
        if (args[0] === 'merge-base' && args[1] === '--is-ancestor'
          && args[2] === merged && args[3] === target) return { status: 0, stdout: '' };
        return f.git(args);
      } });
      expect(model.readyMatch).toHaveBeenCalledTimes(1);
    },
  );

  // Saved before auto-retirement archived lower into top; matchReadyCandidate accepts it as fallback-main-moved.
  async function readyTick({ target, gitError = false }) {
    const f = fixture();
    await f.retire();
    const top = readOverlayState(root, { env: f.env }).overlays.find((o) => o.ref === 'top');
    expect(top.retiredSources).toHaveLength(1);
    model.upToDate = false;
    // Only the saved target's containment read fails; the fresh plan's own archive check stays readable.
    model.gitErrorTarget = gitError ? target : null;
    writeReadyCandidate(root, { kind: 'fallback', prevHead: '1'.repeat(40), passedAt: new Date().toISOString(),
      adopt: { finalSha: target, mainSha: '1'.repeat(40), applied: [] }, failed: 'top' }, f.env);
    model.readyMatch = ({ ready }) => ({ adopt: ready.adopt, failed: 'top', match: 'fallback-main-moved',
      dropRefs: [{ ref: 'top', registrationId: top.registrationId }] });
    model.finalize = vi.fn(async () => ({ moved: true, adopted: true, head: target }));
    const next = await f.prepare();
    return { f, next, discarded: next.alerts.filter((a) => a.kind === 'ready-candidate-discarded') };
  }

  it('discards a saved plain-main fallback that lacks a registered carrier\'s archived source', async () => {
    const { f, next, discarded } = await readyTick({ target: '5'.repeat(40) });
    expect(model.finalize).not.toHaveBeenCalled();
    expect(next.result?.reason).not.toBe('ready-adopted');
    expect(discarded).toEqual([expect.objectContaining({ detail: expect.objectContaining({
      reason: 'archive-source-uncovered', refs: ['top'], target: '5'.repeat(40) }) })]);
    expect(readReadyCandidate(root, f.env)).toBeNull();
    expect(readOverlayState(root, { env: f.env }).overlays.find((o) => o.ref === 'top').retiredSources).toHaveLength(1);
  });

  it('discards a saved candidate when archive containment cannot be verified (fails closed)', async () => {
    const { f, discarded } = await readyTick({ target: '5'.repeat(40), gitError: true });
    expect(model.finalize).not.toHaveBeenCalled();
    expect(discarded).toEqual([expect.objectContaining({ detail: expect.objectContaining({
      reason: 'archive-source-uncovered', refs: ['top'], error: expect.any(String) }) })]);
    expect(readReadyCandidate(root, f.env)).toBeNull();
  });

  it('a mainOnly rebuild skips the archive rule for a saved candidate, as its planning does', async () => {
    const f = fixture();
    await f.retire();
    model.upToDate = false;
    writeReadyCandidate(root, { kind: 'candidate', prevHead: '1'.repeat(40), passedAt: new Date().toISOString(),
      adopt: { finalSha: '5'.repeat(40), mainSha: '1'.repeat(40), applied: [] } }, f.env);
    model.readyMatch = ({ ready }) => ({ adopt: ready.adopt, failed: '', match: 'exact', dropRefs: [] });
    model.finalize = vi.fn(async (args) => ({ moved: true, adopted: true, head: args.plan.finalSha }));
    const next = await f.prepare({ mainOnly: true });
    expect(next.alerts.filter((a) => a.kind === 'ready-candidate-discarded')).toEqual([]);
    expect(model.finalize).toHaveBeenCalledWith(expect.objectContaining({ archiveGuard: false }));
  });

  it('still adopts a saved candidate whose target carries the archived source', async () => {
    const { next, discarded } = await readyTick({ target: '4'.repeat(40) });
    expect(discarded).toEqual([]);
    expect(model.finalize).toHaveBeenCalledTimes(1);
    expect(next.result).toMatchObject({ reason: 'ready-adopted', readyMatch: 'fallback-main-moved' });
    expect(model.finalize).toHaveBeenCalledWith(expect.objectContaining({ archiveGuard: true }));
  });
});

describe('finalize re-reads the registry and refuses a target that drops archived content (PR #6033 red team)', () => {
  // The build smoked unlocked; a sibling tick archived lower into top meanwhile. Finalize runs under the write lock.
  async function finalizeAfterSiblingRetired({ target, gitError = false, archiveGuard }) {
    const f = fixture();
    await f.retire();
    model.gitErrorTarget = gitError ? target : null;
    const resets = [];
    const run = (args) => {
      if (args[0] === 'reset') { resets.push(args.at(-1)); return { stdout: '', status: 0 }; }
      return f.git(args);
    };
    const fin = await finalizeRebuild({ root, env: f.env, run, now: Date.now, prevHead: '1'.repeat(40), lease: { token: null },
      plan: { finalSha: target, mainSha: '1'.repeat(40), applied: [], inputsKey: 'test' },
      ...(archiveGuard === undefined ? {} : { archiveGuard }) });
    return { f, fin, resets };
  }

  it('refuses a plain-main target that lacks the sibling\'s new archive, before any reset', async () => {
    const { f, fin, resets } = await finalizeAfterSiblingRetired({ target: '5'.repeat(40) });
    expect(fin).toMatchObject({ moved: false, reason: 'overlay-source-unavailable' });
    expect(fin.adopted).not.toBe(true);
    expect(resets).toEqual([]);
    expect(fin.alerts).toContainEqual(expect.objectContaining({ kind: 'overlay-source-unavailable',
      detail: expect.objectContaining({ refs: ['top'], failed: 'archive-source-uncovered: top' }) }));
    expect(readOverlayState(root, { env: f.env }).overlays.find((o) => o.ref === 'top').retiredSources).toHaveLength(1);
  });

  it('refuses when archive containment cannot be read (fails closed)', async () => {
    const { fin, resets } = await finalizeAfterSiblingRetired({ target: '5'.repeat(40), gitError: true });
    expect(fin).toMatchObject({ moved: false, reason: 'overlay-source-unverifiable' });
    expect(resets).toEqual([]);
  });

  it('adopts a target that carries the archive, and a mainOnly finalize (archiveGuard false) skips the rule', async () => {
    const carried = await finalizeAfterSiblingRetired({ target: '4'.repeat(40) });
    expect(carried.resets).toEqual(['4'.repeat(40)]);
    expect(carried.fin.alerts.map((a) => a.kind)).not.toContain('overlay-source-unavailable');
    const mainOnly = await finalizeAfterSiblingRetired({ target: '5'.repeat(40), archiveGuard: false });
    expect(mainOnly.resets).toEqual(['5'.repeat(40)]);
  });
});
