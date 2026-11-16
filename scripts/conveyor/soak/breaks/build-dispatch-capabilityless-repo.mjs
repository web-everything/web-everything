/**
 * PR #6911: adding the cards-only longshore registry entry made every build tick
 * depend on credentials for that repo. Replay HTTP 403 and 404 at the real REST
 * transport boundary and drive the daemon through build selection.
 * Discovered automatically by breaks/index.mjs.
 */
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { BUILD_DISPATCH_POLICY } from '../../build-dispatch-policy.mjs';

export default {
  id: 'build-dispatch-capabilityless-repo',
  title: 'an inaccessible cards-only repo must not abort build selection for existing repos',
  card: '#8418 (PR #6911)',
  fixedBy: {
    sha: 'HEAD', where: 'lane/longshore-locus-s1',
    paths: ['skills-src/conveyor/build-dispatch-daemon.mjs'],
  },
  fixPresent(root) {
    const file = join(root, 'skills-src/conveyor/build-dispatch-daemon.mjs');
    return existsSync(file) && /Object\.entries\(capableRepos\('build'\)\)/.test(readFileSync(file, 'utf8'));
  },
  async run({ log, inProcess = false } = {}) {
    if (!inProcess) {
      // A fresh process installs a transport-only loader before importing the
      // daemon. This also works on the pre-fix daemon, without a new IO seam.
      const loader = new URL('./fixtures/build-dispatch-capabilityless-repo-loader.mjs', import.meta.url).href;
      const script = `
        import { register } from 'node:module';
        register(${JSON.stringify(loader)});
        const { default: scenario } = await import(${JSON.stringify(import.meta.url)});
        console.log(JSON.stringify(await scenario.run({ inProcess: true })));
      `;
      try {
        const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
          encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
        });
        log?.(output.trim());
        return JSON.parse(output.trim().split('\n').at(-1));
      } catch (error) {
        return { violations: [`scenario failed: ${String(error.stderr || error.message).slice(0, 2000)}`] };
      }
    }
    const { cliFetchOpenPrs, runBuildDispatchTick } = await import('../../../../skills-src/conveyor/build-dispatch-daemon.mjs');
    const transport = await import('../../open-pr-fetch.mjs');
    if (typeof transport.resetBuildDispatchSoakTransport !== 'function') {
      throw new Error('offline transport loader was not installed');
    }
    const violations = [];
    for (const status of [403, 404]) {
      transport.resetBuildDispatchSoakTransport(status);
      const calls = transport.buildDispatchSoakCalls;
      let repos = [];
      try {
        const out = await runBuildDispatchTick({
          live: false,
          policy: { ...BUILD_DISPATCH_POLICY, maxConcurrentBuilds: 1 },
          effects: {
            planTick: () => ({
              decisions: {
                counts: { building: 1, buildingInFlight: 0 },
                spawnBuilds: [{ num: '9001', lane: 15 }],
                admission: {
                  queue: [{ num: '9001', scope: ['we:src/new-build.mjs'] }],
                  cleared: [{ num: '9001', ready: true }],
                },
              },
              nextState: {},
            }),
            fetchOpenPrs: async () => {
              const snapshot = await cliFetchOpenPrs();
              repos = snapshot.map(row => row.repo);
              return snapshot;
            },
            listClaims: () => [],
            listRunStoreInFlight: () => [],
            killSwitch: () => ({ engaged: false }),
          },
        });
        if (JSON.stringify(out.plan.dispatch.map(row => row.num)) !== '["9001"]') {
          violations.push(`HTTP ${status}: build selection did not retain candidate 9001`);
        }
      } catch (error) {
        violations.push(`HTTP ${status}: tick aborted: ${error.message}`);
      }
      if (JSON.stringify(repos) !== '["we","frontierui","plateau-app"]' || calls.length !== 6) {
        violations.push(`HTTP ${status}: expected pulls and files for all three build repos; repos=${JSON.stringify(repos)}, calls=${JSON.stringify(calls)}`);
      }
      if (calls.some(endpoint => endpoint.startsWith('repos/longshoreai/longshore/'))) {
        violations.push(`HTTP ${status}: attempted a longshore read`);
      }
      log?.(`HTTP ${status}: repos=${repos.join(',')}, REST calls=${calls.length}`);
    }
    return { violations };
  },
  judge(report) { return report.violations; },
};
