#!/usr/bin/env node
/**
 * @file scripts/conveyor/session-watchdog.mjs
 * @description THE SESSION WATCHDOG (card xegykal, epic #3383). Operator ruling 2026-10-04 ~09:30 ET: "we need a
 *   system that actually checks the transcript at regular intervals after standard duration".
 *
 * LIVE INCIDENT (2026-10-04, 09:20 ET manual check). `fix-3771` held its PR fix claim for 1h27 with no push. It
 * was looping on `verify-lane check --wait=540000` — 11 nine-minute waits — so its transcript was never idle and
 * `hung-session.mjs` (a 30-minute idle test, with 3x grace while a call is pending) never fired. Nothing measured
 * how long a fix claim had been held, and four September sessions (prepare-2768, fix-2003, fix-2115, fix-2267)
 * still read `state: working` in `claude agents --json` with transcripts 18-28 days old.
 *
 * WHAT IT DOES. Every `intervalMinutes` (run by the health watch, `health-watch.mjs#probeSessionWatchdog`), for
 * each live conveyor session (fix-, ci-heal-, review-, build-/conveyor-, prepare-) whose runtime has passed its
 * kind's STANDARD DURATION, it reads a BOUNDED tail of that session's own transcript (matched by session id,
 * through the same `agent-health.mjs` reader `hung-session.mjs` uses) and classifies it:
 *   - active-progress   — distinct tool calls, nothing above applies (edits/commits counted as evidence);
 *   - waiting-loop      — the same command repeated `waitLoopRepeats` times in the last `waitLoopWindowCalls` calls,
 *                         those calls together taking at least `waitLoopMinMinutes` (a habit like `git log -1` is not a wait)
 *                         and no edit or commit since its first run in that window (iterating on a fix is not waiting);
 *   - stalled           — idle past `stalledIdleMinutes`, or one call pending past `stalledBlockedMinutes`;
 *   - finished-but-listed — a `done` completion record exists, or the transcript ended on a plain reply;
 *   - ghost             — listed non-terminal, but the transcript is older than `ghostHours` and no process is alive.
 *
 * STANDARD DURATION reuses heavy-admission's rolling medians (`readStandardMinutes`, the numbers behind
 * `queueAdmission.standardMinutes`/`byKind`): a kind's heavy demand (`dispatchDemandMinutes`) x `standardFactor`,
 * never below that kind's `floorMinutes`. With fewer than `minSamples` samples, or a kind with no heavy demand
 * (review/prepare are exempt), it falls back to `fallbackMinutes[kind]`.
 *
 * WHAT IT DOES ABOUT IT — existing product paths only, never a kill:
 *   - a stuck fixer (waiting-loop or stalled while holding a PR fix claim) → a finding for the `fixer-stuck`
 *     health smell AND a typed hand-off event for the fixer-escalation ladder (contract below);
 *   - a fix claim held past the standard duration while the PR head still equals the claimed head → a finding for
 *     the `fix-claim-held-no-progress` smell;
 *   - a ghost → `claude rm <id>` (session-reaper's own `rmSessionRecord`, the deregistration `claude agents` reads;
 *     the reaper already `claude stop`-ped these — a pending in-flight cron task kept them listed `working`), then
 *     ONE re-listing to confirm it is gone: `claude rm` can report success and leave the row (Claude Code issue
 *     #77683), so a row still listed is recorded in `rm-ineffective.json`, not retried for `ghostHours`, and left to
 *     the `ghost-session-listed` smell (whose fix is the human-confirmed `clear-stuck-session` operation). Any live
 *     claim a ghost still holds is released through `fix-procedure.mjs#releaseFixClaim` /
 *     `fix-dispatch-claim.mjs#releaseSessionFixDispatchClaims`.
 *
 * ESCALATION EVENT CONTRACT (v1) — consumed by the fixer-escalation ladder (sibling PR #3889) once it lands.
 * Append-only JSONL at `<coordination root>/session-watchdog/fixer-escalations.jsonl`, one line per new
 * (repo, pr, session, classification, head) — never repeated for the same key:
 *   { "type": "session-watchdog.fixer-stuck", "v": 1, "key": "...", "at": "<iso>", "repo": "we", "pr": 3771,
 *     "claimKind": "fixing", "session": { "name": "fix-3771", "id": "f29aeb29", "sessionId": "<uuid>" },
 *     "classification": "waiting-loop"|"stalled", "reason": "...", "headSha": "<claimed head>",
 *     "evidence": { "repeats": 11, "signature": "...", "idleMinutes": 4, "pendingTool": "Bash",
 *                   "claimAgeMinutes": 87, "standardMinutes": 20 },
 *     "ask": "escalate-fixer" }
 * A consumer acknowledges by appending `{ "key": "<same key>", "by": "<who>", "at": "<iso>" }` to
 * `fixer-escalations.ack.jsonl` beside it; the `fixer-stuck` smell then stops marking the episode human-only.
 *
 * PURE CORE (no fs/exec/clock): {@link resolveSessionWatchdogConfig}, {@link watchdogKindOf},
 * {@link standardDuration}, {@link commandSignature}, {@link summarizeTail}, {@link classifyWatchdogSession},
 * {@link planWatchdog}. IO SHELL: {@link runSessionWatchdogPass} (every IO seam injectable) and the CLI.
 *
 * CHEAP BY CONSTRUCTION: one `claude agents --json` listing (the health watch passes its own), local file reads
 * only (transcript tails, the claim store, the shared open-PR snapshot read cache-only, completion records) — no
 * GitHub or model API call in the loop.
 *
 * Usage:
 *   node scripts/conveyor/session-watchdog.mjs [--json]          # one pass, report only (never acts)
 *   node scripts/conveyor/session-watchdog.mjs --apply [--json]  # one pass that also takes its actions
 */
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { tailLines, summarizeEntry, detectBlockedOnChild } from '../../skills-src/inspect-agent-health/agent-health.mjs';
import { readTranscriptTailActivity } from './hung-session.mjs';
import { parseSessionSlug } from './session-slug.mjs';
import { dispatchDemandMinutes } from '../readiness/heavy-queue-projection.mjs';
import { readStandardMinutes, admissionLockRoot } from '../readiness/heavy-admission.mjs';
import { resolveCoordinationRoot } from '../operations/coordination-root.mjs';
import { listLiveFixClaims, releaseFixClaim, FIXING_KIND } from './fix-procedure.mjs';
import { releaseSessionFixDispatchClaims } from './fix-dispatch-claim.mjs';
import { makeCompletionResolver, rmSessionRecord } from './session-reaper.mjs';
import { readSharedOpenPrs } from '../lib/pr-snapshot.mjs';
import { CONSTELLATION_REPOS } from '../lib/constellation-repos.mjs';
import { isProcessAlive } from './health-smells/ghost-sessions-inflate-cap.mjs';

