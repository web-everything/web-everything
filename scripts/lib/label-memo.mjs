/**
 * @file scripts/lib/label-memo.mjs
 * @description Persistent memo of "this (repo, label) exists on GitHub" for the merge drain, so a restarted or
 *   one-shot drain pass does not `gh label create` the same labels again (perf item 6).
 *   Entries expire after a TTL and are forgotten the moment a label call fails with not-found, so a label
 *   deleted on GitHub after it was memoised is minted again exactly when needed.
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';

export const LABEL_MEMO_TTL_MS = 6 * 60 * 60 * 1000;

export function labelMemoKey(repo, name) { return `${repo || 'cwd'}::${name}`; }

/** Tolerant parse: anything unreadable yields an empty memo (never trust a corrupt file). */
export function parseLabelMemo(text) {
  try {
    const data = JSON.parse(text);
    const out = {};
    for (const [k, v] of Object.entries(data?.labels || {})) if (Number.isFinite(v)) out[k] = v;
    return out;
  } catch { return {}; }
}

export function isLabelMemoFresh(memo, key, now = Date.now(), ttlMs = LABEL_MEMO_TTL_MS) {
  const at = memo?.[key];
  return Number.isFinite(at) && at <= now + 60_000 && now - at < ttlMs;
}

/** gh reports a missing label as "... 'x' not found" / "could not resolve to a Label". */
export function isLabelNotFoundError(err) {
  const text = `${err?.stderr ?? ''} ${err?.message ?? ''}`;
  return /not found|could not resolve to a label/i.test(text);
}

/** gh reports an existing label on create as "already exists". */
export function isLabelAlreadyExistsError(err) {
  return /already exists/i.test(`${err?.stderr ?? ''} ${err?.message ?? ''}`);
}

export function loadLabelMemo(path) {
  try { return parseLabelMemo(readFileSync(path, 'utf8')); } catch { return {}; }
}

export function saveLabelMemo(path, memo) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ labels: memo }));
    renameSync(tmp, path);
    return true;
  } catch { return false; }
}

/**
 * Build the ensure/heal pair over a persisted memo. `run(args, repo)` executes `gh` (throws on failure).
 *  - ensure(repo, name, meta): create the label unless memoised fresh. Memoise only when the create succeeded
 *    or the label already exists; any other failure is retried next time.
 *  - forget(repo, name): drop a memo entry (call on a not-found failure).
 */
export function createLabelEnsurer({ path, run, now = () => Date.now(), ttlMs = LABEL_MEMO_TTL_MS }) {
  const memo = loadLabelMemo(path);
  const persist = () => saveLabelMemo(path, memo);
  return {
    memo,
    ensure(repo, name, meta) {
      const key = labelMemoKey(repo, name);
      if (isLabelMemoFresh(memo, key, now(), ttlMs)) return false;
      try { run(['label', 'create', name, '--color', meta.color, '--description', meta.description], repo); }
      catch (err) { if (!isLabelAlreadyExistsError(err)) return true; }
      memo[key] = now();
      persist();
      return true;
    },
    forget(repo, name) {
      const key = labelMemoKey(repo, name);
      if (!(key in memo)) return;
      delete memo[key];
      persist();
    },
  };
}
