/** Live 2026-11-22 (run 45080540441): gh 2.104 refuses escape-coded job logs, so the red-main safety net never named the timed-out soak test. */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const LOG = [
  '2026-11-22T23:25:07.4285701Z \u001b[33m❯\u001b[39m scripts/conveyor/soak/daemon-soak.soak.test.mjs',
  '2026-11-22T23:25:07.6212213Z \u001b[2m Test Files \u001b[22m \u001b[1m\u001b[31m1 failed\u001b[39m\u001b[22m\u001b[90m (1)\u001b[39m',
  '2026-11-22T23:25:07.6221119Z \u001b[31m\u001b[1m\u001b[7m FAIL \u001b[27m\u001b[22m\u001b[39m scripts/conveyor/soak/daemon-soak.soak.test.mjs\u001b[2m > \u001b[22m50 real daemon ticks',
].join('\n');
/** A gh that behaves like 2.104: an escape-coded log is refused unless --allow-escape-sequences is passed. */
const strictGh = (command, args) => {
  if (!args.includes('--allow-escape-sequences')) throw new Error('the response contains terminal escape sequences; pass --allow-escape-sequences to output it anyway');
  return LOG;
};
const rootOf = () => process.env.SOAK_TREE_ROOT || fileURLToPath(new URL('../../../../', import.meta.url));

async function readWith(root) {
  const io = await import(pathToFileURL(join(root, 'scripts/lib/red-main-quarantine-io.mjs')).href);
  try { return { ok: true, failures: io.readJobFailures(1, { exec: strictGh, repoSlug: 'o/r' }) }; } catch (error) { return { ok: false, error: String(error?.message ?? error) }; }
}

export default {
  id: 'red-main-quarantine-log-escape-sequences',
  title: 'gh 2.104 refuses escape-coded CI job logs, so the red-main safety net could not read a failed job and never quarantined the timed-out test',
  card: 'quarantine-early (main red 22:57Z-23:57Z 2026-11-22)',
  fixedBy: {
    sha: '4ebb27c01821b608443d6e642c7b5c5d91f41b7d',
    where: 'lane/quarantine-early-log-escape',
    paths: ['scripts/lib/red-main-quarantine-io.mjs', 'scripts/conveyor/main-ci-red-probe.mjs'],
  },
  // Fix presence is decided by behaviour: the strict gh read must succeed and name the failing test file.
  fixPresent(root) {
    const probe = `import(${JSON.stringify(pathToFileURL(join(root, 'scripts/lib/red-main-quarantine-io.mjs')).href)}).then((io) => {
      const exec = (c, a) => { if (!a.includes('--allow-escape-sequences')) throw new Error('refused'); return ${JSON.stringify(LOG)}; };
      process.exit(io.readJobFailures(1, { exec, repoSlug: 'o/r' }).complete ? 0 : 1);
    }).catch(() => process.exit(1));`;
    try { execFileSync(process.execPath, ['--input-type=module', '-e', probe], { stdio: 'ignore', timeout: 60_000 }); return true; } catch { return false; }
  },
  async run() {
    const r = await readWith(rootOf());
    const violations = [];
    if (!r.ok) violations.push(`safety-net log read threw on an escape-coded log: ${r.error}`);
    else if (!r.failures.complete) violations.push('escape-coded log was read but the failing test was not named completely');
    return { violations, read: r };
  },
  judge(report) { return report.violations; },
};