const MINUTE = 60_000;
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const WATCHDOG_KINDS = Object.freeze(['fix', 'ci-heal', 'review', 'build', 'prepare']);
export const CLASSES = Object.freeze({
  ACTIVE: 'active-progress', WAITING: 'waiting-loop', STALLED: 'stalled', FINISHED: 'finished-but-listed', GHOST: 'ghost',
  WITHIN: 'within-standard', NO_SIGNAL: 'no-signal',
});
export const STUCK_CLASSES = Object.freeze([CLASSES.WAITING, CLASSES.STALLED]);
export const ESCALATION_EVENT_TYPE = 'session-watchdog.fixer-stuck';

const kindMap = (o) => Object.freeze({ ...o });
/** The platform default. A local override (the health watch's own `config.json`, key `sessionWatchdog`) is merged
 *  ON TOP of it — scalar keys replace, the per-kind maps merge by kind — and an invalid override is reported and
 *  ignored (the default stands), never half-applied. Every threshold and the interval are config dimensions. */
export const DEFAULT_SESSION_WATCHDOG = Object.freeze({
  intervalMinutes: 5,
  standardFactor: 2,
  minSamples: 5,
  floorMinutes: kindMap({ fix: 20, 'ci-heal': 20, review: 15, build: 30, prepare: 20 }),
  fallbackMinutes: kindMap({ fix: 45, 'ci-heal': 45, review: 30, build: 90, prepare: 45 }),
  waitLoopRepeats: 3,
  waitLoopWindowCalls: 12,
  waitLoopMinMinutes: 15,
  stalledIdleMinutes: 30,
  stalledBlockedMinutes: 45,
  finishedIdleMinutes: 10,
  ghostHours: 24,
  prHeadMaxAgeMinutes: 30,
  tailLines: 200,
  tailMaxBytes: 1_500_000,
  act: true,
});
const SCALAR_KEYS = ['intervalMinutes', 'standardFactor', 'minSamples', 'waitLoopRepeats', 'waitLoopWindowCalls', 'waitLoopMinMinutes',
  'stalledIdleMinutes', 'stalledBlockedMinutes', 'finishedIdleMinutes', 'ghostHours', 'prHeadMaxAgeMinutes',
  'tailLines', 'tailMaxBytes'];
const KIND_MAP_KEYS = ['floorMinutes', 'fallbackMinutes'];

/**
 * Merge an override over the platform default. Never throws: `{config, error}` with the default on any problem.
 * PURE.
 */
