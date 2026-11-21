/**
 * A short readable listed thread is complete even when commentsComplete is unset.
 * Replay the production shadow with a draft PR and full local evidence. RED =
 * unknown:thread obscures the actual hold:draft decision.
 */
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const SHADOW = 'scripts/conveyor/dispatch-eligibility-shadow.mjs';
const HEAD = 'a'.repeat(40);

export async function replay(root = ROOT) {
  const load = path => import(pathToFileURL(join(root, path)).href);
  const { runEligibilityShadow } = await load(SHADOW);
  const { renderRedTeamComment } = await load('scripts/operations/review-extra-seats.mjs');
  const { liveResultGateState, redTeamGateMarker } = await load('scripts/lib/red-team-gate.mjs');
  const number = 6001;
  const bot = body => ({ author: { login: 'web-everything', type: 'Bot' }, body });
  const result = bot(renderRedTeamComment({ pr: number, rev: HEAD, provider: 'codex', model: 'm',
    recheckStatus: 'ok', foldedVerdict: 'changes', findings: [{ summary: 'Fixture defect', category: 'edge-case',
      impactIfUnfixed: 'broken', file: 'scripts/example.mjs', line: 1, confirmedByRecheck: true }] }));
  const resultId = liveResultGateState([result], number, HEAD).resultId;
  const pr = { number, headRefOid: HEAD, state: 'OPEN', isDraft: true, labels: [],
    comments: [result, bot(`${redTeamGateMarker(number, HEAD, 'sent-back', resultId)}\ngate`)] };
  const rows = [], errors = [];
  const summary = runEligibilityShadow({ mode: 'shadow', prs: [pr], dispatch: [{ kind: 'fix', prNumber: number }],
    readLocals: () => ({ referral: { state: 'none' }, scope: 'present', claim: { claimed: false },
      pause: { paused: false }, sameHead: { spent: false }, rounds: { attempts: 0, cap: 2 } }),
    now: () => new Date('2026-11-02T12:00:00.000Z'),
    appendLine: line => rows.push(JSON.parse(line)), onError: error => errors.push(String(error)) });
  return { summary, rows, errors };
}

function violations(report) {
  if (report.errors.length) return [`shadow failed: ${report.errors.join('; ')}`];
  if (report.summary.checked !== 1 || report.summary.disagreements !== 1 || report.rows.length !== 1) {
    return [`expected one shadow disagreement: ${JSON.stringify(report)}`];
  }
  const [row] = report.rows;
  return row.gate === 'hold' && row.reasons?.length === 1 && row.reasons[0] === 'draft'
    ? [] : [`expected hold:draft for a short readable thread: ${JSON.stringify(row)}`];
}

export default {
  id: 'dispatch-eligibility-short-thread-not-unknown',
  title: 'a short readable draft thread logs hold:draft instead of unknown:thread',
  card: 'dispatch-eligibility shadow short-thread fix',
  fixedBy: { sha: 'HEAD', where: 'dispatch-eligibility shadow fix', paths: [SHADOW] },
  fixPresent(root) {
    try {
      const output = execFileSync(process.execPath, ['--input-type=module', '-e',
        'const { replay } = await import(process.argv[1]); console.log(JSON.stringify(await replay(process.argv[2])));',
        import.meta.url, root], { encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024 });
      return violations(JSON.parse(output)).length === 0;
    } catch { return false; }
  },
  async run({ sourceRoot = ROOT, log } = {}) {
    try {
      const report = await replay(sourceRoot);
      log?.(JSON.stringify(report));
      return { violations: violations(report), report };
    } catch (error) { return { violations: [`scenario failed: ${String(error)}`] }; }
  },
  judge: report => report.violations,
};
