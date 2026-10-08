/**
 * Card 130 (S1) - the coroner reads each worker session's transcript for FRICTION, deterministically (no LLM).
 *
 * One bounded tail read per session through skills-src/inspect-agent-health/agent-health.mjs `tailLines` (never
 * the whole file), normalised to a small event stream, then folded into per-session friction records and grouped
 * by session kind x executor in a `frictions` section. Sources: Claude `state.json` -> `linkScanPath`, Codex
 * rollouts (joined to `.operations/codex-delivery-threads` and `.operations/completions` records), agy judge logs.
 *
 * Signals: tool denials / guard blocks (permission-denied, EPERM, "Blocked:"), lane failures (already-leased,
 * acquire failures), retries and re-runs, minutes between key steps (lane acquire, first edit, verify request,
 * verify verdict, push, PR open), and the worker's own final outcome line.
 *
 * Only counts, ids and short REDACTED excerpts leave this module: anything token-like is replaced by `[redacted]`.
 * A tail read can start mid-file, so early steps of a very long session may be missing (`truncatedHead` counts them).
 */
import fs from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { tailLines } from '../../skills-src/inspect-agent-health/agent-health.mjs';
import { classifyDenial, normalizeCommand, percentile } from './coroner-extract.mjs';

const MiB = 1024 * 1024;
const ALL_LINES = Number.MAX_SAFE_INTEGER;
const stampMs = (v) => (typeof v === 'string' || typeof v === 'number') ? Date.parse(typeof v === 'number' && v < 1e12 ? v * 1000 : v) : NaN;
const iso = (ms) => Number.isFinite(ms) ? new Date(ms).toISOString() : null;
const mins = (ms) => Math.round(ms / 6000) / 10;
const json = (text) => { try { return JSON.parse(text); } catch { return null; } };
const plain = (o) => o && typeof o === 'object' && !Array.isArray(o);

/**
 * Replace anything token-like with `[redacted]` before it can reach a report.
 * Every pattern is linear: no unanchored lookahead over an unbounded run, no nested quantifier. Redaction also never sees
 * more than RAW_CAP characters (tool output is attacker-influenceable and a tail read is up to 2 MiB).
 */
const SECRET_PATTERNS = [
  /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{16,}\b/g,
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\b(?:[sr]k_(?:live|test)|pk_live|whsec)_[A-Za-z0-9]{16,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{12,}\b/g,
  /\bAIza[0-9A-Za-z_-]{20,}/g,
  /\b(?:npm_[A-Za-z0-9]{30,}|glpat-[A-Za-z0-9_-]{16,})/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/g,
  // PEM / PGP private key: through the END line when it is there (encrypted keys carry `Proc-Type:` headers), else the next 1 KiB.
  /-----BEGIN [A-Z ]{0,30}PRIVATE KEY(?: BLOCK)?-----(?:[\s\S]{0,4096}?-----END [A-Z ]{0,30}PRIVATE KEY(?: BLOCK)?-----|[\s\S]{0,1024})/g,
  // URL userinfo (`postgres://user:pass@host`, `redis://:pass@host`, `https://token@host`): everything between `://` and the last `@` of the authority.
  /(\b[a-z][a-z0-9+.-]{1,15}:\/\/)[^\s/]{1,256}(?=@)/gi,
  // A token of 8+ chars holding a digit, or any 20+ char run (so prose like "Basic functionality" survives).
  /\b(Bearer|Basic)\s+(?:(?=[A-Za-z0-9._~+/=-]*\d)[A-Za-z0-9._~+/=-]{8,}|[A-Za-z0-9._~+/=-]{20,})/gi,
  /\b((?:Set-)?Cookie\s*:\s*)[^\n]{6,512}/gi,
  // Keyed values. No leading `\b`: `_` is a word character, so `GITHUB_TOKEN` / `DB_PASSWORD` / `MY_API_KEY` must match mid-word.
  // A quoted value may hold spaces and `;` (`"correct horse battery"`); a bare one stops at whitespace, quote, `,` and `;`.
  /((?:api[_-]?key|private[_-]?key|token|secret|password|passwd|passphrase|authorization)[A-Za-z0-9_]{0,24}["']?\s*[:=]\s*)(?:"[^"\n]{4,256}"|'[^'\n]{4,256}'|[^\s"',;]{6,})/gi,
  /\b[A-Fa-f0-9]{32,}\b/g,
];
/** A 40+ char key-alphabet run holding both a digit and a letter. One linear regex plus two linear tests (no lookaheads). */
const BLOB = /[A-Za-z0-9+/_-]{40,}={0,2}/g;
const RAW_CAP = 8192;
/** First RAW_CAP chars, cut back to a whitespace boundary so a token is never split into a leftover that no pattern recognises. */
export function boundedText(text, cap = RAW_CAP) {
  const s = String(text ?? '');
  if (s.length <= cap) return s;
  let end = cap;
  while (end > 0 && !/\s/.test(s[end])) end--;
  return end > 0 ? s.slice(0, end) : '[truncated]';
}
export function redact(text) {
  let out = boundedText(text);
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, (m, p1) => (typeof p1 === 'string' && p1 && !/^[A-Fa-f0-9]+$/.test(p1) ? `${p1}[redacted]` : '[redacted]'));
  return out.replace(BLOB, (m) => (/\d/.test(m) && /[A-Za-z]/.test(m) ? '[redacted]' : m));
}
const excerpt = (text, max = 140) => redact(boundedText(text).replace(/\s+/g, ' ').trim()).slice(0, max);
/** Tool output kept per result: head and tail, so a long dump cannot make every later regex scan megabytes. */
const RESULT_CAP = 32 * 1024;
const clipResult = (text) => {
  const s = String(text ?? '');
  if (s.length <= 2 * RESULT_CAP) return s;
  // The tail starts on a line boundary: a mid-line fragment must not look like the start of a line (`Blocked:` is line-anchored).
  const tail = s.slice(-RESULT_CAP), nl = tail.indexOf('\n');
  return `${s.slice(0, RESULT_CAP)}\n${nl >= 0 ? tail.slice(nl + 1) : ''}`;
};