export function resolveSessionWatchdogConfig(override, base = DEFAULT_SESSION_WATCHDOG) {
  if (override == null) return { config: base, error: null };
  try {
    if (typeof override !== 'object' || Array.isArray(override)) throw new TypeError('override must be an object');
    const known = [...SCALAR_KEYS, ...KIND_MAP_KEYS, 'act'];
    for (const k of Object.keys(override)) if (!known.includes(k)) throw new TypeError(`unknown key ${k}`);
    const out = { ...base };
    for (const k of SCALAR_KEYS) {
      if (!(k in override)) continue;
      const n = override[k];
      if (!Number.isFinite(n) || n <= 0) throw new TypeError(`${k} must be a positive number`);
      out[k] = n;
    }
    for (const k of KIND_MAP_KEYS) {
      if (!(k in override)) continue;
      const m = override[k];
      if (!m || typeof m !== 'object' || Array.isArray(m)) throw new TypeError(`${k} must be an object keyed by kind`);
      const merged = { ...base[k] };
      for (const [kind, v] of Object.entries(m)) {
        if (!WATCHDOG_KINDS.includes(kind)) throw new TypeError(`${k}.${kind}: unknown kind (use ${WATCHDOG_KINDS.join('|')})`);
        if (!Number.isFinite(v) || v <= 0) throw new TypeError(`${k}.${kind} must be a positive number`);
        merged[kind] = v;
      }
      out[k] = Object.freeze(merged);
    }
    if ('act' in override) {
      if (typeof override.act !== 'boolean') throw new TypeError('act must be a boolean');
      out.act = override.act;
    }
    return { config: Object.freeze(out), error: null };
  } catch (e) {
    return { config: base, error: `session-watchdog config: ${e?.message || e}` };
  }
}

/** A dispatcher-minted session name → `{kind, repo, id, prBound}` in watchdog terms, or `null` for any other
 *  name (an interactive session, an unknown grammar). PURE. */
export function watchdogKindOf(name) {
  const s = String(name ?? '');
  const p = parseSessionSlug(s);
  if (p) {
    const kind = p.kind === 'conveyor' ? 'build' : p.kind === 'prepare-decision' ? 'prepare' : p.kind;
    if (!WATCHDOG_KINDS.includes(kind)) return null;
    return { kind, repo: p.repo ?? null, id: p.id ?? null, prBound: ['fix', 'ci-heal', 'review'].includes(kind) };
  }
  const b = /^build-([A-Za-z0-9]+)/.exec(s);
  return b ? { kind: 'build', repo: null, id: b[1], prBound: false } : null;
}

/**
 * A kind's standard duration. `heavy` is heavy-admission's `readStandardMinutes` answer (`{minutes, source}`).
 * PURE.
 * @returns {{ms:number, minutes:number, source:'rolling'|'fallback', demandMinutes:number, samples:number}}
 */
export function standardDuration(kind, heavy, cfg = DEFAULT_SESSION_WATCHDOG) {
  const fallback = cfg.fallbackMinutes[kind] ?? cfg.fallbackMinutes.fix;
  const floor = cfg.floorMinutes[kind] ?? cfg.floorMinutes.fix;
  let demand = 0;
  try { demand = dispatchDemandMinutes(kind, { standardMinutes: heavy?.minutes }); } catch { demand = 0; }
  const src = heavy?.source ?? {};
  const samples = Math.min(Number(src.selected?.samples ?? 0), Number(src.standards?.samples ?? 0));
  if (demand > 0 && samples >= cfg.minSamples && src.selected?.from === 'rolling') {
    const minutes = Math.max(floor, Math.round(demand * cfg.standardFactor * 10) / 10);
    return { ms: minutes * MINUTE, minutes, source: 'rolling', demandMinutes: demand, samples };
  }
  return { ms: fallback * MINUTE, minutes: fallback, source: 'fallback', demandMinutes: demand, samples };
}

/**
 * One tool call's comparable SEGMENTS. For Bash: blank out quoted strings (a commit message is never a signal),
 * split on `;`/`&&`/`||`, cut each segment at its first pipe, drop redirections, reduce absolute paths to their
 * basename, collapse spaces, and drop `cd …` — so `node …/verify-lane.mjs check --wait=540000 --json --repo=.
 * 2>/dev/null | cut -c1-900 | tail -1` reads `node verify-lane.mjs check --wait=540000 --json --repo=.` whatever
 * it was piped into or chained with. Other tools: one segment, `<Tool>:<target basename>`. PURE.
 * @returns {string[]}
 */
