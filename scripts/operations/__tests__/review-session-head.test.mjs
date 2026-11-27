import { it, expect, vi } from 'vitest';
import { dispatchReview } from '../review-dispatch.mjs';
import { readPr, createReviewPrSinks } from '../review-pr-io.mjs';
import { REVIEW_EFFECTS } from '../review-pr.mjs';

const head = 'a'.repeat(40), moved = 'b'.repeat(40);
const repo = 'web-everything/web-everything', pr = 77;
function launch() {
  let settings;
  dispatchReview({ pr, repo, root: '/fixture', expectedHead: head, io: { liveHead: () => head },
    ciGate: () => ({ allowed: true }), checkStaleness: () => ({ fresh: true }),
    readBrief: () => 'review', resolveSettingsEnv: () => ({}), wrapReview: false,
    sessionCwdFor: () => '/fixture', ensureSessionCwd: x => x, isolateSession: () => ({}),
    spawnAgent: argv => { settings = JSON.parse(argv[argv.indexOf('--settings') + 1]); return ''; },
  });
  return settings.env;
}

it('a session worker with its admitted head can publish an advisory', async () => {
  const env = launch(), postComment = vi.fn();
  const sinks = createReviewPrSinks({ env, postComment, readPublishHead: () => head,
    publishGate: () => ({ allowed: true, headSha: head, checks: [] }) });
  expect(await sinks[REVIEW_EFFECTS.ADVISORY_NOTE]({ pr, repo, reviewedHead: head, body: 'review evidence' }))
    .toEqual({ posted: true });
  expect(postComment).toHaveBeenCalledWith(repo, pr, 'review evidence');
});

it.each([moved, null])('session worker refuses a changed or unknown head after spawn, before reading the diff: %s', live => {
  const env = launch(), exec = vi.fn(), stack = vi.fn();
  expect(() => readPr({ pr, repo, env, exec, originRepo: () => repo,
    readView: () => ({ number: pr, headRefOid: live }), readStack: stack })).toThrow('session head pin');
  expect(exec).not.toHaveBeenCalled();
  expect(stack).not.toHaveBeenCalled();
});

it.each([REVIEW_EFFECTS.LABEL, REVIEW_EFFECTS.ADVISORY_NOTE, REVIEW_EFFECTS.STACK_HOLD])('session worker refuses a head moved before verdict publication (%s)', async effect => {
  const env = launch(), runNode = vi.fn(), postComment = vi.fn();
  const sinks = createReviewPrSinks({ env, runNode, postComment, readPublishHead: () => moved });
  await expect(sinks[effect]({ pr, repo, reviewedHead: head, to: 'changes' }, {})).rejects.toThrow('head moved');
  expect(runNode).not.toHaveBeenCalled(); expect(postComment).not.toHaveBeenCalled();
});

it.each([moved, null])('session worker cannot publish a different or unpinned reviewed basis: %s', reviewedHead => {
  const env = launch(), runNode = vi.fn();
  const sinks = createReviewPrSinks({ env, runNode, readPublishHead: () => reviewedHead });
  return expect(sinks[REVIEW_EFFECTS.LABEL]({ pr, repo, reviewedHead, to: 'changes' }, {}))
    .rejects.toThrow('session head pin');
});

it.each(['bad-json', 'wrong-pr', 'wrong-repo'])('session worker rejects %s admission binding before diff work', kind => {
  const env = launch(), exec = vi.fn();
  if (kind === 'bad-json') env.WE_REVIEW_SESSION_PIN = '{';
  else {
    const pin = JSON.parse(env.WE_REVIEW_SESSION_PIN);
    if (kind === 'wrong-pr') pin.pr++;
    else pin.repo = 'different/repo';
    env.WE_REVIEW_SESSION_PIN = JSON.stringify(pin);
  }
  expect(() => readPr({ pr, repo, env, exec, originRepo: () => repo,
    readView: () => ({ number: pr, headRefOid: head }) })).toThrow('session head pin');
  expect(exec).not.toHaveBeenCalled();
});
