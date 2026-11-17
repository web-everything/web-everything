/** Unchecked drafts need typed skips; stale acceptance must not hide current-head review blockers. */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const PATHS = ['scripts/conveyor/draft-promotion-rule.mjs',
  'scripts/conveyor/draft-promotion-loop.mjs', 'scripts/conveyor/pr-status-label.mjs'];
const HEAD = 'a'.repeat(40);

export default {
  id: 'unchecked-draft-and-stale-accepted-status',
  title: 'unchecked drafts lose typed skip reasons and stale acceptance masks current-head review blockers',
  card: 'soak-declaration: draft promotion and status derivation',
  fixedBy: { sha: 'HEAD', where: 'lane/soak-declaration', paths: PATHS },
  fixPresent(root) {
    try {
      const [rule, loop, status] = PATHS.map(path => readFileSync(join(root, path), 'utf8'));
      return rule.includes("reason: 'awaiting-ci-trigger'") && rule.includes("reason: 'ci-blocked-by-conflict'")
        && loop.includes('fresh.reason') && status.includes('!reviewBlock') && status.includes('headOnly.outcome');
    } catch { return false; }
  },
  async run({ sourceRoot = ROOT, log } = {}) {
    const { isDraftOwedPromotion } = await import(pathToFileURL(join(sourceRoot, PATHS[0])).href);
    const { runDraftPromotionStep } = await import(pathToFileURL(join(sourceRoot, PATHS[1])).href);
    const { derivePrStatusLabel } = await import(pathToFileURL(join(sourceRoot, PATHS[2])).href);
    const { CONSTELLATION_REPOS } = await import(pathToFileURL(join(sourceRoot, 'scripts/lib/constellation-repos.mjs')).href);
    const repos = [Object.values(CONSTELLATION_REPOS)[0].slug];
    const violations = [];
    const check =(ok, name) => {
      if (!ok) violations.push(name);
      log?.(`${name}: ${ok ? 'pass' : 'FAIL'}`);
    };
    const draft = { number: 7, state: 'OPEN', isDraft: true, headRefName: 'lane/soak-declaration',
      headRefOid: HEAD, baseRefName: 'main', labels: [], isCrossRepository: false, mergeable: 'MERGEABLE' };
    const checks = { state: 'unchecked', sha: HEAD };
    for (const [fields, reason] of [
      [{}, 'awaiting-ci-trigger'],
      [{ mergeable: 'CONFLICTING' }, 'ci-blocked-by-conflict'],
      [{ labels: [{ name: 'status:conflict' }] }, 'ci-blocked-by-conflict'],
      [{ labels: ['merge-status:conflicting'] }, 'ci-blocked-by-conflict'],
    ]) {
      const decision = isDraftOwedPromotion({ pr: { ...draft, ...fields }, checks });
      check(decision.owed === false && decision.reason === reason, `unchecked rule ${JSON.stringify(fields)}: ${reason}`);
      let writes = 0;
      let views = 0;
      const result = runDraftPromotionStep({
        repos, listDrafts: () => [draft], absentNotApplicable: [],
        readHeadCheckState: () => checks,
        // The list is clean: conflict evidence must come from the fresh view.
        readPrView: () => { views++; return { ...draft, ...fields }; },
        ready: () => { writes++; }, clearAwaiting: () => { writes++; },
        readAgents: () => { throw new Error('unchecked draft must stop before planning'); },
      });
      const row = result.rows[0];
      check(writes === 0 && views === 1 && result.rows.length === 1
        && row.action === 'skip' && row.reason === reason, `unchecked loop ${JSON.stringify(fields)}: ${reason}, no writes`);
    }
    check(isDraftOwedPromotion({ pr: draft, checks: { state: 'green', sha: HEAD } }).owed === true,
      'green draft remains eligible');
    let writes = 0;
    const unreadable = runDraftPromotionStep({
      repos, listDrafts: () => [draft], absentNotApplicable: [],
      readHeadCheckState: () => checks,
      readPrView: () => { throw new Error('unreadable PR view'); }, ready: () => { writes++; },
    });
    check(writes === 0 && unreadable.rows[0]?.action === 'error', 'unreadable fresh view fails closed');

    const advisory = (outcome, head = HEAD, hour = 8, login = 'web-everything') => ({
      author: { login }, createdAt: `2026-11-17T${String(hour).padStart(2, '0')}:00:00Z`,
      body: `**Verdict:** ${outcome}\n**Advisory outcome:** ${outcome}\nNet basis: \`${'0'.repeat(40)}..${head}\``,
    });
    const status = (labels = [], comments = []) => derivePrStatusLabel({ humanAt: 99, requiredChecks: ['test'],
      pr: { ...draft, isDraft: false, labels: ['review:accepted', ...labels], comments,
        statusCheckRollup: [{ name: 'test', status: 'completed', conclusion: 'success' }] } });
    check(status(['review:changes']) === 'sent-back-review', 'review changes blocks stale acceptance');
    check(status(['red-team:blocked']) === 'sent-back-red-team', 'red-team blocker blocks stale acceptance');
    for (const outcome of ['changes', 'inconclusive']) {
      check(status([], [advisory(outcome)]) === 'sent-back-review', `${outcome} advisory on current head blocks acceptance`);
      check(status([], [advisory(outcome), advisory('accept', 'b'.repeat(40), 9)]) === 'sent-back-review',
        `${outcome} on current head survives newer accept on another head`);
      check(status([], [advisory(outcome), advisory('accept', HEAD, 9, 'stranger')]) === 'sent-back-review',
        `${outcome} on current head survives untrusted accept`);
    }
    check(status([], [advisory('accept')]) === 'ready-to-merge', 'trusted current-head accept remains ready');
    check(status([], [advisory('changes', 'b'.repeat(40))]) === 'ready-to-merge', 'old-head advisory does not block current acceptance');
    return { violations };
  },
  judge: report => report.violations,
};
