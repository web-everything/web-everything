import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { rebuildClone } from '../rebuild.mjs';
import { rebuildStatePath, readyCandidatePath, writeRebuildState, readRebuildState,
  readReadyCandidate, writeReadyCandidate, clearReadyCandidate, rebuildStateSchema } from '../state.mjs';
import { pendingAdoptionPath, readPendingAdoptions } from '../../overlay-adoption.mjs';
import { overlayFilePath, readOverlayState, appendOverlayEvent } from '../../daemon-overlays.mjs';
import { reportDiscardedCandidate } from '../adopt.mjs';
import { starvePath, readRebuildStarvation } from '../lease.mjs';
import { readOverlayEventLog } from '../prepare.mjs';
import { createRebuildReaders, RebuildEvidenceError } from '../evidence-readers.mjs';
import { withRebuildReaders } from '../evidence-context.mjs';
import { requestPath, watchPath, readForceAdopt, readForceWatch } from '../../daemon-force-adopt.mjs';
import { readOverlayConflictWakes } from '../../overlay-conflict-wake.mjs';
import { pendingPath, readPendingDrops } from '../../overlay-drop-pending.mjs';
import * as preparation from '../prepare.mjs';
import * as locks from '../../daemon-clone-lock.mjs';

const dirs = [];
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const inventory = [
  ['forceRequest', requestPath, readForceAdopt],
  ['forceWatch', watchPath, readForceWatch],
  ['conflictWakes', (_r, e) => join(e.WE_DAEMON_STATE_DIR, 'overlay-conflict-wake.json'), (_r, e) => readOverlayConflictWakes(e)],
  ['pendingDrops', pendingPath, readPendingDrops],
  ['state', rebuildStatePath, readRebuildState],
  ['ready', readyCandidatePath, readReadyCandidate],
  ['pending', pendingAdoptionPath, (r, e) => readPendingAdoptions(r, { env: e })],
  ['lease', rebuildStatePath, (r, e) => readRebuildState(r, e).building],
  ['overlays', overlayFilePath, (r, e) => readOverlayState(r, { env: e })],
  ['starvation', starvePath, readRebuildStarvation],
  ['overlayEvents', (r, e) => overlayFilePath(r, e).replace(/\.json$/, '.events.jsonl'), readOverlayEventLog],
];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'rebuild-evidence-')); dirs.push(root);
  const env = { WE_DAEMON_STATE_DIR: join(root, 'state'), WE_DAEMON_OVERLAY_DIR: join(root, 'overlays') };
  return { root, env };
}
const cases = inventory.flatMap(([reader, path, legacy]) => ['corrupt', 'EACCES', 'wrong type', 'wrong shape'].map(fault => ({ reader, path, legacy, fault })));
for (const [launchedBy, readyOnly] of [['early', true], ['recovery', true], ['tick-start', true], ['tick-start', false]]) {
  describe(`${launchedBy} ${readyOnly ? "child" : "inline"} evidence refusal`, () => {
    for (const stage of ['child entry', 'locked preparation']) {
      it.each(cases)(`${stage}: $reader refuses $fault and preserves bytes`, async ({ reader, path, legacy, fault }) => {
        const { root, env } = fixture();
        const file = path(root, env);
        const pendingFile = pendingAdoptionPath(root, env);
        mkdirSync(dirname(pendingFile), { recursive: true });
        writeFileSync(pendingFile, JSON.stringify([{ ref: 'lane/overdue', sha: 'a'.repeat(40), at: new Date(0).toISOString() }]));
        mkdirSync(dirname(file), { recursive: true });
        let injected = false;
        const stamp = new Date(0).toISOString();
        const valid = {
          state: Object.fromEntries(Object.keys(rebuildStateSchema).map(k => [k, null])),
          lease: Object.fromEntries(Object.keys(rebuildStateSchema).map(k => [k, null])),
          ready: { prevHead: 'head', tree: 'tree', passedAt: stamp, kind: 'candidate', forced: false,
            adopt: { finalSha: 'target', inputsKey: 'inputs', mainSha: 'main', applied: [] } },
          pending: [], overlays: { clone: root, overlays: [] }, starvation: { count: 0 },
          overlayEvents: { ref: 'lane/x', kind: 'added' },
          forceRequest: { daemon: 'test', ruling: 'R1', quote: 'operator quote', sha: 'a'.repeat(40), requestedAt: stamp, expiresAt: stamp },
          forceWatch: { daemon: 'test', ruling: 'R1', sha: 'a'.repeat(40), startedAt: stamp, ticksLeft: 1, bad: 0, lastGood: null },
          conflictWakes: {}, pendingDrops: { pending: [] },
        };
        const expectedBytes = fault === 'corrupt' ? '{broken' : fault === 'EACCES' ? JSON.stringify(valid[reader])
          : fault === 'wrong type' ? 'false' : reader === 'forceRequest' ? JSON.stringify({ ...valid.forceRequest, sha: undefined })
            : reader === 'lease' ? JSON.stringify({ ...valid.lease, building: { token: 'incomplete' } })
            : reader === 'conflictWakes' ? '{"bad":{}}' : '{}';
        const poison = () => {
          writeFileSync(file, expectedBytes);
          injected = true;
        };
        if (stage === 'child entry') poison();
        const run = vi.fn(() => { throw new Error('Git must not run on unreadable evidence'); });
        const evidenceRead = (p, ...args) => {
          if (injected && p === file && fault === 'EACCES') throw Object.assign(new Error('denied'), { code: 'EACCES' });
          return readFileSync(p, ...args);
        };
        vi.spyOn(locks, 'withWriteLock').mockImplementation(async (_root, fn) => {
          if (stage === 'locked preparation') poison();
          return { ok: true, value: await fn() };
        });
        const log = { error: vi.fn() };
        const result = await rebuildClone({ root, env, launchedBy, readyOnly, asJob: false,
          versions: null, mainOnly: true, evidenceRead, run, log });
        expect(result).toMatchObject({ moved: false, reason: 'state-unreadable' });
        const bytes = readFileSync(file, 'utf8');
        if (reader !== 'pending') expect(readFileSync(pendingFile, 'utf8')).toBe(JSON.stringify([
          { ref: 'lane/overdue', sha: 'a'.repeat(40), at: new Date(0).toISOString() },
        ]));
        expect(bytes).toBe(expectedBytes);
        expect(run).not.toHaveBeenCalled();
        expect(log.error).toHaveBeenCalledWith(expect.stringContaining('state-unreadable'));
        // An indirect legacy call must inherit the same policy, including null-valued readers.
        const readers = createRebuildReaders({ strict: true, read: evidenceRead });
        expect(() => withRebuildReaders(readers, () => legacy(root, env))).toThrow(RebuildEvidenceError);
        expect(readFileSync(file, 'utf8')).toBe(bytes);
      });
    }
  });
}

