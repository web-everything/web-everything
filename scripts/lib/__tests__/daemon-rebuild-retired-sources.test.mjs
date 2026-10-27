import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareRebuild } from '../daemon-rebuild/prepare.mjs';
import { autoRetireOverlays } from '../daemon-overlay-auto-retire.mjs';
import { overlayFilePath, readOverlayState, reinstateOverlaySources, writeOverlays } from '../daemon-overlays.mjs';

// Exercise preparation and real registry storage without network or .git writes.
vi.mock('../lane-repair.mjs', () => ({ repairCloneRefs: () => ({ ok: true, pruned: [], reportedNew: [] }), holdsCloneWriteLock: () => true }));
vi.mock('../daemon-rebuild/local-state.mjs', async (original) => ({
  ...await original(), ensureSafeToMove: () => ({ safe: true, untracked: [] }),
  pruneLandedBacklogSidecars: () => {}, collectUntrackedPaths: () => [],
}));
const model = vi.hoisted(() => ({ plans: [], rewritten: false, closed: false, missing: false, gitError: false }));
vi.mock('../daemon-rebuild/plan.mjs', async (original) => ({
  ...await original(),
  planRebuild: async ({ overlays }) => {
    model.plans.push(overlays.map((o) => o.ref));
    const applied = overlays.filter((o) => !(model.closed && o.ref === 'top'));
    const carries = applied.some((o) => o.ref === 'lower' || (o.ref === 'top' && !model.rewritten));
    return { ok: true, upToDate: true, mainSha: '1'.repeat(40), finalSha: (carries ? '4' : '5').repeat(40),
      applied: applied.map((o) => ({ ref: o.ref, sha: (o.ref === 'lower' ? '2' : '3').repeat(40) })),
      decisions: overlays.map((o) => ({ ref: o.ref, pr: o.pr,
        action: model.closed && o.ref === 'top' ? 'remove' : 'apply', reason: 'pr-closed' })),
      alerts: [], establishedLost: [], inputsKey: 'test' };
  },
}));

let root;
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  root = mkdtempSync(join(tmpdir(), 'retired-sources-'));
  Object.assign(model, { plans: [], rewritten: false, closed: false, missing: false, gitError: false });
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
      return result(/^[0-9a-f]{40}$/.test(ref) ? ref : (ref.endsWith('/lower') ? '2' : ref.endsWith('/top') ? (model.rewritten ? '6' : '3') : '1').repeat(40));
    }
    if (cmd === 'for-each-ref') {
      const ref = rest.at(-1);
      return result(`${ref} ${(ref.endsWith('/lower') ? '2' : model.rewritten ? '6' : '3').repeat(40)}`);
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
  const prepare = () => prepareRebuild({ root, env, run: git, now: Date.now, mainOnly: false,
    prState: async () => 'OPEN', prBaseChain: async () => [] });
  return { env, retire, prepare, refs: () => readOverlayState(root, { env }).overlays.map((o) => o.ref) };
}

describe('archived sources remain represented in preparation', () => {
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
