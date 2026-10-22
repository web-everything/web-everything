/** Streaming main-session facts. Never retain raw transcript rows or oversized lines. */
import fs from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONSTELLATION_REPOS } from '../lib/constellation-repos.mjs';
import { workspaceOf } from '../lib/automation-home.mjs';
import { ORCH_COVERED, TOKEN_KEYS, FACT_CAPS, inside, asciiQuotes, rulings, frictions, emptyReport, createAnalyzer } from './coroner-orchestrator-analyze.mjs';
export { CORRECTION_PATTERNS, SCHEDULED_PROMPT_MARKERS, WRONG_PREMISE_PATTERN, ORCH_COVERED, analyzeOrchestratorTurns } from './coroner-orchestrator-analyze.mjs';

const COVERAGE_PATTERNS = {
  'operator-correction': /operator.correction|push.?back/i,
  'ruling-miss': /rulings-check|digest/i,
  'wasted-turn': /wasted.turn|corrected.claim/i,
  'wrong-premise-stop': /wrong.premise|prototype.first|prototype.*load/i,
  'lost-after-compaction': /compact|rulings-inject|digest/i,
};
const MAX_LINE = 4 * 1024 * 1024;
const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };

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
