#!/usr/bin/env node
/** Deterministic conveyor post-mortem. Untimestamped daemon counts describe bounded tails,
 * not necessarily the requested window. Admission ledgers are also bounded (8 MiB each).
 * Percentiles use nearest rank: sorted[ceil(p * n) - 1]; empty populations report zero.
 * Missing gate results have no inferred duration. Overlapping gates are summed; share is capped at 1.
 * errorRates is the first output key. WE_CORONER_COORD (build-dispatch log), WE_CORONER_BUILD_TAIL (tick-row tail bytes) and
 * WE_CORONER_NO_CI (skip gh) are the extra knobs; the gh read is bounded to 5 run pages and 40 job lookups.
 */
import fs from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { LOG_TIMESTAMP_RE, expandRepeatedLines, stripLogTimestamp } from '../lib/log-timestamp.mjs';

const MiB = 1024 * 1024;
const MAX_LINE = 256 * 1024;
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const round = (n, digits = 1) => Number(n.toFixed(digits));
const minutes = (ms) => round(ms / 60000);
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const stamp = (v) => typeof v === 'string' ? Date.parse(v) : NaN;
const elapsed = (end, start) => Number.isFinite(stamp(end) - stamp(start)) ? Math.max(0, stamp(end) - stamp(start)) : 0;
const ordered = (map) => Object.fromEntries([...map].sort(([a], [b]) => compare(a, b)));
const add = (map, key, amount = 1) => map.set(key, (map.get(key) ?? 0) + amount);
const inWindow = (at, window) => stamp(at) >= stamp(window.since) && stamp(at) < stamp(window.until);
const json = (text) => { try { return JSON.parse(text); } catch { return null; } };
const rows = (lines) => lines.map(json).filter((x) => x && typeof x === 'object' && !Array.isArray(x));
const positive = (v, fallback) => Number.isSafeInteger(Number(v)) && Number(v) > 0 ? Number(v) : fallback;
const textOf = (content) => typeof content === 'string' ? content : Array.isArray(content) ? content.map((x) => typeof x?.text === 'string' ? x.text : '').join('\n') : '';

export function percentile(values, p) {
  return values.length ? [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(p * values.length) - 1)] : 0;
}

export const DENIAL_TYPES = Object.freeze([
  { type: 'hook-blocked', pattern: /hook|blocked/i },
  { type: 'classifier-denied', pattern: /classifier|auto mode|not allowed by/i },
  { type: 'user-denied', pattern: /permission to use|doesn't want/i },
  { type: 'refusing', pattern: /refusing/i },
]);
const denialPattern = /blocked|refusing|denied|permission to use|doesn't want|not allowed by/i;
const denialPrefix = /^(?:\W*)(?:Blocked\b|Refusing\b|Permission to use|The user doesn't want|Error: .{0,40}denied|.{0,40}(?:was denied|not allowed by|Hook .* blocked|PreToolUse.*(?:denied|blocked)))/i;
export function classifyDenial(text, isError = false) {
  const prefix = text.trim().slice(0, 300);
  if (!(isError ? denialPattern : denialPrefix).test(prefix)) return null;
  return DENIAL_TYPES.find(({ pattern }) => pattern.test(prefix))?.type ?? 'other';
}

/** Conservative literal shell scan, following agent-usage-report's lexer: quoted prose,
 * comments and heredoc bodies are not executable positions. No shell evaluation.
 */
function shellCommands(source) {
  const commands = [];
  let words = [], word = '', started = false, quote = null, heredocs = [], delimiter = false;
  const flushWord = () => {
    if (!started) return;
    if (delimiter) { heredocs.push(word); delimiter = false; }
    else words.push(word);
    word = ''; started = false;
  };
  const flushCommand = () => { flushWord(); if (words.length) commands.push(words); words = []; };
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === '\\' && quote !== "'") {
      if (source[i + 1] === '\n') { i++; continue; }
      word += source[++i] ?? ''; started = true; continue;
    }
    if (quote) {
      if (c === quote) quote = null;
      else word += c;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; started = true; continue; }
    if (c === '#' && !started) { while (i < source.length && source[i] !== '\n') i++; i--; continue; }
    if (c === '<' && source.slice(i, i + 2) === '<<' && source[i + 2] !== '<') {
      flushWord(); delimiter = true; i++; if (source[i + 1] === '-') i++; continue;
    }
    if (c === '\n') {
      flushCommand();
      for (const end of heredocs) {
        let found = false;
        while (i < source.length) {
          const next = source.indexOf('\n', i + 1);
          const stop = next < 0 ? source.length : next;
          const body = source.slice(i + 1, stop).replace(/^\t+/, '');
          i = stop;
          if (body === end) { found = true; break; }
        }
        if (!found) break;
      }
      heredocs = []; continue;
    }
    if (';&|()'.includes(c)) { flushCommand(); continue; }
    if (c === '<' || c === '>') {
      // Redirections end argv; their targets are never command positions.
      flushWord(); words.push('__redirect__'); continue;
    }
    if (/\s/.test(c)) { flushWord(); continue; }
    word += c; started = true;
  }
  if (!quote) flushCommand(); // Incomplete quoted commands are not evidence of execution.
  return commands;
}

