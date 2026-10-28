import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareRebuild } from '../daemon-rebuild/prepare.mjs';
import { autoRetireOverlays } from '../daemon-overlay-auto-retire.mjs';
import {
  addOverlay, overlayFilePath, readOverlayState, reinstateOverlaySources, removeOverlay, supersededSnapshots, writeOverlays,
} from '../daemon-overlays.mjs';
import { writeRebuildState } from '../daemon-rebuild/state.mjs';

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
  planRebuild: async ({ overlays, ...rest }) => {
    model.plans.push(overlays.map((o) => o.ref));
    if (model.planner) return model.planner({ overlays, ...rest });
    const applied = overlays.filter((o) => !(model.closed && o.ref === 'top'));
    const carries = applied.some((o) => o.ref === 'lower' || (o.ref === 'top' && !model.rewritten));
    return { ok: true, upToDate: true, mainSha: '1'.repeat(40), finalSha: (carries ? '4' : '5').repeat(40),
      applied: applied.map((o) => ({ ref: o.ref, sha: (o.ref === 'lower' ? model.lowerTip : '3').repeat(40) })),
      decisions: overlays.map((o) => ({ ref: o.ref, pr: o.pr,
        action: model.closed && o.ref === 'top' ? 'remove' : 'apply', reason: 'pr-closed' })),
      alerts: [], establishedLost: [], inputsKey: 'test' };
  },
}));

let root;
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  root = mkdtempSync(join(tmpdir(), 'retired-sources-'));
  Object.assign(model, { plans: [], rewritten: false, closed: false, missing: false, gitError: false,
    lowerTip: '2', persisted: [], failTips: false, failAudit: false, planner: null });
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
      return result('', a === b || (a === '2'.repeat(40) && ['3'.repeat(40), '4'.repeat(40)].includes(b)) ? 0 : 1);
    }
    if (cmd === 'diff') return result();
    if (cmd === 'cherry') return result(`+ ${'2'.repeat(40)}`);
    if (cmd === 'merge-tree') return result('7'.repeat(40));
    throw new Error(`Unexpected Git command: ${args.join(' ')}`);
  };
  const entries = [{ ref: 'lower', pr: 1 }, { ref: 'top', pr: 2 }];
  writeOverlays(root, entries, { env });
  const retire = () => autoRetireOverlays({ root, env, overlays: entries, git, mainSha: '1'.repeat(40),
    refEvidence: new Map(entries.map((o) => [o.ref, 'refreshed'])) });
  const prepare = (options = {}) => prepareRebuild({ root, env, run: git, now: Date.now, mainOnly: false,
    prState: async () => 'OPEN', prBaseChain: async () => [], ...options });
  return { env, git, retire, prepare, refs: () => readOverlayState(root, { env }).overlays.map((o) => o.ref) };
}

