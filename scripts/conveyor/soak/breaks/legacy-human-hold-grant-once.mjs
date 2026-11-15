/** #6769: legacy human-only refusals get one S2b dispatch, spent by any later attempt. */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
export const CORE = 'scripts/conveyor/review-referral-hold.mjs';
export const FIX_MARKERS = [
  'const legacyStarts = history.filter(r => r.legacyHumanHold).map(r => r.startedAt);',
  'const newestLegacy = legacyStarts.length ? Math.max(...legacyStarts) : null;',
  'if (noVerdict && newestLegacy !== null && !history.some(r => r.s2bSeen)',
  '&& !history.some(r => !r.legacyHumanHold && r.startedAt > newestLegacy)) return null;',
];

export default {
  id: 'legacy-human-hold-grant-once',
  title: '13 legacy human-only holds grant one dispatch and any later attempt spends it',
  card: '#6769',
  fixedBy: { sha: '9f73f85b', where: 'main', paths: [CORE] },
  fixPresent(root) {
    try {
      const source = readFileSync(join(root, CORE), 'utf8');
      return FIX_MARKERS.every(marker => source.includes(marker));
    } catch { return false; }
  },
  async run({ sourceRoot = ROOT } = {}) {
    const violations = [], decisions = {};
    try {
      const { decideSameHeadHold } = await import(pathToFileURL(join(sourceRoot, CORE)).href);
      const repo = 'example/repo', head = 'b'.repeat(40);
      const at = Date.parse('2026-11-15T10:00:00Z');
      const pr = { number: 6769, headRefOid: head, labels: ['review:pending'], comments: [] };
      const runs = Array.from({ length: 13 }, (_, i) => ({
        id: `legacy-${i}`, repo, pr: pr.number, head, legacyHumanHold: true,
        startedAt: at - i * 120_000 - 60_000, completedAt: at - i * 120_000,
      }));
      const options = { repo, env: { WE_REVIEW_SAME_HEAD_MAX_REVIEWS: '1' },
        now: at + 30 * 60_000, retry: { cooldownReleases: 0, source: 'standard' } };
      const attempt = { id: 'later', repo, pr: pr.number, head, startedAt: at + 60_000 };
      const scenarios = [
        ['legacy', runs, true],
        ['ordinary', runs.map(r => ({ ...r, legacyHumanHold: false })), false],
        ['completed', [{ ...attempt, completedAt: at + 90_000 }, ...runs], false],
        ['incomplete', [...runs, { ...attempt, incomplete: true }], false],
        // An S2b run consumes the grant even when it predates the newest legacy run.
        ['s2b', [...runs, { ...runs.at(-1), id: 's2b', legacyHumanHold: false, s2bSeen: true }], false],
      ];
      for (const [name, history, release] of scenarios) {
        const decision = decideSameHeadHold(pr, history, options);
        decisions[name] = decision;
        if (release ? decision !== null : decision?.kind !== 'same-head' || decision.head !== head) {
          violations.push(`${name}: expected ${release ? 'one dispatch grant (null)' : 'same-head hold'}`);
        }
        if (!release && decision?.noVerdict?.exhausted !== true) {
          violations.push(`${name}: expected exhausted no-verdict budget`);
        }
      }
    } catch (error) {
      violations.push(`scenario failed: ${error.stack ?? error}`);
    }
    return { violations, decisions };
  },
  judge: report => report.violations,
};