/** Bounded tail read via agent-health's reader. Returns parsed JSON rows (objects only). */
export function readTranscriptRows(file, { maxBytes = 2 * MiB } = {}) {
  try {
    const { lines, truncatedHead, size } = tailLines(file, ALL_LINES, maxBytes);
    return { rows: lines.map(json).filter(plain), truncatedHead, bytes: Math.min(size, maxBytes), found: true };
  } catch { return { rows: [], truncatedHead: false, bytes: 0, found: false }; }
}

/**
 * Bounded read of the START of a file: the complete JSON lines inside the first `maxBytes` (a partial last line is dropped,
 * and a first line longer than the cap yields nothing). A tail read of a long rollout loses its `session_meta` and brief;
 * this gets them back without reading the file.
 */
export function readHeadRows(file, { maxBytes = 256 * 1024, io = fs } = {}) {
  let fd;
  try {
    fd = io.openSync(file, 'r');
    const buf = Buffer.alloc(maxBytes);
    const n = io.readSync(fd, buf, 0, maxBytes, 0);
    const text = buf.subarray(0, n).toString('utf8');
    const whole = n < maxBytes;
    const lines = text.split('\n');
    if (!whole) lines.pop();
    return lines.filter(Boolean).map(json).filter(plain);
  } catch { return []; } finally { if (fd !== undefined) try { io.closeSync(fd); } catch { /* already closed */ } }
}

/** `rollout-2026-10-07T12-01-00-<thread id>.jsonl` -> `<thread id>`. */
export const threadIdFromRolloutName = (name) => /^rollout-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-(.+)\.jsonl$/.exec(String(name))?.[1] ?? null;

// ---------------------------------------------------------------------------------------------------------------
// Normalisation: every executor becomes the same event stream.
//   { k: 'call', t, id, name, text } | { k: 'result', t, id, text, err } | { k: 'say', t, text } | { k: 'user', t, text }
const textOf = (content) => typeof content === 'string' ? content : Array.isArray(content) ? content.map((x) => typeof x === 'string' ? x : typeof x?.text === 'string' ? x.text : '').join('\n') : '';

export function claudeEvents(rows) {
  const events = [];
  for (const row of rows) {
    const t = stampMs(row.timestamp);
    const content = row.message?.content;
    if (typeof content === 'string' && row.type === 'user') { events.push({ k: 'user', t, text: content }); continue; }
    for (const block of Array.isArray(content) ? content : []) {
      if (row.type === 'assistant' && block?.type === 'text') events.push({ k: 'say', t, text: String(block.text ?? '') });
      else if (row.type === 'assistant' && block?.type === 'tool_use') events.push({ k: 'call', t, id: block.id, name: String(block.name ?? ''), text: String(block.input?.command ?? block.input?.file_path ?? block.input?.path ?? '') });
      else if (row.type === 'user' && block?.type === 'tool_result') events.push({ k: 'result', t, id: block.tool_use_id, text: clipResult(textOf(block.content)), err: block.is_error === true });
      else if (row.type === 'user' && block?.type === 'text') events.push({ k: 'user', t, text: String(block.text ?? '') });
    }
  }
  return events;
}

