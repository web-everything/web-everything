/** Referral-specific comment reads and cumulative snapshot edits, composed over the label provider. */
import { createGhProvider, parseJsonLines } from './review-label-provider.mjs';
import { runGhSync } from './gh-throttle.mjs';

export function createReferralGhProvider({
  exec = (args, opts) => runGhSync(args, { encoding: 'utf8', ...opts }),
  ...options
} = {}) {
  return {
    ...createGhProvider({ ...options, exec }),

    /** Read every page, including the node id needed to update the original referral. */
    readComments(repo, pr) {
      return parseJsonLines(exec(['api', '--paginate', '--method', 'GET', '-F', 'per_page=100',
        `repos/${repo}/issues/${pr}/comments`, '--jq',
        '.[] | {id: .node_id, url: .html_url, author: {login: .user.login}, body, createdAt: .created_at}'],
      { maxBuffer: 64 * 1024 * 1024 }));
    },

    /** Update a referral's cumulative snapshot in its original comment. */
    editComment(id, body) {
      const result = JSON.parse(exec(['api', 'graphql', '-f',
        'query=mutation($id:ID!,$body:String!){updateIssueComment(input:{id:$id,body:$body}){issueComment{id}}}',
        '-f', `id=${id}`, '-f', `body=${body}`], { maxBuffer: 16 * 1024 * 1024 }));
      if (result.errors?.length || result.data?.updateIssueComment?.issueComment?.id !== id) {
        throw new Error('referral comment update failed');
      }
    },
  };
}