function gateKinds(command) {
  const kinds = new Set();
  const base = (x) => x?.split('/').at(-1);
  for (const words of shellCommands(command)) {
    const args = [...words];
    while (args.length) {
      if (/^[A-Za-z_][\w]*=/.test(args[0]) || ['env', 'command', 'exec'].includes(args[0])) { args.shift(); continue; }
      if (base(args[0]) === 'timeout' && /^\d+(?:\.\d+)?[smhd]?$/.test(args[1] ?? '')) { args.splice(0, 2); continue; }
      if (['node', 'nodejs'].includes(base(args[0]))) { args.shift(); continue; }
      // Admission wraps a real direct invocation; it is not verify-lane.
      if (base(args[0]) === 'heavy-admission.mjs' && args[1] === 'run' && args[2] === '--') { args.splice(0, 3); continue; }
      break;
    }
    if (base(args[0]) === 'verify-lane.mjs') kinds.add('verifyLane');
    if (base(args[0]) === 'npx') args.shift();
    if (base(args[0]) === 'vitest' && /^(run|related)$/.test(args[1] ?? '')) kinds.add('directVitest');
    if (base(args[0]) === 'npm' && args[1] === 'run' && /^(test:unit|check:standards)$/.test(args[2] ?? '')) kinds.add('other');
  }
  if (kinds.has('verifyLane')) kinds.delete('directVitest');
  return kinds;
}
export const normalizeCommand = (command) => command.replace(/\s+/g, ' ').trim().slice(0, 200);

/** IO: positional chunk reads, strictly <= cap bytes, with bounded line buffering.
 * Head/tail windows never splice partial records together. Oversized lines are discarded.
 */
export function readBounded(file, { cap = 8 * MiB, tailOnly = false, io = fs, maxLine = MAX_LINE } = {}) {
  let fd, bytesRead = 0;
  const lines = [];
  let truncated = false;
  try {
    fd = io.openSync(file, 'r');
    const size = io.fstatSync(fd).size;
    if (!io.fstatSync(fd).isFile()) return { lines, bytesRead, truncated, found: false };
    cap = positive(cap, 8 * MiB);
    truncated = size > cap;
    const head = Math.ceil(cap / 2), tail = Math.floor(cap / 2);
    const windows = !truncated ? [[0, size]] : tailOnly ? [[size - cap, cap]] : [[0, head], [size - tail, tail]];
    const buffer = Buffer.alloc(Math.min(64 * 1024, cap));
    for (const [start, length] of windows) {
      let parts = [], lineBytes = 0, skip = start > 0;
      const emit = () => { if (!skip && lineBytes) lines.push(Buffer.concat(parts).toString('utf8')); parts = []; lineBytes = 0; skip = false; };
      for (let offset = 0; offset < length;) {
        const n = io.readSync(fd, buffer, 0, Math.min(buffer.length, length - offset), start + offset);
        if (!n) break;
        bytesRead += n; offset += n;
        let from = 0;
        for (let i = 0; i <= n; i++) {
          if (i !== n && buffer[i] !== 10) continue;
          if (!skip) {
            lineBytes += i - from;
            if (lineBytes > maxLine) { skip = true; parts = []; }
            else parts.push(Buffer.from(buffer.subarray(from, i)));
          }
          if (i < n) emit();
          from = i + 1;
        }
      }
      if (start + length === size) emit();
    }
    return { lines, bytesRead, truncated, found: true };
  } catch { return { lines, bytesRead, truncated, found: false }; }
  finally { if (fd !== undefined) io.closeSync(fd); }
}

export function parseTranscript(entries) {
  const uses = new Map(), results = new Map(), commands = [], denials = new Map();
  let outcomeLine = '';
  for (const row of entries) {
    const content = Array.isArray(row.message?.content) ? row.message.content : [];
    for (const block of content) {
      if (row.type === 'assistant' && block?.type === 'text' && typeof block.text === 'string') outcomeLine = block.text.replace(/\s+/g, ' ').trim().slice(0, 160);
      if (row.type === 'assistant' && block?.type === 'tool_use' && block.name === 'Bash' && typeof block.input?.command === 'string' && !uses.has(block.id)) {
        const command = block.input.command;
        uses.set(block.id, { command, timestamp: row.timestamp });
        commands.push(normalizeCommand(command));
      }
      if (row.type === 'user' && block?.type === 'tool_result' && !results.has(block.tool_use_id)) {
        const text = textOf(block.content);
        results.set(block.tool_use_id, { text, timestamp: row.timestamp });
        const type = classifyDenial(text, block.is_error === true);
        if (type) add(denials, type);
      }
    }
  }
  const gates = [];
  for (const [id, use] of uses) {
    const kinds = gateKinds(use.command);
    if (!kinds.size) continue;
    const result = results.get(id);
    const ms = result && Number.isFinite(stamp(result.timestamp)) && Number.isFinite(stamp(use.timestamp)) ? elapsed(result.timestamp, use.timestamp) : null;
    // lane-verify.mjs emits { status: 'timeout', reason: 'wait-timeout' };
    // match the reason token as well as older textual timeout reports.
    gates.push({ ms, at: use.timestamp, kinds: [...kinds], waitTimeout: /wait-timeout|timed out waiting|wait ceiling/i.test(result?.text ?? '') });
  }
  const counts = new Map();
  for (const command of commands) add(counts, command);
  return { commands, gates, denials: ordered(denials), loops: [...counts].filter(([, count]) => count >= 3).map(([command, count]) => ({ command, count })), outcomeLine };
}

export function parseMarkers(lines) {
  const whole = json(lines.join('\n'));
  const candidates = whole ? (Array.isArray(whole) ? whole : [whole]) : rows(lines);
  return candidates.filter((x) => x && typeof x === 'object' && !Array.isArray(x));
}

export function sessionOutcome(state) {
  const value = `${state.state ?? ''} ${typeof state.detail === 'string' ? state.detail : ''}`;
  if (/fail|error|crash/i.test(value)) return 'failed';
  if (/cancel|abort|killed/i.test(value)) return 'cancelled';
  if (/timeout|timed.out/i.test(value)) return 'timed-out';
  if (/refus|denied|blocked/i.test(value)) return 'blocked';
  if (/complete|success|done|succeeded/i.test(value)) return 'completed';
  return typeof state.state === 'string' && state.state ? state.state : 'unknown';
}


