/** Replay #7109/#7120: an unknown effect must yield to abandonment and a fresh review. No network. */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..', '..');

async function replay(sourceRoot) {
  const dir = mkdtempSync(join(tmpdir(), 'soak-review-abandon-'));
  try {
    const load = path => import(pathToFileURL(join(sourceRoot, path)).href);
    const { main } = await load('scripts/operations/review-abandon.mjs');
    const { newRunRecord, writeRun, runPath } = await load('scripts/operations/run-store.mjs');
    const { readDrainRedTeamEvidence } = await load('scripts/lib/drain-red-team-evidence.mjs');
    const now = Date.now(), repo = 'fixture/repo', pr = 7109, head = 'a'.repeat(40), id = 'review-pr-soak-abandon';
    const run = newRunRecord({ id, op: 'review-pr', input: { repo, pr } });
    run.pending = { kind: 'effect', step: 'record', stepIndex: 9 };
    run.verdict = { verdict: 'accept' };
    run.effects = [{ key: 'label', type: 'review.label-swap', index: 0, stepIndex: 9, step: 'record', status: 'pending', unknownAttempts: 1 }];
    run.findings = { read: { repo, pr, netBasis: { rev: head } } };
    run.stepTimings = [{ step: 'read', stepIndex: 0, startedAt: new Date(now - 32 * 60000).toISOString() }];
    writeRun(run, dir);
    utimesSync(runPath(id, dir), (now - 31 * 60000) / 1000, (now - 31 * 60000) / 1000);
    const before = readFileSync(runPath(id, dir), 'utf8');
    const env = { OPERATION_RUNS_DIR: dir, WE_SHARED_RUNS_DIR: dir, WE_PLATFORM_PREFERENCES_FILE: join(dir, 'prefs.json') };
    const gate = () => readDrainRedTeamEvidence({ repo, pr, head, runsDir: dir, env, now, readScorecards: () => [] });
    if (gate().reason !== 'review-unfinished') throw Error('fixture did not reproduce the unfinished-review hold');
    let result;
    const code = main([`--run=${id}`, '--apply', '--json'], { out: text => { result = JSON.parse(text); }, err: () => {},
      reaperOptions: { dir, env, now, tool: {}, probes: { reviewJobs: () => [], pidIdentity: () => ({ alive: false }), leases: () => '[]', sessions: () => '[]' } } });
    if (code !== 0 || !result?.reaped.includes(id)) throw Error('dead stuck effect was not abandoned');
    const after = gate();
    if (after.reason === 'review-unfinished' || after.loopPayload) throw Error('abandoned run still supplies review evidence');
    if (before !== readFileSync(runPath(id, dir), 'utf8')) throw Error('abandonment rewrote the unknown effect');
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

export default {
  id: 'review-abandon-redo',
  title: 'abandoned unknown review effects owe a fresh review instead of holding the head forever',
  card: 'PR #7109 and #7120 stuck review effects',
  fixedBy: { sha: 'working-tree', where: 'review-abandon', paths: ['scripts/operations/review-abandon.mjs', 'scripts/lib/drain-red-team-evidence.mjs'] },
  fixPresent(root) {
    // The harness requires a synchronous answer. A hermetic child runs the actual operation and gate;
    // neither source markers nor existence of a module count as proof of the fix.
    try {
      execFileSync(process.execPath, [fileURLToPath(import.meta.url), '--probe', root], { timeout: 30000, maxBuffer: 1024 * 1024, stdio: 'pipe' });
      return true;
    } catch { return false; }
  },
  async run({ sourceRoot = REPO_ROOT } = {}) {
    try { await replay(sourceRoot); return { violations: [] }; }
    catch (e) { return { violations: [{ invariant: 'abandon-and-redo', detail: String(e.message) }] }; }
  },
  judge(report) { return report.violations.map(v => `[${v.invariant}] ${v.detail}`); },
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href && process.argv[2] === '--probe') {
  try { await replay(resolve(process.argv[3])); }
  catch { process.exitCode = 1; }
}
