/** Check-evidence contract (#7084 stack, PR2c): a merge-gate hold must never be excused by name or by an unbound/stale run. */
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const MODULE = 'scripts/lib/merge-gate-hold-class.mjs';
const HEAD = 'c'.repeat(40);
const OTHER = 'd'.repeat(40);
const URL = job => `https://github.com/owner/repo/actions/runs/100/job/${job}`;
const SCENARIO = `
const m = await import(process.argv[1]);
const head = ${JSON.stringify(HEAD)};
const row = { name: 'merge-gate', status: 'completed', conclusion: 'failure', head_sha: head, detailsUrl: ${JSON.stringify(URL(123))},
  mergeGateReviewHold: { holds: ['review-acceptance'], holdIds: ['review-acceptance'], headSha: head, jobId: 123, originalConclusion: 'failure' } };
const ok = typeof m.boundMergeGateReviewHold === 'function' && typeof m.resolveReviewRequiredChecks === 'function'
  && m.boundMergeGateReviewHold(row, { headSha: head, labels: ['review:pending'] }) === true;
process.stdout.write(String(ok));`;

export default {
  id: 'check-evidence-hold-excused-by-name-or-stale-run',
  title: 'a merge-gate hold or check was excused by name or by an unbound/stale run, letting a PR advance',
  card: 'check-evidence-contract stack #7084 (PR2c)',
  fixedBy: { sha: 'e17b7a309a', where: 'lane/check-evidence-contract-pr2c', paths: [MODULE] },
  // Decided by behaviour (a child process runs the capability probe against this tree), never by marker strings.
  // The probe only proves the bound-hold resolver exists and accepts a valid hold; every invariant under test is
  // judged in run(), so a regression of one stays a required failure instead of flipping this to expected-fail.
  fixPresent(root) {
    try {
      const out = spawnSync(process.execPath, ['--input-type=module', '-e', SCENARIO, pathToFileURL(join(root, MODULE)).href], { encoding: 'utf8', timeout: 60000 });
      return out.status === 0 && out.stdout.trim() === 'true';
    } catch { return false; }
  },
  async run({ sourceRoot = ROOT, log } = {}) {
    const violations = [];
    const check = (ok, why) => { if (!ok) violations.push(why); };
    const mod = await import(pathToFileURL(join(sourceRoot, MODULE)).href);
    if (typeof mod.boundMergeGateReviewHold !== 'function' || typeof mod.resolveReviewRequiredChecks !== 'function') {
      return { violations: ['no bound-hold resolver: merge-gate holds are excused by name'] };
    }
    const hold = (extra = {}) => ({ holds: ['review-acceptance'], holdIds: ['review-acceptance'], headSha: HEAD, jobId: 123, originalConclusion: 'failure', ...extra });
    const gateRow = (extra = {}, annotation = hold()) => ({ name: 'merge-gate', status: 'completed', conclusion: 'failure', head_sha: HEAD,
      detailsUrl: URL(123), mergeGateReviewHold: annotation, ...extra });
    const resolve_ = (rows, extra = {}) => mod.resolveReviewRequiredChecks({ rows: [{ name: 'test', status: 'completed', conclusion: 'success', head_sha: HEAD }, ...rows],
      rowsHead: HEAD, rowsComplete: true, rosterSource: 'live', requiredNames: ['test', 'merge-gate'], head: HEAD, labels: ['review:pending'], ...extra });
    const advances = result => ['pass', 'held'].includes(result.perName?.['merge-gate']?.state) && result.state !== 'fail';
    const control = resolve_([gateRow()]);
    check(control.perName['merge-gate']?.state === 'held', `bound plain failure not held (state=${control.perName['merge-gate']?.state})`);
    const cases = [
      ['unannotated merge-gate failure (excused by name)', [gateRow({ mergeGateReviewHold: undefined })]],
      ['foreign-origin job URL', [gateRow({ detailsUrl: 'https://github.com.evil.example/o/r/actions/runs/1/job/123' })]],
      ['job URL with extra path segment', [gateRow({ detailsUrl: `${URL(123)}/extra` })]],
      ['annotation bound to another job', [gateRow({}, hold({ jobId: 999 }))]],
      ['stale head annotation', [gateRow({}, hold({ headSha: OTHER }))]],
      ['stale run row on another head', [gateRow({ head_sha: OTHER })]],
      ['cancelled run with hold evidence', [gateRow({ conclusion: 'cancelled' }, hold({ originalConclusion: 'cancelled' }))]],
      ['cancelled run whose annotation claims an original failure', [gateRow({ conclusion: 'cancelled' })]],
      ['timed-out run with hold evidence', [gateRow({ conclusion: 'timed_out' }, hold({ originalConclusion: 'timed_out' }))]],
      ['failed legacy merge-gate status beside a bound run', [gateRow(), { name: 'merge-gate', state: 'failure' }]],
    ];
    for (const [name, rows] of cases) {
      const result = resolve_(rows);
      check(!advances(result), `${name}: merge-gate still advances (state=${result.perName['merge-gate']?.state}, overall=${result.state})`);
      log?.(`${name}: merge-gate=${result.perName['merge-gate']?.state}, overall=${result.state}\n`);
    }
    check(mod.boundMergeGateReviewHold(gateRow(), { headSha: HEAD, labels: ['ready-to-merge'] }) === false, 'ready-to-merge label still excuses a hold');
    return { violations };
  },
  judge: report => report.violations,
};
