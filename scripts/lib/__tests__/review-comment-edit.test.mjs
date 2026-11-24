import { describe, it, expect } from 'vitest';
import { createReferralGhProvider } from '../review-comment-edit.mjs';


describe('referral comment updates', () => {
  it('reads every comment page with the node id and URL, retaining label operations', () => {
    const calls = [];
    const comment = { id: 'IC_referral', url: 'https://github.com/o/n/pull/9#issuecomment-1',
      author: { login: 'reviewer' }, body: 'snapshot', createdAt: '2026-10-15T00:00:00Z' };
    const provider = createReferralGhProvider({ exec: (argv, opts) => {
      calls.push({ argv, opts });
      return `${JSON.stringify(comment)}\n${JSON.stringify(comment)}\n`;
    } });
    expect(provider.readComments('o/n', 9)).toEqual([comment, comment]);
    expect(calls[0].argv).toEqual(['api', '--paginate', '--method', 'GET', '-F', 'per_page=100',
      'repos/o/n/issues/9/comments', '--jq',
      '.[] | {id: .node_id, url: .html_url, author: {login: .user.login}, body, createdAt: .created_at}']);
    expect(calls[0].opts.maxBuffer).toBe(64 * 1024 * 1024);
    expect(provider.postComment).toBeTypeOf('function');
    expect(provider.setLabels).toBeTypeOf('function');
  });

  it('propagates comment read failures and malformed output', () => {
    expect(() => createReferralGhProvider({ exec: () => { throw new Error('gh failed'); } })
      .readComments('o/n', 9)).toThrow(/gh failed/);
    expect(() => createReferralGhProvider({ exec: () => 'not json' }).readComments('o/n', 9)).toThrow();
    expect(createReferralGhProvider({ exec: () => '' }).readComments('o/n', 9)).toEqual([]);
  });

  it('routes the node-id-only mutation to the PR repo owner (GH_REPO), so the app shim never guesses from the daemon checkout', () => {
    const envs = [];
    const ok = JSON.stringify({ data: { updateIssueComment: { issueComment: { id: 'IC_referral' } } } });
    const provider = createReferralGhProvider({ exec: (_argv, opts) => { envs.push(opts.env); return ok; } });
    provider.editComment('IC_referral', 'body', { repo: 'frontier-ui/frontierui' });
    expect(envs[0].GH_REPO).toBe('frontier-ui/frontierui');
    // Fail closed: no repo named means the call is refused, never sent unrouted.
    expect(() => provider.editComment('IC_referral', 'body')).toThrow(/repo/);
    for (const bad of ['!/repo', '-o/n', 'o/n/x', 'o/ n', 'o/']) {
      expect(() => provider.editComment('IC_referral', 'body', { repo: bad })).toThrow(/repo/);
    }
    expect(envs).toHaveLength(1);
  });

  it('updates the original node with the full multiline snapshot and checks the returned id', () => {
    const calls = [];
    const provider = createReferralGhProvider({ exec: argv => { calls.push(argv);
      return JSON.stringify({ data: { updateIssueComment: { issueComment: { id: 'IC_referral' } } } }); } });
    provider.editComment('IC_referral', 'first line\nsecond line', { repo: 'o/n' });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('id=IC_referral');
    expect(calls[0]).toContain('body=first line\nsecond line');
    expect(() => createReferralGhProvider({ exec: () => '{}' }).editComment('IC_referral', 'body', { repo: 'o/n' })).toThrow(/update failed/);
    for (const result of [{ errors: [{ message: 'denied' }] },
      { data: { updateIssueComment: { issueComment: { id: 'IC_other' } } } }]) {
      expect(() => createReferralGhProvider({ exec: () => JSON.stringify(result) })
        .editComment('IC_referral', 'body', { repo: 'o/n' })).toThrow(/update failed/);
    }
  });
});
