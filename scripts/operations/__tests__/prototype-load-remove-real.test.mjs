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

async function removalFixture({ concurrent = false, descendant = true }, check) {
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
        if (args[0] === 'merge-base') {
          ancestry.push({ args, guarded: fs.existsSync(`${overlayFilePath(root, env)}.add-guard.lock`) });
          if (descendant) return '';
          throw Object.assign(new Error('not an ancestor'), { status: 1 });
        }
      }
      throw new Error(`Unexpected subprocess: ${command} ${JSON.stringify(args)}`);
    });
    const load = createPrototypeLoader({ ...defaultDeps(), exec, env,
      settings: { daemons: { control: { clone: root } }, workspaceRoot: root,
        loaderCli: 'scripts/daemon-overlay.mjs', recordPath },
    });
    const result = await load({ daemon: 'control', remove: BASE, reason: 'withdraw base' });
    await check({ result, state: state(), initialBase, listed, ancestry, exec,
      records: fs.readFileSync(recordPath, 'utf8').trim().split('\n').map(JSON.parse) });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

describe('prototype-load default guarded removal ancestry protection', () => {
  const retained = ({ result, state, initialBase, ancestry, exec, records }) => {
    expect(result).toMatchObject({ ok: false, stopReason: 'remove-refused', detail: 'not-proved', removed: [] });
    expect(state.corrupt).toBe(false);
    expect(state.overlays.find((r) => r.ref === BASE)).toEqual(initialBase);
    expect(state.overlays.map((r) => r.ref)).toEqual([BASE, TOP]);
    expect(state.overlays.every((r) => !Object.hasOwn(r, 'stackBases'))).toBe(true);
    expect(ancestry).toEqual([{ args: ['merge-base', '--is-ancestor', BASE_SHA, TOP_SHA], guarded: true }]);
    expect(exec.mock.calls.filter(([command]) => command === 'node')).toHaveLength(1);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ stopReason: 'remove-refused', removed: [] });
  };

  it('default removal retains a base required by an uncached descendant under the add guard', async () => {
    await removalFixture({}, (evidence) => {
      expect(evidence.listed.map((r) => r.ref)).toEqual([BASE, TOP]);
      retained(evidence);
    });
  });

  it('default removal re-reads and protects an uncached descendant registered after listing and before guarded proof', async () => {
    await removalFixture({ concurrent: true }, (evidence) => {
      expect(evidence.listed.map((r) => r.ref)).toEqual([BASE]);
      retained(evidence);
    });
  });

  it('default removal drops only the requested base when the other registration is not a descendant', async () => {
    await removalFixture({ descendant: false }, ({ result, state, ancestry, records }) => {
      expect(result).toMatchObject({ ok: true, stopReason: null, removed: [BASE] });
      expect(state.corrupt).toBe(false);
      expect(state.overlays.map((r) => r.ref)).toEqual([TOP]);
      expect(ancestry).toEqual([{ args: ['merge-base', '--is-ancestor', BASE_SHA, TOP_SHA], guarded: true }]);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ ok: true, removed: [BASE] });
    });
  });
});
