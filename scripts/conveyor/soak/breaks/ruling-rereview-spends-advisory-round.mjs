/**
 * @file breaks/ruling-rereview-spends-advisory-round.mjs — live #4715 (2026-10-11) exhausted its cap at 9/8.
 * An operator ruling followed by another advisory review of the same head spent a repair round.
 *
 * FIX — the advisory round ledger exempts the same-head re-review after an operator-authored ruling.
 * Automation-authored rulings must never grant that exemption.
 *
 * SCENARIO: note(A) → operator ruling(A) → note(A) through the tree's own production counter.
 * RED = 2 rounds; GREEN = 1 round, with the automation-authored control still spending 2 rounds.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..', '..');
const ADVISORY = 'scripts/conveyor/advisory-round-count.mjs';
const BOT = { login: 'web-everything' };
const HEAD_A = 'a'.repeat(40);
const BASE = 'b'.repeat(40);

export async function replay(root = REPO_ROOT) {
  if (!existsSync(join(root, ADVISORY))) return { harness: false };
  const load = (rel) => import(pathToFileURL(join(root, rel)).href);
  const { ADVISORY_NOTE_MARKER, countAdvisoryComments } = await load(ADVISORY);
  const { OPERATOR_LOGINS } = await load('scripts/lib/marker-authorship.mjs');
  const { buildOperatorRulingComment } = await load('scripts/lib/jury-core.mjs');
  const operator = { login: OPERATOR_LOGINS[0] };
  const note = `${ADVISORY_NOTE_MARKER}\n\nAdvisory review of head A.\n\n---\n\n`
    + `Net basis: \`${BASE}..${HEAD_A}\` (rev \`origin/lane/x\` at review time) — 3 net changed file(s) vs current main (#2450), not \`gh pr diff\`'s three-dot list.`;
  const ruling = buildOperatorRulingComment({
    version: 1, repo: 'web-everything/web-everything', pr: 4715, head: HEAD_A,
    actor: operator.login, channel: 'console', reason: 'Re-review this head after ruling on the referral.',
    at: '2026-10-11T08:00:00Z', clearerId: '',
    rulings: [{ runId: 'soak-ruling-rereview', key: 'finding-a', result: 'not-real' }],
  });
  const at = (t, body, author = BOT) => ({ author, createdAt: `2026-10-11T${t}:00Z`, body });
  const comments = [at('07:00', note), at('08:00', ruling, operator), at('09:00', note)];
  const count = countAdvisoryComments(comments);
  const automationCount = countAdvisoryComments(comments.map((comment, index) =>
    index === 1 ? { ...comment, author: BOT } : comment));
  return { harness: true, count, automationCount };
}

export default {
  id: 'ruling-rereview-spends-advisory-round',
  title: 'an operator ruling re-review of the same head spent an advisory round and exhausted the cap',
  card: 'live #4715 (2026-10-11) cap-exhausted 9/8',
  fixedBy: { sha: 'uncommitted', where: 'lane/review-cap-mechanical', paths: [ADVISORY] },
  fixPresent(root) { return readFileSync(join(root, ADVISORY), 'utf8').includes('advisoryRoundLedger'); },
  async run({ log } = {}) {
    try {
      const report = await replay();
      log?.(JSON.stringify(report));
      const violations = [];
      if (!report.harness) violations.push({ invariant: 'advisory-round-count', detail: 'no advisory-round-count module' });
      else {
        if (report.count !== 1) {
          violations.push({ invariant: 'ruling-rereview-exempt', detail: `count ${report.count}, expected 1` });
        }
        if (report.automationCount !== 2) {
          violations.push({ invariant: 'operator-only-exemption', detail: `automation count ${report.automationCount}, expected 2` });
        }
      }
      return { violations, report };
    } catch (e) {
      return { violations: [{ invariant: 'crash', detail: String(e?.stack || e).split('\n').slice(0, 3).join(' ') }] };
    }
  },
  judge(report) { return report.violations.map((v) => `[${v.invariant}] ${v.detail}`); },
};
