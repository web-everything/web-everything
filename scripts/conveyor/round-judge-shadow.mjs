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
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCascade, platformPreference, formatCascadeSourcesLine, logCascadeSources } from '../lib/policy-cascade.mjs';
import { readConfirmedBreaks } from '../lib/red-team-gate.mjs';
import { detectRoundCap, judgeRound, formatJudgeLine } from '../lib/round-judge.mjs';
import { isUnderTest } from '../lib/under-test.mjs';

export const ROUND_JUDGE_MODES = Object.freeze(['off', 'shadow', 'on']);
export const ROUND_JUDGE_MODE_ENV = 'WE_ROUNDS_JUDGE_MODE';
export const ROUND_JUDGE_DIR_ENV = 'WE_ROUND_JUDGE_SHADOW_DIR';
export const ROUND_JUDGE_SETTINGS_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'settings', 'round-judge.json');

const normMode = (v) => { const x = String(v ?? '').trim().toLowerCase(); return ROUND_JUDGE_MODES.includes(x) ? x : null; };

/** `rounds.judge.mode` under the cascade. PURE except the settings read. @returns {{mode:string, source:string}} */
export function resolveRoundJudgeMode({ env = process.env, path = ROUND_JUDGE_SETTINGS_FILE, platform, log } = {}) {
  let file = {};
  try { file = JSON.parse(readFileSync(path, 'utf8')); } catch { file = {}; }
  let plat = platform;
  if (plat === undefined) { try { plat = platformPreference('rounds', { env }); } catch { plat = undefined; } }
  const resolved = resolveCascade({ standard: { judge: { mode: 'off' } }, platform: plat, tool: file?.rounds ?? file,
    valid: { judge: (v) => normMode(v?.mode ?? v) !== null } });
  logCascadeSources('rounds', resolved, { env, ...(log ? { log } : {}) });
  let mode = normMode(resolved.leafValues?.['judge.mode']) ?? 'off';
  let source = resolved.sources?.['judge.mode'] ?? 'standard';
  // env is the top layer; an unusable value never overrides a lower one.
  const fromEnv = normMode(env?.[ROUND_JUDGE_MODE_ENV]);
  if (fromEnv) { mode = fromEnv; source = 'env'; }
  return { mode, source, line: `${formatCascadeSourcesLine('rounds', resolved)}${source === 'env' ? ` · env ${ROUND_JUDGE_MODE_ENV}=${mode}` : ''}` };
}

export function roundJudgeDir(env = process.env) {
  return env?.[ROUND_JUDGE_DIR_ENV]?.trim() || join(homedir(), 'workspace', '.operations', 'round-judge-shadow');
}

const monthFile = (dir, now) => join(dir, `${new Date(now).toISOString().slice(0, 7)}.jsonl`);

function alreadyLogged(dir, key) {
  try {
    const path = join(dir, 'seen-keys.jsonl');
    if (!existsSync(path)) return false;
    return readFileSync(path, 'utf8').split('\n').includes(key);
  } catch { return false; }
}

/** Last observed diff size for this PR, from our own earlier records (the thread carries no per-head diff size). */
function lastSize(dir, pr) {
  try {
    const path = join(dir, 'last-size.json');
    return JSON.parse(readFileSync(path, 'utf8'))?.[String(pr)] ?? null;
  } catch { return null; }
}
function rememberSize(dir, pr, size) {
  if (!Number.isFinite(size)) return;
  try {
    const path = join(dir, 'last-size.json');
    let all = {};
    try { all = JSON.parse(readFileSync(path, 'utf8')) ?? {}; } catch { all = {}; }
    all[String(pr)] = size;
    appendFileAtomic(path, JSON.stringify(all));
  } catch { /* shadow bookkeeping only */ }
}
function appendFileAtomic(path, text) { const tmp = `${path}.${process.pid}.tmp`; writeFileSync(tmp, text); renameSync(tmp, path); }

/**
 * Look at one PR this tick. Returns the record written, or a `{skipped}` note. NEVER throws, never mutates the PR.
 * @param {{pr:number, repo?:string, state:(string|null), subject:object, env?:object, now?:number, dir?:string,
 *   log?:(line:string)=>void, setting?:object}} o
 */
export function observeRoundCap({ pr, repo = null, state = null, subject = {}, env = process.env, now = Date.now(), dir, log = (l) => console.error(l), setting } = {}) {
  try {
    if (isUnderTest(env) && !dir && !env?.[ROUND_JUDGE_DIR_ENV]) return { skipped: 'under-test' };
    const cfg = resolveRoundJudgeMode({ env });
    if (cfg.mode === 'off') return { skipped: 'off', source: cfg.source };
    const comments = Array.isArray(subject?.comments) ? subject.comments : [];
    const head = String(subject?.headRefOid ?? '').toLowerCase();
    const cap = detectRoundCap({ comments, pr, head, state, repo });
    if (!cap) return { skipped: 'no-cap' };
    const outDir = dir ?? roundJudgeDir(env);
    if (alreadyLogged(outDir, cap.key)) return { skipped: 'already-logged', key: cap.key };

    const files = Array.isArray(subject?.files) ? subject.files.map((f) => f?.path ?? f).filter(Boolean) : [];
    const size = Array.isArray(subject?.files) && subject.files.length && subject.files.every((f) => Number.isFinite(f?.additions))
      ? subject.files.reduce((n, f) => n + f.additions + (f.deletions ?? 0), 0)
      : (Number.isFinite(subject?.additions) ? subject.additions + (subject.deletions ?? 0) : null);
    const prevSize = lastSize(outDir, pr);
    const result = judgeRound({ pr, repo, head, trigger: cap.trigger, comments, files, diff: { size, prevSize },
      setting: setting ?? readConfirmedBreaks({ env }).value });

    const line = formatJudgeLine(pr, result);
    const record = { ts: new Date(now).toISOString(), pr: Number(pr), repo, head, trigger: cap.trigger, key: cap.key,
      mode: cfg.mode, modeSource: cfg.source, verdict: result.verdict, ...(result.k ? { k: result.k } : {}),
      reasons: result.reasons, line, evidence: result.evidence };
    mkdirSync(outDir, { recursive: true });
    appendFileSync(monthFile(outDir, now), `${JSON.stringify(record)}\n`);
    appendFileSync(join(outDir, 'seen-keys.jsonl'), `${cap.key}\n`);
    rememberSize(outDir, pr, size);
    try { log(`${line} (mode=${cfg.mode} source=${cfg.source})`); } catch { /* logging never breaks the tick */ }
    return record;
  } catch (e) {
    return { skipped: 'error', error: String(e?.message ?? e).slice(0, 200) };
  }
}
