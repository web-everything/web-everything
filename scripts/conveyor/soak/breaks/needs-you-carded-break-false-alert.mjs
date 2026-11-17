/** #8549 / PR #6933: a gate-carded break must not ask the operator for another send-back. */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CONSTELLATION_REPOS } from '../../../lib/constellation-repos.mjs';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const SOURCE = 'scripts/operations/needs-you-feed.mjs';

export default {
  id: 'needs-you-carded-break-false-alert',
  title: 'a confirmed break with a gate card ruling emits no false needs-you alert',
  card: 'backlog/8549 / PR #6933',
  fixedBy: { sha: 'HEAD', where: 'HEAD', paths: [SOURCE] },
  fixPresent(root) {
    return readFileSync(join(root, SOURCE), 'utf8').includes("r.source === 'automatic' && r.kind === 'card'");
  },
  async run({ sourceRoot = ROOT } = {}) {
    const violations = [];
    try {
      const { gateReadyItems, itemsFromReport } = await import(pathToFileURL(join(sourceRoot, SOURCE)).href);
      const { renderRedTeamComment } = await import(pathToFileURL(join(sourceRoot, 'scripts/operations/review-extra-seats.mjs')).href);
      const { GATE_OUTCOMES, parseRedTeamComment, redTeamGateMarker, redTeamResultId } =
        await import(pathToFileURL(join(sourceRoot, 'scripts/lib/red-team-gate.mjs')).href);
      const repo = CONSTELLATION_REPOS.we.slug, pr = 6933, head = '6933' + 'a'.repeat(36);
      const body = renderRedTeamComment({ pr, rev: head, provider: 'codex', model: 'm', recheckStatus: 'ok', foldedVerdict: 'changes',
        findings: [{ summary: 'confirmed carded break', category: 'edge-case', impactIfUnfixed: 'degraded',
          file: 'scripts/x.mjs', line: 3, confirmedByRecheck: true, recheckReason: 'real' }] });
      const result = { user: { login: 'web-everything' }, created_at: '2026-11-16T10:00:00Z', body };
      const card = { user: { login: 'web-everything' }, created_at: '2026-11-16T10:01:00Z',
        body: redTeamGateMarker(pr, head, GATE_OUTCOMES.CARD_QUEUED, redTeamResultId(parseRedTeamComment(body))) +
          '\n- 1 finding(s) filed as a follow-up card (#1).' };
      const report = { ready: [{ repo, number: pr, title: 'carded break', head }] };
      const judge = comments => gateReadyItems(itemsFromReport(report), report, {
        gh: async (_file, args) => {
          if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({ headRefOid: head, labels: [{ name: 'red-team:blocked' }] });
          if (args[0] === 'api') return JSON.stringify([comments]);
          throw new Error(`unexpected fixture read: ${args.join(' ')}`);
        },
        log: () => {}, fixClaimLive: () => false,
      });
      const uncarded = await judge([result]);
      if (uncarded.kept.length !== 1 || uncarded.kept[0].kind !== 'confirmed-break-owed-send-back') {
        violations.push('uncarded confirmed break did not retain its needs-you alert');
      }
      const carded = await judge([result, card]);
      if (carded.kept.length !== 0) violations.push('gate-carded #6933-style break still emitted a needs-you item');
      if (carded.held.length !== 1) violations.push('carded break did not retain the live review hold');
    } catch (error) { violations.push(`scenario failed: ${error.message}`); }
    return { violations };
  },
  judge: report => report.violations,
};
