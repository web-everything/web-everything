/**
 * @file scripts/conveyor/round-judge-shadow.mjs
 * @description The SHADOW round judge's seam into the conveyor (operator OK 2026-10-21). The review daemon's status
 *   tagger (`we:scripts/conveyor/review-status-tag.mjs`) already knows, every tick, which PR sits at a round cap.
 *   It calls {@link observeRoundCap} there. This module decides whether to look (setting), asks the pure judge
 *   (`we:scripts/lib/round-judge.mjs`) and appends one JSONL line. It NEVER acts: no label, no comment, no grant.
 *
 *   Setting `rounds.judge.mode` = off | shadow | on, through the policy cascade (standard `off` -> platform
 *   preference `rounds` -> this repo's `we:scripts/settings/round-judge.json` -> env `WE_ROUNDS_JUDGE_MODE`). The
 *   resolved source is logged and written on every record. `on` is NOT implemented: it resolves, is logged, and
 *   behaves exactly like `shadow`.
 *
 *   Log: `~/workspace/.operations/round-judge-shadow/YYYY-MM.jsonl` (override dir: `WE_ROUND_JUDGE_SHADOW_DIR`).
 *   One record per (PR, head, cap trigger, cap episode); a re-seen cap is skipped. Never throws into the caller.
 */
import { appendFileSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCascade, platformPreference, formatCascadeSourcesLine, logCascadeSources } from '../lib/policy-cascade.mjs';
import { readConfirmedBreaks } from '../lib/red-team-gate.mjs';
import { detectRoundCap, judgeRound, formatJudgeLine } from '../lib/round-judge.mjs';
import { verifyFinding, makeGitRepo } from '../lib/round-judge-verify.mjs';
import { isUnderTest } from '../lib/under-test.mjs';

export const ROUND_JUDGE_MODES = Object.freeze(['off', 'shadow', 'on']);
export const ROUND_JUDGE_MODE_ENV = 'WE_ROUNDS_JUDGE_MODE';
export const ROUND_JUDGE_MAX_GRANTS_STANDARD = 20;
export const ROUND_JUDGE_DIR_ENV = 'WE_ROUND_JUDGE_SHADOW_DIR';
export const ROUND_JUDGE_SETTINGS_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'settings', 'round-judge.json');

const normMode = (v) => { const x = String(v ?? '').trim().toLowerCase(); return ROUND_JUDGE_MODES.includes(x) ? x : null; };

/** `rounds.judge.mode` under the cascade. PURE except the settings read. @returns {{mode:string, source:string}} */
export function resolveRoundJudgeMode({ env = process.env, path = ROUND_JUDGE_SETTINGS_FILE, platform, log } = {}) {
  let file = {};
  try { file = JSON.parse(readFileSync(path, 'utf8')); } catch { file = {}; }
  let plat = platform;
  if (plat === undefined) { try { plat = platformPreference('rounds', { env }); } catch { plat = undefined; } }
  const resolved = resolveCascade({ standard: { judge: { mode: 'off', maxGrants: ROUND_JUDGE_MAX_GRANTS_STANDARD } }, platform: plat, tool: file?.rounds ?? file,
    valid: { judge: (v) => (typeof v === 'number' ? Number.isInteger(v) && v >= 1 && v <= 100 : normMode(v?.mode ?? v) !== null) } });
  logCascadeSources('rounds', resolved, { env, ...(log ? { log } : {}) });
  let mode = normMode(resolved.leafValues?.['judge.mode']) ?? 'off';
  let source = resolved.sources?.['judge.mode'] ?? 'standard';
  // env is the top layer; an unusable value never overrides a lower one.
  const fromEnv = normMode(env?.[ROUND_JUDGE_MODE_ENV]);
  if (fromEnv) { mode = fromEnv; source = 'env'; }
  const mg = resolved.leafValues?.['judge.maxGrants'];
  const maxGrants = Number.isInteger(mg) && mg >= 1 ? mg : ROUND_JUDGE_MAX_GRANTS_STANDARD;
  return { mode, source, maxGrants, line: `${formatCascadeSourcesLine('rounds', resolved)}${source === 'env' ? ` · env ${ROUND_JUDGE_MODE_ENV}=${mode}` : ''}` };
}

const DIR_NAME = 'round-judge-shadow';
/** The log dir. The env override is honoured only for a directory NAMED `round-judge-shadow`, so a stray value can never
 *  redirect these writes somewhere else. */
export function roundJudgeDir(env = process.env) {
  const o = env?.[ROUND_JUDGE_DIR_ENV]?.trim();
  if (o && basename(resolve(o)) === DIR_NAME) return resolve(o);
  return join(homedir(), 'workspace', '.operations', DIR_NAME);
}

const monthFile = (dir, now) => join(dir, `${new Date(now).toISOString().slice(0, 7)}.jsonl`);

/** Keys already logged: this month's and last month's records, read once per process per dir (bounded to 5000 lines). */
const seenByDir = new Map();
function seenKeys(dir, now) {
  let set = seenByDir.get(dir);
  if (set) return set;
  set = new Set();
  try {
    const months = [new Date(now).toISOString().slice(0, 7), new Date(now - 32 * 864e5).toISOString().slice(0, 7)];
    for (const m of months) {
      let text = '';
      try { text = readFileSync(join(dir, `${m}.jsonl`), 'utf8'); } catch { continue; }
      for (const l of text.split('\n').slice(-5000)) { try { const k = JSON.parse(l)?.key; if (k) set.add(k); } catch { /* skip torn line */ } }
    }
  } catch { /* an unreadable log means "nothing seen yet" */ }
  seenByDir.set(dir, set);
  return set;
}

