/** PR #7480 send-backs: human holds retain waived findings; no-code handoffs spend a repair round. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { planReconcile } from '../../reconcile-core.mjs';
import { buildOperatorAnswer } from '../../stand-down-answer-core.mjs';
import { buildStandDownComment } from '../../stand-down.mjs';
import { buildRearmComment, countRearmComments, runRearmReview } from '../../rearm-review.mjs';
import { defaultRearmNoCode } from '../../../operations/promote-draft-pr-dispatch.mjs';
import { runReviewLabelCli } from '../../../review-set-label.mjs';
import { REVIEW_PR_CHANNEL } from '../../../lib/review-escalation.mjs';
import { REVIEW_PR_FOOTER } from '../../mechanical-round-cap.mjs';
import { defaultRearm } from '../../orphan-fix-round.mjs';
import { NOTE_COMMENT_MARKER, planNoteComment } from '../../reconcile-note-comment.mjs';

const HEAD = '93ff74ce966785fe5844fa63f2be9b8ed091aa52';
const BOT = { login: 'web-everything' };
const NOW = Date.parse('2026-11-25T09:00:00Z');

/** Exercise the orphan guard's actual argv through both production CLI layers, with in-memory IO. */
export function replayOrphanRearm(label) {
  let labels = ['review:changes', label];
  const writes = [];
  defaultRearm({ slug: 'fixture/orphan', pr: 7480, head: HEAD, exec: (_cmd, args) => {
    const exit = process.exit;
    const output = [];
    process.exit = code => { throw Object.assign(new Error(output.join('')), { writerExit: code }); };
    try {
      runRearmReview(args.slice(1), {
        read: args => JSON.stringify(args[0] === 'api' ? [[]] : { headRefOid: HEAD }),
        runLabel: config => runReviewLabelCli({ ...config,
          emit: line => output.push(line), appendLedgerVerdict: () => ({ ok: true }),
          provider: {
            readPostingIdentity: () => ({ login: BOT.login, type: 'User' }),
            readPrState: () => ({ state: 'OPEN', isDraft: false, headRefOid: HEAD, labels, comments: [] }),
            readComments: () => [], readPrReviews: () => [],
            setLabels: (_repo, _pr, { add, remove }) => {
              writes.push({ add, remove });
              labels = labels.filter(name => !remove.includes(name));
              if (add && !labels.includes(add)) labels.push(add);
            },
            postComment: () => ({ id: 'IC_rearmed' }),
          },
        }),
      });
    } catch (error) {
      if (error.writerExit !== 0) throw error;
    } finally { process.exit = exit; }
  } });
  return { labels, writes };
}