// ---------------------------------------------------------------------------------------------------------------
// Error rates (reported first). Every metric is { count, total, pct, basis, causes: { cause: { count, pct, minutes?,
// examples: [{ ref, at }] } } } with at most two examples per cause. Pure: all inputs are already-read data.
// ---------------------------------------------------------------------------------------------------------------
const pct = (count, total) => total ? round(100 * count / total, 1) : 0;
const refCompare = (a, b) => compare(a.at ?? '', b.at ?? '') || compare(a.ref ?? '', b.ref ?? '');
/** items: [{ cause, ref, at, ms? }] -> metric. Examples are the two most recent per cause (stable order). */
export function rateMetric(items, total, basis, extra = {}) {
  const by = new Map();
  for (const item of items) { const g = by.get(item.cause) ?? []; g.push(item); by.set(item.cause, g); }
  const causes = {};
  for (const [cause, group] of [...by].sort(([a, x], [b, y]) => y.length - x.length || compare(a, b))) {
    const ms = sum(group.map((g) => Number.isFinite(g.ms) ? g.ms : 0));
    causes[cause] = { count: group.length, pct: pct(group.length, items.length), ...(ms > 0 ? { minutes: minutes(ms) } : {}), examples: group.filter((g) => g.ref).sort((a, b) => refCompare(b, a)).slice(0, 2).map(({ ref, at }) => ({ ref, at })) };
  }
  return { count: items.length, total, pct: pct(items.length, total), basis, causes, ...extra };
}

/** Marker (one `.lane-verify` record) -> gate-run cause. Timeouts and isolated-retry verdicts are recorded by verify-lane. */
export function gateCause(marker) {
  if (marker.status === 'timeout' || marker.reason === 'wait-timeout') return 'verify-wait-timeout';
  if (marker.isolatedRetry === 'flaky-outside-diff') return 'flaky-outside-diff';
  if (marker.isolatedRetry === 'still-red') return 'still-red-after-isolated-retry';
  const failures = Array.isArray(marker.retriedFailures) ? marker.retriedFailures : [];
  if ((Array.isArray(marker.retriedTimeouts) && marker.retriedTimeouts.length) || (failures.length && failures.every((f) => f?.kind === 'timeout'))) return 'vitest-timeout';
  return 'in-diff-real-failure';
}

const SOAK = /soak/i;
export function ciCheckName(jobName, runName = '') {
  const name = String(jobName || '');
  if (/codeql/i.test(name) || /codeql/i.test(runName)) return 'CodeQL';
  if (/daemon-soak/i.test(name)) return 'daemon-soak';
  if (SOAK.test(name) || SOAK.test(runName)) return 'soak-shard';
  if (/smoke/i.test(name)) return 'smoke';
  if (/review.?gate/i.test(name) || /review.?gate/i.test(runName)) return 'review-gate';
  if (/^test|shard|vitest|unit/i.test(name)) return 'test-shard';
  return name ? name.replace(/\s*\([^)]*\)\s*$/, '') || 'unknown' : 'ci-unspecified';
}

/** CI runs per PR head. `ciRuns`: [{ id, name, conclusion, headSha, pr, runAttempt, createdAt, updatedAt, jobs? }]. */
export function ciMetrics(ciRuns, window) {
  const runs = ciRuns.filter((r) => r.conclusion && inWindow(r.createdAt, window));
  const green = new Set(runs.filter((r) => r.conclusion === 'success').map((r) => `${r.headSha}|${r.name}`));
  const red = runs.filter((r) => ['failure', 'timed_out', 'cancelled', 'startup_failure'].includes(r.conclusion));
  const byCheck = [], byCause = [];
  for (const r of red) {
    const ref = r.pr ? `PR #${r.pr}` : `sha ${String(r.headSha).slice(0, 7)}`;
    const ms = elapsed(r.updatedAt, r.createdAt);
    const failedJobs = (r.jobs ?? []).filter((j) => ['failure', 'timed_out', 'cancelled'].includes(j.conclusion));
    const checks = new Set((failedJobs.length ? failedJobs.map((j) => ciCheckName(j.name, r.name)) : [ciCheckName('', r.name)]));
    for (const check of checks) byCheck.push({ cause: check, ref, at: r.createdAt, ms });
    const soak = [...checks].some((c) => c === 'soak-shard' || c === 'daemon-soak');
    const reviewOnly = [...checks].every((c) => c === 'review-gate');
    const cause = r.conclusion === 'cancelled' ? 'infra-cancelled' : reviewOnly ? 'review-gate-hold' : green.has(`${r.headSha}|${r.name}`) ? 'flaky' : soak ? 'soak-scenario' : 'real-code-defect';
    byCause.push({ cause, ref, at: r.createdAt, ms });
  }
  const heads = new Set(runs.map((r) => r.headSha)), redHeads = new Set(red.map((r) => r.headSha));
  return {
    runs: rateMetric(byCause, runs.length, 'completed PR workflow runs', { heads: heads.size, redHeads: redHeads.size, byCheck: rateMetric(byCheck, runs.length, 'completed PR workflow runs (a run can fail several checks)').causes }),
  };
}

const FIX_KINDS = new Set(['fix', 'ci-heal']);
/** Outcome of a fix/ci-heal session from its state and its final one-line outcome text. First match wins. */
export function fixOutcome(state, text = '') {
  const value = `${typeof state.detail === 'string' ? state.detail : ''} ${text}`;
  if (state.state === 'stopped' || /^\s*stopped\s*$/i.test(state.detail ?? '')) return 'stopped-without-outcome';
  if (/load.?flake|quiet.?host/i.test(value)) return 'load-flake-hold';
  if (/gate.?red|verify.?red|gate red/i.test(value)) return 'gate-red-not-pushed';
  if (/escalat/i.test(value)) return 'escalated';
  if (/no (?:ci )?break|no red checks|no-op|not-applicable|stood down|no heal|heal no-op|cancelled leftovers|nothing to/i.test(value)) return 'no-op';
  if (/blocked|refus|denied/i.test(value) || /refus|blocked/i.test(sessionOutcome(state))) return 'blocked';
  if (/push|re-?armed|fixed|repaired|green|verified|hardened|merged main/i.test(value)) return 'pushed';
  return 'other';
}

