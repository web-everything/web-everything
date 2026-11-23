// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finalizeRebuild, matchReadyCandidate } from '../daemon-rebuild/adopt.mjs';
import { makeAuditedTipGate, revokedAppliedTips } from '../daemon-rebuild/audited-tip.mjs';
import { readRebuildState, writeRebuildState } from '../daemon-rebuild/state.mjs';
import { readForceWatch, runForceWatchTick, watchPath } from '../daemon-force-adopt.mjs';
import * as hotpatchReaders from '../hotpatch-readers.mjs';
import { admitHotpatch } from '../hotpatch-guards.mjs';
import { HP_SHA, hotpatchFixture } from './fixtures/hotpatch.mjs';

const roots = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

// Real state/watch IO and adoption functions; Git is injected so this never mutates a checkout.
function fixture() {
  const root = fs.mkdtempSync(join(tmpdir(), 'hotpatch-recovery-'));
  roots.push(root);
  const env = { WE_DAEMON_STATE_DIR: join(root, 'state'), WE_DAEMON_OVERLAY_DIR: join(root, 'overlays'),
    WE_FORCE_ADOPT_HANDOFF: join(root, 'handoff'), WE_FORCE_ADOPT_CORONER: join(root, 'coroner'),
    WE_DAEMON_OVERLAY_FOLLOW_TIP: 'follow' };
  const previous = 'b'.repeat(40);
  const applied = [{ ref: `hotpatch/${HP_SHA}`, sha: HP_SHA }];
  const plan = { ok: true, finalSha: HP_SHA, mainSha: 'e'.repeat(40), inputsKey: 'hotpatch', applied };
  let head = previous;
  const run = vi.fn(args => {
    if (args[0] === 'rev-parse' && args.at(-1) === 'MERGE_HEAD') return { status: 1, stdout: '' };
    if (args[0] === 'rev-parse') return { status: 0, stdout: args.at(-1) === 'HEAD' ? head : HP_SHA };
    if (args[0] === 'reset') head = args.at(-1);
    return { status: 0, stdout: '' };
  });
  const finalize = (extra = {}) => finalizeRebuild({ root, env, run, now: () => 0,
    plan, prevHead: previous, lease: { token: 'normal' }, ...extra });
  return { root, env, previous, applied, plan, run, finalize, head: () => head };
}

describe('hotpatch ready adoption in follow mode', () => {
  it.each(['passing', 'revoked', 'unreadable', 'fetch-failed', 'moved', 'deleted'])(
    'matches admitted ready candidate, then freshly checks %s evidence at finalization', async evidence => {
      const f = fixture();
      const { data, readers } = hotpatchFixture();
      expect(await admitHotpatch(HP_SHA, readers)).toMatchObject({ outcome: 'pass' });
      const auditedTip = makeAuditedTipGate(f.env);
      expect(auditedTip).toBeNull();
      const ready = { kind: 'candidate', prevHead: f.previous, passedAt: new Date(0).toISOString(), adopt: f.plan };
      const matched = matchReadyCandidate({ ready, plan: f.plan, prevHead: f.previous,
        stillWanted: () => true, treeOf: () => HP_SHA, nowMs: 0, maxAgeMs: 1000, auditedTip });
      expect(matched, JSON.stringify(matched)).toMatchObject({ match: 'exact', adopt: f.plan });
      if (evidence === 'revoked') {
        data.audits[0].verdict = 'WEAKENED';
        data.audits[0].findings = ['guard weakened'];
      }
      if (evidence === 'unreadable') readers.checks = () => { throw new Error('CI unavailable'); };
      if (evidence === 'fetch-failed' || evidence === 'deleted') {
        const original = f.run.getMockImplementation();
        f.run.mockImplementation(args => args[0] === 'fetch' ? { status: 1, stdout: '' } : original(args));
      }
      if (evidence === 'moved') {
        const original = f.run.getMockImplementation();
        f.run.mockImplementation(args => args[0] === 'rev-parse' && args.at(-1).startsWith('refs/remotes/')
          ? { status: 0, stdout: f.previous } : original(args));
      }
      vi.spyOn(hotpatchReaders, 'createHotpatchReaders').mockReturnValue(readers);
      const done = await f.finalize({ plan: matched.adopt, auditedTip });
      if (evidence === 'passing') {
        expect(done).toMatchObject({ adopted: true, moved: true, head: HP_SHA });
        expect(readRebuildState(f.root, f.env).adopted.head).toBe(HP_SHA);
      } else {
        expect(done).toMatchObject({ moved: false, reason: 'ready-audit-revoked' });
        expect(f.run.mock.calls.some(([args]) => args[0] === 'reset')).toBe(false);
        expect(f.head()).toBe(f.previous);
      }
      expect(f.run.mock.calls.some(([args]) => args[0] === 'fetch')).toBe(true);
    },
  );

  it.each(['same-tree', 'superseded', 'fallback', 'fallback-main-moved'])(
    'defers hotpatch evidence for the %s ready path in follow mode', match => {
      const f = fixture();
      const fallback = match.startsWith('fallback');
      const ready = { kind: fallback ? 'fallback' : 'candidate', prevHead: f.previous,
        passedAt: new Date(0).toISOString(), adopt: f.plan, tree: HP_SHA, forInputsKey: f.plan.inputsKey };
      const plan = { ...f.plan, finalSha: 'c'.repeat(40),
        inputsKey: match === 'fallback-main-moved' ? 'new-inputs' : f.plan.inputsKey };
      expect(matchReadyCandidate({ ready, plan, prevHead: f.previous, stillWanted: () => true,
        treeOf: () => match === 'same-tree' ? HP_SHA : 'other-tree', verifyBuilt: () => true,
        liveApplied: [], nowMs: 0, maxAgeMs: 1000, auditedTip: makeAuditedTipGate(f.env) }))
        .toMatchObject({ match, adopt: { applied: f.applied } });
    },
  );

  it('keeps ref identity checks in follow mode and negative audit checks in audited mode', () => {
    const applied = [{ ref: `hotpatch/${HP_SHA}`, sha: HP_SHA }];
    expect(revokedAppliedTips({ applied, auditedTip: () => false })).toEqual([applied[0].ref]);
    expect(revokedAppliedTips({ applied, auditedTip: () => true })).toEqual([]);
    expect(revokedAppliedTips({ applied: [{ ...applied[0], sha: 'c'.repeat(40) }], auditedTip: null }))
      .toEqual([applied[0].ref]);
  });
});

