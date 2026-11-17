/**
 * @file breaks/operator-rearm-answer-deadlock.mjs — LIVE incident, #6748 (2026-11-14 14:54 ET): the fixer stood down
 * (the finding was ruled not real, head unchanged), the operator answered "no code owed; re-review", and then the review
 * daemon said "owed a fix, not a review" while `rearm-review` refused the unchanged head (the #6798 empty-round guard).
 *
 * Fix: an operator `--disposition=rearm-review` answer (posted directly or relayed by trusted automation) naming the
 * latest stand-down clears the empty-round window (`decideEmptyFixRound`). A fixer's own later empty round, an
 * untrusted poster and an answer without the disposition still refuse.
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
    const { buildOperatorAnswer, latestUnresolvedStandDown } = await import(pathToFileURL(join(root, 'scripts/conveyor/stand-down-answer-core.mjs')).href);
    const { runStandDownAnswer } = await import(pathToFileURL(join(root, 'scripts/conveyor/stand-down-answer.mjs')).href);
    const { buildStandDownComment } = await import(pathToFileURL(join(root, 'scripts/conveyor/stand-down.mjs')).href);
    const begin = { body: `🔒 conveyor fix-begin — fix claim held\n\n**Branch:** \`lane/x\` at \`${HEAD.slice(0, 9)}\`\n<!-- fix-claim who=fix-6748 -->`, author: BOT };
    const stop = { id: 'IC_stop', author: BOT, createdAt: '2026-11-14T10:00:00Z', body: buildStandDownComment({ reason: 'needs-judgment', detail: 'Is code owed?' }) };
    const answer = (author) => ({ author, body: buildOperatorAnswer({ standDownId: 'IC_stop', reason: 'No code owed', actor: 'chalbert', channel: 'chat', disposition: 'rearm-review' }) });
    const violations = [];
    // The production rearm CLI reads REST comments; the answer CLI records gh's GraphQL target ID.
    const restBegin = { ...begin, author: undefined, user: BOT, id: 1, node_id: 'IC_begin' };
    const restStop = { ...stop, author: undefined, user: BOT, id: 4242, node_id: stop.id };
    const restAnswer = (user) => ({ body: answer(user).body, user, id: 4300, node_id: 'IC_answer' });
    if (decideEmptyFixRound({ comments: [restBegin, restStop, restAnswer({ login: 'chalbert' })], liveHead: HEAD }).empty) {
      violations.push({ invariant: 'rest-operator-answer-ignored', detail: 'REST user and node_id did not match the human answer built for the GraphQL stand-down ID' });
    }
    for (const user of [{ login: 'outsider' }, { login: 'chalbert', type: 'Bot' }, { login: 'chalbert', is_bot: true }]) {
      if (!decideEmptyFixRound({ comments: [restBegin, restStop, restAnswer(user)], liveHead: HEAD }).empty) {
        violations.push({ invariant: 'rest-untrusted-answer-honoured', detail: `REST answer from ${JSON.stringify(user)} waived the operator relay author check` });
      }
    }
    if (!decideEmptyFixRound({ comments: [restBegin, restStop, restAnswer({ login: 'chalbert' }), restBegin], liveHead: HEAD }).empty) {
      violations.push({ invariant: 'rest-fixer-empty-round-rearmed', detail: 'a REST fix-begin after the answer on the same head was waived' });
    }
    if (decideEmptyFixRound({ comments: [begin, stop, answer({ login: 'chalbert' })], liveHead: HEAD }).empty) {
      violations.push({ invariant: 'operator-answer-ignored', detail: 'a human operator rearm-review answer still left the unchanged head refused' });
    }
    for (const [alreadyAnswered, login] of [[false, 'web-everything'], [true, 'web-everything'],
      [false, 'web-everything[bot]'], [true, 'web-everything[bot]']]) {
      const comments = [begin, stop, ...(alreadyAnswered ? [{ id: 'IC_prior', author: BOT, body: buildOperatorAnswer({ standDownId: stop.id, reason: 'Earlier ruling', actor: 'chalbert', channel: 'chat' }) }] : [])];
      const snapshot = { comments, labels: [{ name: 'status:answered-waiting-fixer' }], headRefOid: HEAD,
        commits: [{ oid: HEAD, committedDate: '2026-11-14T09:00:00Z' }] };
      let posts = 0;
      const gh = (args) => {
        if (args[1] === 'view') return JSON.stringify(snapshot);
        posts += 1;
        comments.push({ id: 'IC_relay', author: { login }, body: args[args.indexOf('--body') + 1] });
        return 'posted';
      };
      const argv = ['6748', '--repo=o/r', '--reason=No code owed', '--actor=chalbert', '--channel=chat', '--disposition=rearm-review'];
      runStandDownAnswer(argv, { gh });
      const rest = comments.map(({ author, id, ...c }, i) => ({ ...c, user: author, id: i + 1, node_id: id }));
      if (latestUnresolvedStandDown(comments) || decideEmptyFixRound({ comments: rest, liveHead: HEAD }).empty) {
        violations.push({ invariant: 'operator-relay-answer-ignored', detail: `posted relay answer did not allow rearm (alreadyAnswered=${alreadyAnswered}, login=${login})` });
      }
      try { runStandDownAnswer(argv, { gh }); } catch (error) {
        if (!error.message.includes('no unresolved stand-down')) throw error;
      }
      if (posts !== 1 || !decideEmptyFixRound({ comments: [...comments, begin], liveHead: HEAD }).empty) {
        violations.push({ invariant: 'operator-relay-answer-replayed', detail: 'relay posted twice or waived a later empty fix round' });
      }
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