export function commandSegments(name, input) {
  if (name !== 'Bash') {
    const target = input?.file_path ?? input?.path ?? input?.pattern ?? input?.url ?? input?.description ?? '';
    return [`${name}:${String(target).split('/').pop()}`];
  }
  const cmd = String(input?.command ?? '')
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'[^']*'/g, "''");
  return [...new Set(cmd.split(/;|&&|\|\||\n/).map((seg) => seg.split('|')[0]
    .replace(/\d?>>?\s*\S+/g, '')
    .replace(/(^|\s)\/[^\s'"]*\/([^\s/'"]+)/g, '$1$2')
    .replace(/\s+/g, ' ').trim())
    .filter((seg) => seg && !/^cd(?:\s|$)/.test(seg)))];
}

/** The whole call as one string (its segments joined). PURE. */
export function commandSignature(name, input) {
  return `${name}:${commandSegments(name, input).join(' ; ')}`;
}

const isEditTool = (name) => name === 'Edit' || name === 'Write' || name === 'NotebookEdit' || name === 'MultiEdit';
const COMMIT_RE = /\bgit\b[^;&|]*\bcommit\b/;
const PUSH_RE = /\bgit\b[^;&|]*\bpush\b|\bpr-land\.mjs\b|\bfix-procedure\.mjs\s+push\b|\brun\.mjs\s+open-pr\b/;

/**
 * Reduce a transcript tail (`summarizeEntry` objects, oldest first) to what the classifier reads. The DOMINANT
 * segment is the command segment carried by the most of the last `windowCalls` non-edit calls (a call counts
 * once per distinct segment), with the wall time those calls took (each call's tool_use → tool_result gap; a
 * still-pending call runs to `nowMs`). Time matters: a quick `git log -1` in every call is habit, not a wait.
 * PURE.
 */
export function summarizeTail(entries, { windowCalls = DEFAULT_SESSION_WATCHDOG.waitLoopWindowCalls, nowMs = null } = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const resultAt = new Map();
  for (const e of list) for (const b of e?.blocks || []) if (b.kind === 'tool_result') resultAt.set(b.toolUseId, Date.parse(e.ts ?? ''));
  const calls = [];
  for (const e of list) {
    for (const b of e?.blocks || []) {
      if (b.kind !== 'tool_use') continue;
      const cmd = b.name === 'Bash' ? String(b.rawInput?.command ?? '') : '';
      const startMs = Date.parse(e.ts ?? '');
      const endMs = resultAt.has(b.id) ? resultAt.get(b.id) : nowMs;
      calls.push({
        id: b.id, name: b.name, ts: e.ts ?? null, segs: commandSegments(b.name, b.rawInput),
        ms: Number.isFinite(startMs) && Number.isFinite(endMs) ? Math.max(0, endMs - startMs) : 0,
        edit: isEditTool(b.name), commit: COMMIT_RE.test(cmd), push: PUSH_RE.test(cmd),
      });
    }
  }
  const recent = calls.slice(-windowCalls);
  const bySeg = new Map();
  for (const c of recent) {
    if (c.edit) continue;
    for (const seg of c.segs) {
      const x = bySeg.get(seg) ?? { count: 0, ms: 0 };
      x.count += 1; x.ms += c.ms;
      bySeg.set(seg, x);
    }
  }
  let dominant = { sig: null, count: 0, minutes: 0 };
  for (const [sig, x] of bySeg) {
    const minutes = Math.round(x.ms / MINUTE);
    if (x.count > dominant.count || (x.count === dominant.count && minutes > dominant.minutes)) dominant = { sig, count: x.count, minutes };
  }
  // A loop is waiting, not iterating: no edit or commit after the dominant command's first run in the window.
  const firstIdx = dominant.sig == null ? -1 : recent.findIndex((c) => !c.edit && c.segs.includes(dominant.sig));
  dominant.changesSince = firstIdx < 0 ? 0 : recent.slice(firstIdx).filter((c) => c.edit || c.commit).length;
  const pending = detectBlockedOnChild(list);
  const last = list.at(-1);
  const lastBlocks = last?.blocks || [];
  const endedOnReply = !pending.pending && last?.kind === 'assistant'
    && lastBlocks.length > 0 && lastBlocks.every((b) => b.kind === 'text');
  let lastActivityMs = null;
  for (const e of list) {
    const t = Date.parse(e?.ts ?? '');
    if (Number.isFinite(t) && (lastActivityMs == null || t > lastActivityMs)) lastActivityMs = t;
  }
  return {
    totalCalls: calls.length,
    recentCalls: recent.length,
    distinct: new Set(recent.map((c) => c.segs.join(' ; '))).size,
    dominant,
    edits: recent.filter((c) => c.edit).length,
    commits: recent.filter((c) => c.commit).length,
    pushes: calls.filter((c) => c.push).length,
    pending: pending.pending ? { tool: pending.toolName ?? null, nestedAgent: !!pending.isNestedBlockingAgent } : null,
    endedOnReply,
    lastActivityMs,
  };
}

/**
 * Classify ONE listed session. Every fact is a parameter. PURE.
 * @param {{row:object, tail:object|null, nowMs:number, standard:{ms:number}, cfg?:object,
 *   completionDone?:boolean|null, pidAlive?:boolean|null}} o
 * @returns {{class:string, reason:string, evidence:object}}
 */
export function classifyWatchdogSession({ row, tail, nowMs, standard, cfg = DEFAULT_SESSION_WATCHDOG, completionDone = null, pidAlive = null }) {
  const startedMs = Number(row?.startedAt) || Date.parse(row?.startedAt ?? '');
  const runtimeMs = Number.isFinite(startedMs) ? nowMs - startedMs : null;
  const ghostMs = cfg.ghostHours * 60 * MINUTE;
  const ev = { runtimeMinutes: runtimeMs == null ? null : Math.round(runtimeMs / MINUTE), standardMinutes: Math.round(standard.ms / MINUTE) };
  if (runtimeMs != null && runtimeMs < standard.ms) return { class: CLASSES.WITHIN, reason: 'runtime-within-standard', evidence: ev };
  if (!tail || !Number.isFinite(tail.lastActivityMs)) {
    if (pidAlive === false && runtimeMs != null && runtimeMs >= ghostMs) {
      return { class: CLASSES.GHOST, reason: 'no-transcript-and-no-process', evidence: ev };
    }
    return { class: CLASSES.NO_SIGNAL, reason: 'transcript-unreadable', evidence: ev };
  }
  const idleMs = nowMs - tail.lastActivityMs;
  Object.assign(ev, {
    idleMinutes: Math.round(idleMs / MINUTE), totalCalls: tail.totalCalls, distinct: tail.distinct,
    edits: tail.edits, commits: tail.commits, pushes: tail.pushes,
    repeats: tail.dominant.count, repeatMinutes: tail.dominant.minutes, signature: tail.dominant.sig, pendingTool: tail.pending?.tool ?? null,
  });
  if (completionDone === true) return { class: CLASSES.FINISHED, reason: 'completion-record-done', evidence: ev };
  if (idleMs >= ghostMs && pidAlive !== true) return { class: CLASSES.GHOST, reason: 'transcript-older-than-ghost-threshold', evidence: ev };
  if (tail.endedOnReply && idleMs >= cfg.finishedIdleMinutes * MINUTE) return { class: CLASSES.FINISHED, reason: 'transcript-ended', evidence: ev };
  if (tail.pending && idleMs >= cfg.stalledBlockedMinutes * MINUTE) return { class: CLASSES.STALLED, reason: 'blocked-on-one-call', evidence: ev };
  if (!tail.pending && idleMs >= cfg.stalledIdleMinutes * MINUTE) return { class: CLASSES.STALLED, reason: 'idle', evidence: ev };
  if (tail.dominant.count >= cfg.waitLoopRepeats && tail.dominant.minutes >= cfg.waitLoopMinMinutes && !tail.dominant.changesSince) return { class: CLASSES.WAITING, reason: 'same-command-repeated', evidence: ev };
  return { class: CLASSES.ACTIVE, reason: tail.edits || tail.commits ? 'edits-or-commits' : 'distinct-tool-calls', evidence: ev };
}

/** The dedupe key of one escalation event. PURE. */
export function escalationKey({ repo, pr, sessionId, name, classification, headSha }) {
  return `${repo}#${pr}|${sessionId ?? name}|${classification}|${headSha ?? '-'}`;
}

/**
 * Turn classified rows + live fix claims + PR heads into findings, actions and escalation events. PURE.
 * @param {{rows:Array<object>, claims:Array<object>, prHeadFor:(repo:string, pr:number)=>string|null,
 *   standardFor:(kind:string)=>{ms:number, minutes:number}, nowMs:number}} o
 */
export function planWatchdog({ rows, claims, prHeadFor = () => null, standardFor, nowMs }) {
  const findings = [];
  const actions = [];
  const events = [];
  const holderOf = (c) => rows.find((r) => (c.meta?.sessionId && r.sessionId === c.meta.sessionId) || r.name === c.meta?.who) ?? null;
  const claimedBy = new Set();
  for (const c of claims || []) {
    const m = c.meta || {};
    const holder = holderOf(c);
    if (holder) claimedBy.add(holder.name);
    const claimedMs = Date.parse(m.claimedAt ?? '');
    const claimAgeMs = Number.isFinite(claimedMs) ? nowMs - claimedMs : null;
    const kind = watchdogKindOf(m.who)?.kind ?? 'fix';
    const standard = standardFor(kind);
    const base = {
      repo: m.repo, pr: m.pr, session: holder ? { name: holder.name, id: holder.id ?? null, sessionId: holder.sessionId ?? null } : { name: m.who ?? null, id: null, sessionId: m.sessionId ?? null },
      headSha: m.headSha ?? null, claimAgeMinutes: claimAgeMs == null ? null : Math.round(claimAgeMs / MINUTE), standardMinutes: standard.minutes,
    };
    if (holder && STUCK_CLASSES.includes(holder.class)) {
      const key = escalationKey({ repo: m.repo, pr: m.pr, sessionId: holder.sessionId, name: holder.name, classification: holder.class, headSha: m.headSha });
      findings.push({ type: 'fixer-stuck', ...base, classification: holder.class, reason: holder.reason, evidence: holder.evidence, key });
      events.push({
        type: ESCALATION_EVENT_TYPE, v: 1, key, at: new Date(nowMs).toISOString(), repo: m.repo, pr: m.pr, claimKind: FIXING_KIND,
        session: base.session, classification: holder.class, reason: holder.reason, headSha: m.headSha ?? null,
        evidence: { ...holder.evidence, claimAgeMinutes: base.claimAgeMinutes, standardMinutes: standard.minutes },
        ask: 'escalate-fixer',
      });
    }
    const head = prHeadFor(m.repo, m.pr);
    if (claimAgeMs != null && claimAgeMs >= standard.ms && head && m.headSha && head === m.headSha) {
      findings.push({ type: 'fix-claim-held-no-progress', ...base, prHead: head, holderClass: holder?.class ?? 'not-listed' });
    }
    if (holder?.class === CLASSES.GHOST) {
      actions.push({ type: 'release-fix-claim', repo: m.repo, pr: m.pr, who: m.who, sessionId: m.sessionId ?? null, session: holder.name });
    }
  }
  for (const r of rows) {
    if (STUCK_CLASSES.includes(r.class) && !claimedBy.has(r.name)) {
      findings.push({ type: 'session-stuck', session: { name: r.name, id: r.id ?? null, sessionId: r.sessionId ?? null }, kind: r.kind, classification: r.class, reason: r.reason, evidence: r.evidence });
    }
    if (r.class === CLASSES.GHOST) {
      if (r.listingKind === 'background') {
        actions.push({ type: 'clear-ghost', handle: r.id ?? null, session: r.name, safe: r.pidAlive === false && !!r.id });
        if (r.prBound && r.repo && r.target) actions.push({ type: 'release-dispatch-claims', repo: r.repo, pr: Number(r.target), session: r.name });
      }
    }
  }
  return { findings, actions, events };
}

// ── IO shell ─────────────────────────────────────────────────────────────────────────────────────────────────

/** `<coordination root>/session-watchdog/` — the escalation event log and its ack log live here. */
export function watchdogEventDir(root = resolveCoordinationRoot()) {
  return join(root, 'session-watchdog');
}

function readJsonl(file, maxLines = 2000) {
  try {
    return readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-maxLines)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

/** Keys already written to the event log, and keys a consumer has acknowledged. */
export function readEscalationLedger(dir = watchdogEventDir()) {
  return {
    emitted: new Set(readJsonl(join(dir, 'fixer-escalations.jsonl')).map((e) => e.key).filter(Boolean)),
    acked: new Set(readJsonl(join(dir, 'fixer-escalations.ack.jsonl')).map((e) => e.key).filter(Boolean)),
  };
}

export function appendEscalationEvent(event, dir = watchdogEventDir()) {
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, 'fixer-escalations.jsonl'), `${JSON.stringify(event)}\n`);
}