describe('archived sources remain represented in preparation', () => {
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
    // `lower` is a legacy (unbound) registration, so its input carries the plan's capture time.
    expect(next.result.plan.applied).toContainEqual({ ref: 'lower', sha: '8'.repeat(40), capturedAt: expect.any(String) });
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
    expect(readOverlayState(root, { env: f.env }).overlays).toEqual([{ ref: 'top', pr: 2 }]);
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

  // Send-back round 13, item 1: retire X/PR1 into C1, re-register X/PR2, retire it into C2 (optionally nested
  // one level deeper in C3). Only the newest archive of X is current, whichever carrier is visited first.
  const [A, B, F] = ['a', 'b', 'c'].map((c) => c.repeat(40));
  function archivedTwice(f, { nested = false } = {}) {
    f.env.WE_DAEMON_OVERLAY_AUTO_RETIRE = 'off';
    writeOverlays(root, [], { env: f.env });
    addOverlay(root, { ref: 'x', pr: 1 }, { env: f.env });
    addOverlay(root, { ref: 'c1', pr: 11 }, { env: f.env });
    removeOverlay(root, 'x', { env: f.env, requireRef: 'c1', retireInto: true, retiredSha: A, now: '2026-10-01T00:00:00.000Z' });
    addOverlay(root, { ref: 'x', pr: 2 }, { env: f.env });
    addOverlay(root, { ref: 'c2', pr: 12 }, { env: f.env });
    removeOverlay(root, 'x', { env: f.env, requireRef: 'c2', retireInto: true, retiredSha: B, now: '2026-10-02T00:00:00.000Z' });
    if (nested) {
      addOverlay(root, { ref: 'c3', pr: 13 }, { env: f.env });
      // C2 is a carrier whose tip is X/PR2's: any build carrying X/PR2 carries C2's archived commit too.
      removeOverlay(root, 'c2', { env: f.env, requireRef: 'c3', retireInto: true, retiredSha: B, now: '2026-10-03T00:00:00.000Z' });
    }
    return readOverlayState(root, { env: f.env }).overlays;
  }

  it.each([false, true])('recovery restores the newest archive of a ref across carriers, never an obsolete one (nested=%s)', async (nested) => {
    const f = fixture();
    archivedTwice(f, { nested });
    const pr2 = readOverlayState(root, { env: f.env }).overlays.flatMap(function all(o) {
      return (o.retiredSources ?? []).flatMap((s) => [s.entry, ...all(s.entry)]);
    }).find((e) => e.ref === 'x' && e.pr === 2);
    const closed = new Set([1, 11, 12, 13]);
    model.planner = async ({ overlays, prState }) => {
      const applied = [];
      const decisions = [];
      for (const o of overlays) {
        const gone = (await prState(o.pr)) === 'CLOSED';
        decisions.push({ ref: o.ref, pr: o.pr, action: gone ? 'remove' : 'apply', reason: gone ? 'pr-closed' : 'applied' });
        if (!gone) applied.push({ ref: o.ref, pr: o.pr, sha: B });
      }
      return { ok: true, upToDate: true, mainSha: '1'.repeat(40), finalSha: applied.length ? F : '1'.repeat(40),
        applied, decisions, alerts: [], establishedLost: [], inputsKey: 'test' };
    };
    const next = await f.prepare({
      prState: async (pr) => (closed.has(pr) ? 'CLOSED' : 'OPEN'),
      run: (args) => {
        const [cmd, ...rest] = args;
        if (cmd === 'rev-parse' && /\/x(\^\{commit\})?$/.test(rest.at(-1))) return { status: 0, stdout: B };
        if (cmd === 'for-each-ref' && rest.at(-1).endsWith('/x')) return { status: 0, stdout: `${rest.at(-1)} ${B}` };
        if (cmd === 'merge-base' && rest[0] === '--is-ancestor' && rest[1] === B && rest[2] === F) return { status: 0, stdout: '' };
        return f.git(args);
      },
    });
    expect(next.alerts.filter((a) => a.kind === 'overlay-source-unavailable')).toEqual([]);
    expect(next.result.reason).toBe('up-to-date');
    const x = readOverlayState(root, { env: f.env }).overlays.find((o) => o.ref === 'x');
    expect(x).toMatchObject({ pr: 2, registrationId: pr2.registrationId, tipSha: B });
    // The adopted inputs name the registration they were built from (send-back item 2's evidence).
    expect(next.result.plan.applied).toEqual([{ ref: 'x', pr: 2, sha: B, registrationId: pr2.registrationId }]);
  });

  it('carriers closing one after another: the restored X/PR2 supersedes X/PR1 still archived in C1', async () => {
    const f = fixture();
    archivedTwice(f);
    const closed = new Set([1, 12]);
    model.planner = async ({ overlays, prState }) => {
      const applied = [];
      const decisions = [];
      for (const o of overlays) {
        const gone = (await prState(o.pr)) === 'CLOSED';
        decisions.push({ ref: o.ref, pr: o.pr, action: gone ? 'remove' : 'apply', reason: gone ? 'pr-closed' : 'applied' });
        if (!gone) applied.push({ ref: o.ref, pr: o.pr, sha: o.ref === 'c1' ? A : B });
      }
      const has = (ref) => applied.some((o) => o.ref === ref);
      // G carries both C1 (X/PR1's commit A) and X/PR2 (B); F carries X/PR2 alone.
      return { ok: true, upToDate: true, mainSha: '1'.repeat(40),
        finalSha: has('x') && has('c1') ? G : has('x') ? F : has('c1') ? A : '1'.repeat(40),
        applied, decisions, alerts: [], establishedLost: [], inputsKey: 'test' };
    };
    const G = 'd'.repeat(40);
    const run = (args) => {
      const [cmd, ...rest] = args;
      if (cmd === 'rev-parse' && /\/x(\^\{commit\})?$/.test(rest.at(-1))) return { status: 0, stdout: B };
      if (cmd === 'for-each-ref' && rest.at(-1).endsWith('/x')) return { status: 0, stdout: `${rest.at(-1)} ${B}` };
      if (cmd === 'merge-base' && rest[0] === '--is-ancestor'
        && ((rest[1] === B && [F, G].includes(rest[2])) || (rest[1] === A && rest[2] === G))) return { status: 0, stdout: '' };
      return f.git(args);
    };
    const prState = async (pr) => (closed.has(pr) ? 'CLOSED' : 'OPEN');
    // C2 closes first: X/PR2 comes back from it while C1 (still open) keeps X/PR1's archive.
    const first = await f.prepare({ prState, run });
    expect(first.result.reason).toBe('up-to-date');
    expect(readOverlayState(root, { env: f.env }).overlays.map((o) => [o.ref, o.pr])).toEqual([['c1', 11], ['x', 2]]);
    closed.add(11);
    const next = await f.prepare({ prState, run });
    expect(next.alerts.filter((a) => a.kind === 'overlay-source-unavailable')).toEqual([]);
    expect(next.result.reason).toBe('up-to-date');
    expect(readOverlayState(root, { env: f.env }).overlays).toEqual([expect.objectContaining({ ref: 'x', pr: 2 })]);
  });

  it('a re-registration the build does not apply never releases its ref\'s archive (branch gone, carrier closed)', async () => {
    const f = fixture();
    f.env.WE_DAEMON_OVERLAY_AUTO_RETIRE = 'off';
    writeOverlays(root, [], { env: f.env });
    addOverlay(root, { ref: 'x', pr: 2 }, { env: f.env });
    addOverlay(root, { ref: 'c2', pr: 12 }, { env: f.env });
    removeOverlay(root, 'x', { env: f.env, requireRef: 'c2', retireInto: true, retiredSha: B });
    // Re-registered under a new registrationId while its branch is gone: nothing in the build supplies B.
    addOverlay(root, { ref: 'x', pr: 2 }, { env: f.env });
    const next = await f.prepare({
      prState: async (pr) => (pr === 12 ? 'CLOSED' : 'OPEN'),
      run: (args) => (args[0] === 'fetch' && args.some((a) => a.includes('heads/x:')) ? { status: 1, stdout: '' } : f.git(args)),
    });
    expect(next.result.reason).toBe('overlay-source-unavailable');
    const c2 = readOverlayState(root, { env: f.env }).overlays.find((o) => o.ref === 'c2');
    expect(c2.retiredSources).toEqual([expect.objectContaining({ sha: B, entry: expect.objectContaining({ ref: 'x', pr: 2 }) })]);
  });

  it.each([false, true])('removing a carrier never restores a ref whose newer archive sits on another carrier (nested=%s)', (nested) => {
    const f = fixture();
    archivedTwice(f, { nested });
    const first = removeOverlay(root, 'c1', { env: f.env });
    expect(first.reinstated).toEqual([]);
    expect(first.list.map((o) => o.ref)).toEqual([nested ? 'c3' : 'c2']);
    const second = removeOverlay(root, nested ? 'c3' : 'c2', { env: f.env });
    expect(second.reinstated).toEqual(nested ? ['c2'] : ['x']);
    const x = nested ? removeOverlay(root, 'c2', { env: f.env }).list.find((o) => o.ref === 'x')
      : second.list.find((o) => o.ref === 'x');
    expect(x).toMatchObject({ pr: 2, tipSha: B });
  });

  // Send-back round 13, item 2: an adopted input pins only the registration it was built from.
  it.each([
    { name: 'a new PR re-registering the ref', applied: { pr: 1, registrationId: 'r1' }, pinned: false },
    { name: 'a same-PR re-registration', applied: { pr: 2, registrationId: 'r1' }, pinned: false },
    { name: 'a legacy record of another PR', applied: { pr: 1 }, pinned: false },
    { name: 'the identical registration', applied: { pr: 2, registrationId: 'r2' }, pinned: true },
    { name: 'a legacy record of the same PR (cannot prove a new registration)', applied: { pr: 2 }, pinned: true },
  ])('an unavailable registration inherits a mechanism pin only from its own adopted input: $name', async ({ applied, pinned }) => {
    const f = fixture();
    writeOverlays(root, [{ ref: 'x', pr: 2, registrationId: 'r2', addedAt: '2026-10-02T00:00:00.000Z' }], { env: f.env });
    writeRebuildState(root, { adopted: { head: '1'.repeat(40), mainSha: '1'.repeat(40),
      applied: [{ ref: 'x', sha: A, ...applied }] } }, f.env);
    const next = await f.prepare({ run: (args) => {
      if (args[0] === 'fetch' && args.some((a) => a.includes('heads/x:'))) return { status: 1, stdout: '' };
      if (args[0] === 'diff' && args.includes(A)) return { status: 0, stdout: 'scripts/lib/daemon-rebuild.mjs\n' };
      return f.git(args);
    } });
    if (pinned) {
      expect(next.result.reason).toBe('pinned-overlay-unavailable');
    } else {
      expect(next.result.reason).not.toBe('pinned-overlay-unavailable');
      expect(next.alerts).toContainEqual(expect.objectContaining({ kind: 'overlay-fetch-unverifiable',
        detail: expect.objectContaining({ refs: ['x'] }) }));
    }
    expect(f.refs()).toEqual(['x']);
  });

  // A bound input came from a registration that had an id; a legacy entry with none (e.g. restored from an archive
  // made before ids existed) is some other registration, whatever its PR says.
  it.each([null, 2])('a bound adopted input never pins a legacy registration with no registrationId (pr=%s)', async (pr) => {
    const f = fixture();
    writeOverlays(root, [{ ref: 'x', pr, addedAt: '2026-09-01T00:00:00.000Z' }], { env: f.env });
    writeRebuildState(root, { adopted: { head: '1'.repeat(40), mainSha: '1'.repeat(40), at: '2026-10-02T00:00:00.000Z',
      applied: [{ ref: 'x', pr: 2, sha: A, registrationId: 'r2' }] } }, f.env);
    const next = await f.prepare({ run: (args) => {
      if (args[0] === 'fetch' && args.some((a) => a.includes('heads/x:'))) return { status: 1, stdout: '' };
      if (args[0] === 'diff' && args.includes(A)) return { status: 0, stdout: 'scripts/lib/daemon-rebuild.mjs\n' };
      return f.git(args);
    } });
    expect(next.result.reason).not.toBe('pinned-overlay-unavailable');
    expect(f.refs()).toEqual(['x']);
  });

  // Live overlay lists predate registrationIds and mostly carry `pr: null`, so most adopted inputs are unbound:
  // ref + PR cannot tell registrations apart. Such an input pins only a registration that existed at adoption.
  it.each([
    { name: 're-registered after the build was adopted', registeredAt: '2026-10-03T00:00:00.000Z', pinned: false },
    { name: 'registered before the build was adopted', registeredAt: '2026-10-01T00:00:00.000Z', pinned: true },
    { name: 'a legacy registration with no registeredAt', registeredAt: undefined, pinned: true },
  ])('an unbound pr-less adopted input pins a registration only if it predates the adoption: $name', async ({ registeredAt, pinned }) => {
    const f = fixture();
    writeOverlays(root, [{ ref: 'x', pr: null, registrationId: 'r2', ...(registeredAt ? { registeredAt } : {}),
      addedAt: '2026-09-01T00:00:00.000Z' }], { env: f.env });
    writeRebuildState(root, { adopted: { head: '1'.repeat(40), mainSha: '1'.repeat(40), at: '2026-10-02T00:00:00.000Z',
      applied: [{ ref: 'x', pr: null, sha: A }] } }, f.env);
    const next = await f.prepare({ run: (args) => {
      if (args[0] === 'fetch' && args.some((a) => a.includes('heads/x:'))) return { status: 1, stdout: '' };
      if (args[0] === 'diff' && args.includes(A)) return { status: 0, stdout: 'scripts/lib/daemon-rebuild.mjs\n' };
      return f.git(args);
    } });
    if (pinned) expect(next.result.reason).toBe('pinned-overlay-unavailable');
    else expect(next.result.reason).not.toBe('pinned-overlay-unavailable');
    expect(f.refs()).toEqual(['x']);
  });

  it('a re-registration records when it began, so an older unbound adopted input never pins it', () => {
    const f = fixture();
    writeOverlays(root, [{ ref: 'x', pr: null, addedAt: '2026-09-01T00:00:00.000Z' }], { env: f.env });
    const [x] = addOverlay(root, { ref: 'x', now: '2026-10-03T00:00:00.000Z' }, { env: f.env });
    expect(x).toMatchObject({ addedAt: '2026-09-01T00:00:00.000Z', registeredAt: '2026-10-03T00:00:00.000Z' });
  });

  it('a legacy archive with no registrationId is released once the build applies the ref\'s re-registration', async () => {
    const f = fixture();
    f.env.WE_DAEMON_OVERLAY_AUTO_RETIRE = 'off';
    writeOverlays(root, [{ ref: 'c1', pr: 11, addedAt: '2026-09-01T00:00:00.000Z',
      retiredSources: [{ entry: { ref: 'x', pr: null, addedAt: '2026-08-01T00:00:00.000Z' }, sha: A }] }], { env: f.env });
    addOverlay(root, { ref: 'x' }, { env: f.env });
    model.planner = async ({ overlays }) => ({ ok: true, upToDate: true, mainSha: '1'.repeat(40), finalSha: F,
      applied: overlays.map((o) => ({ ref: o.ref, pr: o.pr, sha: B })),
      decisions: overlays.map((o) => ({ ref: o.ref, pr: o.pr, action: 'apply', reason: 'applied' })),
      alerts: [], establishedLost: [], inputsKey: 'test' });
    const run = (args) => {
      const [cmd, ...rest] = args;
      if (cmd === 'rev-parse' && /\/(x|c1)(\^\{commit\})?$/.test(rest.at(-1))) return { status: 0, stdout: B };
      if (cmd === 'for-each-ref' && /\/(x|c1)$/.test(rest.at(-1))) return { status: 0, stdout: `${rest.at(-1)} ${B}` };
      if (cmd === 'merge-base' && rest[0] === '--is-ancestor' && rest[1] === B && rest[2] === F) return { status: 0, stdout: '' };
      return f.git(args);
    };
    const next = await f.prepare({ run });
    expect(next.alerts.filter((a) => a.kind === 'overlay-source-unavailable')).toEqual([]);
    expect(next.result.reason).toBe('up-to-date');
  });

  it('unstamped archives are ordered by registration time, then archive order — never by carrier order alone', () => {
    const pr1 = { entry: { ref: 'x', pr: 1, addedAt: '2026-09-01T00:00:00.000Z' }, sha: A };
    const pr2 = { entry: { ref: 'x', pr: 2, addedAt: '2026-09-02T00:00:00.000Z' }, sha: B };
    for (const list of [[{ ref: 'c2', retiredSources: [pr2] }, { ref: 'c1', retiredSources: [pr1] }],
      [{ ref: 'c1', retiredSources: [pr1] }, { ref: 'c2', retiredSources: [pr2] }]]) {
      const superseded = supersededSnapshots(list);
      expect([superseded.has(pr1), superseded.has(pr2)]).toEqual([true, false]);
    }
    // Tied registration time: archive order decides, whatever the nesting (C2, holding the newer X/PR2, was
    // retired into C1 after C1 archived X/PR1).
    const older = { entry: { ref: 'x', pr: 1 }, sha: A };
    const newer = { entry: { ref: 'x', pr: 2 }, sha: B };
    const superseded = supersededSnapshots([{ ref: 'c1', retiredSources: [older,
      { entry: { ref: 'c2', retiredSources: [newer] }, sha: F }] }]);
    expect([superseded.has(older), superseded.has(newer)]).toEqual([true, false]);
  });

  it('an unbound input captured before a re-registration never pins it, even when adopted after it', async () => {
    const f = fixture();
    writeOverlays(root, [{ ref: 'x', pr: null, registrationId: 'r2', registeredAt: '2026-10-02T00:00:00.000Z',
      addedAt: '2026-09-01T00:00:00.000Z' }], { env: f.env });
    // Captured before X was re-registered; smoke (or a crash recovery) adopted it only afterwards.
    writeRebuildState(root, { adopted: { head: '1'.repeat(40), mainSha: '1'.repeat(40), at: '2026-10-03T00:00:00.000Z',
      applied: [{ ref: 'x', pr: null, sha: A, capturedAt: '2026-10-01T00:00:00.000Z' }] } }, f.env);
    const next = await f.prepare({ run: (args) => {
      if (args[0] === 'fetch' && args.some((a) => a.includes('heads/x:'))) return { status: 1, stdout: '' };
      if (args[0] === 'diff' && args.includes(A)) return { status: 0, stdout: 'scripts/lib/daemon-rebuild.mjs\n' };
      return f.git(args);
    } });
    expect(next.result.reason).not.toBe('pinned-overlay-unavailable');
  });

  it('a plan stamps unbound inputs with their capture time and binds the rest to their registration', async () => {
    const f = fixture();
    f.env.WE_DAEMON_OVERLAY_AUTO_RETIRE = 'off';
    writeOverlays(root, [{ ref: 'lower', pr: 1 }, { ref: 'top', pr: 2, registrationId: 'r-top' }], { env: f.env });
    const next = await f.prepare({ now: () => Date.parse('2026-10-05T00:00:00.000Z') });
    expect(next.result.plan.applied).toEqual([
      expect.objectContaining({ ref: 'lower', capturedAt: '2026-10-05T00:00:00.000Z' }),
      expect.objectContaining({ ref: 'top', registrationId: 'r-top' }),
    ]);
    expect(next.result.plan.applied[1].capturedAt).toBeUndefined();
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
