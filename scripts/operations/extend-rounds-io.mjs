/** Live reader and verified comment writer for the operator's extend-rounds operation. */
import { execFileSyncThrottled } from '../lib/gh-throttle.mjs';
import { countGrantedRoundExtensions } from '../conveyor/round-extension-mark.mjs';
import { OPERATOR_LOGINS } from '../lib/marker-authorship.mjs';
import { ROUND_EXTENSION_POST_EFFECT, planRoundExtension } from './extend-rounds.mjs';

const gh = (args, throttle) => execFileSyncThrottled('gh', args, {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000, maxBuffer: 64 * 1024 * 1024,
  ...(throttle ? { throttle } : {}),
});

export function readExtensionThread(repo, pr) {
  return JSON.parse(gh(['pr', 'view', String(pr), '--repo', repo, '--json', 'state,comments']));
}

export function createExtendRoundsReader({ readThread = readExtensionThread, now = () => new Date().toISOString() } = {}) {
  return ({ repo, pr }) => ({ ...readThread(repo, pr), now: now() });
}

/**
 * The GitHub login the posting credential authenticates as — what will be recorded as the comment's author.
 * The throttle's personal-read route is switched off for this call: it sends READS (this one) under the operator's
 * stored token while the comment WRITE stays on the App token, so a routed read would name an identity that never posts.
 */
export const readViewerLogin = () => gh(['api', 'user', '--jq', '.login'], { personalRoute: false }).trim();

export function createExtendRoundsSinks({
  readThread = readExtensionThread,
  post = (repo, pr, body) => gh(['pr', 'comment', String(pr), '--repo', repo, '--body', body]),
  readViewerLogin: viewerLogin = readViewerLogin,
} = {}) {
  return {
    [ROUND_EXTENSION_POST_EFFECT]: async ({ record, body }) => {
      const { repo, pr, by } = record;
      // The grant counts only when GitHub records the operator as the author, so refuse before posting under any
      // other credential (e.g. the automation's) rather than leave an inert, misleading grant on the PR.
      const viewer = String(await viewerLogin() ?? '').trim().toLowerCase();
      if (!OPERATOR_LOGINS.includes(viewer) || viewer !== record.actor) {
        throw new Error(`extend-rounds must run under the operator's own GitHub credential (acting as "${record.actor}"); this one is "${viewer || 'unknown'}"`);
      }
      const before = await readThread(repo, pr);
      const validated = planRoundExtension({ ...before, now: record.at }, record);
      if (validated.body !== body) throw new Error('round extension body does not match its validated record');
      const count = countGrantedRoundExtensions(before.comments, { repo, pr });
      await post(repo, pr, body);
      const after = await readThread(repo, pr);
      if (countGrantedRoundExtensions(after.comments, { repo, pr }) !== count + by
        || !after.comments.some((c) => c.body === body && countGrantedRoundExtensions([c], { repo, pr }) === by)) {
        throw new Error('could not prove the posted round extension increased the trusted grant count');
      }
      return { granted: by, total: count + by };
    },
  };
}
