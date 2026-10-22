/** Streaming main-session facts. Never retain raw transcript rows or oversized lines. */
import fs from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { redact } from './coroner-transcripts.mjs';
import { CONSTELLATION_REPOS } from '../lib/constellation-repos.mjs';
import { workspaceOf } from '../lib/automation-home.mjs';

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
const COVERAGE_PATTERNS = {
  'operator-correction': /operator.correction|push.?back/i,
  'ruling-miss': /rulings-check|digest/i,
  'wasted-turn': /wasted.turn|corrected.claim/i,
  'wrong-premise-stop': /wrong.premise|prototype.first|prototype.*load/i,
  'lost-after-compaction': /compact|rulings-inject|digest/i,
};
const MAX_LINE = 4 * 1024 * 1024;
const TOKEN_KEYS = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'];
const inside = (at, w) => Date.parse(at) >= Date.parse(w.since) && Date.parse(at) < Date.parse(w.until);
const quote = (value) => redact(String(value ?? '').replace(/\/(?:Users|private)\/[^\s<>"'`]+/g, '<path>')).replace(/\s+/g, ' ').trim().slice(0, 160);
const asciiQuotes = (value) => String(value).replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
const words = (value) => new Set(asciiQuotes(value).toLowerCase().match(/[a-z0-9]+/g) ?? []);
const et = (at) => new Intl.DateTimeFormat('en-GB', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(at));
const tokens = () => Object.fromEntries(TOKEN_KEYS.map((k) => [k, 0]));
const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };
const text = (content) => typeof content === 'string' ? content : Array.isArray(content)
  ? content.filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('\n') : '';
const realUser = (s) => s.trim() && !/^\s*(?:<|Caveat:)/im.test(s);

/** Chunk reader caps retained bytes even for a single enormous, unterminated line. */
async function* lines(file, io, budget) {
  if (budget?.remaining === 0) return;
  let chunks = [], size = 0, skipping = false;
  for await (const chunk of io.createReadStream(file, { highWaterMark: 64 * 1024, ...(budget ? { end: budget.remaining - 1 } : {}) })) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (budget) { budget.remaining -= buf.length; budget.read += buf.length; }
    let start = 0;
    while (start < buf.length) {
      const end = buf.indexOf(10, start), stop = end < 0 ? buf.length : end;
      const piece = buf.subarray(start, stop);
      if (!skipping) {
        size += piece.length;
        if (size > MAX_LINE) { chunks = []; skipping = true; }
        else chunks.push(piece);
      }
      if (end < 0) break;
      if (!skipping) yield Buffer.concat(chunks, size).toString('utf8');
      chunks = []; size = 0; skipping = false; start = end + 1;
    }
  }
  if (size && !skipping && (!budget || budget.remaining > 0)) yield Buffer.concat(chunks, size).toString('utf8');
}

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

async function loadDigest(file, io) {
  let source;
  try { source = io.readFileSync(file, 'utf8'); } catch { return []; }
  try {
    // Computed specifier: the digest module may be absent on this branch, and a literal import would fail at bundle time.
    const { parseDigest } = await import(/* @vite-ignore */ new URL('../lib/rulings-digest.mjs', import.meta.url).href);
    const parsed = parseDigest(source);
    return rulings(parsed.rulings ?? parsed.entries ?? parsed);
  } catch { /* Optional parser is absent in older checkouts; accept simple digest lines. */ }
  return source.split('\n').flatMap((line) => {
    if (/^\s*#/.test(line)) return [];
    const cells = line.trim().replace(/^\|\s*|\s*\|$/g, '').split('|').map((c) => c.trim());
    const [id] = cells;
    if (!/^R\d+$/.test(id)) return [];
    // Current format: Rn | date | class | "quote" | rule. Also accept older three-cell digests.
    const dated = cells.length >= 5;
    return [{ id, class: cells[dated ? 2 : 1] ?? '', rule: dated ? cells.slice(4).join(' | ') : cells[2] ?? '',
      quote: asciiQuotes(cells[dated ? 3 : 2] ?? '').replace(/^["']|["']$/g, '') }];
  });
}

function coverage(digest) {
  const out = { ...ORCH_COVERED };
  for (const r of [...digest].sort((a, b) => a.id.localeCompare(b.id))) {
    if (!/^S:/.test(r.class ?? '')) continue;
    for (const [kind, pattern] of Object.entries(COVERAGE_PATTERNS)) {
      if (!out[kind] && pattern.test(`${r.class} ${r.rule ?? r.quote ?? ''}`)) out[kind] = r.id;
    }
  }
  return out;
}

function children(dir, io) { try { return io.readdirSync(dir).sort(); } catch { return []; } }

async function loadedFixes(window, { env, home, io }) {
  const dir = env.HEALTH_WATCH_SELF_SYNC_DIR || join(home, '.claude/daemon-self-sync-state');
  const adopted = new Set();
  for (const name of children(dir, io).filter((n) => n.endsWith('.rebuild.json'))) {
    try {
      const adoption = JSON.parse(io.readFileSync(join(dir, name), 'utf8')).adopted;
      if (inside(adoption?.at, window)) for (const a of adoption.applied ?? []) {
        if (typeof a.sha === 'string' && a.sha.length >= 7) adopted.add(a.sha);
      }
    } catch { /* Missing/malformed state. */ }
  }
  const loaded = new Set();
  try {
    for await (const line of lines(env.FIX_READY_STORE || join(home, 'workspace/.operations/coordination/fix-ready.jsonl'), io)) {
      const r = parse(line);
      if (typeof r?.sha === 'string' && r.sha.length >= 7
        && [...adopted].some((sha) => sha.startsWith(r.sha) || r.sha.startsWith(sha))) loaded.add(r.sha);
    }
  } catch { /* Store may not exist. */ }
  return loaded.size;
}

function outcomeReport(t, mergedPrs, loadedFixes) {
  const outcomes = (mergedPrs ?? 0) + loadedFixes;
  return { tokens: t, mergedPrs, loadedFixes, tokensPerOutcome: Object.values(t).reduce((a, b) => a + b, 0) / Math.max(1, outcomes), outcomes, outcomesPartial: mergedPrs === null };
}

export async function collectOrchestratorSessions(window, { env = process.env, home = homedir(), sessionId, io = fs, gh = null } = {}) {
  if (env.WE_CORONER_NO_ORCH) return null;
  if (sessionId !== undefined && !/^[\w-]+$/.test(sessionId)) throw new Error('invalid orchestrator session id');
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  // The orchestrator's own chats run in the PRIMARY checkout (e.g. ~/workspace/webeverything), not in the lane or
  // daemon clone this script may run from, so look under every known checkout name of this repo, plus REPO_ROOT.
  const projects = env.WE_CORONER_PROJECTS || join(home, '.claude/projects');
  const workspace = workspaceOf(repo);
  const dirs = env.WE_CORONER_ORCH_DIR ? [env.WE_CORONER_ORCH_DIR]
    : [...new Set([...CONSTELLATION_REPOS.we.dirs.map((d) => join(workspace, d)), repo].map((p) => join(projects, p.replaceAll('/', '-'))))];
  const digest = await loadDigest(env.RULINGS_DIGEST_PATH || join(home, 'workspace/.operations/handoff/rulings.md'), io);
  const coveredBy = coverage(digest), sessions = [], errors = [];
  const recordError = (file, error) => errors.push({ file: basename(file), code: error.code ?? 'UNKNOWN' });
  const files = dirs.flatMap((dir) => (sessionId ? [`${sessionId}.jsonl`] : children(dir, io).filter((n) => n.endsWith('.jsonl'))).map((n) => join(dir, n)));
  const cap = (value, fallback) => /^\d+$/.test(value ?? '') && Number.isSafeInteger(Number(value)) ? Number(value) : fallback;
  const fileCap = cap(env.WE_CORONER_ORCH_FILE_CAP, 1024 ** 3);
  let remaining = cap(env.WE_CORONER_ORCH_TOTAL_CAP, 2 * 1024 ** 3);
  for (const file of files) {
    const name = file.slice(file.lastIndexOf('/') + 1);
    try {
      const stat = io.statSync(file);
      if (!stat.isFile() || stat.mtimeMs < Date.parse(window.since)) continue;
    } catch (error) {
      if (!(sessionId !== undefined && error.code === 'ENOENT')) recordError(file, error);
      continue;
    }
    const analyzer = createAnalyzer({ window, digestIds: digest, coveredBy });
    const budget = { remaining: Math.min(fileCap, remaining), read: 0 };
    // Feed facts directly: the analyzer keeps only the preceding assistant claim and bounded evidence.
    try { for await (const line of lines(file, io, budget)) analyzer.consume(parse(line)); }
    catch (error) { recordError(file, error); remaining -= budget.read; continue; }
    remaining -= budget.read;
    const report = analyzer.finish();
    report.truncated = budget.remaining === 0;
    sessions.push({ id: name.slice(0, -6), ...report });
  }
  let mergedPrs = null;
  // One bounded search includes PRs opened before the window.
  if (!env.WE_CORONER_NO_CI && gh) {
    try {
      const prs = await gh(['pr', 'list', '--repo', CONSTELLATION_REPOS.we.slug, '--state', 'merged', '--search', `merged:${window.since}..${window.until}`, '--limit', '1000', '--json', 'number,mergedAt']);
      if (Array.isArray(prs)) mergedPrs = new Set(prs.filter((p) => inside(p.mergedAt, window)).map((p) => p.number)).size;
    } catch { /* Unavailable is null, never a false zero. */ }
  }
  const fixes = await loadedFixes(window, { env, home, io });
  const total = { ...emptyReport(), lostAfterCompaction: 0 };
  for (const s of sessions) {
    for (const key of Object.keys(FACT_CAPS)) {
      total[key].push(...s[key]);
      total[key].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
      const excess = Math.max(0, total[key].length - FACT_CAPS[key]);
      total[key].splice(0, excess);
      total.dropped[key] += s.dropped[key] + excess;
    }
    total.truncated ||= s.truncated;
    total.lostAfterCompaction += s.lostAfterCompaction;
    for (const k of TOKEN_KEYS) total.tokens[k] += s.tokens[k];
    s.tokensPerOutcome = outcomeReport(s.tokens, mergedPrs, fixes);
  }
  const misses = new Map();
  for (const c of total.corrections) for (const id of c.digestIds) {
    if (!misses.has(id)) misses.set(id, { id, count: 0, at: [] });
    const m = misses.get(id); m.count++; m.at.push(c.at);
  }
  total.rulingMisses = [...misses.values()].sort((a, b) => a.id.localeCompare(b.id));
  total.tokensPerOutcome = outcomeReport(total.tokens, mergedPrs, fixes);
  total.frictions = frictions(total, coveredBy);
  return { sessions, totals: total, frictions: total.frictions, errors, partial: errors.length > 0 };
}