describe('retained rollback obligation authorizes only its last-good head', () => {
  it.each(['missing', 'unreadable'])('retries from memory after the watch becomes %s', async loss => {
    const f = fixture();
    const lastGood = { head: HP_SHA, inputsKey: f.plan.inputsKey, mainSha: f.plan.mainSha, applied: f.applied };
    writeRebuildState(f.root, { adopted: { ...lastGood, head: f.previous } }, f.env);
    const path = watchPath(f.root, f.env);
    fs.writeFileSync(path, JSON.stringify({ sha: f.previous, lastGood, adoptedSeen: true,
      daemon: 'test', ruling: 'R1', ticksLeft: 5, version: 1, startedAt: new Date(0).toISOString() }));
    // A directory at the atomic-write temporary path makes persistence fail with EISDIR.
    fs.mkdirSync(`${path}.${process.pid}.tmp`);
    const failed = await runForceWatchTick({ root: f.root, env: f.env, currentHead: f.head,
      probe: async () => ({ healthy: false }), rollback: async () => ({ ok: false }) });
    expect(failed.action).toBe('rollback-failed');
    expect(readForceWatch(f.root, f.env).rollbackPending).toBeUndefined();
    if (loss === 'missing') fs.rmSync(path);
    else fs.writeFileSync(path, 'unreadable JSON');
    expect(readForceWatch(f.root, f.env)).toBeNull();
    const original = f.run.getMockImplementation();
    f.run.mockImplementation(args => args[0] === 'fetch' ? { status: 1, stdout: '' } : original(args));
    const factory = vi.spyOn(hotpatchReaders, 'createHotpatchReaders');
    // A token alone, a caller-supplied target, or normal adoption must not inherit the exemption.
    expect(await f.finalize({ lease: { token: 'force-adopt-rollback' },
      plan: { ...f.plan, finalSha: 'c'.repeat(40) } })).toMatchObject({ reason: 'ready-audit-revoked' });
    expect(await f.finalize()).toMatchObject({ reason: 'ready-audit-revoked' });
    // A new disk watch takes precedence over an old in-process obligation on the same path.
    fs.writeFileSync(path, JSON.stringify({ sha: f.previous, lastGood: { ...lastGood, head: 'c'.repeat(40) } }));
    expect(await f.finalize({ lease: { token: 'force-adopt-rollback' } }))
      .toMatchObject({ reason: 'ready-audit-revoked' });
    if (loss === 'missing') fs.rmSync(path);
    else fs.writeFileSync(path, 'unreadable JSON');
    f.run.mockClear();
    let finalization;
    const retried = await runForceWatchTick({ root: f.root, env: f.env, currentHead: f.head,
      probe: async () => ({ healthy: true }), rollback: async (retained, { sha }) => {
        expect(retained).toEqual(lastGood);
        finalization = await f.finalize({ prevHead: sha, lease: { token: 'force-adopt-rollback' },
          plan: { ...f.plan, finalSha: retained.head, applied: retained.applied } });
        return { ok: finalization.adopted === true };
      } });
    expect(finalization).toMatchObject({ moved: true, adopted: true, head: HP_SHA });
    expect(retried.action).toBe('rollback');
    expect(f.run.mock.calls.some(([args]) => args[0] === 'fetch')).toBe(false);
    expect(factory).not.toHaveBeenCalled();
    expect(readRebuildState(f.root, f.env).adopted.head).toBe(HP_SHA);
    if (loss === 'unreadable') fs.rmSync(path);
    expect(await runForceWatchTick({ root: f.root, env: f.env })).toEqual({ action: 'none' });
  });
});
