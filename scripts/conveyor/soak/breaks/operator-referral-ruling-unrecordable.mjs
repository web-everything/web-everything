/**
 * @file breaks/operator-referral-ruling-unrecordable.mjs — live break, 2026-10-04 (PR #3771, card #4979). The
 * operator ruled on a PR's mandatory referral and nothing could record it, so the PR could never move.
 *
 * LIVE INCIDENT: web-everything/web-everything PR #3771 (`review:human`). Its current head carried one mandatory
 * referral the independent reviewer had ruled `block` (a protected-list gap). The operator ruled "card" (follow-up
 * card xvm9vbu). `review-set-label.mjs 3771 --to=clear-human` refused: "mandatory referral hold: [...] record
 * finding-specific mandatory rulings before acceptance". Only the run-derived reviewer could write a ruling; there
 * was no actor, channel or operator-words field, and hand-posting one would be a forged record.
 *
 * FIX — `jury-core.mjs#mandatoryReferralState` reads operator rulings (trusted principal, exact record, actor an
 * operator login, pinned to the head) alongside reviewer rulings, and `run.mjs record-referral-ruling` is the
 * sanctioned writer.
 *
 * SCENARIO: ONE PR, `review:human`, one trusted referral record whose reviewer ruled `block`; a readable card on
 * main. Round 1 the operator's ruling goes through the sanctioned CLI (`record-referral-ruling`), then the
 * `clear-human` ceremony runs. RED = either step refuses (no sanctioned path, or the gate ignores the ruling).
 * GREEN = the ruling is recorded and `clear-human` lands `review:accepted`. The review daemon ticks throughout.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { CONSTELLATION_REPOS } from '../../../lib/constellation-repos.mjs';
import { mandatoryReferralReviewer, normalizeFinding, referralFindingKey, renderReferralRecord } from '../../../lib/jury-core.mjs';
import { runSoak } from '../soak.mjs';

const WE_SLUG = CONSTELLATION_REPOS.we.slug;
const CARD_FILE = 'backlog/5999-soak-follow-up-card.md';

function cli(w, args) {
  try {
    return { ok: true, out: execFileSync(process.execPath, args, { cwd: w.simCloneRoot, env: { ...process.env, ...w.env },
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 }) };
  } catch (e) {
    return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}`.split('\n').filter(Boolean).slice(-3).join(' | ') || String(e.message) };
  }
}

export default {
  id: 'operator-referral-ruling-unrecordable',
  title: 'an operator ruling on a mandatory referral has no sanctioned path, so clear-human refuses forever',
  card: 'operator ruling path — live PR #3771 (card #4979)',
  fixedBy: { sha: '3aaa828f2', where: 'lane/build-4979-operator-ruling', paths: ['scripts/lib/jury-core.mjs', 'scripts/review-set-label.mjs', 'scripts/operations/run.mjs', 'scripts/operations/record-referral-ruling.mjs', 'scripts/operations/record-referral-ruling-io.mjs', 'scripts/operations/review-pr-io.mjs', 'scripts/conveyor/review-referral-hold.mjs'] },
  fixPresent(root) {
    try { return readFileSync(join(root, 'scripts/lib/jury-core.mjs'), 'utf8').includes('export function readOperatorRulings('); }
    catch { return false; }
  },
  run({ log } = {}) {
    return runSoak({
      name: 'break:operator-referral-ruling-unrecordable',
      rounds: 3,
      daemons: ['review'],
      mainEvery: 0,
      scorecards: false,
      fleet: false,
      // The fake GitHub posts as its own actor; it is this world's automation login.
      env: { WE_AUTOMATION_LOGINS: 'we-daemon-bot,web-everything' },
      setup(w) {
        // The cited card exists in the checkout the ceremony runs from (this sim clone carries no backlog/ of its
        // own; excluded locally so the clone stays clean for the daemon's own invariants).
        mkdirSync(join(w.simCloneRoot, 'backlog'), { recursive: true });
        writeFileSync(join(w.simCloneRoot, CARD_FILE), '---\nstatus: open\n---\n# follow-up card\n');
        appendFileSync(join(w.simCloneRoot, '.git', 'info', 'exclude'), '\n/backlog/\n');
        const head = 'lane/soak-operator-ruling';
        w.git.createBranch('we', head, { from: 'main', files: { 'soak/operator-ruling.txt': 'a PR held by a referral\n' } });
        const pr = w.gh.openPr({ repo: 'we', head, base: 'main', title: 'soak: referral held for the operator', labels: ['review:human'], body: 'No backlog item.' });
        const sha = w.gh.pr('we', pr).headRefOid;
        const original = { summary: 'protected list misses edits', file: 'scripts/x.mjs', verdict: 'CONFIRMED', impactIfUnfixed: 'broken' };
        const seat = 'judgeCorrectnessAdvisory';
        const runId = 'review-pr-soak-referral';
        const reviewer = mandatoryReferralReviewer(runId);
        const key = referralFindingKey(seat, original);
        const record = { version: 1, repo: WE_SLUG, pr, head: sha, runId, reviewer, authorBody: 'No backlog item.', attempted: true,
          referrals: [{ key, seat, original, finding: normalizeFinding(original) }],
          rulings: [{ id: `${runId}:0`, key, reviewerId: reviewer.id, lens: 'correctness', result: 'block', rationale: 'real gap', evidence: ['diff'] }] };
        w.gh.comment('we', pr, renderReferralRecord(record), { author: 'web-everything' });
        return { pr };
      },
      perRound(w, round, ctx, api) {
        if (round !== 1) return;
        const pr = String(ctx.pr);
        const ruled = cli(w, ['scripts/operations/run.mjs', 'record-referral-ruling', `--pr=${pr}`, `--repo=${WE_SLUG}`,
          '--finding=all-open', '--ruling=card', `--card=we:${CARD_FILE}`, '--actor=chalbert', '--channel=soak', '--reason=Accept']);
        if (!ruled.ok || /refused|error/i.test(ruled.out)) api.violation('operator-ruling-unrecordable', `record-referral-ruling: ${ruled.out}`);
        const cleared = cli(w, ['scripts/review-set-label.mjs', pr, `--repo=${WE_SLUG}`, '--to=clear-human', '--actor=chalbert',
          '--channel=soak', '--reason=Accept (operator): rule card on the remaining finding']);
        const labels = (w.gh.pr('we', ctx.pr).labels ?? []).map((l) => (typeof l === 'string' ? l : l.name));
        if (!cleared.ok || !labels.includes('review:accepted')) {
          api.violation('operator-ruling-unrecordable', `clear-human after the operator's ruling: ${cleared.out} (labels: ${labels.join(', ')})`);
        }
      },
      log,
    });
  },
  judge(report) {
    return [...(report.fatal ? [report.fatal] : []), ...report.violations
      .filter((v) => ['operator-ruling-unrecordable', 'crash'].includes(v.invariant))
      .map((v) => `${v.daemon ?? '-'} tick ${v.tick ?? '-'}: [${v.invariant}] ${v.detail}`)];
  },
};
