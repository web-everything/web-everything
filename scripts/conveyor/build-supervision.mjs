/**
 * @file scripts/conveyor/build-supervision.mjs
 * @description Health-watch supervision of conveyor BUILD and PREPARE work (operator 2026-10-06: "start but with
 *   strong supervision, I don't want model spinning for nothing"). DETECTION ONLY — nothing here stops, kills or
 *   signals anything. Lives OUTSIDE `health-smells/` (that directory is disk-discovered; every file there must be
 *   a smell module). Feeds four smells: `build-session-idle`, `build-session-overrun`, `build-session-looping`
 *   (Claude sessions) and `external-run-stalled` (Codex/other external runs).
 *
 * WHY TWO SOURCES: a build/prepare the daemon routes to Codex runs as a detached `codex-direct-task` process, never
 * as a Claude session, so `claude agents --json` / `~/.claude/jobs` cannot see it. Its liveness lives in the build
 * daemon's dispatch run records (`<coordination>/build-dispatch-runs/dispatch-lane-*.json`, one `effects[]` entry
 * per launch: `status`, `handle` = `pid:<n>`, `startedAt`, `expectedBy`, `dispatch.executor`, `payload.lane`)
 * plus the worker's own output log in its lane (`<lane>/.git/<provider>-direct-task.jsonl`), whose mtime is the
 * only output-growth signal there is.
 *
 * Every read is bounded: transcripts by a byte-capped tail, run records by mtime window + a file-count cap.
 * A thing that cannot be read is reported as unknown (`null`), never guessed stale.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tailLines, summarizeEntry, detectBlockedOnChild } from '../../skills-src/inspect-agent-health/agent-health.mjs';
import { resolveSessionTranscript } from '../operations/agent-usage-report.mjs';

const MINUTE = 60_000;

/** Declared thresholds — the defaults the operator named. Each smell re-declares its own as a field. */
export const BUILD_SUPERVISION_DEFAULTS = Object.freeze({
  idleMs: 12 * MINUTE,
  overrunMs: 60 * MINUTE,
  repeatCount: 4,
  stallMs: 12 * MINUTE,
  unconfirmedMs: 10 * MINUTE,
});

/** conveyor-4452 (build), prepare-item-4773, prepare-decision-4090, prepare-4090, build-4452 → {kind, num}. */
const SESSION_NAME_RE = /^(conveyor|build|prepare-item|prepare-decision|prepare)-(\d+)$/;
export function parseBuildSessionName(name) {
  const m = SESSION_NAME_RE.exec(String(name ?? ''));
  if (!m) return null;
  return { kind: m[1] === 'conveyor' || m[1] === 'build' ? 'build' : 'prepare', num: m[2] };
}

const isLiveAgent = (a) => a?.state !== 'done' && a?.state !== 'stopped' && a?.state !== 'failed';
const toMs = (v) => (Number.isFinite(Number(v)) && Number(v) > 1e11 ? Number(v) : Date.parse(v ?? ''));

/** Normalise a shell command for "same command again": trim + collapse whitespace. Pure. */
export function normalizeCommand(cmd) {
  return String(cmd ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * The most-repeated Bash command among the LAST `window` Bash commands in `entries` (summarizeEntry shape). Pure.
 * @returns {{command:string, count:number}|null}
 */
export function mostRepeatedCommand(entries, window = 30) {
  const cmds = [];
  for (const e of entries || []) {
    for (const b of e?.blocks || []) {
      if (b.kind === 'tool_use' && b.name === 'Bash' && typeof b.rawInput?.command === 'string') {
        const c = normalizeCommand(b.rawInput.command);
        if (c) cmds.push(c);
      }
    }
  }
  const recent = cmds.slice(-window);
  const counts = new Map();
  for (const c of recent) counts.set(c, (counts.get(c) ?? 0) + 1);
  let best = null;
  for (const [command, count] of counts) if (!best || count > best.count) best = { command, count };
  return best;
}

/** Bounded read of one session transcript: last activity, pending tool call, repeated command. Never throws. */
export function readSessionActivity(agent, {
  resolveTranscript = resolveSessionTranscript, tail = tailLines, summarize = summarizeEntry, stat = statSync,
  tailLineCount = 200, maxBytes = 600_000, fieldMax = 300,
} = {}) {
  if (!agent?.cwd || !agent?.sessionId) return null;
  let file;
  try { file = resolveTranscript({ session: String(agent.sessionId), cwd: String(agent.cwd) }); } catch { return null; }
  let entries = [];
  try {
    const { lines } = tail(file, tailLineCount, maxBytes);
    entries = (Array.isArray(lines) ? lines : []).map((l) => { try { return summarize(l, fieldMax); } catch { return null; } }).filter(Boolean);
  } catch { /* fall through to mtime only */ }
  let lastActivityMs = null;
  try { lastActivityMs = stat(file).mtimeMs; } catch { /* unknown */ }
  for (const e of entries) {
    const t = Date.parse(e?.ts ?? '');
    if (Number.isFinite(t) && (lastActivityMs === null || t > lastActivityMs)) lastActivityMs = t;
  }
  let pending = false;
  try { pending = detectBlockedOnChild(entries).pending === true; } catch { /* unknown */ }
  return { file, lastActivityMs, pendingToolCall: pending, repeated: mostRepeatedCommand(entries) };
}

/** Best-effort PR for a backlog item: an open PR whose branch or title names the item number. */
function prForItem(prs, num) {
  const re = new RegExp(`(?:^|[^0-9])${num}(?:[^0-9]|$)`);
  const hit = (prs || []).find((p) => re.test(String(p?.headRefName ?? '')) || re.test(String(p?.title ?? '')));
  return hit ? { number: hit.number, title: hit.title ?? null } : null;
}

/**
 * Probe: live Claude build/prepare sessions with age, idle time, pending-call flag, and the most-repeated recent
 * Bash command. One row per live session whose name matches {@link parseBuildSessionName}.
 */
export function probeBuildSessions(agents, { nowMs = Date.now(), prs = [], read = readSessionActivity } = {}) {
  const rows = [];
  for (const a of Array.isArray(agents) ? agents : []) {
    const parsed = parseBuildSessionName(a?.name);
    if (!parsed || !isLiveAgent(a)) continue;
    const startedMs = toMs(a.startedAt);
    const act = read(a);
    rows.push({
      name: a.name, kind: parsed.kind, card: parsed.num, sessionId: a.sessionId ?? null, state: a.state ?? null,
      pr: prForItem(prs, parsed.num),
      ageMs: Number.isFinite(startedMs) ? Math.max(0, nowMs - startedMs) : null,
      idleMs: act && Number.isFinite(act.lastActivityMs) ? Math.max(0, nowMs - act.lastActivityMs) : null,
      pendingToolCall: act?.pendingToolCall ?? null,
      repeated: act?.repeated ?? null,
      transcriptPath: act?.file ?? null,
    });
  }
  return rows;
}

const defaultAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; } };

