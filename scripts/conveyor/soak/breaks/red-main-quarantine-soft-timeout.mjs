/** Live 2026-11-22 (run 45080540441): a soak test timed out at its soft limit once; the safety net waited for flake proof and main stayed red an hour. */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const FILE = 'scripts/conveyor/soak/daemon-soak.soak.test.mjs';
const JOB = 'soak-shard (1)';
const rootOf = () => process.env.SOAK_TREE_ROOT || fileURLToPath(new URL('../../../../', import.meta.url));

/** Replay the incident's failure excerpt through the tree's own shadow publisher. */
const PROBE = (root) => `(async () => {
  const io = await import(${JSON.stringify(pathToFileURL(join(root, 'scripts/lib/red-main-quarantine-io.mjs')).href)});
  const q = await import(${JSON.stringify(pathToFileURL(join(root, 'scripts/lib/red-main-quarantine.mjs')).href)});
  const { readFileSync, mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const policy = JSON.parse(readFileSync(${JSON.stringify(join(root, 'scripts/settings/test-timeout-policy.json'))}, 'utf8'));
  const text = '##[group]Run npx vitest run\\n##[endgroup]\\n2026-11-22T23:25:07Z FAIL ' + ${JSON.stringify(FILE)} + ' > 50 real daemon ticks: every invariant holds after every tick\\nError: Test timed out in 1020000ms.\\n Test Files 1 failed | 2 passed\\n Tests 1 failed\\n⎯⎯⎯\\n##[error]Process completed with exit code 1.\\nPost job cleanup.';
  const dir = mkdtempSync(join(tmpdir(), 'soft-timeout-replay-'));
  try {
    const now = Date.parse('2026-11-22T23:26:00Z'), run = 45080540441;
    const printed = [];
    const out = io.runSafetyNet({ dir, now, live: false, timeoutPolicy: policy,
      mode: { value: 'quarantine', source: 'soak' }, settings: { value: q.QUARANTINE_SAFETY_NET_DEFAULTS },
      mainCiRuns: { runs: [{ databaseId: run, headSha: 'a'.repeat(40), status: 'completed', conclusion: 'failure',
        createdAt: '2026-11-22T22:57:00Z', updatedAt: '2026-11-22T23:25:07Z', attempt: 1 }],
        failing: { runId: run, jobs: [${JSON.stringify(JOB)}, 'daemon-soak'] }, priority: { prs: [99] } },
      readJobs: () => ({ failed: [{ id: 1, name: ${JSON.stringify(JOB)} }] }),
      readLog: () => io.readJobFailures(1, { exec: () => text, repoSlug: 'o/r' }),
      readList: () => { throw Error('shadow must not read live list'); },
      write: () => { throw Error('shadow must not publish'); },
      log: line => { if (line.startsWith('red-main-quarantine: ')) printed.push(JSON.parse(line.slice('red-main-quarantine: '.length))); } });
    const ledger = JSON.parse(readFileSync(join(dir, io.SAFETY_NET_LEDGER), 'utf8'));
    process.stdout.write(JSON.stringify({ action: out.plan?.action, tests: out.plan?.tests ?? [], why: out.plan?.why,
      error: out.error, outputs: printed, fixPrSkips: q.testsToSkip({ list: ledger.shadowList, now, prNumber: 99 }) }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
})().catch((e) => { process.stdout.write(JSON.stringify({ error: String(e?.message ?? e) })); });`;

function plan(root) {
  try {
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', PROBE(root)], { encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024 });
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
  // Fix presence requires the printable entry, not just a planner decision.
  fixPresent(root) {
    try {
      const p = plan(root);
      return violations(p).length === 0;
    } catch { return false; }
  },
  async run() {
    const root = rootOf();
    const p = plan(root);
    return { violations: violations(p), plan: p };
  },
  judge(report) { return report.violations; },
};

function violations(p) {
  if (p.error) return [`replaying a soft timeout failed: ${p.error}`];
  const quarantine = p.outputs?.find(o => o.type === 'quarantine' && o.test === FILE);
  const entry = quarantine?.entry;
  const at = Date.parse('2026-11-22T23:26:00Z');
  return p.action === 'add' && p.tests.includes(FILE) && quarantine?.at === at && quarantine.shadow === true
    && entry?.expiresAt === Date.parse('2026-11-23T05:26:00Z') && entry.release?.passesUnderSoft === 3
    && entry.timeout?.run === 45080540441 && entry.timeout.outcomes?.[0]?.runnerLimitMs === 1020000
    && entry.timeout.outcomes[0].class === 'soft' && entry.note?.includes('file-level skip')
    && p.outputs.some(o => o.type === 'alert') && p.outputs.some(o => o.type === 'fix-card')
    && Array.isArray(p.fixPrSkips) && p.fixPrSkips.length === 0
    ? [] : ['soft-limit replay did not print the complete quarantine, alert and fix-card records at 23:26Z'];
}