/** Builder launches from build-dispatch-daemon tick rows ({ at, dispatched[], failures[] }). */
export function builderMetrics(ticks, window) {
  const inTick = ticks.filter((t) => inWindow(t.at, window));
  const items = [], seen = new Map();
  const note = (num, at) => { const g = seen.get(num) ?? []; g.push(at); seen.set(num, g); };
  for (const t of inTick) {
    for (const d of Array.isArray(t.dispatched) ? t.dispatched : []) { items.push({ cause: 'launched', ref: `card ${d.num}`, at: t.at, num: d.num }); note(d.num, t.at); }
    for (const f of Array.isArray(t.failures) ? t.failures : []) {
      if (f?.stage !== 'dispatch') continue;
      const reason = String(f.reason ?? '');
      items.push({ cause: /not confirmed/i.test(reason) ? 'launch-not-confirmed' : 'failed', ref: `card ${f.num}`, at: t.at, num: f.num }); note(f.num, t.at);
    }
  }
  // A card attempted in more than one tick was re-dispatched: every attempt after its first is a repeat.
  const repeats = [];
  for (const [num, ats] of seen) for (const at of ats.slice(1)) repeats.push({ cause: 'repeated-same-card', ref: `card ${num}`, at });
  const attempts = items.length;
  const base = rateMetric(items.filter((i) => i.cause !== 'launched'), attempts, 'launch attempts', { launched: items.filter((i) => i.cause === 'launched').length, ticks: inTick.length });
  const repeated = rateMetric(repeats, attempts, 'launch attempts');
  base.causes = { ...base.causes, ...Object.fromEntries(Object.entries(repeated.causes).map(([k, v]) => [k, { ...v, pct: pct(v.count, attempts) }])) };
  base.repeatedSameCard = repeated.count;
  return base;
}

const DAEMON_PATTERNS = [
  ['smokeFailures', /\bsmoke-fail(?:ed|ure)?\b/, /daemon-rebuild: smoke|\bsmoke-fail/, 'smoke events'],
  ['concurrentMover', /concurrent-mover/, null, 'log lines'],
  ['tickInProgress', /tick-in-progress/, null, 'log lines'],
  ['rateLimit', /rate limit (?:exceeded|hit)|secondary rate limit|gh-throttle[^\n]*(?:backoff|rate limit)/i, null, 'log lines'],
  ['ghReadFailures', /Command failed: gh |gh read fail|gh: [^\n]*\(HTTP 5\d\d\)/, null, 'log lines'],
];
/** `entries`: [{ source, at, line }] already expanded (repeat markers replayed) and windowed. */
export function daemonMetrics(entries) {
  const out = {};
  for (const [key, pattern, basisPattern, basis] of DAEMON_PATTERNS) {
    const hits = entries.filter((e) => pattern.test(e.line) && !(key === 'ghReadFailures' && DAEMON_PATTERNS[3][1].test(e.line)));
    const total = basisPattern ? entries.filter((e) => basisPattern.test(e.line)).length : entries.length;
    out[key] = rateMetric(hits.map((e) => ({ cause: key === 'ghReadFailures' ? (e.line.match(/--repo (\S+)/)?.[1] ?? 'other') : e.source, ref: e.source, at: e.at })), total, basis);
  }
  return out;
}

/** Attribute each log line to the nearest preceding timestamp (many daemon lines carry none); drop what has no anchor. */
export function stampedEntries(lines, source, window) {
  let at = null, unattributed = 0;
  const entries = [], unanchored = [];
  for (const raw of lines) {
    const m = LOG_TIMESTAMP_RE.exec(raw);
    if (m) at = m[0].trim();
    if (!at) { unattributed++; unanchored.push(raw); continue; }
    if (inWindow(at, window)) entries.push({ source, at, line: stripLogTimestamp(raw) });
  }
  return { entries, unattributed, unanchored };
}

/** Parse build-dispatch tick rows (`{"at":..,"timings":..,"dispatched":[..],"failures":[..]}`), tolerating a stamp prefix. */
export function parseBuildTicks(lines) {
  const out = [];
  for (const line of lines) {
    const i = line.indexOf('{"at"');
    if (i < 0) continue;
    const row = json(line.slice(i));
    if (row && typeof row.at === 'string') out.push({ at: row.at, dispatched: row.dispatched, failures: row.failures });
  }
  return out;
}

export function buildErrorRates({ window, notes = {}, gateRuns, killed, waitTimeouts, fixSessions, ciRuns, buildTicks, daemonEntries }) {
  const gateItems = [
    ...gateRuns.filter((g) => g.red).map((g) => ({ cause: g.cause, ref: g.ref, at: g.at, ms: g.ms })),
    ...killed.map((k) => ({ cause: 'killed-superseded', ref: k.ref, at: k.at })),
    ...waitTimeouts,
  ];
  const gateTotal = gateRuns.length + killed.length + waitTimeouts.length;
  const fixOutcomes = rateMetric(fixSessions.map((s) => ({ cause: s.outcome, ref: s.pr ? `PR #${s.pr}` : `session ${s.session}`, at: s.at, ms: s.ms })), fixSessions.length, 'fix/ci-heal sessions');
  const rounds = new Map();
  for (const s of fixSessions) if (s.pr) rounds.set(s.pr, (rounds.get(s.pr) ?? 0) + 1);
  const roundList = [...rounds].map(([pr, n]) => ({ pr, rounds: n })).sort((a, b) => b.rounds - a.rounds || a.pr - b.pr);
  return {
    gateRuns: { ...rateMetric(gateItems, gateTotal, 'local gate attempts (lane markers + verify-daemon kills + wait-timeouts)', { flakyRescuedGreen: gateRuns.filter((g) => !g.red && g.cause === 'flaky-outside-diff').length, markerSample: 'each lane keeps only its last two markers' }) },
    ci: ciMetrics(ciRuns, window).runs,
    fixSessions: { ...fixOutcomes, rounds: { prs: roundList.length, multiRoundPrs: roundList.filter((r) => r.rounds > 1).length, max: roundList[0]?.rounds ?? 0, top: roundList.slice(0, 5) } },
    builderLaunches: builderMetrics(buildTicks, window),
    daemonErrors: daemonMetrics(daemonEntries),
    notes: { ciRunsTruncated: Boolean(notes.ciRunsTruncated), verifyLogUnstampedLines: notes.verifyUnstamped ?? 0, verifyLogUnstampedSuperseded: notes.verifyUnstampedSuperseded ?? 0, note: 'lines with no preceding timestamp (before #4076) cannot be placed in the window and are excluded' },
  };
}

