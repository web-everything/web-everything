import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const hooks = vi.hoisted(() => ({ proof: vi.fn(), adoption: vi.fn(), rebuild: vi.fn(), prepare: vi.fn() }));
// Keep the production observer, files and lock. Only launchd discovery is replaced.
vi.mock('../probation-io.mjs', async original => {
  const real = await original();
  return { ...real, ownDaemonId: () => 'X',
    createProbationObserver: opts => {
      const observer = real.createProbationObserver(opts);
      return { ...observer, proof: async own => {
        const result = await observer.proof(own); hooks.proof(own, result); return result;
      } };
    },
    observeAdoptionLocked: (opts, previous, adopted) => {
      const result = real.observeAdoptionLocked({ ...opts, registered: [{ id: 'X', entry: 'x.mjs' }],
        readClosure: () => ({ complete: true, files: { 'x.mjs': 'c'.repeat(40) } }) }, previous, adopted);
      hooks.adoption(opts, previous, adopted, result); return result;
    },
  };
});
// Self-sync uses its DEFAULT rebuild entry (realIo=true); rebuilding is outside these tick-hook tests.
vi.mock('../../daemon-rebuild.mjs', async original => ({ ...await original(), rebuildClone: (...args) => hooks.rebuild(...args) }));
// Isolate the prepare caller's observation boundary from planning/smoke/Git/network operations.
vi.mock('../prepare.mjs', () => ({ prepareRebuild: (...args) => hooks.prepare(...args) }));

import { withSelfSync } from '../../daemon-self-sync.mjs';
import { rebuildClone } from '../rebuild.mjs';
import { finalizeRebuild } from '../adopt.mjs';
import { probationPath } from '../probation-io.mjs';
import { freezeProbation } from '../probation.mjs';
import { readRebuildState, writeRebuildState } from '../state.mjs';
import { withWriteLock, acquireWrite, releaseWrite } from '../../daemon-clone-lock.mjs';

const GOOD = 'a'.repeat(40), HEAD = 'b'.repeat(40);
let dir, root, env, now, log, initial, adopted;
const protectedNames = ['proven-good.json', 'rollback-marker.json', 'unverified-marker.json'];
const protectedBytes = () => protectedNames.map(name => readFileSync(join(env.WE_DAEMON_STATE_DIR, name), 'utf8'));
const stateBytes = () => Object.fromEntries(readdirSync(env.WE_DAEMON_STATE_DIR)
  .filter(name => !name.includes('.probation.json'))
  .map(name => [name, readFileSync(join(env.WE_DAEMON_STATE_DIR, name), 'utf8')]));
beforeEach(() => {
  vi.clearAllMocks();
  dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'probation-callers-'));
  root = join(dir, 'clone'); mkdirSync(root);
  env = { WE_DAEMON_STATE_DIR: join(dir, 'state'), WE_DAEMON_CLONE_LOCK_ROOT: join(dir, 'locks') };
  mkdirSync(env.WE_DAEMON_STATE_DIR);
  now = Date.now(); log = { error: vi.fn() };
  initial = { adopted: { head: GOOD, at: new Date(now - 2000).toISOString(), inputsKey: 'old' },
    rejected: null, inProgress: null, quarantine: null, held: null, unverified: null };
  adopted = { head: HEAD, at: new Date(now).toISOString(), inputsKey: 'new', mainSha: HEAD, applied: [] };
  writeRebuildState(root, initial, env);
  for (const name of protectedNames) writeFileSync(join(env.WE_DAEMON_STATE_DIR, name), `keep ${name}`);
  hooks.rebuild.mockResolvedValue({ moved: false, reason: 'up-to-date' });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function seedPass() {
  const record = freezeProbation({ adoptionId: 'fixture', sha: HEAD, provenGood: GOOD,
    adoptedAt: new Date(now - 1000).toISOString(), registered: [{ id: 'X' }],
    readClosure: () => ({ complete: true, files: { 'x.mjs': GOOD } }) });
  writeFileSync(probationPath(root, env), JSON.stringify(record));
}
const lockOpts = () => ({ lockRoot: env.WE_DAEMON_CLONE_LOCK_ROOT, waitMs: 0 });

