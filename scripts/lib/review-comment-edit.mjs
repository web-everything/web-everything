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
    editComment(id, body, { repo } = {}) {
      // The mutation names only a node id, so the app shim cannot tell which owner's installation to use and would
      // fall back to the daemon checkout's origin (live 2026-11-23, frontierui#55: the persist failed three times
      // and then again after #7399). Route it by the PR's repo, and refuse rather than send it unrouted.
      if (!/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/.test(String(repo ?? ''))) throw new Error('referral comment update needs the PR repo (owner/name) to route the call');
      const result = JSON.parse(exec(['api', 'graphql', '-f',
        'query=mutation($id:ID!,$body:String!){updateIssueComment(input:{id:$id,body:$body}){issueComment{id}}}',
        '-f', `id=${id}`, '-f', `body=${body}`], { maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GH_REPO: repo } }));
      if (result.errors?.length || result.data?.updateIssueComment?.issueComment?.id !== id) {
        throw new Error('referral comment update failed');
      }
    },
  };
}