export function codexEvents(rows) {
  const events = [];
  for (const row of rows) {
    const t = stampMs(row.timestamp), p = row.payload ?? {};
    if (row.type === 'response_item' && p.type === 'message' && p.role === 'assistant') events.push({ k: 'say', t, text: textOf(p.content) });
    else if (row.type === 'response_item' && p.type === 'message' && p.role === 'user') events.push({ k: 'user', t, text: textOf(p.content).slice(0, 4000) });
    else if (row.type === 'response_item' && p.type === 'custom_tool_call') {
      const cmds = [...String(p.input ?? '').matchAll(/\bcmd\s*:\s*("(?:[^"\\]|\\.)*")/g)].map((m) => json(m[1])).filter((x) => typeof x === 'string');
      const patch = p.name === 'apply_patch' || /tools\.apply_patch/.test(String(p.input ?? ''));
      events.push({ k: 'call', t, id: p.call_id, name: patch ? 'apply_patch' : String(p.name ?? ''), text: cmds.join(' ; ') });
    } else if (row.type === 'response_item' && p.type === 'function_call') {
      const args = json(String(p.arguments ?? '')) ?? {};
      const cmd = Array.isArray(args.command) ? args.command.join(' ') : String(args.cmd ?? args.command ?? '');
      events.push({ k: 'call', t, id: p.call_id, name: String(p.name ?? ''), text: cmd });
    } else if (row.type === 'response_item' && (p.type === 'custom_tool_call_output' || p.type === 'function_call_output')) {
      const text = clipResult(typeof p.output === 'string' ? p.output : textOf(p.output));
      const code = /exit_code\\*"?\s*[:=]\s*(-?\d+)/.exec(text)?.[1];
      events.push({ k: 'result', t, id: p.call_id, text, err: code !== undefined && Number(code) !== 0 });
    } else if (row.type === 'event_msg' && p.type === 'task_complete' && typeof p.last_agent_message === 'string') events.push({ k: 'say', t, text: p.last_agent_message, final: true });
  }
  return events;
}

export function agyEvents(rows) {
  const events = [];
  for (const row of rows) {
    const step = row.step_update;
    const t = stampMs(row.timestamp);
    if (row.event === 'step_update' && step?.step_type === 'tool' && step.state !== 'ACTIVE') {
      events.push({ k: 'call', t, id: step.id ?? step.step_id, name: String(step.tool_name ?? ''), text: String(step.input ?? step.tool_name ?? '') });
      events.push({ k: 'result', t, id: step.id ?? step.step_id, text: clipResult(step.output ?? step.error ?? ''), err: step.state === 'ERROR' });
    } else if (row.event === 'result') events.push({ k: 'say', t, text: String(row.result?.output ?? row.result?.status ?? ''), final: true });
  }
  return events;
}

// ---------------------------------------------------------------------------------------------------------------
// Signals
const EPERM = /EPERM: operation not permitted|\bOperation not permitted\b/;
const EPERM_STRONG = /EPERM: operation not permitted, \w+ '/;
const ADMISSION = /heavy-admission|\.admission\b|admission/i;
const PERMISSION_DENIED = /\bpermission denied\b|\bEACCES\b|permission_denied/i;
const GUARD_BLOCK = /^[ \t]*(?:[✗x][ \t]*)?Blocked:|\bhook\b[^\n]{0,60}\bblocked\b|PreToolUse[^\n]{0,60}(?:denied|blocked)/im;
const LANE_LEASED = /\blane-\d+ is (?:leased|held) by\b|lane[- ]already[- ]leased/i;
const LANE_ACQUIRE_FAIL = /no lane within|Command failed:[^\n]{0,60}lane-pool\.mjs acquire|could not determine an origin URL|lane-pool\.mjs acquire[^\n]{0,80}(?:failed|error)|acquire(?:s)? (?:failed|timed out)/i;
const READ_ONLY = /^(?:ls|cd|pwd|cat|echo|head|tail|sed -n|rg|grep|egrep|fgrep|nl|jq|awk|cut|tr|sort|uniq|column|stat|file|less|more|tree|du|od|xxd|strings|basename|dirname|realpath|which|git (?:status|diff|log|show|grep|blame|ls-files|rev-parse|ls-remote)|gh (?:pr|issue|run|repo|api) (?:view|list|checks|diff|status)|wc|find)\b/;
const STEP = {
  acquire: /lane-pool\.mjs\s+acquire/,
  verify: /operations\/run\.mjs\s+verify\b|verify-lane\.mjs/,
  push: /\bgit\s+push\b|operations\/run\.mjs\s+open-pr\b|\bopen-pr\b/,
  openPr: /operations\/run\.mjs\s+open-pr\b|\bopen-pr\b/,
};
/** True when any `&&` / `;` segment of a shell line does more than read. */
const actsOn = (text) => String(text).split(/&&|\|\||;|\n/).map((x) => x.trim()).some((x) => x && !READ_ONLY.test(normalizeCommand(x)));
const SHELL_TOOLS = /^(?:bash|exec|shell|exec_command|shell_command|local_shell|run|run_command|execute_command|terminal)$/i;
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'apply_patch']);
const VERDICT = /\bverify\b[^\n]{0,40}\b(GREEN|RED)\b|"status"\s*:\s*"(green|red|timeout)"|\bVERDICT\b[^\n]{0,30}\b(green|red)\b/i;
const PULL_URL = /github\.com\/[\w.-]+\/[\w.-]+\/pull\/(\d+)/;

