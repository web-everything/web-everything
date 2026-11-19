// Retry a git command whose failure is a transient forge/transport error.
//
// Why: CI checks out blobless (`--filter=blob:none`), so a command that reads an OLD commit's blobs
// (`git archive <old-sha>`, `git show <old-sha>:path`) lazily fetches them from the promisor remote. A 503
// from github.com there fails the command with status 128 although nothing in the repo is wrong — main went
// red on f2de36bde (fix-end-rearms-review soak) for exactly this. A bounded retry is the same remedy
// `scripts/ci/fetch-main-history.sh` applies to the history fetch. Non-transient failures rethrow at once.
import { execFileSync } from 'node:child_process';

const TRANSIENT = /(promisor remote|unable to access 'https?:|The requested URL returned error: 5\d\d|Could not resolve host|Connection (?:reset|timed out)|early EOF|RPC failed|HTTP\/2 stream)/i;

export function isTransientGitFailure(error) {
  const text = `${error?.stderr ?? ''}\n${error?.message ?? ''}`;
  return TRANSIENT.test(text);
}

export function execGitRetrying(args, options = {}, {
  attempts = 4,
  exec = execFileSync,
  sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
  delayMs = attempt => attempt * 2000,
} = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try { return exec('git', args, options); } catch (error) {
      if (attempt >= attempts || !isTransientGitFailure(error)) throw error;
      sleep(delayMs(attempt));
    }
  }
}
