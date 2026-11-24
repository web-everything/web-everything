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
it('rejects a held execution that returns fix, and an executor ignoring any one hold label', async () => {
  const { refreshMqFailureHead } = await import('../../../lib/mq-failure-refresh.mjs');
  expect(await probe(async options => { const r = await refreshMqFailureHead(options); return r.action === 'stop' ? { action: 'fix' } : r; })).not.toEqual([]);
  for (const ignored of ['review:human', 'red-team:blocked', 'red-team:pending', 'review:held-mechanical']) {
    const violations = await probe(options => {
      const read = options.io.readAuthorization;
      options.io.readAuthorization = (...a) => { const v = read(...a); return { ...v, labels: v.labels.filter(l => l.name !== ignored) }; };
      return refreshMqFailureHead(options);
    });
    expect(violations, ignored).not.toEqual([]);
  }
});
it('fixedBy names a resolvable commit', () => { expect(() => execFileSync('git', ['cat-file', '-e', `${b.fixedBy.sha}^{commit}`], { stdio: 'pipe' })).not.toThrow(); });
