/**
 * @file scripts/operations/coroner-judge.mjs
 * @description Rank extracted causes, judge coverage, and file explicit NEW causes through an injected
 * file-item port. Stable metric/cause keys survive changed evidence; callers persist state after each filing.
 * Defaults: five ranked causes, at most three cards. Invalid judgment files nothing and leaves retry owed.
 */
import { FENCED_DATA_RULE, fenceUntrusted } from '../lib/mandate-fence.mjs';

export function rankFrictions(metrics, { topN = 5 } = {}) {
  const rows = [];
  for (const [metric, value] of Object.entries(metrics?.errorRates ?? {})) {
    for (const [cause, evidence] of Object.entries(value?.causes ?? {})) {
      if (!evidence || !Number.isFinite(evidence.count) || evidence.count <= 0) continue;
      rows.push({ key: `${metric}:${cause}`, metric, cause, count: evidence.count,
        minutes: Number.isFinite(evidence.minutes) && evidence.minutes >= 0 ? evidence.minutes : null,
        examples: structuredClone(evidence.examples ?? []) });
    }
  }
  return rows.sort((a, b) => (b.minutes ?? -1) - (a.minutes ?? -1) || b.count - a.count ||
    (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)).slice(0, Number.isSafeInteger(topN) && topN >= 0 ? topN : 5);
}

const SHAPE = {
  type: 'object', additionalProperties: false, required: ['verdicts'], properties: {
    verdicts: { type: 'array', maxItems: 5, items: {
      type: 'object', additionalProperties: false, required: ['key', 'verdict', 'coveredBy'], properties: {
        key: { type: 'string' }, verdict: { type: 'string', enum: ['NEW', 'COVERED-BY'] },
        coveredBy: { type: ['string', 'null'] },
      },
    } },
  },
};

/** The whole answer is rejected on any invalid entry; omission is never inferred as NEW. */
export async function judgeFrictions({ ranked, held = [], openPrs = [], recentCards = [], judge, log = console.error }) {
  try {
    const answer = await judge({
      mandate: `${FENCED_DATA_RULE}\nUse only the supplied evidence; do not call tools. Compare each cause against held items, open PRs, then recent cards. Return NEW only for a concrete actionable cause with examples that no existing item would remove. Otherwise return COVERED-BY with its reference, or omit uncertain candidates. Return only the requested schema.`,
      input: fenceUntrusted('material', JSON.stringify({ ranked, held, openPrs, recentCards })), shape: SHAPE,
    });
    const verdicts = answer?.value?.verdicts;
    if (!Array.isArray(verdicts) || verdicts.length > ranked.length) throw new Error('invalid judge verdicts');
    const keys = new Set(ranked.map((r) => r.key)), seen = new Set();
    for (const row of verdicts) {
      if (!row || !keys.has(row.key) || seen.has(row.key) || !['NEW', 'COVERED-BY'].includes(row.verdict) ||
        (row.verdict === 'NEW' && row.coveredBy != null && row.coveredBy !== '') ||
        (row.verdict === 'COVERED-BY' && (typeof row.coveredBy !== 'string' || !row.coveredBy.trim()))) {
        throw new Error('invalid judge verdict entry');
      }
      seen.add(row.key);
    }
    return verdicts;
  } catch (e) { log(`coroner judge: ${String(e.message ?? e).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')}`); return []; }
}

export async function fileNewCards({ ranked, verdicts, state, fileItem, maxCards = 3, signal, save = () => {} }) {
  if (!Number.isSafeInteger(maxCards) || maxCards < 0) throw new Error('invalid coroner judge maxCards');
  state.filed ??= {};
  const filed = [], seen = new Set();
  for (const row of ranked) {
    if (filed.length >= maxCards) break;
    const matches = verdicts.filter((v) => v.key === row.key);
    if (!Array.isArray(row.examples) || !row.examples.length || !matches.length || matches.some((v) => v.verdict !== 'NEW') || seen.has(row.key) ||
      Object.hasOwn(state.filed, row.key)) continue;
    seen.add(row.key);
    signal?.throwIfAborted();
    // The sink must deduplicate by key: recovery after a failed save returns the same receipt.
    // Recovered receipts count toward this run's cap exactly like newly appended cards.
    const item = await fileItem({ key: row.key, examples: row.examples, title: `Coroner: ${row.metric} / ${row.cause}`, kind: 'story', size: '3',
      queue: 'false', digest: `Recurring delivery friction: ${row.cause}. Count: ${row.count}; minutes: ${row.minutes ?? 'unknown'}. Evidence: ${JSON.stringify(row.examples)}. Investigate the cause and implement an automatic prevention in the responsible tooling.` });
    if (!item || !(item.id || item.rel)) throw new Error('file-item returned no card receipt');
    state.filed[row.key] = item.id ?? item.rel;
    await save(state);
    filed.push({ key: row.key, item });
  }
  return filed;
}

export async function runCoronerJudge({ metrics, state = {}, log = console.error, ...io }) {
  const ranked = rankFrictions(metrics);
  let error = null;
  const verdicts = await judgeFrictions({ ranked, ...io, log: (message) => { error = message; log(message); } });
  io.signal?.throwIfAborted();
  if (error) return { ranked, verdicts, filed: [], error };
  const filed = await fileNewCards({ ranked, verdicts, state, ...io });
  return { ranked, verdicts, filed, error: null };
}