/**
 * Probe: in-flight EXTERNAL (non-Claude) build/prepare runs from the build daemon's dispatch run records.
 * Only records modified within `recordWindowMs` are read (bounded by `maxFiles`); a dead pid is skipped (the
 * daemon's own reconcile owns dead runs — this smell is about runs that are ALIVE but not producing output).
 * @returns {Array<{runId, card, kind, lane, pr, executor, handle, pid, startedAt, ageMs, confirmed, outputAgeMs, heartbeatAgeMs, outputFile}>}
 */
export function probeExternalRuns({
  runsDir, lanesRoot, nowMs = Date.now(), recordWindowMs = 6 * 60 * MINUTE, maxFiles = 80,
  isAlive = defaultAlive, ls = readdirSync, stat = statSync, readText = (p) => readFileSync(p, 'utf8'),
} = {}) {
  let names;
  try { names = ls(runsDir).filter((n) => n.startsWith('dispatch-lane-') && n.endsWith('.json')); } catch { return []; }
  const recent = [];
  for (const n of names) {
    try { const m = stat(join(runsDir, n)).mtimeMs; if (nowMs - m <= recordWindowMs) recent.push({ n, m }); } catch { /* raced */ }
  }
  recent.sort((a, b) => b.m - a.m);
  const rows = [];
  for (const { n } of recent.slice(0, maxFiles)) {
    let rec; try { rec = JSON.parse(readText(join(runsDir, n))); } catch { continue; }
    for (const e of rec?.effects || []) {
      if (e?.status !== 'in-flight') continue;
      const executor = e?.dispatch?.executor ?? null;
      if (!executor || executor === 'claude') continue;
      const pm = /^pid:(\d+)$/.exec(String(e.handle ?? ''));
      const pid = pm ? Number(pm[1]) : null;
      if (pid && !isAlive(pid)) continue;
      const startedMs = Date.parse(e.startedAt ?? '');
      const lane = e?.payload?.lane ?? null;
      let outputAgeMs = null, outputFile = null;
      if (lane != null && lanesRoot) {
        for (const f of [`${executor}-direct-task.jsonl`, 'codex-direct-task.jsonl']) {
          const p = join(lanesRoot, 'web-everything', `lane-${lane}`, '.git', f);
          try { outputAgeMs = Math.max(0, nowMs - stat(p).mtimeMs); outputFile = p; break; } catch { /* next */ }
        }
      }
      const hb = Date.parse(e.lastSeenLiveAt ?? '');
      rows.push({
        runId: rec.id ?? n, card: String(e?.payload?.num ?? ''), kind: e?.dispatch?.launchKind ?? e?.payload?.launchKind ?? null,
        lane, pr: e?.payload?.pr ?? null, executor, handle: e.handle ?? null, pid,
        startedAt: e.startedAt ?? null,
        ageMs: Number.isFinite(startedMs) ? Math.max(0, nowMs - startedMs) : null,
        confirmed: Boolean(pid),
        outputAgeMs, outputFile,
        heartbeatAgeMs: Number.isFinite(hb) ? Math.max(0, nowMs - hb) : null,
      });
    }
  }
  return rows;
}

export const fmtMin = (ms) => `${Math.round(ms / MINUTE)} min`;
