/** Live reader and verified comment writer for the operator's extend-rounds operation. */
import { execFileSyncThrottled } from '../lib/gh-throttle.mjs';
import { countGrantedRoundExtensions } from '../conveyor/round-extension-mark.mjs';
import { ROUND_EXTENSION_POST_EFFECT, planRoundExtension } from './extend-rounds.mjs';

const gh = (args) => execFileSyncThrottled('gh', args, {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000, maxBuffer: 64 * 1024 * 1024,
});

export function readExtensionThread(repo, pr) {
  return JSON.parse(gh(['pr', 'view', String(pr), '--repo', repo, '--json', 'state,comments']));
}

export function createExtendRoundsReader({ readThread = readExtensionThread, now = () => new Date().toISOString() } = {}) {
  return ({ repo, pr }) => ({ ...readThread(repo, pr), now: now() });
}

export function createExtendRoundsSinks({
  readThread = readExtensionThread,
  post = (repo, pr, body) => gh(['pr', 'comment', String(pr), '--repo', repo, '--body', body]),
} = {}) {
  return {
    [ROUND_EXTENSION_POST_EFFECT]: async ({ record, body }) => {
      const { repo, pr, by } = record;
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
