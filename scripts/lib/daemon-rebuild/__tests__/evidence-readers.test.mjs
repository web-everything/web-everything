import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { rebuildClone } from '../rebuild.mjs';
import { rebuildStatePath, readyCandidatePath, writeRebuildState, readRebuildState,
  readReadyCandidate, writeReadyCandidate, clearReadyCandidate, rebuildStateSchema } from '../state.mjs';
import { pendingAdoptionPath, readPendingAdoptions } from '../../overlay-adoption.mjs';
import { overlayFilePath, readOverlayState } from '../../daemon-overlays.mjs';
import { starvePath, readRebuildStarvation } from '../lease.mjs';
import { readOverlayEventLog } from '../prepare.mjs';
import { createRebuildReaders } from '../evidence-readers.mjs';
import { withRebuildReaders } from '../evidence-context.mjs';
import { requestPath, watchPath, readForceAdopt, readForceWatch } from '../../daemon-force-adopt.mjs';
import { readOverlayConflictWakes } from '../../overlay-conflict-wake.mjs';
import { pendingPath, readPendingDrops } from '../../overlay-drop-pending.mjs';
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
const cases = inventory.flatMap(([reader, path, legacy]) => ['corrupt', 'EACCES', 'wrong shape'].map(fault => ({ reader, path, legacy, fault })));
for (const launchedBy of ['early', 'recovery']) {
  describe(`${launchedBy} child evidence refusal`, () => {
    for (const stage of ['child entry', 'locked preparation']) {
      it.each(cases)(`${stage}: $reader refuses $fault and preserves bytes`, async ({ reader, path, legacy, fault }) => {
        const { root, env } = fixture();
        const file = path(root, env);
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
          : reader === 'conflictWakes' ? '[]' : '{}';
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
        const result = await rebuildClone({ root, env, launchedBy, readyOnly: true, asJob: false,
          versions: null, mainOnly: true, evidenceRead, run, log: { error() {} } });
        expect(result).toMatchObject({ moved: false, reason: 'state-unreadable' });
        const bytes = readFileSync(file, 'utf8');
        expect(bytes).toBe(expectedBytes);
        expect(run).not.toHaveBeenCalled();
        // An indirect legacy call must inherit the same policy, including null-valued readers.
        const readers = createRebuildReaders({ strict: true, read: evidenceRead });
        expect(() => withRebuildReaders(readers, () => legacy(root, env))).toThrow();
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
