import { expect, it } from 'vitest';
import { buildVerdictComment, canRestoreHumanClearance } from '../../review-set-label.mjs';
import b from '../soak/breaks/clear-human-refused-park.mjs';

it('CLI refusals after posting cannot be revived by immediate or repeated park healing; a later operator clearance can heal', async () => {
  expect(b.judge(await b.run())).toEqual([]);
}, 180_000);

it('park recovery binds delegation to the latest trusted acceptance and preserves ordinary clearance', () => {
  const head = 'a'.repeat(40);
  const human = { author: { login: 'chalbert' },
    body: buildVerdictComment({ to: 'clear-human', headSha: head, actor: 'operator', reason: 'reviewed' }) };
  const delegated = { ...human, body: human.body + '\n\n<!-- delegated-clearance: guarded -->' };
  expect(canRestoreHumanClearance([human, delegated], head)).toBe(false);
  expect(canRestoreHumanClearance([delegated, human], head)).toBe(true);
  expect(canRestoreHumanClearance([delegated, { ...human, author: { login: 'untrusted-user' } }], head)).toBe(false);
  expect(canRestoreHumanClearance([human, { ...delegated, author: { login: 'untrusted-user' } }], head)).toBe(true);
  expect(canRestoreHumanClearance([human], 'b'.repeat(40))).toBe(false);
  expect(canRestoreHumanClearance(null, head)).toBe(false);
  expect(canRestoreHumanClearance([human, { ...human,
    body: buildVerdictComment({ to: 'accepted', headSha: head, actor: 'reviewer' }) }], head)).toBe(false);
});
