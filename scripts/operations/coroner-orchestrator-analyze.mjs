/** Pure, bounded analysis of orchestrator transcript rows. */
import { redact } from './coroner-transcripts.mjs';

export const CORRECTION_PATTERNS = Object.freeze([
  /\bwhy\b/i, /\bdidn't we\b/i, /\bdid not we\b/i, /\byou could not\b/i,
  /\byou couldn't\b/i, /\bI thought\b/i, /\bcareful\b/i, /\bwrong\b/i,
  /\bnot what I\b/i, /\bwe ruled\b/i, /\bwe said\b/i, /\bagain\?/i, /\bstop\b/i,
]);
// Scheduled loop prompts are automation, even when recorded as ordinary user turns.
export const SCHEDULED_PROMPT_MARKERS = Object.freeze(['PR movement sweep']);
export const WRONG_PREMISE_PATTERN = /\b(?:wrong premise|false premise|premise (?:was|is) (?:slightly )?(?:off|wrong)|premise turned out to be wrong)\b/i;
// The skill's held-card coverage is judgment-only. No unverified card/R1 mapping.
export const ORCH_COVERED = Object.freeze({});
const TOKEN_KEYS = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'];
const inside = (at, w) => Date.parse(at) >= Date.parse(w.since) && Date.parse(at) < Date.parse(w.until);
const quote = (value) => redact(String(value ?? '').replace(/\/(?:Users|private)\/[^\s<>"'`]+/g, '<path>')).replace(/\s+/g, ' ').trim().slice(0, 160);
const asciiQuotes = (value) => String(value).replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
const words = (value) => new Set(asciiQuotes(value).toLowerCase().match(/[a-z0-9]+/g) ?? []);
const et = (at) => new Intl.DateTimeFormat('en-GB', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(at));
const tokens = () => Object.fromEntries(TOKEN_KEYS.map((k) => [k, 0]));
const text = (content) => typeof content === 'string' ? content : Array.isArray(content)
  ? content.filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('\n') : '';
const realUser = (s) => s.trim() && !/^\s*(?:<|Caveat:)/im.test(s);

/** Project one raw row to small facts, scrubbing before anything is retained. */
function fact(row, agentTools = new Set(), digest = []) {
  if (!row || row.type === 'queue-operation' || !Number.isFinite(Date.parse(row.timestamp))) return null;
  const content = row.message?.content ?? row.content;
  const body = text(content);
  const compact = row.type === 'system' && row.subtype === 'compact_boundary'
    || row.isCompactSummary === true || /^This session is being continued from a previous conversation/.test(body);
  const userBody = typeof content === 'string' ? (realUser(content) ? content : '')
    : Array.isArray(content) ? content.filter((b) => b?.type === 'text' && realUser(b.text ?? '')).map((b) => b.text).join('\n') : '';
  const notification = row.type === 'user' && /<task-notification\b/i.test(body);
  const scheduled = row.isMeta === true || SCHEDULED_PROMPT_MARKERS.some((marker) => body.trimStart().startsWith(marker));
  const user = row.type === 'user' && !compact && !notification && !scheduled && !!userBody;
  const assistant = row.type === 'assistant';
  const blocks = Array.isArray(content) ? content : [];
  const last = blocks.filter((b) => b?.type === 'text').at(-1)?.text ?? body;
  if (assistant) for (const b of blocks) {
    if (b?.type === 'tool_use' && /^(?:Agent|Task)$/.test(b.name) && b.id) agentTools.add(b.id);
  }
  const results = notification ? [...body.matchAll(/<task-notification\b[^>]*>([\s\S]*?)<\/task-notification>/gi)]
    .flatMap((m) => [...m[1].matchAll(/<result\b[^>]*>([\s\S]*?)<\/result>/gi)].map((r) => r[1])) : [];
  if (row.type === 'user') for (const b of blocks) {
    if (b?.type === 'tool_result' && agentTools.delete(b.tool_use_id)) results.push(text(b.content));
  }
  const wrong = results.find((s) => WRONG_PREMISE_PATTERN.test(s));
  if (!compact && !user && !assistant && !wrong) return null;
  return {
    at: new Date(row.timestamp).toISOString(), role: assistant ? 'assistant' : user ? 'user' : 'other',
    text: quote(assistant ? last : user ? userBody : ''), compact: !!compact,
    correction: !!user && CORRECTION_PATTERNS.some((p) => p.test(asciiQuotes(userBody))),
    digestIds: user ? matchRulings(userBody, digest) : [],
    wrong: wrong ? quote(wrong) : '', id: row.message?.id,
    usage: assistant && row.message?.usage ? Object.fromEntries(TOKEN_KEYS.map((k) => [k, Number(row.message.usage[k]) || 0])) : null,
  };
}

function matchRulings(body, digest) {
  const ws = words(body), ids = new Set(body.match(/\bR\d+\b/g) ?? []);
  for (const r of digest) {
    const rw = words(r.quote ?? r.rule ?? r.text ?? '');
    const shared = [...rw].filter((w) => ws.has(w)).length;
    if (shared >= 4 && shared / rw.size >= 0.6) ids.add(r.id);
  }
  return [...ids].sort();
}

function rulings(digestIds) {
  const list = Array.isArray(digestIds) ? digestIds : Object.entries(digestIds ?? {}).map(([id, value]) => typeof value === 'string' ? { id, quote: value } : { ...value, id });
  return list.map((r) => typeof r === 'string' ? { id: r, quote: '' } : r).filter((r) => /^R\d+$/.test(r?.id));
}

function frictions(report, coveredBy) {
  const groups = {
    'operator-correction': report.corrections.map((c) => c.quote),
    'ruling-miss': report.corrections.flatMap((c) => c.digestIds.map(() => c.quote)),
    'wasted-turn': report.wastedTurns.filter((t) => t.kind === 'corrected-claim').map((t) => t.quote),
    'wrong-premise-stop': report.wastedTurns.filter((t) => t.kind === 'wrong-premise').map((t) => t.quote),
    'lost-after-compaction': report.compactions.flatMap((c) => c.correctionsAfter),
  };
  return Object.entries(groups).filter(([, xs]) => xs.length).map(([kind, xs]) => ({
    kind, count: kind === 'lost-after-compaction' ? report.lostAfterCompaction : xs.length, examples: [...new Set(xs.map(quote))].slice(0, 3),
    status: 'UNJUDGED',
    ...(/^R\d+$/.test(coveredBy[kind]) ? { candidateCoveredBy: coveredBy[kind] } : {}),
  })).sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind));
}

function finish(report, coveredBy) {
  const misses = new Map();
  // TODO: switch these digest mentions/matches to rulings-check findings once available.
  for (const c of report.corrections) for (const id of c.digestIds) {
    if (!misses.has(id)) misses.set(id, { id, count: 0, at: [] });
    const m = misses.get(id); m.count++; m.at.push(c.at);
  }
  report.rulingMisses = [...misses.values()].sort((a, b) => a.id.localeCompare(b.id));
  report.lostAfterCompaction = new Set(report.compactions.flatMap((c) => c.correctionIndices)).size;
  report.compactions = report.compactions.map(({ correctionIndices, registered, ...c }) => c);
  report.frictions = frictions(report, coveredBy);
  return report;
}

const FACT_CAPS = { corrections: 100, wastedTurns: 100, compactions: 50 };
function retain(report, key, value) {
  report[key].push(value);
  if (report[key].length > FACT_CAPS[key]) {
    report[key].shift(); report.dropped[key]++;
  }
}
function emptyReport() {
  return { corrections: [], rulingMisses: [], wastedTurns: [], tokens: tokens(), compactions: [],
    dropped: { corrections: 0, wastedTurns: 0, compactions: 0 }, truncated: false };
}

/** Pure analysis of raw synthetic rows or the collector's compact facts, in transcript order. */
function createAnalyzer({ window, digestIds = [], coveredBy = ORCH_COVERED, compactWindowTurns = 6 }) {
  const report = emptyReport();
  const digest = rulings(digestIds), seenUsage = new Map(), agentTools = new Set();
  let prior = '', userIndex = 0, correctionIndex = 0;
  const boundaries = [];
  function consume(raw) {
    const t = raw?.role ? raw : fact(raw, agentTools, digest);
    if (!t) return;
    const inWindow = inside(t.at, window);
    if (t.compact) {
      const c = { at: t.at, atEt: et(t.at), correctionsAfter: [], correctionIndices: [], userIndex };
      boundaries.push(c);
      if (boundaries.length > 50) boundaries.shift();
      if (inWindow) { retain(report, 'compactions', c); c.registered = true; }
      prior = '';
    }
    if (t.role === 'assistant') {
      if (t.text) prior = quote(t.text);
      if (inWindow && t.usage) {
        // Streamed copies can carry cumulative usage; retain the maximum per field per message.
        const previous = t.id ? seenUsage.get(t.id) ?? tokens() : tokens();
        const next = Object.fromEntries(TOKEN_KEYS.map((k) => [k, Math.max(previous[k], Number(t.usage[k]) || 0)]));
        for (const k of TOKEN_KEYS) report.tokens[k] += next[k] - previous[k];
        if (t.id) seenUsage.set(t.id, next);
      }
    }
    if (inWindow && t.wrong) retain(report, 'wastedTurns', { at: t.at, atEt: et(t.at), kind: 'wrong-premise', quote: quote(t.wrong) });
    if (t.role !== 'user') return;
    userIndex++;
    if (inWindow && (t.correction ?? CORRECTION_PATTERNS.some((p) => p.test(t.text)))) {
      const q = quote(t.text);
      const c = { at: t.at, atEt: et(t.at), quote: q, priorClaim: prior, digestIds: t.digestIds ?? matchRulings(t.text, digest) };
      const index = correctionIndex++;
      retain(report, 'corrections', c);
      if (prior) retain(report, 'wastedTurns', { at: t.at, atEt: et(t.at), kind: 'corrected-claim', quote: prior });
      for (const b of boundaries) if (userIndex - b.userIndex <= compactWindowTurns) {
        b.correctionsAfter.push(q); b.correctionIndices.push(index);
        if (!b.registered) { retain(report, 'compactions', b); b.registered = true; }
      }
    }
    // A second user turn without an intervening assistant claim cannot waste the same claim twice.
    prior = '';
    while (boundaries.length && userIndex - boundaries[0].userIndex >= compactWindowTurns) boundaries.shift();
  }
  return { consume, finish() {
    report.tokensPerOutcome = outcomeReport(report.tokens, null, 0);
    return finish(report, coveredBy);
  } };
}

export function analyzeOrchestratorTurns(turns, options) {
  const analyzer = createAnalyzer(options);
  for (const turn of turns) analyzer.consume(turn);
  return analyzer.finish();
}

function outcomeReport(t, mergedPrs, loadedFixes) {
  const outcomes = (mergedPrs ?? 0) + loadedFixes;
  return { tokens: t, mergedPrs, loadedFixes, tokensPerOutcome: Object.values(t).reduce((a, b) => a + b, 0) / Math.max(1, outcomes), outcomes, outcomesPartial: mergedPrs === null };
}

export { TOKEN_KEYS, FACT_CAPS, inside, asciiQuotes, rulings, frictions, emptyReport, createAnalyzer };
