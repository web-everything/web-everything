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
    for (const scenario of ['shell', 'partial-recovery']) {
      let phase = 'drift';
      const copy = '/home/fixture/ops/sync-guard-clone.mjs';
      const deps = {
        home: '/home/fixture',
        listPlists: () => phase === 'partial-recovery' ? ['com.we.guard.plist', 'unreadable.plist'] : ['com.we.guard.plist'],
        readPlist: (name) => {
          if (name === 'unreadable.plist') throw new Error('unreadable');
          return { Label: 'com.we.guard', ProgramArguments: phase === 'shell' ? ['/bin/sh', '-c', `node ${copy}`] : ['node', copy] };
        },
        inGitCheckout: () => false,
        repoFilesByBasename: () => ['scripts/sync-guard-clone.mjs'],
        hashCopy: () => phase === 'partial-recovery' ? 'new' : 'old',
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
      if (scenario === 'shell' && (state.episodes[key]?.status !== 'open' || state.episodes[key]?.cleanStreak !== 0)) {
        violations.push('shell command closed or cleaned a still-unverified drift episode');
      }
      if (scenario === 'partial-recovery' && state.episodes[key]) violations.push('unrelated unreadable plist prevented verified recovery');
    }
    return { violations };
  },
  judge: (report) => report.violations,
};