/** Production planner, executor and label writer with all GitHub IO held in memory. */
export function replayNoCodeHandoff({ human = false, rounds = 0, red = true, guardUnreadable = false } = {}) {
  const comments = [];
  const post = body => comments.push({ id: `IC_${comments.length}`, author: BOT, body,
    createdAt: new Date(NOW - 60_000 + comments.length * 1000).toISOString() });
  Array.from({ length: rounds }, () => post(buildRearmComment({ actor: 'fixer', decision: { rearmFrom: 'review:changes' } })));
  post(`🔁 review — changes requested\n\nRecorded by agent via ${REVIEW_PR_CHANNEL}.\n\nRepair required.\n\n---\n\nNet basis: \`${'a'.repeat(40)}..${HEAD}\` — 1 net changed file(s) vs current main\n\n${REVIEW_PR_FOOTER}`);
  post(`🔒 conveyor fix-begin — fix claim held\n\n**Branch:** \`lane/x\` at \`${HEAD.slice(0, 9)}\`\n<!-- fix-claim who=fix-7480 -->`);
  post(buildStandDownComment({ reason: 'needs-judgment', detail: 'Is code owed?' }));
  const standDownId = comments.at(-1).id;
  post(buildOperatorAnswer({ standDownId, reason: 'No code is owed', actor: 'chalbert', channel: 'chat',
    disposition: 'rearm-review', noCodeOwed: true, head: HEAD }));
  const snapshot = { number: 7480, state: 'OPEN', isDraft: false, headRefName: 'lane/x', headRefOid: HEAD,
    labels: ['review:changes', ...(human ? ['review:human'] : [])].map(name => ({ name })), comments,
    commits: [], rowsComplete: true, rowsHead: HEAD, mergeStateStatus: 'CLEAN',
    statusCheckRollup: [{ name: 'merge-gate', status: 'completed', conclusion: red ? 'failure' : 'success' }] };
  const tick = () => planReconcile({ prs: [snapshot], agents: [], durableCounts: {}, now: NOW,
    shadowDeps: {}, requiredChecks: ['merge-gate'],
    reviewTiming: { startEarly: 'off', startBeforeCi: false, startAfter: 'ci-green' } });
  const first = tick();
  const writes = [];
  for (const entry of first.dispatch.filter(d => d.kind === 'rearm-no-code')) {
    defaultRearmNoCode({ ...entry, repoSlug: 'fixture/no-code', postComment: ({ comment }) => post(comment),
      run: (_cmd, args) => {
        const exit = process.exit;
        const output = [];
        process.exit = code => { throw Object.assign(new Error(`label writer exit ${code}: ${output.join('')}`), { writerExit: code }); };
        try {
          runRearmReview(args.slice(1), {
            read: args => {
              if (guardUnreadable) throw new Error('initial empty-round read unavailable');
              return JSON.stringify(args[0] === 'api' ? [comments] : { headRefOid: HEAD });
            },
            runLabel: config => runReviewLabelCli({ ...config,
              emit: line => output.push(line), appendLedgerVerdict: () => ({ ok: true }),
              provider: {
                readPostingIdentity: () => ({ login: BOT.login, type: 'User' }),
                readPrState: () => snapshot, readComments: () => comments, readPrReviews: () => [],
                setLabels: (_repo, _pr, { add, remove }) => {
                  writes.push({ add, remove });
                  snapshot.labels = snapshot.labels.filter(l => !remove.includes(l.name));
                  if (add && !snapshot.labels.some(l => l.name === add)) snapshot.labels.push({ name: add });
                },
                postComment: (_repo, _pr, body) => { post(body); return { id: comments.at(-1).id }; },
              },
            }),
          });
        } catch (error) {
          if (error.writerExit !== 0) throw error;
        } finally { process.exit = exit; }
        return { status: 0 };
      },
    });
  }
  return { first, second: tick(), snapshot, writes, attempts: countRearmComments(comments), planNext: tick };
}

export default {
  id: 'no-code-rearm-handoff',
  title: 'no-code handoffs retire waived findings under a human hold and preserve review eligibility at the round cap (#7480)',
  card: 'x1b8hlo',
  fixedBy: { sha: 'pending', where: 'lane/standdown-s2-d2', paths: [
    'scripts/conveyor/reconcile-core.mjs', 'scripts/conveyor/rearm-review.mjs', 'scripts/conveyor/rearm-round-count.mjs',
    'scripts/review-set-label.mjs',
  ] },
  fixPresent: root => readFileSync(join(root, 'scripts/conveyor/rearm-round-count.mjs'), 'utf8').includes('NO_CODE_REARM_TRAILER'),
  async run() {
    const violations = [];
    for (const label of ['red-team:pending', 'red-team:blocked']) {
      try {
        const result = replayOrphanRearm(label);
        if (result.labels.join() !== 'review:pending' || result.writes.length !== 1) violations.push(`orphan ${label}: handoff failed`);
      } catch (error) { violations.push(`orphan ${label}: ${error.message}`); }
    }
    for (const config of [{ human: true }, { human: false }, { rounds: 5, red: false }, { rounds: 5, red: false, guardUnreadable: true }]) {
      const result = replayNoCodeHandoff(config);
      const expected = config.red === false ? 'review' : 'ci-heal';
      if (result.first.dispatch.map(d => d.kind).join() !== 'rearm-no-code' || result.first.refusals.length) {
        violations.push(`${JSON.stringify(config)} tick 1: ${JSON.stringify(result.first)}`);
      }
      if (result.second.dispatch.map(d => d.kind).join() !== expected) {
        violations.push(`${JSON.stringify(config)} tick 2: ${JSON.stringify(result.second)}`);
      }
      if (result.second.dispatch.some(row => Object.hasOwn(row, 'operatorAnswer'))) violations.push('no-code answer leaked into ordinary work');
      const asks = result.second.notes.map(note => planNoteComment(note, result.snapshot.comments))
        .filter(note => !note.alreadyPosted && !note.suppressed && note.body.startsWith(NOTE_COMMENT_MARKER));
      if (asks.length) violations.push(`successful handoff asks for a decision: ${asks.map(note => note.body).join()}`);
      if (result.attempts !== (config.rounds ?? 0)) violations.push(`handoff consumed a round: ${result.attempts}`);
      if (config.human && !result.snapshot.labels.some(l => l.name === 'review:human')) violations.push('human hold lost');
    }
    return { violations };
  },
  judge: report => report.violations,
};
