/** Replay the 2026-11-18 rebuild failure: fail-fast must leave unrelated environment probes runnable. */
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..', '..');
const RUNNER = 'scripts/lib/daemon-rebuild/smoke.mjs';

export default {
  id: 'smoke-failfast-env-checks',
  title: 'rebuild fail-fast still runs unrelated environment checks',
  card: '2026-11-18 wev-review-daemon — plain-main reported unrun boot and clean-tree checks as failures',
  fixedBy: { sha: 'pending', where: 'smoke fail-fast scope fix', paths: [RUNNER] },
  fixPresent(root) {
    // defineBreakTest requires a synchronous answer; the subprocess runs the same behavioral replay.
    try {
      execFileSync(process.execPath, ['--input-type=module', '-e', `
        const { default: b } = await import(process.argv[1]);
        const report = await b.run({ sourceRoot: process.argv[2] });
        if (b.judge(report).length) process.exitCode = 1;
      `, import.meta.url, root], { encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024 });
      return true;
    } catch { return false; }
  },
  async run({ log, sourceRoot = REPO_ROOT } = {}) {
    const violations = [];
    try {
      const { budgetedRunChild, smokeCheckOfChild } = await import(pathToFileURL(join(sourceRoot, RUNNER)).href);
      const calls = [];
      const run = budgetedRunChild({ deadline: Infinity, now: () => 0,
        failFast: ['reconcile-dry-run', 'dispatch-dry-run'],
        runChild: async (cmd, args) => {
          calls.push({ cmd, args });
          if (smokeCheckOfChild(cmd, args) === 'reconcile-dry-run') throw new Error('fixture reconcile failed');
          return 'ran';
        } });
      const cases = [
        ['initial reconcile failure', 'node', ['scripts/conveyor/reconcile-pass.mjs'], 'fixture reconcile failed', 1],
        ['boot still runs', 'node', ['scripts/readiness/daemon-entry-boot.mjs'], null, 1],
        ['tree check still runs', 'git', ['status', '--porcelain'], null, 1],
        ['later reconcile refused', 'node', ['scripts/conveyor/reconcile-pass.mjs'], 'skipped: fail-fast', 0],
        ['later dispatch refused', 'node', ['--input-type=module', '-e', 'fixture'], 'skipped: fail-fast', 0],
      ];
      for (const [invariant, cmd, args, error, expectedCalls] of cases) {
        const before = calls.length;
        let value, failure;
        try { value = await run(cmd, args); } catch (e) { failure = String(e?.message ?? e); }
        const correct = error ? failure?.includes(error) : !failure && value === 'ran';
        log?.(`${invariant}: ${failure ?? value}`);
        if (!correct || calls.length - before !== expectedCalls) {
          violations.push({ invariant, detail: `result=${failure ?? value}, child calls=${calls.length - before}` });
        }
      }
    } catch (e) {
      violations.push({ invariant: 'crash', detail: String(e?.message ?? e) });
    }
    return { violations };
  },
  judge(report) { return report.violations.map((v) => `[${v.invariant}] ${v.detail}`); },
};
