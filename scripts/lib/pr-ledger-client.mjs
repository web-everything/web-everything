import { PR_EVENTS_DEFAULTS, classifyFeedHealth, resolvePrEventsConfig } from './pr-events.mjs';

const unavailable = reason => ({ ok: false, source: 'unavailable', fallback: 'github', reason });
const sameRepo = (a, b) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();

/** Read the complete projection; incomplete evidence always falls back to GitHub. */
export async function readLedgerPrs({
  repo, env = process.env, config, fetchImpl = globalThis.fetch,
  timeoutMs = PR_EVENTS_DEFAULTS.timeoutMs, staleAfterMs = PR_EVENTS_DEFAULTS.staleAfterMs,
  maxBytes = 16 * 1024 * 1024,
} = {}) {
  if (typeof repo !== 'string' || !repo.trim()) return unavailable('no-repo');
  let timer;
  const ac = new AbortController();
  try {
    const cfg = config ?? resolvePrEventsConfig(env);
    if (!cfg.enabled || !cfg.url || !cfg.token) return unavailable('not-configured');
    timer = setTimeout(() => ac.abort(), timeoutMs);
    const res = await fetchImpl(`${cfg.url.replace(/\/+$/, '')}/prs`, {
      headers: { authorization: `Bearer ${cfg.token}`, accept: 'application/json' }, signal: ac.signal,
    });
    if (!res.ok) {
      ac.abort();
      return unavailable(res.status === 401 || res.status === 403 ? 'unauthorized'
        : Number.isInteger(res.status) && res.status >= 100 && res.status <= 599 ? `http-${res.status}` : 'network');
    }
    const declaredSize = Number(res.headers.get('content-length'));
    if (declaredSize > maxBytes) {
      ac.abort();
      return unavailable('too-large');
    }
    const chunks = [];
    let size = 0;
    if (res.body) {
      const reader = res.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > maxBytes) {
            ac.abort();
            return unavailable('too-large');
          }
          chunks.push(Buffer.from(value));
        }
      } finally {
        reader.releaseLock();
      }
    }
    let body;
    try { body = JSON.parse(Buffer.concat(chunks, size).toString('utf8')); }
    catch { return unavailable('malformed'); }
    if (!body || typeof body !== 'object' || Array.isArray(body) || !Array.isArray(body.prs)) return unavailable('malformed');
    if (body.repo != null && !sameRepo(body.repo, repo)) return unavailable('wrong-repo');
    if (body.gap) return unavailable('gap');
    if (!Number.isSafeInteger(body.stateCursor) || body.stateCursor < 0) return unavailable('malformed');
    if (!Array.isArray(body.coverage?.bootstrap)
      || !body.coverage.bootstrap.some(entry => entry && sameRepo(entry.repo, repo) && entry.status === 'complete'
        && Number.isSafeInteger(entry.cursor) && entry.cursor <= body.stateCursor)) {
      return unavailable('coverage-gap');
    }
    const now = Date.now();
    const feedNow = body.now ?? now;
    if (!Number.isFinite(feedNow) || (body.lastDeliveryAt != null && !Number.isFinite(body.lastDeliveryAt))) return unavailable('malformed');
    // The Worker's own clock must agree with ours (5 min skew), or its `now` cannot vouch for freshness.
    if (Math.abs(feedNow - now) > 5 * 60_000) return unavailable('stale');
    // A delivery dated beyond the Worker's own clock (plus 60s skew) is not evidence of freshness.
    if (body.lastDeliveryAt != null && body.lastDeliveryAt > feedNow + 60_000) return unavailable('malformed');
    if (classifyFeedHealth({ lastOkAt: now, lastFailAt: null, lastDeliveryAt: body.lastDeliveryAt,
      now: feedNow, staleAfterMs }) !== 'healthy') return unavailable('stale');
    const prs = [];
    for (const row of body.prs) {
      // A row without a repository cannot safely be excluded from this listing.
      if (!row || typeof row.repo !== 'string') return unavailable('malformed');
      if (!sameRepo(row.repo, repo)) continue;
      if (row.state !== 'open' && row.state !== 'closed') return unavailable('malformed');
      if (row.state !== 'open') continue;
      if (!Number.isInteger(row.number) || row.number <= 0 || typeof row.sha !== 'string' || !row.sha.trim()
        || !Array.isArray(row.labels) || !row.labels.every(label => typeof label === 'string')
        || typeof row.draft !== 'boolean') return unavailable('malformed');
      if (prs.some(p => p.number === row.number)) return unavailable('malformed');
      prs.push({ number: row.number, headRefOid: row.sha, isDraft: row.draft,
        labels: row.labels.map(name => ({ name })) });
    }
    return { ok: true, source: 'ledger', repo, prs, stateCursor: body.stateCursor,
      lastDeliveryAt: body.lastDeliveryAt, ageMs: Math.max(0, feedNow - body.lastDeliveryAt) };
  } catch {
    return unavailable(ac.signal.aborted ? 'timeout' : 'network');
  } finally {
    clearTimeout(timer);
  }
}

/** Pure shadow diagnostic. Neither input is modified or used to drive the sweep. */
export function compareLedgerToGithub(githubPrs, ledger) {
  const result = { ok: false, agree: false, onlyGithub: [], onlyLedger: [], disagreements: [],
    savedListCalls: 0, fallbackReason: ledger?.reason ?? 'unavailable' };
  if (ledger?.ok !== true) return result;
  const dupes = list => list.map(pr => pr.number).filter((n, i, all) => all.indexOf(n) !== i);
  for (const number of new Set([...dupes(githubPrs), ...dupes(ledger.prs)])) result.disagreements.push({ number, reason: 'duplicate-row' });
  const github = new Map(githubPrs.map(pr => [pr.number, pr]));
  const projected = new Map(ledger.prs.map(pr => [pr.number, pr]));
  const labels = pr => JSON.stringify([...new Set(pr.labels.map(label => typeof label === 'string' ? label : label.name))].sort());
  for (const number of [...new Set([...github.keys(), ...projected.keys()])].sort((a, b) => a - b)) {
    const actual = github.get(number), expected = projected.get(number);
    let reason;
    if (result.disagreements.some(d => d.number === number)) continue;
    if (!expected) { result.onlyGithub.push(number); reason = 'missing-in-ledger'; }
    else if (!actual) { result.onlyLedger.push(number); reason = 'missing-in-github'; }
    else if (actual.headRefOid !== expected.headRefOid) reason = 'head-differs';
    else if (labels(actual) !== labels(expected)) reason = 'labels-differ';
    // Draft state is NOT compared: the GitHub list this pass reads does not carry it, so a comparison would be vacuous.
    if (reason) result.disagreements.push({ number, reason });
  }
  return { ...result, ok: true, agree: result.disagreements.length === 0, savedListCalls: 1, fallbackReason: null };
}

export function resolveLedgerMode(env = process.env) {
  const mode = env.WE_LABEL_SWEEP_LEDGER;
  if (mode === undefined) return { mode: 'shadow', source: 'default' };
  if (mode === 'off' || mode === 'shadow') return { mode, source: 'env' };
  return { mode: 'off', source: 'invalid' };
}