export const GAPS = Object.freeze([
  ['acquireToEdit', 'acquire', 'edit'], ['editToVerify', 'edit', 'verify'], ['verifyWait', 'verify', 'verdict'],
  ['verdictToPush', 'verdict', 'push'], ['pushToPr', 'push', 'prOpen'],
]);

/** Fold one session's event stream into a friction record. Pure. */
export function extractFrictions(events, meta = {}) {
  const calls = new Map(), steps = {}, commands = [], counts = new Map();
  const rec = {
    toolDenials: {}, permissionDenied: 0, guardBlocks: 0, sandboxEperm: 0, admissionEperm: 0,
    laneFailures: {}, reruns: 0, retriesAfterError: 0, verifyRequests: 0, openPrRuns: 0, toolErrors: 0,
  };
  const examples = [];
  const first = (name, t) => { if (Number.isFinite(t) && !(name in steps)) steps[name] = t; };
  let verifyAt = null, prevCommand = null, prevErr = false, outcomeLine = '', pr = null;
  const bump = (map, key) => { map[key] = (map[key] ?? 0) + 1; };
  const example = (type, text) => { if (examples.filter((e) => e.type === type).length < 2) examples.push({ type, excerpt: excerpt(text) }); };
  for (const e of events) {
    if (e.k === 'call') {
      calls.set(e.id, e);
      const shell = SHELL_TOOLS.test(e.name);
      const command = normalizeCommand(e.text);
      // A command that only reads files (cat, rg, git diff ...) can print a step's name without taking the step.
      const acts = shell && actsOn(e.text);
      e.acts = acts;
      if (acts && STEP.acquire.test(e.text)) first('acquire', e.t);
      if (EDIT_TOOLS.has(e.name) || (acts && /\bsed\s+-i\b/.test(e.text))) first('edit', e.t);
      if (acts && STEP.verify.test(e.text)) { rec.verifyRequests++; first('verify', e.t); verifyAt ??= e.t; }
      if (acts && STEP.push.test(e.text)) first('push', e.t);
      if (acts && STEP.openPr.test(e.text)) rec.openPrRuns++;
      if (acts && command.length > 12) { commands.push(command); counts.set(command, (counts.get(command) ?? 0) + 1); }
      if (prevErr && command && command === prevCommand) rec.retriesAfterError++;
      prevCommand = command; prevErr = false;
    } else if (e.k === 'result') {
      const call = calls.get(e.id), text = e.text;
      prevErr = e.err;
      // Output of a read-only viewer is file content, not an event: source code mentions leases and guard text.
      // A Node-format EPERM line (`EPERM: operation not permitted, mkdir '/path'`) is an error message whichever command printed it.
      // Trust boundary: only the output of a command that acts is an event source. A successful result of ANY other tool
      // (Read, Grep, Edit's echoed snippet, Task, MCP file fetches ...) or of a call that fell off the truncated tail is
      // content. An ERROR result of such a tool is still the harness's own message (a real denial), so it stays an event.
      const contentTool = !call || !SHELL_TOOLS.test(call.name);
      const fileViewer = contentTool && !e.err;
      const viewer = fileViewer || Boolean(call && !call.acts && SHELL_TOOLS.test(call.name));
      if (e.err) rec.toolErrors++;
      const strongEperm = !fileViewer && EPERM_STRONG.test(text);
      const denial = viewer ? null : classifyDenial(text, e.err);
      if (denial) { bump(rec.toolDenials, denial); example(`denial:${denial}`, text); }
      if (!viewer && PERMISSION_DENIED.test(text) && (e.err || /^\W*(?:bash|zsh|sh)?:?[^\n]{0,80}permission denied/i.test(text.trim()))) rec.permissionDenied++;
      if (!viewer && GUARD_BLOCK.test(text)) { rec.guardBlocks++; example('guard-block', text); }
      if (strongEperm || (!viewer && EPERM.test(text))) {
        rec.sandboxEperm++;
        if (ADMISSION.test(text) || ADMISSION.test(call?.text ?? '')) rec.admissionEperm++;
        example('sandbox-eperm', text.slice(Math.max(0, text.search(EPERM) - 40)));
      }
      const leased = !viewer && LANE_LEASED.test(text);
      if (leased) { bump(rec.laneFailures, 'lane-already-leased'); example('lane-already-leased', text.slice(Math.max(0, text.search(LANE_LEASED) - 30))); }
      else if (!viewer && LANE_ACQUIRE_FAIL.test(text)) { bump(rec.laneFailures, 'lane-acquire-failed'); example('lane-acquire-failed', text); }
      if (call && !viewer && STEP.openPr.test(call.text)) { const m = PULL_URL.exec(text); if (m) { first('prOpen', e.t); pr = Number(m[1]); } }
      else if (call && !viewer && /\bgh\s+pr\s+create\b/.test(call.text)) { const m = PULL_URL.exec(text); if (m) { first('prOpen', e.t); pr = Number(m[1]); } }
      if (!viewer && verifyAt !== null && !('verdict' in steps) && VERDICT.test(text)) first('verdict', e.t);
    } else if (e.k === 'user') {
      if (verifyAt !== null && !('verdict' in steps) && VERDICT.test(e.text)) first('verdict', e.t);
      const m = PULL_URL.exec(e.text); if (m && pr === null && /opened|created/i.test(e.text)) pr = Number(m[1]);
    } else if (e.k === 'say') {
      if (e.text.trim()) outcomeLine = e.text;
    }
  }
  rec.reruns = [...counts.values()].reduce((a, n) => a + (n > 1 ? n - 1 : 0), 0);
  const gaps = {};
  for (const [name, from, to] of GAPS) if (from in steps && to in steps && steps[to] >= steps[from]) gaps[name] = steps[to] - steps[from];
  return {
    ...meta, ...rec,
    steps: Object.fromEntries(Object.entries(steps).map(([k, v]) => [k, iso(v)])), gaps,
    pr, outcomeLine: excerpt(outcomeLine, 160), examples,
    friction: rec.sandboxEperm + rec.guardBlocks + rec.permissionDenied + Object.values(rec.toolDenials).reduce((a, n) => a + n, 0) + Object.values(rec.laneFailures).reduce((a, n) => a + n, 0),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Aggregation: kind x executor, and code vs card-only apart.
const sumOf = (xs, f) => xs.reduce((a, x) => a + f(x), 0);
const mergeCounts = (xs, f) => { const out = {}; for (const x of xs) for (const [k, n] of Object.entries(f(x))) out[k] = (out[k] ?? 0) + n; return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a < b ? -1 : 1)); };

