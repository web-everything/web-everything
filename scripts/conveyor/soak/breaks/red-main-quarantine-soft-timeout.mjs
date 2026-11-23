/** Live 2026-11-22 (run 45080540441): a soak test timed out at its soft limit once; the safety net waited for flake proof and main stayed red an hour. */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const FILE = 'scripts/conveyor/soak/daemon-soak.soak.test.mjs';
const JOB = 'soak-shard (1)';
const rootOf = () => process.env.SOAK_TREE_ROOT || fileURLToPath(new URL('../../../../', import.meta.url));

/** Reads the tree's own io + planner and plans a single red soak job whose only failure is a soft-limit timeout. */
const PROBE = (root) => `(async () => {
  const io = await import(${JSON.stringify(pathToFileURL(join(root, 'scripts/lib/red-main-quarantine-io.mjs')).href)});
  const q = await import(${JSON.stringify(pathToFileURL(join(root, 'scripts/lib/red-main-quarantine.mjs')).href)});
  const { readFileSync } = await import('node:fs');
  const policy = JSON.parse(readFileSync(${JSON.stringify(join(root, 'scripts/settings/test-timeout-policy.json'))}, 'utf8'));
  const t = await import(${JSON.stringify(pathToFileURL(join(root, 'scripts/lib/test-timeout-policy.mjs')).href)});
  const soft = t.resolveLimits(policy, { file: ${JSON.stringify(FILE)}, job: ${JSON.stringify(JOB)} }).softMs;
  const text = '2026-11-22T23:25:07Z FAIL ' + ${JSON.stringify(FILE)} + ' > 50 real daemon ticks\\nError: Test timed out in ' + soft + 'ms.\\n Test Files 1 failed | 2 passed';
  const f = io.readJobFailures(1, { exec: () => text, repoSlug: 'o/r' });
  const plan = q.planSafetyNet({ status: 'red', firstRedSha: 'a'.repeat(40), failedJobs: [${JSON.stringify(JOB)}], jobFailures: { [${JSON.stringify(JOB)}]: f },
    latestRunId: 1, now: Date.parse('2026-11-22T23:26:00Z'), list: { version: 1, entries: [] }, fixPrs: [99], timeoutPolicy: policy, settings: {} });
  process.stdout.write(JSON.stringify({ action: plan.action, tests: plan.tests ?? [], why: plan.why }));
})().catch((e) => { process.stdout.write(JSON.stringify({ error: String(e?.message ?? e) })); });`;

function plan(root) {
  try {
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', PROBE(root)], { encoding: 'utf8', timeout: 60_000 });
    return JSON.parse(out);
  } catch (error) { return { error: String(error?.message ?? error) }; }
}

export default {
  id: 'red-main-quarantine-soft-timeout',
  title: 'a red-main soak test that timed out once at its soft limit was held back for flake proof instead of being quarantined at once',
  card: 'quarantine-early (main red 22:57Z-23:57Z 2026-11-22)',
  fixedBy: {
    sha: 'pending',
    where: 'lane/quarantine-soft-timeout',
    paths: ['scripts/lib/red-main-quarantine.mjs', 'scripts/lib/red-main-quarantine-io.mjs', 'scripts/lib/test-timeout-policy.mjs'],
  },
  // Fix presence is decided by behaviour: a soft-limit timeout must plan an add of the timed-out file.
  fixPresent(root) {
    try {
      const p = plan(root);
      return p.action === 'add' && p.tests.includes(FILE);
    } catch { return false; }
  },
  async run() {
    const root = rootOf();
    const violations = [];
    const p = plan(root);
    if (p.error) violations.push(`planning a soft timeout failed: ${p.error}`);
    else if (p.action !== 'add' || !p.tests.includes(FILE)) violations.push(`soft-limit timeout was not quarantined at once: ${p.action} (${p.why})`);
    return { violations, plan: p };
  },
  judge(report) { return report.violations; },
};