describe('R986 production caller probation results remain telemetry only', () => {
  it.each(['pass', 'invalid persistence', 'lock refusal'])('self-sync preserves tick result and lifecycle state on %s', async mode => {
    seedPass();
    if (mode === 'invalid persistence') writeFileSync(probationPath(root, env), '{}');
    const before = stateBytes(), protectedBefore = protectedBytes();
    const tickResult = { processed: 3, cursor: 'keep' };
    const onRestart = vi.fn(), releaseRead = vi.fn();
    const tick = vi.fn(async () => {
      if (mode === 'lock refusal') expect(await acquireWrite(root, { ...lockOpts(), owner: 'other-writer' })).toEqual({ ok: true });
      return tickResult;
    });
    const wrapped = withSelfSync({ tickOnce: tick }, {
      root, env, log, entries: ['x.mjs'], versions: null, background: null, rebuildAsJob: false,
      readHead: () => HEAD, readOriginRef: () => HEAD, readReady: () => null, now: () => now,
      readState: () => readRebuildState(root, env), onRestart,
      acquireRead: () => ({ ok: true }), releaseRead,
      maintain: async () => {}, hasMaintenanceRebuildJob: () => false,
      tickProgress: { read: () => ({}), markTickDone() {}, markSeen() {}, alert() {} },
      recloneMarker: { read: () => null, write() {}, clear() {} }, cloneIdentity: () => 'same-clone',
      rebuildJobIds: () => [], readLatestRebuildJobResult: () => null,
    });
    try {
      expect(await wrapped.tickOnce()).toBe(tickResult);
      expect(tick).toHaveBeenCalledTimes(1);
      expect(onRestart).not.toHaveBeenCalled();
      expect(releaseRead).toHaveBeenCalledTimes(1);
      expect(hooks.rebuild).toHaveBeenCalledTimes(1);
      expect(hooks.proof).toHaveBeenCalledTimes(1);
      expect(releaseRead.mock.invocationCallOrder[0]).toBeLessThan(hooks.proof.mock.invocationCallOrder[0]);
      const [own, result] = hooks.proof.mock.calls[0];
      expect(own).toMatchObject({ daemonId: 'X', pid: process.pid, bootHead: HEAD, tickHead: HEAD });
      expect(result).toMatchObject(mode === 'pass' ? { status: 'valid', action: 'pass' } : { status: 'invalid', action: 'pending' });
      if (mode === 'lock refusal') expect(result.reason).toContain('concurrent-mover');
      expect(stateBytes()).toEqual(before);
      expect(protectedBytes()).toEqual(protectedBefore);
    } finally { releaseWrite(root, { ...lockOpts(), owner: 'other-writer' }); }
  });

  it.each(['pass', 'invalid persistence'])('locked prepare adoption preserves its result and lifecycle state on %s', async mode => {
    if (mode === 'invalid persistence') mkdirSync(probationPath(root, env));
    const protectedBefore = protectedBytes();
    const expected = { moved: true, adopted: true, head: HEAD, reason: 'ready-adopted' };
    hooks.prepare.mockImplementation(async () => {
      writeRebuildState(root, { ...initial, adopted }, env);
      return { terminal: true, result: expected, alerts: [] };
    });
    const result = await rebuildClone({ root, env, log, now: () => now, asJob: false, versions: null,
      skipCheck: null, emitEvent: async () => {}, lockOpts: lockOpts() });
    expect(result).toEqual({ ...expected, alerts: [] });
    expect(hooks.adoption).toHaveBeenCalledTimes(1);
    expect(hooks.adoption.mock.calls[0][3]).toMatchObject(mode === 'pass'
      ? { status: 'valid', action: 'pass' } : { status: 'invalid', action: 'pending' });
    expect(readRebuildState(root, env)).toMatchObject({ adopted, rejected: null, quarantine: null, unverified: null });
    expect(protectedBytes()).toEqual(protectedBefore);
  });

  it.each(['pass', 'invalid persistence'])('locked finalize adoption preserves its result and lifecycle state on %s', async mode => {
    if (mode === 'invalid persistence') mkdirSync(probationPath(root, env));
    const protectedBefore = protectedBytes();
    const plan = { finalSha: HEAD, inputsKey: 'new', mainSha: HEAD, applied: [] };
    const run = vi.fn(args => ({ status: args.includes('MERGE_HEAD') ? 1 : 0,
      stdout: args[0] === 'rev-parse' && args.at(-1) === 'HEAD' ? GOOD : '', stderr: '' }));
    const result = await withWriteLock(root, () => finalizeRebuild({ root, env, log, run, now: () => now,
      prevHead: GOOD, plan, lease: { token: 'fixture' } }), lockOpts());
    expect(result).toMatchObject({ ok: true, value: { moved: true, adopted: true, head: HEAD, prevHead: GOOD, plan, alerts: [] } });
    expect(hooks.adoption).toHaveBeenCalledTimes(1);
    expect(hooks.adoption.mock.calls[0][3]).toMatchObject(mode === 'pass'
      ? { status: 'valid', action: 'pass' } : { status: 'invalid', action: 'pending' });
    expect(run.mock.calls.filter(([args]) => args[0] === 'reset').map(([args]) => args)).toEqual([['reset', '--hard', HEAD]]);
    expect(readRebuildState(root, env)).toMatchObject({ adopted, rejected: null, inProgress: null, quarantine: null, unverified: null });
    expect(protectedBytes()).toEqual(protectedBefore);
  });

  it('prepare lock refusal preserves the existing concurrent-mover decision without observing or adopting', async () => {
    const before = stateBytes();
    expect(await acquireWrite(root, { ...lockOpts(), owner: 'other-writer' })).toEqual({ ok: true });
    try {
      const result = await rebuildClone({ root, env, log, now: () => now, asJob: false, versions: null,
        skipCheck: null, emitEvent: async () => {}, lockOpts: lockOpts() });
      expect(result).toEqual({ moved: false, reason: 'concurrent-mover', heldBy: 'other-writer' });
      expect(hooks.prepare).not.toHaveBeenCalled();
      expect(hooks.adoption).not.toHaveBeenCalled();
      expect(stateBytes()).toEqual(before);
    } finally { releaseWrite(root, { ...lockOpts(), owner: 'other-writer' }); }
  });
});