/** Ghost handles `claude rm` already failed to remove: `{<id>: <iso of the failed attempt>}`. */
export function readRmIneffective(dir = watchdogEventDir()) {
  try { return JSON.parse(readFileSync(join(dir, 'rm-ineffective.json'), 'utf8')) || {}; } catch { return {}; }
}

export function writeRmIneffective(ledger, dir = watchdogEventDir()) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'rm-ineffective.json');
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(ledger)}\n`);
  renameSync(tmp, file);
}

/** Bounded tail read of one listed session's own transcript, through `hung-session.mjs`'s shared primitive. */
export function readWatchdogTail(row, cfg = DEFAULT_SESSION_WATCHDOG, nowMs = Date.now()) {
  const t = readTranscriptTailActivity(row, { tailLines: cfg.tailLines, maxBytes: cfg.tailMaxBytes, fieldMax: 200, tailLinesFn: tailLines, summarizeEntryFn: summarizeEntry });
  if (!t) return null;
  const s = summarizeTail(t.entries, { windowCalls: cfg.waitLoopWindowCalls, nowMs });
  return { ...s, lastActivityMs: t.lastActivityMs, file: t.file };
}

/** PR head from the shared open-PR snapshot, CACHE ONLY (never a fetch). `null` when unknown. */
export function makeSnapshotHeadReader({ maxAgeMs = DEFAULT_SESSION_WATCHDOG.prHeadMaxAgeMinutes * MINUTE, read = readSharedOpenPrs } = {}) {
  const cache = new Map();
  return (repoKey, pr) => {
    const slug = CONSTELLATION_REPOS[repoKey]?.slug;
    if (!slug) return null;
    if (!cache.has(slug)) {
      let rows = null;
      try { rows = read({ repo: slug, fields: ['number', 'headRefOid'], cacheOnly: true, ttlMs: maxAgeMs }); } catch { rows = null; }
      cache.set(slug, Array.isArray(rows) ? rows : null);
    }
    const hit = cache.get(slug)?.find((p) => Number(p.number) === Number(pr));
    return hit?.headRefOid ?? null;
  };
}

export function defaultListAgentsJson(exec = execFileSync) {
  return JSON.parse(String(exec('claude', ['agents', '--json'], { cwd: homedir(), encoding: 'utf8', timeout: 60_000 })));
}

function defaultProcesses(exec = execFileSync) {
  try {
    const out = String(exec('ps', ['-axo', 'pid=,command='], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 10_000 }));
    return out.split('\n').filter(Boolean).map((l) => { const m = /^\s*(\d+)\s+(.*)$/.exec(l); return m ? { pid: Number(m[1]), command: m[2] } : null; }).filter(Boolean);
  } catch { return null; }
}

const isNonTerminal = (a) => a?.state !== 'done' && a?.state !== 'stopped' && a?.state !== 'failed';

/**
 * ONE watchdog pass. Never throws on a single session; each IO seam is injectable for tests.
 * @returns {{at:string, act:boolean, standards:object, rows:Array<object>, findings:Array<object>,
 *   actions:Array<object>, events:Array<object>, acked:string[]}}
 */
export function runSessionWatchdogPass({
  nowMs = Date.now(),
  config = DEFAULT_SESSION_WATCHDOG,
  act = config.act,
  agents = null,
  listAgents = () => defaultListAgentsJson(),
  processes = undefined,
  readProcesses = () => defaultProcesses(),
  readTail = (row) => readWatchdogTail(row, config, nowMs),
  readHeavy = () => readStandardMinutes(admissionLockRoot(REPO_ROOT)),
  listClaims = () => listLiveFixClaims({ nowMs }),
  prHeadFor = makeSnapshotHeadReader({ maxAgeMs: config.prHeadMaxAgeMinutes * MINUTE }),
  completionFor = makeCompletionResolver(),
  rm = rmSessionRecord,
  releaseFixing = releaseFixClaim,
  releaseDispatch = releaseSessionFixDispatchClaims,
  eventDir = watchdogEventDir(),
  readLedger = () => readEscalationLedger(eventDir),
  appendEvent = (e) => appendEscalationEvent(e, eventDir),
  relist = listAgents,
  readRmLedger = () => readRmIneffective(eventDir),
  writeRmLedger = (l) => writeRmIneffective(l, eventDir),
  log = () => {},
} = {}) {
  const listing = (agents ?? listAgents()) || [];
  const procs = processes === undefined ? readProcesses() : processes;
  let heavy = null;
  try { heavy = readHeavy(); } catch { heavy = null; }
  const standardCache = {};
  const standardFor = (kind) => (standardCache[kind] ??= standardDuration(kind, heavy, config));

  const rows = [];
  for (const a of listing) {
    if (!a || a.kind !== 'background' || !isNonTerminal(a)) continue;
    const k = watchdogKindOf(a.name);
    if (!k) continue;
    const standard = standardFor(k.kind);
    const startedMs = Number(a.startedAt) || Date.parse(a.startedAt ?? '');
    const pastStandard = !Number.isFinite(startedMs) || nowMs - startedMs >= standard.ms;
    let tail = null;
    if (pastStandard) { try { tail = readTail(a); } catch { tail = null; } }
    let completionDone = null;
    try { completionDone = completionFor({ name: a.name, sessionId: a.sessionId })?.done ?? null; } catch { completionDone = null; }
    const pidAlive = isProcessAlive(a, procs);
    const verdict = classifyWatchdogSession({ row: a, tail, nowMs, standard, cfg: config, completionDone, pidAlive });
    rows.push({
      name: a.name, id: a.id ?? null, sessionId: a.sessionId ?? null, state: a.state ?? null, listingKind: a.kind,
      kind: k.kind, repo: k.repo, target: k.id, prBound: k.prBound, pid: Number.isInteger(a.pid) ? a.pid : null, pidAlive,
      startedAt: Number.isFinite(startedMs) ? new Date(startedMs).toISOString() : null,
      standardMinutes: standard.minutes, standardSource: standard.source,
      class: verdict.class, reason: verdict.reason, evidence: verdict.evidence,
    });
  }

  let claims = [];
  try { claims = listClaims() || []; } catch { claims = []; }
  const plan = planWatchdog({ rows, claims, prHeadFor, standardFor, nowMs });

  // Escalation events: write each key once; report which ones a consumer acknowledged.
  let ledger = { emitted: new Set(), acked: new Set() };
  try { ledger = readLedger(); } catch { /* unreadable — treat as empty, a duplicate event is harmless */ }
  const written = [];
  for (const e of plan.events) {
    if (ledger.emitted.has(e.key)) continue;
    if (act) {
      try { appendEvent(e); written.push(e.key); } catch (err) { log(`session-watchdog: event write failed ${e.key}: ${err?.message || err}`); }
    }
  }

  const done = [];
  let rmLedger = {};
  try { rmLedger = readRmLedger() || {}; } catch { rmLedger = {}; }
  const retryMs = config.ghostHours * 60 * MINUTE;
  const removed = [];
  for (const a of plan.actions) {
    if (!act) { done.push({ ...a, ok: null, detail: 'report-only' }); continue; }
    try {
      if (a.type === 'clear-ghost') {
        if (!a.safe) { done.push({ ...a, ok: false, detail: 'refused: process liveness unknown or no handle' }); continue; }
        const prior = Date.parse(rmLedger[a.handle] ?? '');
        if (Number.isFinite(prior) && nowMs - prior < retryMs) {
          done.push({ ...a, ok: false, ineffective: true, detail: `claude rm left it listed on ${rmLedger[a.handle]} (Claude Code issue #77683); not retried until ${config.ghostHours}h later` });
          continue;
        }
        const r = rm({ handle: a.handle });
        const entry = { ...a, ok: true, detail: r.alreadyGone ? 'already-gone' : 'removed' };
        removed.push(entry);
        done.push(entry);
      } else if (a.type === 'release-fix-claim') {
        const r = releaseFixing({ repo: a.repo, pr: a.pr, who: a.who, sessionId: a.sessionId });
        done.push({ ...a, ok: r.released === true, detail: r.released ? 'released' : r.reason });
      } else if (a.type === 'release-dispatch-claims') {
        const r = releaseDispatch({ repo: a.repo, pr: a.pr, who: a.session });
        done.push({ ...a, ok: true, detail: `released ${r.released.length}` });
      }
    } catch (err) {
      done.push({ ...a, ok: false, detail: String(err?.message || err).split('\n')[0] });
    }
  }

  // `claude rm` can report success and leave the row listed (Claude Code issue #77683). Re-read the listing once,
  // only when something was removed; a row still there is NOT cleared, is remembered so it is not retried every
  // pass, and keeps its ghost smell open for the human-confirmed `clear-stuck-session` operation.
  if (removed.length) {
    let still = null;
    try { still = new Set((relist() || []).filter(isNonTerminal).map((x) => x.id).filter(Boolean)); } catch { still = null; }
    for (const e of removed) {
      if (still == null) { e.ok = false; e.detail = `${e.detail}, but the re-listing failed — unconfirmed`; continue; }
      if (still.has(e.handle)) {
        e.ok = false; e.ineffective = true;
        e.detail = 'claude rm returned success but the session is still listed (Claude Code issue #77683)';
        rmLedger[e.handle] = new Date(nowMs).toISOString();
      } else {
        delete rmLedger[e.handle];
      }
    }
    try { writeRmLedger(rmLedger); } catch (err) { log(`session-watchdog: rm ledger write failed: ${err?.message || err}`); }
  }

  return {
    at: new Date(nowMs).toISOString(), act: !!act,
    standards: Object.fromEntries(WATCHDOG_KINDS.map((k) => [k, standardFor(k)])),
    rows, findings: plan.findings, actions: done, events: plan.events.map((e) => ({ ...e, written: written.includes(e.key) || ledger.emitted.has(e.key) })),
    acked: [...ledger.acked],
  };
}