it.each(['write state', 'publish ready', 'clear ready'])('rechecks evidence before %s after a clean read', action => {
  const { root, env } = fixture();
  const readers = createRebuildReaders({ strict: true });
  const file = readyCandidatePath(root, env);
  withRebuildReaders(readers, () => {
    readers.validate(root, env);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '{changed during smoke');
    const write = action === 'write state' ? () => writeRebuildState(root, {}, env)
      : action === 'publish ready' ? () => writeReadyCandidate(root, {}, env) : () => clearReadyCandidate(root, env);
    expect(write).toThrow();
    expect(readFileSync(file, 'utf8')).toBe('{changed during smoke');
  });
});

it('absent evidence stays empty for every strict reader', () => {
  const { root, env } = fixture();
  const readers = createRebuildReaders({ strict: true });
  expect(() => readers.validate(root, env)).not.toThrow();
  expect(readers.lease(root, env)).toBeNull();
  expect(readers.ready(root, env)).toBeNull();
  expect(readers.pending(root, env)).toEqual([]);
});

it.each([true, false])('tick-start readyOnly=%s proceeds normally with cleanly absent evidence', async readyOnly => {
  const { root, env } = fixture();
  const prepare = vi.spyOn(preparation, 'prepareRebuild').mockResolvedValue({ terminal: true,
    result: { moved: false, reason: 'up-to-date' }, alerts: [] });
  vi.spyOn(locks, 'withWriteLock').mockImplementation(async (_root, fn) => ({ ok: true, value: await fn() }));
  const result = await rebuildClone({ root, env, launchedBy: 'tick-start', readyOnly, asJob: false,
    versions: null, mainOnly: true, emitEvent: vi.fn(), log: { error() {} } });
  expect(result).toMatchObject({ moved: false, reason: 'up-to-date' });
  expect(prepare).toHaveBeenCalledOnce();
});

