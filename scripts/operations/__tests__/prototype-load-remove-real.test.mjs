/** Exercise the default guarded removal transaction with real registry/lock IO.
 * Only subprocesses are faked; no removal or retirement boundary is substituted. */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPrototypeLoader, defaultDeps } from '../prototype-load-io.mjs';
import { addOverlay, overlayFilePath, readOverlayState } from '../../lib/daemon-overlays.mjs';

const BASE = 'lane/base';
const TOP = 'lane/top';
const BASE_SHA = 'a'.repeat(40);
const TOP_SHA = 'b'.repeat(40);

async function removalFixture({ concurrent = false, acceptOmission = true, identity = null, actor }, check) {
  const root = fs.mkdtempSync(join(tmpdir(), 'prototype-load-remove-'));
  const env = { HOME: root, TMPDIR: root, USER: 'test', WE_DAEMON_OVERLAY_DIR: join(root, 'overlays') };
  const recordPath = join(root, 'prototype-loads.jsonl');
  const state = () => readOverlayState(root, { env });
  const registerTop = () => addOverlay(root, { ref: TOP, reason: 'uncached registration', now: '2026-11-09T12:00:00Z' }, { env });
  try {
    addOverlay(root, { ref: BASE, reason: 'base registration', now: '2026-11-09T11:00:00Z' }, { env });
    if (!concurrent) registerTop();
    const initialBase = state().overlays.find((r) => r.ref === BASE);
    let listed;
    const ancestry = [];
    const exec = vi.fn((command, args) => {
      if (command === 'node' && args[1] === 'list') {
        listed = state().overlays;
        return JSON.stringify({ list: listed });
      }
      if (command === 'git') {
        if (args[0] === 'fetch') return '';
        if (args[0] === 'rev-parse') {
          if (args.at(-1) === `refs/remotes/origin/${BASE}^{commit}`) {
            // The listing has already been captured. Introduce the new dependent
            // immediately before the real retirement acquires its add guard.
            if (concurrent) registerTop();
            return BASE_SHA;
          }
          if (args.at(-1) === `refs/remotes/origin/${TOP}^{commit}`) return TOP_SHA;
        }
        if (args[0] === 'ls-remote' && args.at(-1) === `refs/heads/${BASE}`)
          return `${BASE_SHA}\trefs/heads/${BASE}\n`;

      }
      throw new Error(`Unexpected subprocess: ${command} ${JSON.stringify(args)}`);
    });
    const resolveOperatorIdentity = vi.fn(() => { if (!identity) throw new Error('identity unavailable'); return identity; });
    const load = createPrototypeLoader({ ...defaultDeps(), exec, env,
      resolveOperatorIdentity,
      settings: { daemons: { control: { clone: root } }, workspaceRoot: root,
        loaderCli: 'scripts/daemon-overlay.mjs', recordPath },
    });
    const result = await load({ daemon: 'control', remove: BASE, reason: 'withdraw base', acceptOmission, ...(actor === undefined ? {} : { actor }) });
    await check({ result, state: state(), initialBase, listed, ancestry, exec, resolveOperatorIdentity,
      events: fs.existsSync(overlayFilePath(root, env).replace(/\.json$/, '.events.jsonl'))
        ? fs.readFileSync(overlayFilePath(root, env).replace(/\.json$/, '.events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse) : [],
      records: fs.readFileSync(recordPath, 'utf8').trim().split('\n').map(JSON.parse) });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

describe('prototype-load default guarded removal', () => {
  it('refuses without explicit omission acknowledgement and retains every registration', async () => {
    await removalFixture({ acceptOmission: false }, ({ result, state, events }) => {
      expect(result).toMatchObject({ ok: false, stopReason: 'remove-refused', detail: 'accept-omission-required', removed: [] });
      expect(state.overlays.map(r => r.ref)).toEqual([BASE, TOP]);
      expect(events).toEqual([]);
    });
  });
  it.each([false, true])('acknowledged withdrawal drops only the base despite a dependent (concurrent: %s)', async concurrent => {
    await removalFixture({ concurrent }, ({ result, state, ancestry, records, events, exec }) => {
      expect(result).toMatchObject({ ok: true, removed: [BASE] });
      expect(state.overlays.map(r => r.ref)).toEqual([TOP]);
      expect(ancestry).toEqual([]);
      expect(exec.mock.calls.some(([cmd, args]) => cmd === 'git' && ['merge-base', '--is-shallow-repository', '--git-path'].some(x => args.includes(x)))).toBe(false);
      expect(records[0]).toMatchObject({ ok: true, removed: [BASE] });
      expect(events.at(-1)).not.toHaveProperty('operatorReason');
    });
  });
  it('default removal records the authenticated operator with an explicit actor flag', async () => {
    await removalFixture({ actor: 'CHALBERT', identity: { login: 'CHALBERT', type: 'User' } }, ({ result, events, resolveOperatorIdentity }) => {
      expect(result.ok).toBe(true);
      expect(resolveOperatorIdentity).toHaveBeenCalledTimes(1);
      expect(events.at(-1)).toMatchObject({ kind: 'auto-retired', actor: 'chalbert', operatorReason: true, acceptedOmission: true, tip: BASE_SHA });
    });
  });
  it('without --actor never resolves an available operator and supplies no operator proof', async () => {
    await removalFixture({ identity: { login: 'CHALBERT', type: 'User' } }, ({ result, events, resolveOperatorIdentity }) => {
      expect(result.ok).toBe(true);
      expect(resolveOperatorIdentity).not.toHaveBeenCalled();
      expect(events.at(-1)).not.toHaveProperty('actor');
      expect(events.at(-1)).not.toHaveProperty('operatorReason');
    });
  });
  it('refuses non-operator --actor without changing registrations or events', async () => {
    await removalFixture({ actor: 'outsider', identity: { login: 'outsider', type: 'User' } }, ({ result, state, events, resolveOperatorIdentity }) => {
      expect(result).toMatchObject({ ok: false, stopReason: 'operator-identity-refused', removed: [] });
      expect(resolveOperatorIdentity).toHaveBeenCalledTimes(1);
      expect(state.overlays.map(r => r.ref)).toEqual([BASE, TOP]);
      expect(events).toEqual([]);
    });
  });
});