export function summarizeGroup(records) {
  const gaps = {};
  for (const [name] of GAPS) {
    const xs = records.map((r) => r.gaps?.[name]).filter((x) => Number.isFinite(x));
    if (xs.length) gaps[name] = { n: xs.length, medianMin: mins(percentile(xs, 0.5)), p90Min: mins(percentile(xs, 0.9)) };
  }
  const outcomes = {};
  for (const r of records) if (r.outcomeLine) outcomes[r.outcomeLine.slice(0, 80)] = (outcomes[r.outcomeLine.slice(0, 80)] ?? 0) + 1;
  const withEperm = records.filter((r) => r.sandboxEperm > 0);
  const laneEvents = mergeCounts(records, (r) => r.laneFailures);
  return {
    sessions: records.length,
    sessionsWithFriction: records.filter((r) => r.friction > 0).length,
    toolDenials: { total: sumOf(records, (r) => Object.values(r.toolDenials).reduce((a, n) => a + n, 0)), byType: mergeCounts(records, (r) => r.toolDenials) },
    permissionDenied: sumOf(records, (r) => r.permissionDenied),
    guardBlocks: sumOf(records, (r) => r.guardBlocks),
    sandboxEperm: { sessions: withEperm.length, events: sumOf(records, (r) => r.sandboxEperm), admissionSessions: records.filter((r) => r.admissionEperm > 0).length },
    laneFailures: { sessions: records.filter((r) => Object.keys(r.laneFailures).length).length, events: sumOf(Object.values(laneEvents), (n) => n), byType: laneEvents },
    reruns: { events: sumOf(records, (r) => r.reruns), sessions: records.filter((r) => r.reruns > 0).length, afterError: sumOf(records, (r) => r.retriesAfterError) },
    verifyRequests: sumOf(records, (r) => r.verifyRequests),
    reVerifySessions: records.filter((r) => r.verifyRequests > 1).length,
    openPrRuns: sumOf(records, (r) => r.openPrRuns),
    steps: gaps,
    toolErrors: sumOf(records, (r) => r.toolErrors),
    outcomeLines: Object.entries(outcomes).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 3).map(([line, count]) => ({ line, count })),
    truncatedHead: records.filter((r) => r.truncatedHead).length,
  };
}

