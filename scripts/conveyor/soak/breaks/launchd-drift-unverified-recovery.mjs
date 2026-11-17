/** Replay PR #6927 through the production scanner, evaluator and persisted health engine. */
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const SCANNER = 'scripts/conveyor/health-smells/launchd-ops-copy-drift.mjs';

export default {
  id: 'launchd-drift-unverified-recovery',
  title: 'shell commands retain drift episodes while independently verified jobs recover',
  card: 'PR #6927',
  fixedBy: { sha: 'HEAD', where: 'lane/launchd-ops-copy-drift', paths: [SCANNER] },
  fixPresent() { return true; },
  async run({ sourceRoot = ROOT } = {}) {
    const { default: smell, scanLaunchdOpsCopyDrift } = await import(pathToFileURL(join(sourceRoot, SCANNER)).href);
    const { emptyHealthState, episodeKey, runHealthTick } = await import(pathToFileURL(join(sourceRoot, 'scripts/conveyor/health-watch-core.mjs')).href);
    const violations = [];
    for (const scenario of ['shell', 'env-split-shell', 'env-split-escape', 'wrapped-env-split', 'env-split-mixed-scripts', 'partial-recovery']) {
      let phase = 'drift';
      const copy = '/home/fixture/ops/sync-guard-clone.mjs';
      const deps = {
        home: '/home/fixture',
        listPlists: () => phase === 'partial-recovery' ? ['com.we.guard.plist', 'unreadable.plist'] : ['com.we.guard.plist'],
        readPlist: (name) => {
          if (name === 'unreadable.plist') throw new Error('unreadable');
          return { Label: 'com.we.guard', ProgramArguments: phase === 'shell' ? ['/bin/sh', '-c', `node ${copy}`]
            : phase === 'env-split-shell' ? ['/usr/bin/env', '-S', `sh -c "node ${copy}"`]
            : phase === 'env-split-escape' ? ['/usr/bin/env', '-S', String.raw`sh\_-c\_'node "$SCRIPT"'`]
            : phase === 'env-split-mixed-scripts' ? ['/usr/bin/env', '-S', `node --import=/home/fixture/ops/guard.mjs "${copy}"`]
            : phase === 'wrapped-env-split' ? ['/usr/bin/nohup', '/usr/bin/env', '-S', 'sh -c \'node "$SCRIPT"\''] : ['node', copy] };
        },
        inGitCheckout: () => false,
        repoFilesByBasename: () => ['scripts/sync-guard-clone.mjs'],
        hashCopy: () => ['partial-recovery', 'env-split-mixed-scripts'].includes(phase) ? 'new' : 'old',
        hashMain: () => 'new', copyMtimeMs: () => 0, mainCommitMs: () => 86_400_000,
      };
      const descriptor = { ...smell, evaluate: (p, ctx) => smell.evaluate(p, { ...ctx, scan: () => scanLaunchdOpsCopyDrift(deps) }) };
      let state = emptyHealthState();
      const key = episodeKey(smell.id, 'com.we.guard');
      for (let tick = 1; tick <= 4; tick++) {
        if (tick === 3) {
          if (state.episodes[key]?.status !== 'open') violations.push(`${scenario}: initial drift did not open`);
          state = JSON.parse(JSON.stringify(state));
          phase = scenario;
        }
        state = runHealthTick(state, {}, [descriptor], tick * 1000).state;
      }
      if (scenario !== 'partial-recovery' && (state.episodes[key]?.status !== 'open' || state.episodes[key]?.cleanStreak !== 0)) {
        violations.push(`${scenario}: shell command closed or cleaned a still-unverified drift episode`);
      }
      if (scenario === 'partial-recovery' && state.episodes[key]) violations.push('unrelated unreadable plist prevented verified recovery');
    }
    return { violations };
  },
  judge: (report) => report.violations,
};
