/**
 * @file breaks/operator-rearm-answer-deadlock.mjs — LIVE incident, #6748 (2026-11-14 14:54 ET): the fixer stood down
 * (the finding was ruled not real, head unchanged), the operator answered "no code owed; re-review", and then the review
 * daemon said "owed a fix, not a review" while `rearm-review` refused the unchanged head (the #6798 empty-round guard).
 *
 * Fix: a HUMAN-operator `--disposition=rearm-review` answer naming the latest stand-down clears the empty-round window
 * (`decideEmptyFixRound`). A fixer's own later empty round, an automation-authored answer and an answer without the
 * disposition still refuse.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..', '..');

const HEAD = '4e4a927e9aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const BOT = { login: 'web-everything' };

export default {
  id: 'operator-rearm-answer-deadlock',
  title: 'an operator "no code owed" stand-down answer never led to a re-review on an unchanged head (#6748)',
  card: 'we:backlog/6748',
  fixedBy: { sha: '44e76316d', where: 'lane/standdown-rearm', paths: ['scripts/conveyor/rearm-review.mjs', 'scripts/conveyor/stand-down-answer-core.mjs'] },
  fixPresent(root) {
    const p = join(root, 'scripts/conveyor/stand-down-answer-core.mjs');
    return existsSync(p) && /rearm-review/.test(readFileSync(p, 'utf8'));
  },
  async run() {
    const root = REPO_ROOT;
    const { decideEmptyFixRound } = await import(pathToFileURL(join(root, 'scripts/conveyor/rearm-review.mjs')).href);
    const { buildOperatorAnswer } = await import(pathToFileURL(join(root, 'scripts/conveyor/stand-down-answer-core.mjs')).href);
    const { buildStandDownComment } = await import(pathToFileURL(join(root, 'scripts/conveyor/stand-down.mjs')).href);
    const begin = { body: `🔒 conveyor fix-begin — fix claim held\n\n**Branch:** \`lane/x\` at \`${HEAD.slice(0, 9)}\`\n<!-- fix-claim who=fix-6748 -->`, author: BOT };
    const stop = { id: 'IC_stop', author: BOT, body: buildStandDownComment({ reason: 'needs-judgment', detail: 'Is code owed?' }) };
    const answer = (author) => ({ author, body: buildOperatorAnswer({ standDownId: 'IC_stop', reason: 'No code owed', actor: 'chalbert', channel: 'chat', disposition: 'rearm-review' }) });
    const violations = [];
    if (decideEmptyFixRound({ comments: [begin, stop, answer({ login: 'chalbert' })], liveHead: HEAD }).empty) {
      violations.push({ invariant: 'operator-answer-ignored', detail: 'a human operator rearm-review answer still left the unchanged head refused' });
    }
    if (!decideEmptyFixRound({ comments: [begin, stop, answer(BOT)], liveHead: HEAD }).empty) {
      violations.push({ invariant: 'automation-answer-honoured', detail: 'an automation-authored answer waived the empty-round guard' });
    }
    if (!decideEmptyFixRound({ comments: [begin, stop, answer({ login: 'chalbert' }), begin], liveHead: HEAD }).empty) {
      violations.push({ invariant: 'fixer-empty-round-rearmed', detail: 'a fix-begin after the answer on the same head was waived' });
    }
    return { violations };
  },
  judge(report) {
    return report.violations.map((v) => `[${v.invariant}] ${v.detail}`);
  },
};