/** gh runner: JSON or null on any failure. Stderr is dropped so no credential text can leak into a report. */
export function makeGh({ home = homedir(), env = process.env, exec = execFileSync } = {}) {
  const shim = join(home, '.claude/github-app-token/gh-shim');
  const PATH = fs.existsSync(shim) ? `${shim}:${env.PATH ?? ''}` : env.PATH;
  return (args) => { try { return JSON.parse(exec('gh', args, { env: { ...env, PATH }, encoding: 'utf8', timeout: 45000, maxBuffer: 32 * MiB, stdio: ['ignore', 'pipe', 'ignore'] })); } catch { return null; } };
}

/** Bounded gh read: <= maxPages run pages and <= maxJobCalls job lookups (only non-green runs, newest first). */
export function fetchCiRuns(window, gh, { repo = 'web-everything/web-everything', maxPages = 8, maxJobCalls = 40 } = {}) {
  if (typeof gh !== 'function') return { runs: [], found: false, calls: 0, truncated: false };
  const created = encodeURIComponent(`${window.since}..${window.until}`);
  const raw = []; let calls = 0, found = false, truncated = false;
  for (let page = 1; page <= maxPages; page++) {
    calls++;
    const data = gh(['api', `repos/${repo}/actions/runs?event=pull_request&created=${created}&per_page=100&page=${page}`]);
    if (!data || !Array.isArray(data.workflow_runs)) break;
    found = true; raw.push(...data.workflow_runs);
    if (data.workflow_runs.length < 100) break;
    if (page === maxPages) truncated = true;
  }
  const runs = raw.map((r) => ({ id: r.id, name: r.name, conclusion: r.conclusion, headSha: r.head_sha, pr: r.pull_requests?.[0]?.number ?? null, runAttempt: r.run_attempt, createdAt: r.created_at, updatedAt: r.updated_at }));
  const red = runs.filter((r) => ['failure', 'timed_out', 'startup_failure'].includes(r.conclusion)).sort((a, b) => compare(b.createdAt, a.createdAt)).slice(0, maxJobCalls);
  for (const r of red) { calls++; const data = gh(['api', `repos/${repo}/actions/runs/${r.id}/jobs?per_page=100`]); if (data && Array.isArray(data.jobs)) r.jobs = data.jobs.map((j) => ({ name: j.name, conclusion: j.conclusion })); }
  return { runs, found, calls, truncated };
}

