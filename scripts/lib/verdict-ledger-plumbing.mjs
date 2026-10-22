/**
 * @file scripts/lib/verdict-ledger-plumbing.mjs
 * @description Layer 2 of the ledger outbox (see verdict-ledger-outbox-spool.mjs): the ONE ledger push shape, and
 *   the direct append (CI, unit seams) that uses it.
 *
 *   3. PLUMBING, NO WORKTREE. read the tip blob, append, `hash-object -w`, a temp `GIT_INDEX_FILE` (`read-tree <tip>`
 *      + `update-index --cacheinfo`), `write-tree`, `commit-tree -p <tip>`, and a NON-FORCE push of `<sha>:<ref>`. No
 *      checkout, no local branch ref moved, no worktree to strand.
 *   4. OFF-HOST WRITERS (the CI applier) still race the remote. A rejection that says `fetch first`/`non-fast-forward`
 *      is retried on a refetched tip with jitter, on a TIME budget (setting); anything else fails at once.
 *
 * INVARIANTS (the audit focus).
 *   · No row is lost: an entry is deleted only after a push that contains it succeeded, or after a fetched tip
 *     already holds every one of its ids.
 *   · No row is duplicated: each flush dedups against the tip it builds on, by event id, exactly as the old append
 *     did; a crash between push and delete is therefore a no-op replay on the next flush.
 *   · Never forced: the remote arbitrates every push; the lock is an efficiency, not the correctness mechanism.
 *   · Bounded: one overall deadline per flush, every git call has a timeout, the daemon backstop never throws.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { retryTransientGit } from './git-fetch-retry.mjs';
import { assertPushRef, trackingRefspec, withGitError } from './git-transport-branch.mjs';
import { parseLedgerEvents, ledgerEventId } from './verdict-ledger.mjs';
import {
  defaultLog, defaultSleep, resolveOutboxSettings, safeLog,
} from './verdict-ledger-outbox-spool.mjs';
import {
  boardEnv, canonicalRemote, classifyPushFailure, defaultGit, GIT_CALL_TIMEOUT_MS, OutboxFlushError,
} from './verdict-ledger-git.mjs';

/** Same blob cap as the reader (`verdict-ledger-io.mjs#DEFAULT_LEDGER_READ_MAX_BYTES`). */
const BLOB_MAX_BYTES = 64 * 1024 * 1024;
function readBlobAt(run, board, tip, path, env) {
  const listed = String(run(['ls-tree', tip, '--', path], { cwd: board, env })).trim();
  if (!listed) return { text: '', mode: '100644' };
  const [meta] = listed.split('\t');
  const [mode, type, oid] = meta.split(/\s+/);
  if (type !== 'blob') throw new Error(`verdict-ledger-outbox: ${path} at ${tip} is a ${type}, not a blob`);
  const size = Number(String(run(['cat-file', '-s', oid], { cwd: board, env })).trim());
  if (!Number.isSafeInteger(size)) throw new Error(`verdict-ledger-outbox: unreadable size for ${path}`);
  if (size > BLOB_MAX_BYTES) throw new Error(`verdict-ledger-outbox: ${path} is ${size} bytes, over the ${BLOB_MAX_BYTES}-byte cap`);
  return { text: String(run(['cat-file', 'blob', oid], { cwd: board, env, maxBuffer: size + 64 * 1024 })), mode };
}

/**
 * ONE attempt: fetch, compute every entry's fresh rows against the fetched tip, and push them as ONE commit.
 * Returns per-entry counts; `pushed: false` when the tip already held every row (a replay after a crash).
 * A failure of the PUSH command itself carries `phase: 'publish'` and the `commit`, so the caller can reconcile:
 * a push can land on the remote and still report failure (a dropped connection after the remote accepted it).
 */
