import { expect, it } from 'vitest';
import { derivePrStatusLabel } from '../pr-status-label.mjs';
import { buildStandDownComment } from '../stand-down.mjs';
import { buildOperatorAnswer } from '../stand-down-answer-core.mjs';
const comments = [
  { id: 'sd', author: { login: 'web-everything' }, createdAt: '2026-10-04T14:00:00Z', body: buildStandDownComment({ reason: 'needs-judgment', detail: 'Rule please' }) },
  { id: 'answer', author: { login: 'web-everything' }, createdAt: '2026-10-04T15:00:00Z',
    body: buildOperatorAnswer({ standDownId: 'sd', actor: 'chalbert', channel: 'chat', reason: 'No fix owed' }) },
];
it('resolved stand-down falls through to review after rearming', () => {
  expect(derivePrStatusLabel({ pr: { comments, labels: ['review:pending'] } })).toBe('awaiting-review');
});
it('resolved stand-down waits for a fixer only while changes is live', () => {
  expect(derivePrStatusLabel({ pr: { comments, labels: ['review:changes'] } })).toBe('answered-waiting-fixer');
});
it('unresolved stand-down still holds and a human reply still counts', () => {
  expect(derivePrStatusLabel({ pr: { comments: comments.slice(0, 1) } })).toBe('stood-down');
  expect(derivePrStatusLabel({ pr: { comments: [comments[0], { ...comments[1], author: { login: 'chalbert' }, body: 'Answer' }] } })).toBe('answered-waiting-fixer');
});
it('uses chronological order when the snapshot lists a newer question before an older one', () => {
  const newer = { ...comments[0], id: 'newer', createdAt: '2026-10-04T16:00:00Z' };
  const human = { ...comments[1], author: { login: 'chalbert' }, body: 'A reply to the old question' };
  expect(derivePrStatusLabel({ pr: { comments: [human, newer, comments[0]] } })).toBe('stood-down');
});
