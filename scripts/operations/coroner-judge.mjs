/**
 * @file scripts/operations/coroner-judge.mjs
 * @description Rank extracted causes, judge coverage, and file explicit NEW causes through an injected
 * file-item port. Stable metric/cause keys survive changed evidence; callers persist state after each filing.
 * Defaults: five ranked causes, at most three cards. Invalid judgment files nothing and leaves retry owed.
 */
import { FENCED_DATA_RULE, fenceUntrusted } from '../lib/mandate-fence.mjs';

// Display text is untrusted even after schema validation. Only code emits structural lines.
const TRUNCATED = '[truncated; see coroner report]';
function heldText(value, limit) {
  let text = String(value ?? '').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/gu, ' ').trim();
  if (/^(?:\d+\.|Coroner key:|Fix idea:|Evidence:|Scope:|[#*+>_`~\-=])/i.test(text)) text = `\\${text}`;
  return text.length > limit ? `${text.slice(0, limit - TRUNCATED.length)}${TRUNCATED}` : text;
}

/** Pure held-list rendering: display fields are bounded; numbering and the ranked-key receipt are code-owned.
 * Truncated fields point the operator to the full extraction report rather than hiding the bound.
 */
export function renderHeldEntry({ title, count, minutes, examples, proposedFix, key }, { number, night }) {
  if (typeof key !== 'string' || !key || key !== key.trim() || key.length > 512 || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(key)) {
    throw new Error('invalid coroner filing key; run manual /coroner');
  }
  if (!Number.isSafeInteger(number) || number < 1 || !/^\d{4}-\d{2}-\d{2}$/.test(night)) {
    throw new Error('invalid coroner held numbering or night; run manual /coroner');
  }
  const refs = Array.isArray(examples) ? examples.slice(0, 10).map((example) => heldText(example?.ref, 300)) : [];
  if (examples?.length > 10) refs.push(TRUNCATED);
  const evidence = heldText(refs.join('; '), 3200);
  const measuredCount = Number.isFinite(count) && count >= 0 ? count : 'unknown';
  const measuredMinutes = Number.isFinite(minutes) && minutes >= 0 ? minutes : 'unknown';
  return `\n${number}. (coroner-${night}, held) **${heldText(title, 300)}.** Count: ${measuredCount}; minutes: ${measuredMinutes}.
    Fix idea: ${heldText(proposedFix, 1600)}
    Evidence: ${evidence}. Scope: we:scripts/. Size 3.
    Coroner key: ${key}`;
}

const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export function validateCoronerCoverage(coverage) {
  if (!record(coverage) || !(typeof coverage.held === 'string' || Array.isArray(coverage.held)) ||
    !Array.isArray(coverage.openPrs) || !Array.isArray(coverage.recentCards)) {
    throw new Error('coroner coverage incomplete or malformed; retry or run manual /coroner');
  }
}

const NON_CAUSE_KEYS = new Set(['notes', 'byKind', 'falseFindings', 'window', 'daemonErrors', 'mergeConflicts']);
export function rankFrictions(metrics, { topN = 5 } = {}) {
  const invalid = () => { throw new Error('coroner metrics incomplete or malformed; retry or run manual /coroner'); };
  if (!record(metrics) || !record(metrics.errorRates)) invalid();
  const rows = [];
  for (const [metric, value] of Object.entries(metrics.errorRates)) {
    if (NON_CAUSE_KEYS.has(metric) && !(record(value) && 'causes' in value)) continue; // extractor members that carry no cause table
    if (!record(value) || !record(value.causes)) invalid();
    for (const [cause, evidence] of Object.entries(value.causes)) {
      if (!record(evidence) || !Number.isFinite(evidence.count) || evidence.count < 0 || !Array.isArray(evidence.examples)) invalid();
      if (evidence.count === 0) continue;
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
      type: 'object', additionalProperties: false, required: ['key', 'verdict', 'coveredBy', 'proposedFix'], properties: {
        key: { type: 'string' }, verdict: { type: 'string', enum: ['NEW', 'COVERED-BY'] },
        coveredBy: { type: ['string', 'null'] },
        proposedFix: { type: 'string', description: 'For NEW, a non-empty concrete change to the daemon or tooling that handles the cause automatically. May be empty for COVERED-BY.' },
      },
    } },
  },
};

/** The whole answer is rejected on any invalid entry; omission is never inferred as NEW. */
export async function judgeFrictions({ ranked, held, openPrs, recentCards, judge, log = console.error }) {
  try {
    validateCoronerCoverage({ held, openPrs, recentCards });
    const answer = await judge({
      mandate: `${FENCED_DATA_RULE}\nUse only the supplied evidence. This judge runs with the tool-free provider (--tools ""); no tools are available. Compare each cause against held items, open PRs, then recent cards. Return NEW only for a concrete actionable cause with examples that no existing item would remove. For each NEW verdict, supply a non-empty proposedFix describing the concrete change to the daemon or tooling that handles the cause automatically. Otherwise return COVERED-BY with its reference (proposedFix may be empty), or omit uncertain candidates. Return only the requested schema.`,
      input: fenceUntrusted('material', JSON.stringify({ ranked, held, openPrs, recentCards })), shape: SHAPE,
    });
    const verdicts = answer?.value?.verdicts;
    if (!Array.isArray(verdicts) || verdicts.length > ranked.length) throw new Error('invalid judge verdicts');
    const keys = new Set(ranked.map((r) => r.key)), seen = new Set();
    for (const row of verdicts) {
      if (!row || !keys.has(row.key) || seen.has(row.key) || !['NEW', 'COVERED-BY'].includes(row.verdict) ||
        (row.verdict === 'NEW' && (typeof row.proposedFix !== 'string' || !row.proposedFix.trim())) ||
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
    const item = await fileItem({ key: row.key, count: row.count, minutes: row.minutes, examples: row.examples, title: `Coroner: ${row.metric} / ${row.cause}`, kind: 'story', size: '3',
      queue: 'false', proposedFix: matches[0].proposedFix, digest: `Recurring delivery friction: ${row.cause}. Count: ${row.count}; minutes: ${row.minutes ?? 'unknown'}. Evidence: ${JSON.stringify(row.examples)}.` });
    if (item?.limitReached === true) break; // The sink enforces the durable per-night bound under its append lock.
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