/** Pure metrics core. Input arrays may be unordered; sources and all maps are sorted. */
export function extractMetrics({ window, sessions = [], durations = [], reaped = [], markers = [], verifyLines = [], refusalLines = [], ciRuns = [], buildTicks = [], buildLines = [], daemonLogs = {}, sources = {} }) {
  const selected = sessions.filter(({ state }) => inWindow(state.createdAt || state.updatedAt, window))
    .sort((a, b) => compare(a.state.sessionId ?? a.state.name ?? '', b.state.sessionId ?? b.state.name ?? '') || compare(JSON.stringify(a), JSON.stringify(b)));
  const byKind = new Map(), outcomes = new Map(), prs = new Map(), denials = new Map(), holds = new Map(), reasons = new Map(), refusals = new Map(), refusalPrs = new Map();
  const times = [], gates = [], loops = [], waits = [], reapedWaits = [], records = [], fixSessions = [], gateRuns = [];
  const waitTimeoutItems = [];
  let waitTimeoutSessions = 0, transcriptsTruncated = 0, bytesRead = 0, waiterMs = 0;
  for (const { state, transcript = {} } of selected) {
    const ms = elapsed(state.lastTerminalAt || state.updatedAt, state.createdAt || state.updatedAt);
    times.push(ms);
    const name = String(state.name ?? ''), kind = name.match(/^(.*?)-(?=\d)/)?.[1] || 'other';
    const pr = Number(name.match(/\d+/)?.[0] ?? String(state.intent ?? '').match(/#(\d+)/)?.[1]) || null;
    const session = String(state.sessionId ?? state.name ?? 'unknown');
    const parsed = parseTranscript(transcript.entries ?? []);
    const outcome = sessionOutcome(state);
    add(outcomes, outcome);
    const group = byKind.get(kind) ?? []; group.push(ms); byKind.set(kind, group);
    if (pr !== null) { const group = prs.get(pr) ?? []; group.push(ms); prs.set(pr, group); }
    gates.push(...parsed.gates);
    if (FIX_KINDS.has(kind)) fixSessions.push({ session, pr, outcome: fixOutcome(state, parsed.outcomeLine), at: state.lastTerminalAt || state.updatedAt || state.createdAt, ms });
    for (const g of parsed.gates) if (g.waitTimeout) waitTimeoutItems.push({ cause: 'verify-wait-timeout', ref: `session ${session}`, at: g.at, ms: g.ms ?? 0 });
    if (parsed.gates.some((g) => g.waitTimeout)) waitTimeoutSessions++;
    for (const [type, count] of Object.entries(parsed.denials)) add(denials, type, count);
    loops.push(...parsed.loops.map((loop) => ({ session, ...loop })));
    transcriptsTruncated += Number(Boolean(transcript.truncated)); bytesRead += transcript.bytesRead ?? 0;
    records.push({ session, name, kind, pr, outcome, minutes: minutes(ms), outcomeLine: parsed.outcomeLine, truncated: Boolean(transcript.truncated) });
  }
  for (const row of durations) {
    if (!inWindow(row.at, window) || !Number.isFinite(row.ms) || row.ms < 0) continue;
    const kind = typeof row.kind === 'string' ? row.kind : 'unknown';
    const group = holds.get(kind) ?? []; group.push(row.ms); holds.set(kind, group);
  }
  for (const row of reaped) {
    if (!inWindow(row.reapedAt, window)) continue;
    add(reasons, typeof row.reason === 'string' ? row.reason : 'unknown');
    if (Number.isFinite(stamp(row.requestedAt))) { const ms = elapsed(row.reapedAt, row.requestedAt); waiterMs += ms; reapedWaits.push(ms); }
  }
  // Marker waits and reaped waiter lifetimes describe different populations.
  const markerSeen = new Set(), markerModes = new Map(), markerGate = [], markerVitest = [], markerStandards = [];
  let markerCount = 0;
  for (const row of markers) {
    if (!inWindow(row.finishedAt, window)) continue;
    const key = JSON.stringify([row.sha, row.startedAt]);
    if (markerSeen.has(key)) continue;
    markerSeen.add(key); markerCount++;
    const cause = gateCause(row);
    gateRuns.push({ red: row.status === 'red' || row.status === 'timeout', cause, ref: `sha ${String(row.sha ?? '').slice(0, 7)}`, at: row.finishedAt, ms: elapsed(row.finishedAt, row.startedAt) });
    const phases = row.phases ?? {};
    add(markerModes, phases.admissionMode ?? 'unknown');
    for (const [field, xs] of [['admissionWaitMs', waits], ['gateMs', markerGate], ['vitestMs', markerVitest], ['standardsMs', markerStandards]]) {
      if (Number.isFinite(phases[field]) && phases[field] >= 0) xs.push(phases[field]);
    }
  }
  const verifyDaemon = { starts: 0, superseded: 0, codeNull: 0, codeChanged: 0, sigterm: 0, note: 'untimestamped log tail window' };
  const patterns = { starts: /^\s*dispatching verify for /, superseded: /superseded by a newer request/, codeNull: /exited with code null/, codeChanged: /loop stopped \(code-changed\)/, sigterm: /^verify-daemon: SIGTERM/ };
  for (const raw of verifyLines) { const line = stripLogTimestamp(raw); for (const [key, pattern] of Object.entries(patterns)) if (pattern.test(line)) verifyDaemon[key]++; }
  for (const line of refusalLines) {
    // Tick summaries report counts, not individual refusal events/reasons.
    if (/\bdispatched \d+, refused \d+\b/.test(line)) continue;
    if (!/\b(?:reconcile-refused|refused)\b/.test(line)) continue;
    const reason = line.match(/(?:reconcile-refused|\brefused)\s+([a-z][a-z0-9-]+)/)?.[1] ?? 'unparsed';
    add(refusals, reason);
    const pr = line.match(/PR #(\d+)/)?.[1];
    if (pr) add(refusalPrs, Number(pr));
  }
  const gateTimes = gates.filter((g) => g.ms !== null).map((g) => g.ms), total = sum(times), gateMs = sum(gateTimes);
  const stats = (xs) => ({ count: xs.length, minutes: minutes(sum(xs)), medianMin: minutes(percentile(xs, 0.5)), p90Min: minutes(percentile(xs, 0.9)) });
  const verifyGates = gates.filter((g) => g.kinds.includes('verifyLane'));
  const verifyTimes = verifyGates.filter((g) => g.ms !== null).map((g) => g.ms);
  const directVitest = gates.filter((g) => g.kinds.includes('directVitest'));
  const seconds = (xs, p = 0.5) => round(percentile(xs, p) / 1000);
  records.sort((a, b) => b.minutes - a.minutes || compare(a.session, b.session));
  const stampedVerify = stampedEntries(verifyLines, 'verify-daemon', window);
  const killed = stampedVerify.entries.filter((e) => /superseded by a newer request/.test(e.line)).map((e) => ({ ref: e.line.match(/web-everything\/lane-\d+/)?.[0] ?? 'verify-daemon', at: e.at }));
  const daemonEntries = [stampedVerify.entries, ...Object.entries({ 'build-dispatch': buildLines, ...daemonLogs }).sort(([a], [b]) => compare(a, b)).map(([source, lines]) => stampedEntries(lines, source, window).entries)].flat();
  const errorRates = buildErrorRates({ window, notes: { ciRunsTruncated: sources.ci?.truncated, verifyUnstamped: stampedVerify.unattributed, verifyUnstampedSuperseded: stampedVerify.unanchored.filter((l) => /superseded by a newer request/.test(l)).length }, gateRuns, killed, waitTimeouts: waitTimeoutItems.filter((w) => inWindow(w.at, window)), fixSessions, ciRuns, buildTicks, daemonEntries });
  return {
    window: { since: window.since, until: window.until },
    errorRates,
    sessions: { ...stats(times), byKind: ordered(new Map([...byKind].map(([key, xs]) => [key, { count: xs.length, minutes: minutes(sum(xs)) }]))), outcomes: ordered(outcomes), records: records.slice(0, 60) },
    gate: { minutesInGate: minutes(gateMs), shareInGate: total ? round(Math.min(1, gateMs / total), 3) : 0, commands: gates.length, medianMin: minutes(percentile(verifyTimes, 0.5)), p90Min: minutes(percentile(verifyTimes, 0.9)), allCommands: stats(gateTimes), verifyLane: { calls: verifyGates.length, medianMin: minutes(percentile(verifyTimes, 0.5)), p90Min: minutes(percentile(verifyTimes, 0.9)), waitTimeouts: verifyGates.filter((g) => g.waitTimeout).length }, directVitest: { runs: directVitest.length, minutes: minutes(sum(directVitest.map((g) => g.ms ?? 0))) }, waitTimeouts: gates.filter((g) => g.waitTimeout).length, waitTimeoutSessions, waitTimeoutMinutes: minutes(sum(gates.filter((g) => g.waitTimeout).map((g) => g.ms ?? 0))) },
    admission: { waitMedianSec: round(percentile(waits, 0.5) / 1000), waitP90Sec: round(percentile(waits, 0.9) / 1000), holdsByKind: ordered(new Map([...holds].map(([key, xs]) => [key, stats(xs)]))), markers: { count: markerCount, byMode: ordered(markerModes), gateMedianSec: seconds(markerGate), gateP90Sec: seconds(markerGate, 0.9), vitestMedianSec: seconds(markerVitest), standardsMedianSec: seconds(markerStandards) }, reaped: { waiterMedianSec: seconds(reapedWaits), waiterP90Sec: seconds(reapedWaits, 0.9), byReason: ordered(reasons), waiterMinutes: minutes(waiterMs) } },
    denials: { byType: ordered(denials), total: sum([...denials.values()]) },
    loops: { count: loops.length, top: loops.sort((a, b) => b.count - a.count || compare(a.session, b.session) || compare(a.command, b.command)).slice(0, 10) },
    verifyDaemon,
    topPrs: [...prs].map(([pr, xs]) => ({ pr, sessions: xs.length, minutes: minutes(sum(xs)), ms: sum(xs) })).sort((a, b) => b.ms - a.ms || a.pr - b.pr).slice(0, 10).map(({ ms, ...row }) => row),
    refusalByPr: [...refusalPrs].map(([pr, count]) => ({ pr, count })).sort((a, b) => b.count - a.count || a.pr - b.pr).slice(0, 10),
    refusalReasons: [...refusals].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count || compare(a.reason, b.reason)).slice(0, 20),
    truncation: { transcriptsTruncated, bytesRead },
    sources: Object.fromEntries(Object.entries({ ...sources, verifyDaemon: { ...sources.verifyDaemon, windowed: false } }).sort(([a], [b]) => compare(a, b))),
  };
}

function children(path, io) { try { return io.readdirSync(path, { withFileTypes: true }).sort((a, b) => compare(a.name, b.name)); } catch { return []; } }
function exists(path, io) { try { return io.statSync(path).isFile(); } catch { return false; } }
function directory(path, io) { try { return io.statSync(path).isDirectory(); } catch { return false; } }
export function collectInputs(window, { env = process.env, home = homedir(), io = fs, gh = null } = {}) {
  const paths = {
    jobs: env.WE_CORONER_JOBS || join(home, '.claude/jobs'),
    archive: env.WE_CORONER_JOBS_ARCHIVE || join(home, '.claude/jobs-archive'),
    projects: env.WE_CORONER_PROJECTS || join(home, '.claude/projects'),
    daemon: env.WE_CORONER_DAEMON_DIR || '/Users/nicolasgilbert/workspace/wev-review-daemon/.conveyor',
    verify: env.WE_CORONER_VERIFY_LOG || join(home, 'workspace/.operations/coordination/verify-daemon.log'),
    admission: env.WE_CORONER_ADMISSION || join(home, 'workspace/.lanes/.admission/heavy'),
    coord: env.WE_CORONER_COORD || join(home, 'workspace/.operations/coordination'),
    lanes: env.WE_CORONER_LANES || join(home, 'workspace/.lanes/web-everything'),
  };
  const sources = {}, sessions = [], seen = new Set();
  const read = (file, options = {}) => readBounded(file, { io, ...options });
  for (const key of ['jobs', 'archive']) {
    const files = [];
    for (const child of children(paths[key], io).filter((x) => x.isDirectory())) {
      files.push(join(paths[key], child.name, 'state.json'));
      if (key === 'archive') for (const nested of children(join(paths[key], child.name), io).filter((x) => x.isDirectory())) files.push(join(paths[key], child.name, nested.name, 'state.json'));
    }
    sources[key] = { found: directory(paths[key], io), count: 0 };
    for (const file of files.sort(compare)) {
      const readState = read(file, { cap: 64 * 1024 });
      const state = readState.truncated ? null : json(readState.lines.join('\n'));
      if (!state || typeof state !== 'object' || Array.isArray(state)) continue;
      sources[key].count++;
      if (!inWindow(state.createdAt || state.updatedAt, window)) continue;
      const id = state.sessionId || state.name || file;
      if (seen.has(id)) continue;
      seen.add(id); sessions.push({ state });
    }
  }
  const projectDirs = children(paths.projects, io).filter((x) => x.isDirectory()).map((x) => join(paths.projects, x.name));
  sources.projects = { found: directory(paths.projects, io), count: 0 };
  sources.transcripts = { found: false, count: 0 };
  for (const session of sessions) {
    const { state } = session;
    const safeId = typeof state.sessionId === 'string' && /^[\w-]+$/.test(state.sessionId);
    const fallback = safeId ? projectDirs.map((dir) => join(dir, `${state.sessionId}.jsonl`)).find((file) => exists(file, io)) : null;
    const file = typeof state.linkScanPath === 'string' && exists(state.linkScanPath, io) ? state.linkScanPath : fallback;
    if (!file) continue;
    const data = read(file, { cap: positive(env.WE_CORONER_TRANSCRIPT_CAP, 8 * MiB) });
    session.transcript = { entries: rows(data.lines), truncated: data.truncated, bytesRead: data.bytesRead };
    if (data.found) { sources.transcripts.found = true; sources.transcripts.count++; if (file === fallback) sources.projects.count++; }
  }
  // 68b: a size-rotated log keeps its older half in `<log>.1`, and collapsed repeats are replayed, so the counts
  // are the same as if the log had never been rotated or de-duplicated.
  const log = (key, file, { cap = positive(env.WE_CORONER_LOG_TAIL, 2 * MiB), maxLine, olderToo = true } = {}) => {
    const data = read(file, { cap, tailOnly: true, maxLine });
    const older = olderToo && data.bytesRead < cap ? read(`${file}.1`, { cap, tailOnly: true, maxLine }) : { lines: [], found: false };
    // One pass over the joined lines, so back-to-back markers interleave and the expansion budget is shared.
    const joined = expandRepeatedLines([...(older.found ? older.lines : []), ...data.lines].join('\n'));
    const all = joined === '' ? [] : joined.split('\n');
    sources[key] = { found: data.found || older.found, count: all.length };
    return all;
  };
  const verifyLines = log('verifyDaemon', paths.verify);
  const logNames = ['fix-dispatch-daemon.log', 'review-daemon.log'];
  const extra = children(paths.daemon, io).filter((x) => x.isFile?.() !== false && /^(?:pass-daemon\..+|parked-pr-conflict-watch-.+|lease-reaper)\.log$/.test(x.name)).map((x) => x.name);
  const daemonLogs = Object.fromEntries([...logNames, ...extra].map((name) => [name.replace(/\.log$/, ''), log(name, join(paths.daemon, name))]));
  const refusalLines = [...daemonLogs['fix-dispatch-daemon'], ...daemonLogs['review-daemon']];
  // Tick rows are ~300 KB of JSON each: read a larger tail with a larger line cap, keep only the compact fields.
  const buildAll = log('build-dispatch-daemon.log', join(paths.coord, 'build-dispatch-daemon.log'), { cap: positive(env.WE_CORONER_BUILD_TAIL, 48 * MiB), maxLine: 2 * MiB, olderToo: true });
  const buildTicks = parseBuildTicks(buildAll), buildLines = buildAll.filter((l) => l.indexOf('{"at"') < 0);
  const ci = fetchCiRuns(window, gh);
  sources.ci = { found: ci.found, count: ci.runs.length, ghCalls: ci.calls, truncated: ci.truncated };
  const ledger = (name) => { const data = read(join(paths.admission, `${name}.jsonl`)); const entries = rows(data.lines); sources[name] = { found: data.found, count: entries.length }; return entries; };
  const durations = ledger('durations'), reaped = ledger('reaped'), markers = [];
  sources.lanes = { found: directory(paths.lanes, io), count: 0 };
  for (const lane of children(paths.lanes, io).filter((x) => x.isDirectory() && x.name.startsWith('lane-'))) {
    for (const marker of ['.lane-verify', '.lane-verify.previous']) {
      const data = read(join(paths.lanes, lane.name, '.git', marker), { cap: 64 * 1024 });
      if (data.found) sources.lanes.count++;
      if (!data.truncated) markers.push(...parseMarkers(data.lines));
    }
  }
  return { window, sessions, durations, reaped, markers, verifyLines, refusalLines, ciRuns: ci.runs, buildTicks, buildLines, daemonLogs, sources };
}

/** Flatten the same metrics into a compact two-column human table. */
export function formatHuman(metrics) {
  const lines = ['METRIC  VALUE'];
  const walk = (value, path) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) for (const [key, child] of Object.entries(value)) walk(child, path ? `${path}.${key}` : key);
    else lines.push(`${path}  ${typeof value === 'object' ? JSON.stringify(value) : value}`);
  };
  walk(metrics, '');
  return lines.join('\n');
}