/** One line per listed session — the human-readable listing the CLI prints. PURE. */
export function renderWatchdogPass(result) {
  const lines = [`session watchdog @ ${result.at} (${result.act ? 'acting' : 'report only'})`];
  for (const r of result.rows) {
    const ev = r.evidence || {};
    const bits = [`runtime ${ev.runtimeMinutes ?? '?'}m / standard ${r.standardMinutes}m (${r.standardSource})`];
    if (ev.idleMinutes != null) bits.push(`idle ${ev.idleMinutes}m`);
    if (ev.repeats) bits.push(`top command x${ev.repeats}`);
    if (ev.pendingTool) bits.push(`pending ${ev.pendingTool}`);
    lines.push(`  ${r.name.padEnd(18)} ${r.class.padEnd(20)} ${r.reason} — ${bits.join(', ')}`);
  }
  for (const f of result.findings) lines.push(`  finding ${f.type}: ${f.repo ? `${f.repo}#${f.pr} ` : ''}${f.session?.name ?? ''} ${f.classification ?? ''}`.trimEnd());
  for (const a of result.actions) lines.push(`  action ${a.type} ${a.session ?? ''} → ${a.ok === null ? 'not taken (report only)' : a.ok ? a.detail : `FAILED: ${a.detail}`}`);
  return lines.join('\n');
}

const IS_CLI = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (IS_CLI) {
  const argv = process.argv.slice(2);
  const result = runSessionWatchdogPass({ act: argv.includes('--apply'), log: (m) => process.stderr.write(`${m}\n`) });
  process.stdout.write(argv.includes('--json') ? `${JSON.stringify(result, null, 2)}\n` : `${renderWatchdogPass(result)}\n`);
}
