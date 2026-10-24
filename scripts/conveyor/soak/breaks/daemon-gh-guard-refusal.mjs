/** PR #5729: guard installation failure must stop both daemon loops before they spawn unguarded gh. */
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureFreshGithubAppEnv } from '../../../lib/github-app-auth-env.mjs';
import { ensureGhShim } from '../../../lib/gh-app-shim.mjs';
import { runLoopCycle } from '../../await-verify-loop.mjs';
import { runPassDaemonLoop } from '../../../../skills-src/conveyor/pass-daemon.mjs';

export default {
  id: 'daemon-gh-guard-refusal',
  title: 'daemon loops stop when their gh refusal guard cannot be installed',
  card: 'PR #5729',
  fixedBy: {
    sha: '07a112db9', where: 'lane/grad-gh-auth-2026-10-19',
    paths: ['scripts/lib/github-app-auth-env.mjs', 'scripts/conveyor/await-verify-loop.mjs', 'skills-src/conveyor/pass-daemon.mjs'],
  },
  fixPresent(root) {
    return ['scripts/conveyor/await-verify-loop.mjs', 'skills-src/conveyor/pass-daemon.mjs']
      .every((path) => readFileSync(join(root, path), 'utf8').includes('isGithubAppAuthGuardError(error)'))
      && readFileSync(join(root, 'scripts/lib/github-app-auth-env.mjs'), 'utf8').includes("'guard-config-invalid'");
  },
  async run({ log } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'soak-gh-guard-'));
    const violations = [];
    try {
      const marker = join(dir, 'called');
      const gh = join(dir, 'gh');
      writeFileSync(gh, `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(marker)}, 'called\\n');\n`, { mode: 0o755 });
      // A regular file in place of the directory fails even under privileged test runners.
      const blockedDir = join(dir, 'blocked');
      writeFileSync(blockedDir, 'not a directory');
      for (const loop of ['pass', 'verify']) for (const failAt of [1, 2]) {
        rmSync(marker, { force: true });
        const env = { HOME: dir, PATH: dir, GH_TOKEN: 'fixture-personal' };
        let refreshes = 0;
        let work = 0;
        let rejected = false;
        const refresh = () => ensureFreshGithubAppEnv({
          env, daemon: true, caller: 'soak-guard', identity: {}, policy: { auth: 'app' },
          writeStatus: () => {}, log: { error() {} },
          installShim: async () => ++refreshes < failAt ? { ok: true } : ensureGhShim({ dir: blockedDir, realGhPath: gh }),
        });
        const cycle = async () => {
          work++;
          // Only work after the failed refresh is unsafe. The earlier successful cycle is a control.
          if (refreshes >= failAt) spawnSync('gh', ['repo', 'view'], { env, timeout: 2000, stdio: 'ignore' });
          return { code: 0 };
        };
        try {
          if (loop === 'pass') {
            await runPassDaemonLoop({ refreshAuth: refresh, runPass: cycle, intervalMs: 1, maxRuns: failAt, sleep: async () => {} });
          } else {
            for (let i = 0; i < failAt; i++) await runLoopCycle({ ensureAuth: refresh, cycle });
          }
        } catch (error) {
          rejected = /refusing to run daemon without the gh auth guard/.test(error.message);
        }
        const invoked = existsSync(marker);
        log?.(`${loop} failAt=${failAt}: rejected=${rejected}, work=${work}, unguardedGh=${invoked}`);
        if (!rejected || work !== failAt - 1 || invoked) violations.push(`${loop} failAt=${failAt}: guard refusal swallowed (work=${work}, unguardedGh=${invoked})`);
      }
      // Red team on 07ea5585e: a malformed delivery.identity threw a TypeError BEFORE the guard was installed,
      // the loop swallowed it as a transient refresh error, and the cycle ran on the personal token.
      const malformedIdentity = JSON.stringify({ worker: { appId: '1', key: { file: '/fixture.pem' }, installations: { 'web-everything': { toString: null } } } });
      for (const loop of ['pass', 'verify']) {
        rmSync(marker, { force: true });
        const env = { HOME: dir, PATH: dir, GH_TOKEN: 'fixture-personal', WE_DELIVERY_IDENTITY: malformedIdentity };
        let work = 0;
        let rejected = false;
        const refresh = () => ensureFreshGithubAppEnv({
          env, daemon: true, caller: 'soak-guard-config', policy: { auth: 'app' },
          writeStatus: () => {}, writeCallerStatus: () => {}, log: { error() {} },
          installShim: async () => ({ ok: true }),
        });
        const cycle = async () => {
          work++;
          spawnSync('gh', ['repo', 'view'], { env, timeout: 2000, stdio: 'ignore' });
          return { code: 0 };
        };
        try {
          if (loop === 'pass') {
            await runPassDaemonLoop({ refreshAuth: refresh, runPass: cycle, intervalMs: 1, maxRuns: 1, sleep: async () => {} });
          } else {
            await runLoopCycle({ ensureAuth: refresh, cycle });
          }
        } catch (error) {
          rejected = /refusing to run daemon without the gh auth guard/.test(error.message);
        }
        const invoked = existsSync(marker);
        log?.(`${loop} malformed identity: rejected=${rejected}, work=${work}, unguardedGh=${invoked}`);
        if (!rejected || work !== 0 || invoked) violations.push(`${loop} malformed identity: pre-guard config error swallowed (work=${work}, unguardedGh=${invoked})`);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
    return { violations };
  },
  judge: (report) => report.violations,
};
