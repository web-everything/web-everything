/**
 * Card 103 - /coroner reads Codex and agy (Antigravity) run logs, not just Claude transcripts, and compares the
 * three executors side by side. Pure parsers over already-read lines (bounded reads happen in collectExecutorLogs).
 *
 * Log sources (all read-only, bounded, tokens/secrets never copied out - only counts and ids):
 *   codex  ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl   (session_meta, custom_tool_call exec, token_count, task_complete)
 *   codex  <coord>/codex-pilot.jsonl                      (card, PR, minutes, outcome, codex.threadId): the run record
 *   agy    ~/.antigravity-judge-transcripts/antigravity-judge-<conversation>.jsonl  (init, step_update, result)
 */
import fs from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { classifyDenial, normalizeCommand, percentile, readBounded } from './coroner-extract.mjs';

const MiB = 1024 * 1024;
const ms = (a, b) => (Number.isFinite(a) && Number.isFinite(b) && a >= b ? a - b : 0);
const jsonRows = (lines) => lines.flatMap((l) => { try { const o = JSON.parse(l); return o && typeof o === 'object' ? [o] : []; } catch { return []; } });
const minutesOf = (x) => Math.round((x / 60000) * 10) / 10;
const prOf = (text) => Number(/\b(?:PR|pull)\s*#?(\d{2,6})\b/i.exec(text)?.[1] ?? 0) || null;

/** Shared summary over per-run records ({ ok, ms, tokens, task, role }). */
function loops(commands) {
  const counts = new Map();
  for (const c of commands) counts.set(c, (counts.get(c) ?? 0) + 1);
  return [...counts].filter(([, n]) => n >= 3).map(([command, count]) => ({ command, count }));
}

/** One Codex rollout -> a run record. `pilot` maps threadId -> { card, pr, outcome, minutes }. */
export function parseCodexRollout(lines, { pilot = {} } = {}) {
  const rows = jsonRows(lines);
  const meta = rows.find((r) => r.type === 'session_meta')?.payload ?? {};
  const id = meta.id ?? meta.session_id ?? null;
  const cwd = String(meta.cwd ?? '');
  let first = null, last = null, prompt = '', done = false, aborted = false, tokens = 0, waitMs = 0, errors = 0, denials = 0;
  const commands = [];
  for (const r of rows) {
    const t = Date.parse(r.timestamp);
    if (Number.isFinite(t)) { first = first === null ? t : Math.min(first, t); last = last === null ? t : Math.max(last, t); }
    const p = r.payload ?? {};
    if (!prompt && p.item?.type === 'UserMessage') prompt = String(p.item.content?.[0]?.text ?? '').slice(0, 2000);
    if (r.type === 'event_msg' && p.type === 'task_complete') done = true;
    if (r.type === 'event_msg' && p.type === 'turn_aborted') aborted = true;
    if (r.type === 'event_msg' && p.type === 'token_count') tokens = Math.max(tokens, Number(p.info?.total_token_usage?.total_tokens) || 0);
    if (p.type === 'custom_tool_call' && p.name === 'exec') {
      for (const m of String(p.input ?? '').matchAll(/\bcmd\s*:\s*("(?:[^"\\]|\\.)*")/g)) { try { commands.push(normalizeCommand(JSON.parse(m[1]))); } catch { /* skip */ } }
    }
    if (p.type === 'custom_tool_call_output' || p.type === 'function_call_output') {
      const text = typeof p.output === 'string' ? p.output : (p.output ?? []).map?.((x) => x?.text ?? '').join('\n') ?? '';
      for (const m of text.matchAll(/exit_code\\*"\s*:\s*(-?\d+)/g)) if (Number(m[1]) !== 0) errors++;
      if (classifyDenial(text.slice(0, 4000), false)) denials++;
      const w = /Wall time:\s*([\d.]+)\s*seconds/.exec(text); if (p.type === 'function_call_output' && w) waitMs += Number(w[1]) * 1000;
    }
  }
  const pilotRow = pilot[id] ?? null;
  const role = /we-review-seat/.test(cwd) ? 'review' : /delivery-agent brief|^Card \d+ slice|^Implement/i.test(prompt) ? 'build' : /prepare/i.test(prompt.slice(0, 200)) ? 'prepare' : 'task';
  const task = pilotRow?.card ? `card-${pilotRow.card}` : prOf(prompt) ? `pr-${prOf(prompt)}` : /\/lane-\d+/.test(cwd) ? `cwd-${cwd.split('/').slice(-2).join('/')}` : `session-${id}`;
  return {
    executor: 'codex', id, role, task, link: pilotRow ? 'codex-pilot' : prOf(prompt) ? 'prompt' : 'cwd',
    at: first === null ? null : new Date(first).toISOString(), ms: ms(last, first), tokens, waitMs,
    commands: commands.length, errors, denials, loops: loops(commands),
    outcome: pilotRow?.outcome ?? (done ? 'completed' : aborted ? 'aborted' : 'incomplete'), failed: !done && !pilotRow?.outcome?.startsWith?.('pr-') || aborted,
  };
}

/** One agy stream-json transcript -> a run record. */
export function parseAgyTranscript(lines, { mtime = null } = {}) {
  const rows = jsonRows(lines);
  const init = rows.find((r) => r.event === 'init');
  const result = rows.filter((r) => r.event === 'result').at(-1)?.result;
  const steps = rows.filter((r) => r.event === 'step_update').map((r) => r.step_update);
  const tools = steps.filter((s) => s.step_type === 'tool' && s.state !== 'ACTIVE');
  const toolErrors = tools.filter((s) => s.state === 'ERROR').length;
  const cwd = String(init?.init?.cwd ?? '');
  const id = result?.conversation_id ?? init?.conversation_id ?? null;
  const names = tools.map((s) => s.tool_name ?? '');
  return {
    executor: 'agy', id, role: /agy-juror|judge/.test(cwd) || result?.json_schema ? 'review' : 'task', task: `session-${id}`, link: 'transcript-only',
    model: init?.init?.model ?? 'unknown', at: mtime, ms: Math.round((Number(result?.duration_seconds) || 0) * 1000),
    tokens: Number(result?.usage?.total_tokens) || 0, waitMs: 0, commands: tools.length, errors: toolErrors, denials: 0, loops: loops(names),
    outcome: result?.status === 'SUCCESS' ? 'completed' : result ? 'error' : 'incomplete', failed: result?.status !== 'SUCCESS',
  };
}

/** Per-executor table. `claude` = { sessions: [{ task, ms, failed }] } from the job records. */
export function executorTable(runsByExecutor) {
  const out = {};
  for (const [executor, runs] of Object.entries(runsByExecutor)) {
    const tasks = new Set(runs.map((r) => r.task));
    const times = runs.map((r) => r.ms).filter((x) => x > 0);
    const tokens = runs.reduce((a, r) => a + (r.tokens || 0), 0);
    out[executor] = {
      runs: runs.length, tasks: tasks.size, roundsPerTask: tasks.size ? Math.round((runs.length / tasks.size) * 10) / 10 : 0,
      errorRatePct: runs.length ? Math.round((1000 * runs.filter((r) => r.failed).length) / runs.length) / 10 : 0,
      medianMin: minutesOf(percentile(times, 0.5)), p90Min: minutesOf(percentile(times, 0.9)),
      commands: runs.reduce((a, r) => a + (r.commands || 0), 0), toolErrors: runs.reduce((a, r) => a + (r.errors || 0), 0),
      denials: runs.reduce((a, r) => a + (r.denials || 0), 0), loopRuns: runs.filter((r) => r.loops?.length).length,
      tokens: tokens || null, byRole: runs.reduce((m, r) => { m[r.role] = (m[r.role] ?? 0) + 1; return m; }, {}),
    };
  }
  return out;
}

export function executorMarkdown(table, window) {
  const rows = Object.entries(table).map(([e, t]) => `| ${e} | ${t.runs} | ${t.tasks} | ${t.roundsPerTask} | ${t.errorRatePct}% | ${t.medianMin} | ${t.p90Min} | ${t.tokens ?? 'n/a'} | ${t.commands} | ${t.toolErrors} |`);
  return [`# Executors ${window.since} .. ${window.until}`, '', '| executor | runs | tasks | rounds/task | error rate | median min | p90 min | tokens | commands | tool errors |', '|---|---|---|---|---|---|---|---|---|---|', ...rows, ''].join('\n');
}

const inWin = (iso, w) => { const t = Date.parse(iso); return Number.isFinite(t) && t >= Date.parse(w.since) && t < Date.parse(w.until); };

/** Bounded collection: per-file cap, file-count cap. Returns { runs: { codex, agy }, sources }. */
export function collectExecutorLogs(window, { env = process.env, home = homedir(), io = fs, maxFiles = 600 } = {}) {
  const dirs = {
    codex: env.WE_CORONER_CODEX_SESSIONS || join(home, '.codex/sessions'),
    agy: env.WE_CORONER_AGY_TRANSCRIPTS || join(home, '.antigravity-judge-transcripts'),
    pilot: env.WE_CORONER_CODEX_PILOT || join(home, 'workspace/.operations/coordination/codex-pilot.jsonl'),
  };
  const cap = Number(env.WE_CORONER_EXECUTOR_CAP) || 4 * MiB;
  const sources = { codex: { found: false, count: 0 }, agy: { found: false, count: 0 }, pilot: { found: false, count: 0 } };
  const pilot = {};
  const pr = readBounded(dirs.pilot, { cap: MiB, io });
  sources.pilot = { found: pr.found, count: 0 };
  for (const r of jsonRows(pr.lines)) if (r.codex?.threadId) { pilot[r.codex.threadId] = { card: r.card, outcome: r.outcome, minutes: r.minutes }; sources.pilot.count++; }
  const list = (d) => { try { return io.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1)); } catch { return []; } };
  const codex = [], agy = [];
  const days = [];
  for (const y of list(dirs.codex).filter((x) => x.isDirectory())) for (const m of list(join(dirs.codex, y.name)).filter((x) => x.isDirectory())) for (const d of list(join(dirs.codex, y.name, m.name)).filter((x) => x.isDirectory())) {
    const day = Date.parse(`${y.name}-${m.name}-${d.name}T00:00:00Z`);
    // A rollout lives in its start-day folder (UTC); keep the day before the window for runs that straddle it.
    if (Number.isFinite(day) && day + 2 * 86400000 > Date.parse(window.since) && day < Date.parse(window.until)) days.push(join(dirs.codex, y.name, m.name, d.name));
  }
  sources.codex.found = days.length > 0 || list(dirs.codex).length > 0;
  for (const dir of days) for (const f of list(dir).filter((x) => x.name.endsWith('.jsonl'))) {
    if (sources.codex.count >= maxFiles) break;
    const data = readBounded(join(dir, f.name), { cap, io }); if (!data.found) continue;
    const run = parseCodexRollout(data.lines, { pilot });
    if (!inWin(run.at, window)) continue;
    sources.codex.count++; codex.push(run);
  }
  const agyFiles = list(dirs.agy).filter((x) => x.name.endsWith('.jsonl'));
  sources.agy.found = agyFiles.length > 0;
  for (const f of agyFiles) {
    if (sources.agy.count >= maxFiles) break;
    const file = join(dirs.agy, f.name);
    let mtime = null; try { mtime = io.statSync(file).mtime.toISOString(); } catch { continue; }
    if (!inWin(mtime, window)) continue;
    const data = readBounded(file, { cap, io }); if (!data.found) continue;
    sources.agy.count++; agy.push(parseAgyTranscript(data.lines, { mtime }));
  }
  return { runs: { codex, agy }, sources };
}