export function runCoroner(argv, { env = process.env, home = homedir(), now = new Date().toISOString(), io = fs, gh = null } = {}) {
  const { values } = parseArgs({ args: argv, options: { since: { type: 'string' }, until: { type: 'string' }, json: { type: 'boolean' }, state: { type: 'string' }, 'no-save': { type: 'boolean' } } });
  const statePath = values.state || env.WE_CORONER_STATE || join(home, 'workspace/.operations/state/coroner-last.json');
  let since = values.since;
  if (since === 'last') {
    since = json(readBounded(statePath, { cap: 64 * 1024, io }).lines.join('\n'))?.lastEnd;
    if (!since) throw new Error('no previous run; pass an ISO --since');
  }
  const until = values.until || now;
  const validISO = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(stamp(value));
  if (!validISO(since) || !validISO(until) || stamp(since) > stamp(until)) throw new Error('pass valid ISO --since and --until with since <= until');
  const window = { since: new Date(since).toISOString(), until: new Date(until).toISOString() };
  const metrics = extractMetrics(collectInputs(window, { env, home, io, gh }));
  const output = values.json ? JSON.stringify(metrics) : formatHuman(metrics);
  if (!values['no-save']) {
    io.mkdirSync(dirname(statePath), { recursive: true });
    const tmp = `${statePath}.${randomUUID()}.tmp`;
    try { io.writeFileSync(tmp, JSON.stringify({ lastEnd: window.until }) + '\n', { flag: 'wx' }); io.renameSync(tmp, statePath); }
    finally { try { io.unlinkSync(tmp); } catch { /* Already renamed. */ } }
  }
  return { metrics, output };
}
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  // A consumer such as head may close the pipe after its requested prefix.
  process.stdout.on('error', (error) => { if (error.code !== 'EPIPE') { process.stderr.write(`${error.message}\n`); process.exitCode = 1; } });
  try { process.stdout.write(runCoroner(process.argv.slice(2), { gh: process.env.WE_CORONER_NO_CI ? null : makeGh() }).output + '\n'); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
