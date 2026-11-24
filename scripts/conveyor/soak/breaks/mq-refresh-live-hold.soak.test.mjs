import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';
import b, { probe } from './mq-refresh-live-hold.mjs';

it(b.title, async () => {
  expect(b.judge(await b.run({}))).toEqual([]);
});
it('rejects an always-stopping executor and one missing the post-merge hold check', async () => {
  expect(await probe(async () => ({ action: 'stop' }))).not.toEqual([]);
  const { refreshMqFailureHead } = await import('../../../lib/mq-failure-refresh.mjs');
  expect(await probe(options => { const read = options.io.readAuthorization, initial = read(); options.io.readAuthorization = () => initial; return refreshMqFailureHead(options); })).not.toEqual([]);
});
it('fixedBy names a resolvable commit', () => { expect(() => execFileSync('git', ['cat-file', '-e', `${b.fixedBy.sha}^{commit}`], { stdio: 'pipe' })).not.toThrow(); });
