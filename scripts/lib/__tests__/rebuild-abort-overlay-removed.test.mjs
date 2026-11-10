import { it, expect, vi, afterEach } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { smokeAndAdopt, checkAppliedOverlays } from '../daemon-rebuild/smoke.mjs';
import { readReadyCandidate } from '../daemon-rebuild/state.mjs';
import { removeOverlay, overlayFilePath, appendOverlayEvent } from '../daemon-overlays.mjs';
import { fixture } from './helpers/safe-point-fixture.mjs';
const fixtures = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.cleanup(); });
function make() { const f = fixture(); fixtures.push(f); return f; }
it('removal during smoke stops subsequent children, tears down candidate and records no readiness', async () => {
  const f = make(); const log = { error: vi.fn() }; let checks = 0;
  const result = await smokeAndAdopt({ root: f.root, env: f.env, stEnv: f.env, log, run: f.run, stateOpts: {},
    now: Date.now, plan: f.plan, prevHead: f.head, lease: { token: 'test', path: `${f.dir}/candidate` },
    overlaysBefore: f.plan.applied, prepAlerts: [], mainOnly: false, readyOnly: true,
    finalLockOpts: { lockRoot: f.env.WE_DAEMON_CLONE_LOCK_ROOT, waitMs: 20 }, dispatchSmoke: { settings: { enabled: false } },
    runSmoke: async ({ runChild }) => {
      checks++; removeOverlay(f.root, 'B', { env: f.env });
      await expect(runChild('must-not-spawn', [])).rejects.toThrow('rebuild-aborted-overlay-removed');
      return { verdict: 'pass', smoke: { results: [] } };
    } });
  expect(checks).toBe(1); expect(result).toMatchObject({ moved: false, reason: 'rebuild-aborted-overlay-removed', refs: ['B'] });
  expect(readReadyCandidate(f.root, f.env)).toBeNull();
  expect(f.git('worktree', 'list', '--porcelain')).not.toContain(`${f.dir}/candidate`);
  const events = readFileSync(overlayFilePath(f.root, f.env).replace(/\.json$/, '.events.jsonl'), 'utf8');
  expect(events).toContain('rebuild-aborted-overlay-removed'); expect(events).toContain('"refs":["B"]');
});
it('corrupt registry fails closed before running any smoke', () => {
  const f = make(); writeFileSync(overlayFilePath(f.root, f.env), '{bad');
  expect(() => checkAppliedOverlays({ root: f.root, env: f.env, applied: f.plan.applied, git: (args) => f.run(args) }))
    .toThrow('rebuild-aborted-overlay-removed');
});

it('proven in-main graduation during smoke does not abort the build', () => {
  const f = make();
  f.git('update-ref', 'refs/remotes/origin/main', f.target);
  removeOverlay(f.root, 'B', { env: f.env });
  appendOverlayEvent(f.root, { kind: 'auto-dropped', ref: 'B', reason: 'in-main', at: '2020-01-01T00:00:00.000Z' }, { env: f.env });
  expect(() => checkAppliedOverlays({ root: f.root, env: f.env, applied: f.plan.applied, git: (args) => f.run(args) })).not.toThrow();
});