export function pushBatch({ board, branch, entries, run, allowRef, sleep = undefined }) {
  const ref = assertPushRef(branch, allowRef);
  const env = boardEnv(board);
  assertSingleDestination({ board, run, env });
  retryTransientGit(() => run(['fetch', '--quiet', 'origin', trackingRefspec(branch)], { cwd: board, env }), sleep ? { sleep } : {});
  const tip = String(run(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}^{commit}`], { cwd: board, env })).trim();
  if (!/^[0-9a-f]{40,64}$/.test(tip)) throw new Error(`verdict-ledger-outbox: origin/${branch} did not resolve to a commit`);

  const byPath = new Map();
  for (const e of entries) {
    if (!byPath.has(e.entry.path)) byPath.set(e.entry.path, []);
    byPath.get(e.entry.path).push(e);
  }
  const counts = new Map();
  const changes = [];
  for (const [path, group] of byPath) {
    const { text: base, mode } = readBlobAt(run, board, tip, path, env);
    const seen = new Set(parseLedgerEvents(base).map(ledgerEventId));
    const fresh = [];
    for (const { name, entry } of group) {
      let rows = 0;
      entry.lines.forEach((line, i) => {
        if (seen.has(entry.ids[i])) return;
        seen.add(entry.ids[i]);
        fresh.push(line);
        rows += 1;
      });
      counts.set(name, { rows, duplicates: entry.lines.length - rows });
    }
    if (fresh.length) changes.push({ path, mode, base, content: `${base}${base && !base.endsWith('\n') ? '\n' : ''}${fresh.join('\n')}\n` });
  }
  if (!changes.length) return { pushed: false, counts };

  const tmp = mkdtempSync(join(tmpdir(), 'we-ledger-index-'));
  try {
    const idx = boardEnv(board, { GIT_INDEX_FILE: join(tmp, 'index') });
    run(['read-tree', tip], { cwd: board, env: idx });
    for (const [i, c] of changes.entries()) {
      // From a FILE, never stdin: a runner that spawns git with stdin ignored would silently hash an EMPTY blob
      // (seen in a test seam) and the push would replace the whole ledger with nothing. `--no-filters`: the bytes
      // are stored exactly as computed, whatever attributes apply to the temp path.
      const src = join(tmp, `blob-${i}`);
      writeFileSync(src, c.content);
      const blob = String(run(['hash-object', '-w', '--no-filters', '--', src], { cwd: board, env: idx })).trim();
      if (!/^[0-9a-f]{40,64}$/.test(blob)) throw new Error(`verdict-ledger-outbox: hash-object returned no object id for ${c.path}`);
      run(['update-index', '--add', '--cacheinfo', `${c.mode},${blob},${c.path}`], { cwd: board, env: idx });
    }
    const tree = String(run(['write-tree'], { cwd: board, env: idx })).trim();
    const message = entries.length === 1 ? entries[0].entry.message
      : `verdict-ledger: append ${entries.length} queued appends (${[...new Set(entries.map((e) => e.entry.repo))].join(', ')})`;
    const commit = String(run(['commit-tree', tree, '-p', tip, '-m', message || 'verdict-ledger: append'], { cwd: board, env: idx })).trim();
    try {
      // A FULL ref, never forced, never a local branch: the remote alone decides whether this lands.
      run(['push', '--porcelain', '--no-follow-tags', 'origin', `${commit}:${ref}`], { cwd: board, env });
    } catch (e) {
      e.phase = 'publish';
      e.commit = commit;
      throw e;
    }
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* a temp dir left behind never undoes a push */ }
  }
  return { pushed: true, counts };
}

/**
 * ONE publication destination, and it is the one we fetch (and reconcile) from (round 11: `remote.origin.pushurl`
 * can point elsewhere, and several push URLs can split one push into an accepted and a rejected half). Anything
 * else is refused BEFORE publication, so the refusal is a truthful "not recorded".
 */
function assertSingleDestination({ board, run, env }) {
  const list = (args) => String(run(args, { cwd: board, env })).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const push = list(['remote', 'get-url', '--push', '--all', 'origin']);
  const fetch = list(['remote', 'get-url', '--all', 'origin']);
  if (!push.length && !fetch.length) return; // nothing configured to compare (a seam): the push itself decides
  const canon = (u) => canonicalRemote(u, resolve(board));
  if (push.length !== 1 || fetch.length !== 1 || canon(push[0]) !== canon(fetch[0])) {
    throw new Error(`verdict-ledger-outbox: refusing to publish: origin must have exactly ONE push destination equal to its fetch URL (push: ${push.join(', ') || '(none)'}; fetch: ${fetch.join(', ') || '(none)'})`);
  }
}

/**
 * After a push command FAILED for a non-race reason: did the commit land anyway? `true` landed, `false` provably
 * not (the refetched tip does not contain it), `null` unknown (the remote cannot be read now).
 */
export function reconcilePush({ board, branch, run, commit }) {
  if (!commit) return false;
  const env = boardEnv(board);
  try {
    run(['fetch', '--quiet', 'origin', trackingRefspec(branch)], { cwd: board, env });
  } catch { return null; }
  try {
    run(['merge-base', '--is-ancestor', commit, `refs/remotes/origin/${branch}`], { cwd: board, env });
    return true;
  } catch (e) {
    return e?.status === 1 ? false : null;
  }
}

const defaultRemove = (abs) => rmSync(abs, { force: true });

export function common(o) {
  const settings = o.settings ?? resolveOutboxSettings({ repo: {}, env: o.env ?? process.env });
  return {
    board: o.board,
    branch: o.branch,
    dir: o.dir,
    run: withGitError(o.run ?? defaultGit),
    now: o.now ?? Date.now,
    sleep: o.sleep ?? defaultSleep,
    random: o.random ?? Math.random,
    log: safeLog(o.log ?? defaultLog),
    budgetMs: o.budgetMs ?? settings.flushBudgetMs,
    staleMs: o.staleMs ?? settings.staleMs,
    onRetry: o.onRetry ?? null,
    removeEntry: o.removeEntry ?? defaultRemove,
    allowRef: o.allowRef ?? null,
  };
}

/**
 * THE DIRECT PATH (CI, where an outbox would die with the runner, and unit seams): the SAME plumbing commit and the
 * SAME push site as the flusher, for this call's rows only, retried on a fetched tip up to `attempts` times. The
 * ledger therefore has ONE push shape; the worktree stager in `git-transport-branch.mjs` no longer carries ledger
 * rows at all. A push that reports failure is reconciled against the remote first. THROWS `OutboxFlushError` when
 * every attempt failed.
 * @returns {{status: 'appended', attempts: number, rows: number, duplicates: number}}
 */
export function appendDirect(o) {
  const c = common(o);
  const attempts = Math.max(1, o.attempts ?? 5);
  const entry = { path: o.path, repo: o.repo, message: o.message, lines: o.lines, ids: o.ids };
  const errors = [];
  let unresolved = false; // ANY earlier push without an answer keeps the outcome indeterminate, whatever follows
  const directDeadline = Date.now() + c.budgetMs;
  const { run, clampedSleep } = deadlineBound(c.run, c.sleep, directDeadline, c.budgetMs);
  for (let attempt = 1; ; attempt += 1) {
    try {
      const out = pushBatch({ board: c.board, branch: c.branch, entries: [{ name: 'direct', entry }], run, allowRef: c.allowRef, sleep: clampedSleep });
      const mine = out.counts.get('direct');
      return { status: 'appended', attempts: attempt, rows: mine.rows, duplicates: mine.duplicates };
    } catch (e) {
      errors.push(e);
      if (e?.phase === 'publish' && classifyPushFailure(e, assertPushRef(c.branch, c.allowRef)) === 'unknown') {
        if (reconcilePush({ board: c.board, branch: c.branch, run, commit: e.commit }) === true) {
          c.log(`verdict-ledger: push reported failure but ${e.commit} is on the remote; counted as landed`);
          return { status: 'appended', attempts: attempt, rows: entry.lines.length, duplicates: 0 };
        }
        unresolved = true;
      }
      if (attempt >= attempts || Date.now() >= directDeadline) {
        const unknown = unresolved;
        // CI has no durable queue to fall back on: a transport failure DURING the push is reported as an UNKNOWN
        // outcome, never as a proven miss. Rows carry event ids, so the caller's retry can never duplicate.
        throw new OutboxFlushError(`verdict-ledger: direct append failed after ${attempt} attempts${unknown ? ' (push outcome UNKNOWN: the remote may hold it)' : ''}: ${String(e?.message ?? e).split('\n')[0]}`,
          { errors, attempts: attempt, kind: unknown ? 'ambiguous' : 'flush' });
      }
      // Round 9: an observer's failure must never replace the publication state (an UNKNOWN push stays UNKNOWN).
      if (c.onRetry) { try { c.onRetry({ attempt, error: e }); } catch (cbErr) { c.log(`verdict-ledger: onRetry callback failed (ignored): ${cbErr?.message ?? cbErr}`); } }
      clampedSleep(Math.min(250 * 2 ** (attempt - 1), 4000) + Math.floor(c.random() * 500));
      if (Date.now() >= directDeadline) {
        throw new OutboxFlushError(`verdict-ledger: direct append budget ${c.budgetMs}ms spent after ${attempt} attempts${unresolved ? ' (push outcome UNKNOWN: the remote may hold it)' : ''}`,
          { errors, attempts: attempt, kind: unresolved ? 'ambiguous' : 'flush' });
      }
    }
  }
}

/**
 * ONE absolute deadline for a run of git calls: none starts after it (it throws `budget`), none is given a timeout
 * past it, and sleeps never cross it. A call cut off by the deadline is a SPENT BUDGET, not a verdict on the remote
 * (a push it cut off is still classified as UNKNOWN by its caller).
 */
export function deadlineBound(rawRun, sleep, hardDeadline, budgetMs) {
  const run = (args, opts = {}) => {
    const left = hardDeadline - Date.now();
    if (left <= 0) {
      const e = new Error(`verdict-ledger-outbox: budget ${budgetMs}ms spent before git ${args[0]}`);
      e.budget = true;
      throw e;
    }
    try {
      return rawRun(args, { timeout: Math.max(1, Math.min(GIT_CALL_TIMEOUT_MS, left)), ...opts });
    } catch (e) {
      if (Date.now() >= hardDeadline && e && typeof e === 'object') { try { e.budget = true; } catch { /* frozen */ } }
      throw e;
    }
  };
  const clampedSleep = (ms) => sleep(Math.max(0, Math.min(ms, hardDeadline - Date.now())));
  return { run, clampedSleep };
}
