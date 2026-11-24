import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSyncThrottled } from './gh-throttle.mjs';

/** Default IO is bounded and argv-only. It never modifies the dispatch checkout. `exec`/`throttled` are injectable for hermetic tests. */
export function mqFailureRefreshIo(root, { exec = execFileSync, throttled = execFileSyncThrottled } = {}) {
  const git = (cwd, args) => exec('git', args, { cwd, encoding: 'utf8', timeout: 120000, maxBuffer: 2 * 1024 * 1024 });
  const pr = (repo, number, fields) => JSON.parse(throttled('gh', ['pr', 'view', String(number), '--repo', repo, '--json', fields],
    { cwd: root, encoding: 'utf8', timeout: 30000, maxBuffer: 128 * 1024, throttle: { noMemo: true } }));
  return {
    readAuthorization: ({ repo, pr: number }) => pr(repo, number, 'labels,state,isDraft'),
    readHead: ({ repo, pr: number }) => pr(repo, number, 'headRefOid').headRefOid,
    createCheckout({ repo, pr: number, head }) {
      const data = pr(repo, number, 'headRefOid,headRefName,isCrossRepository');
      if (data.headRefOid !== head || data.isCrossRepository !== false) throw new Error('Stale or fork head; operator inspection required');
      git(root, ['check-ref-format', '--branch', data.headRefName]);
      const remote = git(root, ['remote', 'get-url', 'origin']).trim();
      if (!remote.endsWith(`/${repo}.git`) && !remote.endsWith(`:${repo}.git`) && !remote.endsWith(`/${repo}`))
        throw new Error('Origin does not match route repository');
      const cwd = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'mq-failure-refresh-'));
      try {
        git(root, ['clone', '--no-checkout', '--shared', '--', root, cwd]);
        git(cwd, ['remote', 'set-url', 'origin', remote]);
        git(cwd, ['fetch', '--no-tags', 'origin', '+refs/heads/main:refs/remotes/origin/main', `refs/heads/${data.headRefName}`]);
        git(cwd, ['checkout', '--detach', head]);
        return { cwd, branch: data.headRefName };
      } catch (error) { rmSync(cwd, { recursive: true, force: true }); throw error; }
    },
    git({ cwd, args }) {
      try {
        git(cwd, args);
        return { ok: true, ...(args[0] === 'merge' ? { head: git(cwd, ['rev-parse', 'HEAD']).trim() } : {}) };
      } catch { return { ok: false, conflict: args[0] === 'merge' }; }
    },
    removeCheckout: ({ cwd }) => rmSync(cwd, { recursive: true, force: true }),
  };
}

/** Same MQ holds as reconcile-core; malformed evidence never grants write authority. */
export function mqFailureHoldReason(labels) {
  if (!Array.isArray(labels) || labels.some(label => typeof (typeof label === 'string' ? label : label?.name) !== 'string'))
    return 'held: labels unreadable; operator inspection required';
  return labels.some(label => ['review:human', 'red-team:blocked', 'red-team:pending', 'review:held-mechanical']
    .includes(typeof label === 'string' ? label : label.name)) ? 'held: human-only' : null;
}

export function mqFailureAuthorizationReason(pr) {
  return pr?.state !== 'OPEN' || pr.isDraft !== false
    ? 'held: PR closed, draft or unreadable; operator inspection required' : mqFailureHoldReason(pr.labels);
}

