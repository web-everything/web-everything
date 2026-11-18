/** Bounded, ordered reads and barrier-separated enqueue preparation. No GitHub or git IO. */
export async function mapWithConcurrency(items, limit, fn) {
  const list = Array.isArray(items) ? items : [...items];
  const results = new Array(list.length);
  const width = Math.max(1, Math.min(Math.trunc(limit) || 1, list.length || 1));
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < list.length; i = next++) results[i] = await fn(list[i], i);
  };
  await Promise.all(Array.from({ length: width }, worker));
  return results;
}

/** Conservative eligibility: unknown or potentially branch-writing paths stay serial. */
export function canParallelEnqueue(c, { enqueues = false, numbering = false, mayRefresh = false, coupled = false } = {}) {
  return enqueues && !numbering && !mayRefresh && !coupled && !c.rebaseDrop;
}

/** An approved-head hold avoids rebasing; pending cards still need numbering before enqueue. */
export function shouldPrepareBranchBeforeEnqueue({ required, enqueues }) {
  return Boolean(required && enqueues);
}

/** Skip branch preparation only when the entire pinned tree is proven free of pending cards. A miss stays serial. */
export function createBranchPreparationRequired({ enabled, serial, readFiles, hasPendingCards }) {
  const memo = new Map();
  return c => {
    if (!enabled) return false;
    if (serial) return true;
    const sha = c.listedHeadSha || c.headSha;
    if (!sha || !/^[a-f0-9]{40}$/i.test(sha)) return true;
    const key = `${c.repo || 'cwd'}:${sha}`;
    if (!memo.has(key)) {
      try { memo.set(key, hasPendingCards(readFiles(c, sha))); }
      catch { memo.set(key, true); }
    }
    return memo.get(key);
  };
}

/**
 * Run consecutive eligible candidates in a bounded pool. A serial candidate is a barrier: drain the pool,
 * run it alone, then admit the next batch. Width 1 uses the original sequential execution order.
 * An individual failure is reported without cancelling siblings or subsequent serial candidates.
 */
export async function runEnqueueCandidates(candidates, { concurrency = 1, canParallel, run, onError = () => {} }) {
  const attempt = async c => {
    try { await run(c); }
    catch (e) { onError(c, e); }
  };
  let batch = [];
  const flush = async () => {
    await mapWithConcurrency(batch, concurrency, attempt);
    batch = [];
  };
  for (const c of candidates) {
    if (concurrency === 1 || !canParallel(c)) {
      await flush();
      await attempt(c);
    } else batch.push(c);
  }
  await flush();
}

export function formatConcurrencySources(policy) {
  return ['gateReads', 'enqueue'].map(key =>
    `concurrency.${key}=${policy.concurrency[key]} (${policy.sources?.[`concurrency.${key}`] ?? 'standard'})`).join(', ');
}
