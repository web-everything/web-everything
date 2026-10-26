/** PR #5551 red team: a break the gate held at the round cap on SAVED evidence (no posted red-team comment) never
 * reached RULING NEEDED, the advertised clear-human ruling refused it ("nothing to clear"), and on the drain's REST
 * thread a ruling could never release it. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SOURCES = ['scripts/lib/red-team-gate.mjs', 'scripts/lib/drain-saved-red-team.mjs', 'scripts/lib/drain-queue-safety.mjs',
  'scripts/operations/operator-queue.mjs', 'scripts/operations/operator-why-io.mjs', 'scripts/operations/red-team-gate-apply.mjs',
  'scripts/review-set-label.mjs'];

export default {
  id: 'saved-red-team-round-cap-unclearable',
  title: 'saved red-team break held at the round cap has no RULING NEEDED row and no clear-human ruling',
  card: 'PR #5551',
  fixedBy: { sha: 'd1a1d0ca5,dea507fdf,4e9a2f798', where: 'lane/drain-reads-saved-redteam', paths: SOURCES },
  fixPresent(root) {
    return ['scripts/review-set-label.mjs', 'scripts/operations/operator-queue.mjs', 'scripts/operations/operator-why-io.mjs']
      .every(f => readFileSync(join(root, f), 'utf8').includes('savedRedTeamFallback'))
      && readFileSync(join(root, 'scripts/lib/red-team-gate.mjs'), 'utf8').includes('c?.created_at');
  },
  async run({ sourceRoot } = {}) {
    const root = sourceRoot ?? resolve(fileURLToPath(import.meta.url), '../../../../..');
    const load = rel => import(pathToFileURL(join(root, rel)).href);
    const { applyRedTeamGate } = await load('scripts/operations/red-team-gate-apply.mjs');
    const { redTeamRulingRow } = await load('scripts/operations/operator-queue.mjs');
    const { decideSetLabel } = await load('scripts/review-set-label.mjs');
    const { redTeamEnqueueHold } = await load('scripts/lib/drain-queue-safety.mjs');
    const saved = await load('scripts/lib/drain-saved-red-team.mjs');
    const { saveProvenanceFixtures } = await load('scripts/lib/__tests__/fixtures/saved-red-team-provenance.mjs');
    const { resolveScorecardStorePath } = await load('scripts/conveyor/run-scorecard-store.mjs');
    const { buildClearedHumanMarker, buildReviewedShaMarker } = await load('scripts/lib/review-escalation.mjs');
    const head = 'a'.repeat(40), repo = 'o/n', pr = 5551;
    const setting = { broken: 'send-back', degraded: 'card', unconfirmed: 'advisory' };
    const dir = mkdtempSync(join(tmpdir(), 'soak-saved-red-team-'));
    const violations = [];
    try {
      const env = { CONVEYOR_STATE_ROOT: dir, OPERATION_RUNS_DIR: join(dir, 'runs') };
      const path = resolveScorecardStorePath(env);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify({ version: 1, records: [{ dispatchKind: 'review-seat', seat: 'red-team', repo, pr, rev: head,
        status: 'ok', recheckStatus: 'ok', scoredAt: '2026-10-18T09:00:00Z', confirmedMissCount: 1,
        findings: [{ confirmedByRecheck: true, impactIfUnfixed: 'broken', category: 'edge-case', file: 'a.mjs', line: 1, summary: 'two writers race' }] }] }));
      saveProvenanceFixtures(env);
      const readSaved = saved.savedRedTeamFallback
        ? saved.savedRedTeamFallback({ repo, pr, head, env })
        : () => saved.readSavedRedTeamResult({ repo, pr, head, env });
      const comments = [];
      const gate = await applyRedTeamGate({ repo, pr }, {
        readPr: () => ({ headRefOid: head, comments, labels: ['review:accepted'] }), readHead: () => head,
        readSavedResult: args => saved.readSavedRedTeamResult({ ...args, env }), readSetting: () => ({ value: setting }),
        readRound: () => 99, log: () => {},
        postComment: ({ body }) => comments.push({ author: { login: 'web-everything' }, createdAt: '2026-10-18T09:01:00Z', body }),
      });
      if (gate.outcome !== 'round-cap') violations.push(`gate did not hold the saved break at the round cap: ${gate.status}/${gate.outcome}`);
      const subject = { number: pr, title: 't', headRefOid: head, labels: ['review:accepted'], comments };
      const row = redTeamRulingRow(repo, subject, setting, { readSaved });
      if (!row) violations.push('the saved break held at the round cap is missing from RULING NEEDED');
      const decision = decideSetLabel({ to: 'clear-human', currentLabels: subject.labels, redTeamRulingHold: row !== null });
      if (!decision.allowed) violations.push(`the advertised clear-human ruling is refused: ${decision.reason}`);
      // main #5803: the clear-human ruling counts only when the human operator posted it.
      comments.push({ author: { login: 'chalbert' }, createdAt: '2026-10-18T09:02:00Z', body: [
        '✅ review — `review:human` cleared via the sanctioned path', '',
        'Cleared by operator via `review-set-label.mjs --to=clear-human` (gate-self).', '',
        buildReviewedShaMarker(head), buildClearedHumanMarker('operator')].join('\n') });
      if (redTeamRulingRow(repo, subject, setting, { readSaved })) violations.push('the ruling did not clear RULING NEEDED');
      // The drain reads the REST thread (`user.login`, `created_at`), not the GraphQL shape the queue reads.
      const rest = comments.map(c => ({ user: { login: c.author.login }, created_at: c.createdAt, body: c.body }));
      for (const [shape, thread] of [['GraphQL', comments], ['REST', rest]]) {
        const hold = redTeamEnqueueHold({ repo, pr, head, comments: thread, env, scheduled: true, confirmedBreaks: setting,
          loopPayload: { verdict: { verdict: 'accept' } } });
        if (hold) violations.push(`the ruling did not release the drain hold on the ${shape} thread: ${hold}`);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
    return { violations };
  },
  judge(report) { return report.violations; },
};