const groupBy = (records, key) => { const m = new Map(); for (const r of records) { const k = key(r); (m.get(k) ?? m.set(k, []).get(k)).push(r); } return m; };
const tableOf = (records) => Object.fromEntries([...groupBy(records, (r) => `${r.kind}/${r.executor}`)].sort(([a], [b]) => a < b ? -1 : 1).map(([k, xs]) => [k, summarizeGroup(xs)]));

/** `records` carry { kind, executor, pr?, ... }. `prKinds` maps PR number -> 'code' | 'card-only'; unclassified counts as code. */
export function buildFrictions(records, { prKinds = {}, sources = {} } = {}) {
  const kindOfPr = (r) => (r.pr && prKinds[r.pr]) || 'code';
  const builds = records.filter((r) => r.kind === 'build');
  const headlineFor = (executor) => {
    const mine = builds.filter((r) => r.executor === executor);
    return {
      builds: mine.length,
      sandboxEpermBlocked: mine.filter((r) => r.sandboxEperm > 0).length,
      sandboxEpermEvents: sumOf(mine, (r) => r.sandboxEperm),
      admissionEpermBlocked: mine.filter((r) => r.admissionEperm > 0).length,
      laneAlreadyLeasedBuilds: mine.filter((r) => r.laneFailures['lane-already-leased']).length,
      laneAlreadyLeasedEvents: sumOf(mine, (r) => r.laneFailures['lane-already-leased'] ?? 0),
    };
  };
  const executors = [...new Set(builds.map((r) => r.executor))].sort();
  return {
    sessions: records.length,
    headline: Object.fromEntries(executors.map((e) => [e, headlineFor(e)])),
    byKindExecutor: tableOf(records),
    byPrKind: Object.fromEntries(['code', 'card-only'].map((kind) => [kind, tableOf(records.filter((r) => kindOfPr(r) === kind))])),
    top: Object.entries(tableOf(records)).map(([group, s]) => ({ group, sessions: s.sessions, withFriction: s.sessionsWithFriction, sandboxEpermSessions: s.sandboxEperm.sessions, laneFailureSessions: s.laneFailures.sessions, guardBlocks: s.guardBlocks, rerunSessions: s.reruns.sessions }))
      .sort((a, b) => b.withFriction - a.withFriction || (a.group < b.group ? -1 : 1)).slice(0, 8),
    examples: records.flatMap((r) => r.examples.map((e) => ({ group: `${r.kind}/${r.executor}`, session: r.session, ...e }))).slice(0, 12),
    sources,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Collection (IO). Everything is a bounded tail read.
const KIND_ALIAS = { conveyor: 'build' };
export const kindOfSessionName = (name) => { const raw = String(name ?? '').match(/^(.*?)-(?=\d)/)?.[1] || 'other'; return KIND_ALIAS[raw] ?? raw; };

/** fix / ci-heal / review sessions are named for their PR; a build's number is a card, so its PR comes from the transcript. */
const NAMED_PR_KINDS = new Set(['fix', 'ci-heal', 'review']);
const withNamedPr = (rec, name) => { if (NAMED_PR_KINDS.has(rec.kind)) rec.pr = Number(String(name).match(/\d+/)?.[0]) || rec.pr; return rec; };

export function claudeFriction(state, file, { maxBytes } = {}) {
  const read = readTranscriptRows(file, { maxBytes });
  if (!read.found) return null;
  const name = String(state.name ?? '');
  const kind = kindOfSessionName(name);
  return withNamedPr(extractFrictions(claudeEvents(read.rows), { session: String(state.sessionId ?? name), executor: 'claude', kind, truncatedHead: read.truncatedHead }), name);
}

const listDir = (dir, io) => { try { return io.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1); } catch { return []; } };
const readJsonFile = (file, io) => { try { return json(io.readFileSync(file, 'utf8')); } catch { return null; } };

/** `.operations/codex-delivery-threads/<slug>.json` + `.operations/completions/<slug>.json`, across the workspace's checkouts. */
export function readCodexRecords({ env = process.env, home = homedir(), io = fs, limit = 40 } = {}) {
  const roots = env.WE_CORONER_OPS_ROOTS ? env.WE_CORONER_OPS_ROOTS.split(':').filter(Boolean)
    : listDir(join(home, 'workspace'), io).filter((x) => x.isDirectory()).slice(0, 200).map((x) => join(home, 'workspace', x.name, '.operations'));
  const byThread = new Map();
  let scanned = 0;
  for (const root of roots) {
    const dir = join(root, 'codex-delivery-threads');
    for (const f of listDir(dir, io).filter((x) => x.name.endsWith('.json'))) {
      if (scanned++ > 2000) break;
      const rec = readJsonFile(join(dir, f.name), io);
      if (!rec?.threadId || !rec?.sessionSlug) continue;
      const completion = readJsonFile(join(root, 'completions', `${rec.sessionSlug}.json`), io);
      byThread.set(rec.threadId, { slug: String(rec.sessionSlug), completion: completion && { outcome: completion.outcome ?? null, status: completion.status ?? null } });
    }
    if (byThread.size > 5000 || roots.length > limit * 10) break;
  }
  return byThread;
}

/** The first few messages of a rollout (any role), where the brief lives. */
const briefText = (rows) => rows.filter((r) => r.type === 'response_item' && r.payload?.type === 'message').slice(0, 8).map((r) => textOf(r.payload.content)).join('\n').slice(0, 40000);
/** A Codex rollout with no thread record is a build only when its brief says so; judges and other tasks stay out of the build group. */
export function codexKindFromBrief(brief, cwd = '') {
  if (/we-review-seat/.test(cwd) || /Answer APPROVE or REJECT|Check this [\w-]+ against its spec/.test(brief)) return 'review';
  if (/prepare item \d+|Probation worker mode\s+[—-]\s+prepare/i.test(brief)) return 'prepare-item';
  if (/DELIVERY_SESSION|delivery-report-cli|delivery-agent brief|Probation worker mode/i.test(brief)) return 'build';
  return 'task';
}

/** Codex rollouts whose start day touches the window. */
export function collectCodexFrictions(window, { env = process.env, home = homedir(), io = fs, maxFiles = 400, maxBytes } = {}) {
  const base = env.WE_CORONER_CODEX_SESSIONS || join(home, '.codex/sessions');
  const threads = readCodexRecords({ env, home, io });
  const out = [], sources = { found: false, count: 0, joined: 0, threads: threads.size };
  for (const y of listDir(base, io).filter((x) => x.isDirectory())) for (const m of listDir(join(base, y.name), io).filter((x) => x.isDirectory())) for (const d of listDir(join(base, y.name, m.name), io).filter((x) => x.isDirectory())) {
    const day = Date.parse(`${y.name}-${m.name}-${d.name}T00:00:00Z`);
    if (!(Number.isFinite(day) && day + 2 * 86400000 > Date.parse(window.since) && day < Date.parse(window.until))) continue;
    sources.found = true;
    for (const f of listDir(join(base, y.name, m.name, d.name), io).filter((x) => x.name.endsWith('.jsonl'))) {
      if (sources.count >= maxFiles) break;
      const read = readTranscriptRows(join(base, y.name, m.name, d.name, f.name), { maxBytes });
      if (!read.found) continue;
      // A rollout bigger than the tail cap lost its `session_meta` and brief: read them from the head instead, so the thread
      // join, the build/other classification and the start time (window membership) survive truncation.
      const head = read.truncatedHead ? readHeadRows(join(base, y.name, m.name, d.name, f.name), { io }) : [];
      const headRows = head.length ? head : read.rows;
      const metaFull = [...head, ...read.rows].find((r) => r.type === 'session_meta');
      const metaRow = metaFull?.payload ?? {};
      const startedAt = stampMs(metaRow.timestamp ?? metaFull?.timestamp ?? headRows[0]?.timestamp);
      if (!(startedAt >= Date.parse(window.since) && startedAt < Date.parse(window.until))) continue;
      const id = metaRow.id ?? metaRow.session_id ?? threadIdFromRolloutName(f.name);
      const joined = id ? threads.get(id) : null;
      if (joined) sources.joined++;
      const events = codexEvents(read.rows);
      const kind = joined ? kindOfSessionName(joined.slug) : codexKindFromBrief(briefText(headRows), String(metaRow.cwd ?? ''));
      const rec = withNamedPr(extractFrictions(events, { session: String(id ?? f.name), executor: 'codex', kind, truncatedHead: read.truncatedHead }), joined?.slug ?? '');
      rec.recordOutcome = joined?.completion?.outcome ?? null;
      rec.at = iso(startedAt);
      sources.count++; out.push(rec);
    }
  }
  return { records: out, sources };
}

export function collectAgyFrictions(window, { env = process.env, home = homedir(), io = fs, maxFiles = 200, maxBytes } = {}) {
  const dir = env.WE_CORONER_AGY_TRANSCRIPTS || join(home, '.antigravity-judge-transcripts');
  const out = [], sources = { found: false, count: 0 };
  for (const f of listDir(dir, io).filter((x) => x.name.endsWith('.jsonl'))) {
    sources.found = true;
    if (sources.count >= maxFiles) break;
    let mtime; try { mtime = io.statSync(join(dir, f.name)).mtimeMs; } catch { continue; }
    if (!(mtime >= Date.parse(window.since) && mtime < Date.parse(window.until))) continue;
    const read = readTranscriptRows(join(dir, f.name), { maxBytes });
    if (!read.found) continue;
    // The `init` row is the first line: a truncated tail lost it, so read it from the head (same fix as the Codex meta).
    const init = [...(read.truncatedHead ? readHeadRows(join(dir, f.name), { io }) : []), ...read.rows].find((r) => r.event === 'init')?.init ?? {};
    const kind = /judge|juror/.test(String(init.cwd ?? '')) ? 'review' : 'task';
    out.push(extractFrictions(agyEvents(read.rows), { session: f.name.replace(/\.jsonl$/, ''), executor: 'agy', kind, truncatedHead: read.truncatedHead }));
    sources.count++;
  }
  return { records: out, sources };
}

// ---------------------------------------------------------------------------------------------------------------
// Build dispatch run records (S2): the real result of each launch, by kind x executor.
export function laneFailureType(text) {
  const s = String(text ?? '');
  return LANE_LEASED.test(s) ? 'lane-already-leased' : LANE_ACQUIRE_FAIL.test(s) ? 'lane-acquire-failed' : null;
}

/** `<coord>/build-dispatch-runs/dispatch-lane-*.json` rows started in the window. Bounded: 1 MiB per file, mtime pre-filter. */
export function collectDispatchRuns(window, { coord, io = fs, maxFiles = 3000, maxBytes = MiB } = {}) {
  const dir = join(coord, 'build-dispatch-runs');
  const rows = [], sources = { found: false, count: 0, skippedLarge: 0 };
  const sinceMs = Date.parse(window.since), untilMs = Date.parse(window.until);
  let seen = 0;
  for (const f of listDir(dir, io).filter((x) => /^dispatch-lane-.*\.json$/.test(x.name))) {
    sources.found = true;
    if (seen++ >= maxFiles) break;
    let st; try { st = io.statSync(join(dir, f.name)); } catch { continue; }
    if (st.mtimeMs < sinceMs) continue;
    if (st.size > maxBytes) { sources.skippedLarge++; continue; }
    const rec = readJsonFile(join(dir, f.name), io);
    if (!rec || !Array.isArray(rec.effects)) continue;
    for (const e of rec.effects) {
      const startedAt = stampMs(e.startedAt ?? e.lastAttemptAt);
      if (!(startedAt >= sinceMs && startedAt < untilMs)) continue;
      const num = rec.input?.num ?? e.payload?.num ?? null;
      rows.push({ runId: rec.id, num: num === null ? null : String(num), launchKind: String(e.dispatch?.launchKind ?? 'unknown'), executor: String(e.dispatch?.executor ?? 'unknown'), status: String(e.status ?? 'unknown'), outcome: typeof e.result?.outcome === 'string' ? e.result.outcome : null, pr: Number(e.result?.pr) || null, error: e.error ? excerpt(e.error, 160) : null, startedAt: iso(startedAt) });
    }
    sources.count++;
  }
  return { rows, sources };
}

/**
 * Outcomes use the run's recorded result, not a guess. `orphan-released` rows predate the settle fix
 * (xykwe0h) and are reported as-is under `legacyOrphanReleased`; this does not re-derive PRs from GitHub.
 */
export function summarizeBuildOutcomes(rows, { prKinds = {} } = {}) {
  const label = (r) => r.outcome ?? (r.status === 'in-flight' ? 'in-flight' : r.status === 'failed' ? 'failed-no-result' : r.status);
  const table = (xs) => Object.fromEntries([...groupBy(xs, (r) => `${r.launchKind}/${r.executor}`)].sort(([a], [b]) => a < b ? -1 : 1).map(([k, ys]) => {
    const outcomes = {}; for (const r of ys) outcomes[label(r)] = (outcomes[label(r)] ?? 0) + 1;
    const lane = {}; for (const r of ys) { const t = laneFailureType(r.error); if (t) lane[t] = (lane[t] ?? 0) + 1; }
    return [k, { runs: ys.length, outcomes: Object.fromEntries(Object.entries(outcomes).sort(([a], [b]) => a < b ? -1 : 1)), laneFailures: lane, legacyOrphanReleased: ys.filter((r) => r.outcome === 'orphan-released').length }];
  }));
  const kindOf = (r) => (r.pr && prKinds[r.pr]) || 'code';
  return { total: rows.length, byKindExecutor: table(rows), byPrKind: Object.fromEntries(['code', 'card-only'].map((k) => [k, table(rows.filter((r) => kindOf(r) === k))])), note: 'result.outcome of each dispatch-lane run record; orphan-released = pre-settle-fix record, not re-derived. PR kind known only when the record names a PR; unclassified counts as code.' };
}