it('strict readers accept persisted legacy backoff, hold and lease records', () => {
  const { root, env } = fixture();
  const stamp = new Date(0).toISOString();
  writeRebuildState(root, {
    rejected: { inputsKey: 'inputs', reason: 'smoke-rejected', at: stamp },
    held: { reason: 'smoke-env-timeout', since: stamp, updatedAt: stamp },
    building: { token: 'legacy', pid: process.pid, host: 'host', startedAt: stamp, target: 'target', inputsKey: 'inputs', path: root },
  }, env);
  const readers = createRebuildReaders({ strict: true });
  expect(() => readers.validate(root, env)).not.toThrow();
  expect(readers.state(root, env).held).toEqual({ reason: 'smoke-env-timeout', since: stamp, updatedAt: stamp });
  expect(readers.lease(root, env)).not.toHaveProperty('adoptOnly');
  expect(readers.state(root, env).rejected).not.toHaveProperty('retryAt');
});

function publishDiscard({ root, env }, refs) {
  reportDiscardedCandidate({
    ready: { adopt: { finalSha: 'target', applied: refs.map(ref => ({ ref, sha: 'tip' })) } },
    match: { reason: 'forced-sha-pinned' }, alert() {},
    needsYou: ({ kind, ...detail }) => appendOverlayEvent(root, { kind: 'needs-you', need: kind, ...detail }, { env }),
  });
  return overlayFilePath(root, env).replace(/\.json$/, '.events.jsonl');
}

it.each([[], ['lane/x']].map(refs => [refs]))('strict readers accept the production aggregate discard notice for refs %j', refs => {
  const f = fixture();
  publishDiscard(f, refs);
  const readers = createRebuildReaders({ strict: true });
  expect(() => readers.validate(f.root, f.env)).not.toThrow();
  expect(readers.overlayEvents(f.root, f.env)).toEqual([{
    at: expect.any(String), kind: 'needs-you', need: 'ready-candidate-discarded',
    target: 'target', reason: 'forced-sha-pinned', refs,
  }]);
});

it.each(['at', 'kind', 'need', 'target', 'reason', 'refs'].flatMap(key =>
  ['missing', 'wrong-type'].map(mode => [key, mode])))(
  'strict aggregate discard notice refuses %s %s without changing evidence', (key, mode) => {
    const f = fixture();
    const file = publishDiscard(f, ['lane/x']);
    const event = JSON.parse(readFileSync(file, 'utf8'));
    if (mode === 'missing') delete event[key]; else event[key] = 42;
    const bytes = JSON.stringify(event) + '\n';
    writeFileSync(file, bytes);
    expect(() => createRebuildReaders({ strict: true }).validate(f.root, f.env)).toThrow(RebuildEvidenceError);
    expect(readFileSync(file, 'utf8')).toBe(bytes);
  });

it.each([{ ref: null }, { ref: 42 }, { refs: [42] }, { refs: [null] },
  { ref: 'lane/x', refs: [42] }, { ref: 'lane/x', target: 42 }])(
  'strict aggregate discard notice refuses wrong-typed reference evidence %j', patch => {
    const f = fixture();
    const file = publishDiscard(f, ['lane/x']);
    const bytes = JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), ...patch }) + '\n';
    writeFileSync(file, bytes);
    expect(() => createRebuildReaders({ strict: true }).validate(f.root, f.env)).toThrow(RebuildEvidenceError);
    expect(readFileSync(file, 'utf8')).toBe(bytes);
  });
