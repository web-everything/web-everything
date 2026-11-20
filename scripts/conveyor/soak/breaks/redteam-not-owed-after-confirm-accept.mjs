/**
 * LIVE: #6949 — a prevention-outstanding review accepted at the confirm step owed no red team
 * ("red-team-not-owed"), leaving a stale red-team:blocked from an older head. Behaviour check only.
 */
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const POLICY = 'scripts/lib/review-red-team-policy.mjs';

export default {
  id: 'redteam-not-owed-after-confirm-accept',
  title: 'a confirm-step accept of a prevention-outstanding review owes a red team on that head',
  card: 'LIVE: #6949',
  fixedBy: { sha: 'pending', where: 'lane/redteam-owed-confirm-accept', paths: [POLICY] },
  fixPresent() { return true; },
  async run({ sourceRoot = ROOT } = {}) {
    const violations = [];
    try {
      const { redTeamOwedFor } = await import(pathToFileURL(join(sourceRoot, POLICY)).href);
      if (typeof redTeamOwedFor !== 'function') return { violations: ['redTeamOwedFor missing'] };
      const po = { verdict: { verdict: 'prevention-outstanding' } };
      if (redTeamOwedFor({ ...po, findings: { confirm: 'accept' } }) !== true) violations.push('confirm-accepted prevention-outstanding owes no red team');
      if (redTeamOwedFor({ ...po, findings: {} }) !== false) violations.push('unconfirmed prevention-outstanding owes a red team');
      if (redTeamOwedFor({ verdict: { verdict: 'accept' } }) !== true) violations.push('plain accept lost its red team');
    } catch (error) { violations.push(`scenario failed: ${error.stack ?? error}`); }
    return { violations };
  },
  judge: report => report.violations,
};