// One state machine, driven asynchronously by hermetic callers and synchronously by the existing dispatcher.
function* refresh({ repo, pr, head, ledger, io, dryRun = false }) {
  const stop = note => ({ action: 'stop', note });
  if (dryRun) return stop('Dry-run: no refresh claim or writes');
  if (!/^[a-f0-9]{40}$/.test(head ?? '')) return stop('Unknown head; operator inspection required');
  const identity = { repo, pr, head };
  let checkout, claimed = false;
  // Attempts are never released; post-claim holds preserve fixer ownership.
  const fallback = function* (note) {
    const recorded = yield () => ledger.recordFixFallback(identity);
    return recorded?.recorded === true ? { action: 'fix', note } : stop('Fix fallback unconfirmed; operator inspection required');
  };
  const authorize = function* () {
    try { return mqFailureAuthorizationReason(yield () => io.readAuthorization({ repo, pr })); }
    catch { return 'held: labels unreadable; operator inspection required'; }
  };
  try {
    if ((yield () => io.readHead({ repo, pr })) !== head) return stop('Head changed; stale route retained for operator inspection');
    const held = yield* authorize();
    if (held) return stop(held);
    const claim = yield () => ledger.claim({ ...identity, kind: 'refresh' });
    if (claim?.claimed !== true) {
      // A head this ledger produced by a refresh that failed again is main-caused or real: the fixer gets it. Any other
      // denied claim (a concurrent executor, an earlier attempt) stays a loop-guard stop.
      if (claim?.claimed === false && (yield () => ledger.readRefreshSuccessor?.(identity)) === true)
        return yield* fallback('Refreshed head failed again; normal fix required (no second refresh)');
      return stop(claim.note ?? 'Already refreshed once; operator inspection required');
    }
    claimed = true;
    checkout = yield () => io.createCheckout(identity);
    if (!checkout?.cwd || typeof checkout.branch !== 'string' || !/^[\w./-]+$/.test(checkout.branch)
      || checkout.branch.startsWith('-') || checkout.branch.includes('..')) return yield* fallback('Invalid checkout branch; normal fix required');
    const merged = yield () => io.git({ cwd: checkout.cwd, args: ['merge', 'origin/main'] });
    if (!merged?.ok) return yield* fallback('Merge conflict or failure; normal fix required');
    if (!/^[a-f0-9]{40}$/.test(merged.head ?? '')) return yield* fallback('Unknown merged head; normal fix required');
    if (merged.head === head) return yield* fallback('Merge left head unchanged (main already included); normal fix required');
    // Reserve the successor BEFORE publication: a crash after push cannot grant it another refresh.
    let successor;
    try { successor = yield () => ledger.recordRefresh({ ...identity, newHead: merged.head }); }
    catch { return yield* fallback('Successor reservation unreadable; normal fix required'); }
    if (successor?.recorded !== true) return yield* fallback('Successor reservation unconfirmed; normal fix required');
    if ((yield () => io.readHead({ repo, pr })) !== head) return stop('Head changed after merge; refusing stale push');
    const pushHeld = yield* authorize();
    if (pushHeld) {
      // A detected hold always ends in stop, even when recording the fallback throws (never retried into fix).
      try { yield* fallback(pushHeld); } catch { /* hold wins */ }
      return stop(pushHeld);
    }
    const pushed = yield () => io.git({ cwd: checkout.cwd, args: ['push', 'origin', `HEAD:refs/heads/${checkout.branch}`] });
    if (!pushed?.ok) return yield* fallback('Ordinary push rejected; normal fix required (no retry)');
    return { action: 'refreshed', head: merged.head };
  } catch {
    if (!claimed) return stop('Refresh head, checkout or ledger unreadable; operator inspection required');
    try { return yield* fallback('Refresh failed after the attempt was claimed; normal fix required'); }
    catch { return stop('Refresh failed and the fixer fallback could not be recorded; operator inspection required'); }
  }
  finally { if (checkout) { try { yield () => io.removeCheckout(checkout); } catch { /* Isolated checkout may need operator cleanup. */ } } }
}
export async function refreshMqFailureHead(options) {
  const steps = refresh(options);
  let step = steps.next();
  while (!step.done) {
    try { step = steps.next(await step.value()); } catch (error) { step = steps.throw(error); }
  }
  return step.value;
}
export function refreshMqFailureHeadSync(options) {
  const steps = refresh(options);
  let step = steps.next();
  while (!step.done) {
    try {
      const value = step.value();
      if (value?.then) { value.catch(() => {}); throw new Error('Synchronous refresh requires synchronous IO'); }
      step = steps.next(value);
    } catch (error) { step = steps.throw(error); }
  }
  return step.value;
}
