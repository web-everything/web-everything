/** PR #5729 send-back: a daemon dispatch whose gh refusal shim cannot be written must never reach the provider. */
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..', '..');

export default {
  id: 'daemon-dispatch-gh-guard-refusal',
  title: 'a daemon dispatch with an unwritable gh shim dir reaches the provider without the refusal guard',
  card: 'PR #5729 (operator send-back, red-team break 1)',
  fixedBy: { sha: 'HEAD', where: 'lane/grad-gh-auth-2026-10-19', paths: ['scripts/operations/dispatch-lane-io.mjs'] },
  fixPresent(root) {
    try { return readFileSync(join(root, 'scripts/operations/dispatch-lane-io.mjs'), 'utf8').includes('dispatch refused: '); } catch { return false; }
  },
  async run({ log } = {}) {
    const io = await import(resolve(REPO_ROOT, 'scripts/operations/dispatch-lane-io.mjs'));
    const { DISPATCH_EFFECT } = await import(resolve(REPO_ROOT, 'scripts/operations/dispatch-lane.mjs'));
    const violations = [];
    for (const marker of [{ WE_GH_DAEMON_CALLER: 'soak-review-daemon' }, { XPC_SERVICE_NAME: 'com.we.soak-review-daemon' }]) {
      const dir = mkdtempSync(join(tmpdir(), 'soak-dispatch-guard-'));
      const bin = join(dir, 'bin');
      const claude = join(dir, 'home', '.claude');
      mkdirSync(bin);
      mkdirSync(claude, { recursive: true });
      writeFileSync(join(bin, 'gh'), '#!/bin/sh\n', { mode: 0o755 });
      chmodSync(claude, 0o500); // the shim dir under HOME cannot be created: EACCES
      const keys = ['HOME', 'PATH', 'WE_GH_DAEMON_CALLER', 'XPC_SERVICE_NAME'];
      const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
      let providerCalls = 0;
      let outcome = 'dispatched';
      try {
        Object.assign(process.env, { HOME: join(dir, 'home'), PATH: bin, WE_GH_DAEMON_CALLER: '', XPC_SERVICE_NAME: '' }, marker);
        const sinks = io.createDispatchSinks({
          root: '/soak/workspace/webeverything', mintSessionId: () => 'soak-sess', now: () => new Date('2026-10-22T00:00:00Z'),
          sessionCwdFor: () => join(dir, 'scratch'), ensureSessionCwd: (d) => d, resolveSettingsEnv: io.resolveDispatchSettingsEnv,
          resolveLaneGrant: () => ({}), grantLanePermission: () => {}, ensureWorktreeIsolation: () => {},
          reserveLane: () => ({ reserved: false }), releaseLane: () => {},
          provider: async () => { providerCalls++; return 'soak-handle'; },
        });
        await sinks[DISPATCH_EFFECT]({ num: '1', launchKind: 'build', lane: 2, sessionSlug: 'soak-1', scope: [], prompt: 'brief' }, {});
      } catch (e) {
        outcome = e?.notApplied ? 'refused' : `threw-indeterminate: ${String(e?.message || e).slice(0, 80)}`;
      } finally {
        for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
        chmodSync(claude, 0o700);
        rmSync(dir, { recursive: true, force: true });
      }
      const name = Object.keys(marker)[0];
      log?.(`${name}: outcome=${outcome}, providerCalls=${providerCalls}`);
      if (outcome !== 'refused' || providerCalls !== 0) violations.push(`${name}: daemon dispatch went out without the gh guard (outcome=${outcome}, providerCalls=${providerCalls})`);
    }
    return { violations };
  },
  judge: (report) => report.violations,
};