/** Test seam: forget the in-process dedup. @test-only-export-ok */
export function resetRoundJudgeSeenForTest() { seenByDir.clear(); }

/** Last observed diff size for this PR (the thread carries no per-head diff size). Best effort. */
function lastSize(dir, pr) {
  try { return JSON.parse(readFileSync(join(dir, 'last-size.json'), 'utf8'))?.[String(pr)] ?? null; } catch { return null; }
}
function rememberSize(dir, pr, size) {
  if (!Number.isFinite(size)) return;
  try {
    const path = join(dir, 'last-size.json');
    let all = {};
    try { all = JSON.parse(readFileSync(path, 'utf8')) ?? {}; } catch { all = {}; }
    all[String(pr)] = size;
    const keep = Object.fromEntries(Object.entries(all).slice(-500));
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(keep));
    renameSync(tmp, path);
  } catch { /* shadow bookkeeping only */ }
}

/**
 * Look at one PR this tick. Returns the record written, or a `{skipped}` note. NEVER throws, never mutates the PR.
 * Fails closed: an error after the cap is known writes (best effort) an `escalate` record naming the error.
 * @param {{pr:number, repo?:string, state:(string|null), subject:object, env?:object, now?:number, dir?:string,
 *   log?:(line:string)=>void, setting?:object, repoRoot?:string, verifyRepo?:object}} o
 *   `verifyRepo` replaces the read-only git adapter for the claim checker (tests); default reads the head from this clone.
 */
export function observeRoundCap({ pr, repo = null, state = null, subject = {}, env = process.env, now = Date.now(), dir, log = (l) => console.error(l), setting, repoRoot, verifyRepo } = {}) {
  let cap = null, cfg = null, outDir = null;
  const write = (record) => {
    mkdirSync(outDir, { recursive: true });
    appendFileSync(monthFile(outDir, now), `${JSON.stringify(record)}\n`);
    seenKeys(outDir, now).add(record.key);
    try { log(`${record.line} (mode=${cfg.mode} source=${cfg.source})`); } catch { /* logging never breaks the tick */ }
    return record;
  };
  try {
    if (isUnderTest(env) && !dir && !env?.[ROUND_JUDGE_DIR_ENV]) return { skipped: 'under-test' };
    cfg = resolveRoundJudgeMode({ env });
    if (cfg.mode === 'off') return { skipped: 'off', source: cfg.source };
    outDir = dir ?? roundJudgeDir(env);
    const comments = Array.isArray(subject?.comments) ? subject.comments : [];
    const head = String(subject?.headRefOid ?? '').toLowerCase();
    cap = detectRoundCap({ comments, pr, head, state, repo });
    if (!cap) return { skipped: 'no-cap' };
    if (seenKeys(outDir, now).has(cap.key)) return { skipped: 'already-logged', key: cap.key };

    const files = Array.isArray(subject?.files) ? subject.files.map((f) => f?.path ?? f).filter(Boolean) : [];
    const size = Array.isArray(subject?.files) && subject.files.length && subject.files.every((f) => Number.isFinite(f?.additions))
      ? subject.files.reduce((n, f) => n + f.additions + (f.deletions ?? 0), 0)
      : (Number.isFinite(subject?.additions) ? subject.additions + (subject.deletions ?? 0) : null);
    const vrepo = verifyRepo ?? makeGitRepo({ head, cwd: repoRoot });
    const result = judgeRound({ pr, repo, head, trigger: cap.trigger, comments, files, diff: { size, prevSize: lastSize(outDir, pr) },
      setting: setting ?? readConfirmedBreaks({ env }).value, verify: (f) => verifyFinding(f, vrepo), maxGrants: cfg.maxGrants });

    const line = formatJudgeLine(pr, result);
    const record = write({ ts: new Date(now).toISOString(), pr: Number(pr), repo, head, trigger: cap.trigger, key: cap.key,
      mode: cfg.mode, modeSource: cfg.source, verdict: result.verdict, ...(result.k ? { k: result.k } : {}),
      ...(result.proof ? { proof: result.proof } : {}), ...(result.body ? { body: result.body } : {}), reasons: result.reasons, line, evidence: result.evidence });
    rememberSize(outDir, pr, size);
    return record;
  } catch (e) {
    const error = String(e?.message ?? e).slice(0, 200);
    if (cap && cfg && outDir) {
      try {
        const reasons = [`fail-closed: observer error (${error})`];
        return write({ ts: new Date(now).toISOString(), pr: Number(pr), repo, head: String(subject?.headRefOid ?? ''), trigger: cap.trigger,
          key: cap.key, mode: cfg.mode, modeSource: cfg.source, verdict: 'escalate', reasons,
          line: formatJudgeLine(pr, { verdict: 'escalate', reasons }), evidence: { failClosed: true } });
      } catch { /* nothing more a shadow observer can do */ }
    }
    return { skipped: 'error', error };
  }
}
