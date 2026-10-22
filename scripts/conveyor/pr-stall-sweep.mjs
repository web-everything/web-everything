/**
 * @file scripts/conveyor/pr-stall-sweep.mjs
 * @description THE AUTOMATIC PR STALL SWEEP, slice 2: SHADOW MODE (operator OK 2026-10-21). Rides the card-335 health PR
 *   job: every `intervalMinutes` it reads every open PR (read-only `pr-sweep` reader), judges round caps / referral holds,
 *   classifies each stalled row (`pr-stall-classify.mjs`) and logs what it WOULD do. ZERO GitHub writes; `on` is not
 *   implemented yet and behaves as `shadow`. Settings: `prStallSweep` through the policy cascade (standard -> platform ->
 *   `we:scripts/settings/pr-stall-sweep.json` -> env `WE_PR_STALL_SWEEP_<KEY>`); any unusable mode or unreadable layer
 *   means off. Rate limits apply to "would do" too. Any incomplete read plans nothing. Audit log:
 *   `~/workspace/.operations/pr-stall-sweep/YYYY-MM.jsonl` (`WE_PR_STALL_SWEEP_DIR` only for a dir named `pr-stall-sweep`):
 *   `pass`, `would-do`, `would-skip`, `operator`, each logged once per PR head and state.
 */
import { appendFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withFileLock } from '../lib/atomic-json-file.mjs';
import { cascadePolicy, readPlatformPreferences, logCascadeSources } from '../lib/policy-cascade.mjs';
import { isUnderTest } from '../lib/under-test.mjs';
import { readConfirmedBreaks } from '../lib/red-team-gate.mjs';
import { detectRoundCap, judgeRound } from '../lib/round-judge.mjs';
import { assessPrSweep } from '../operations/pr-sweep-core.mjs';
import { createPrSweepReader, STALLED_AFTER_ENV, tailOf } from '../operations/pr-sweep-io.mjs';
import { readSettings } from '../lib/settings-files.mjs';
import { resolveRoundJudgeMode } from './round-judge-shadow.mjs';
import { classifyStall, JUDGED_STATES, CLASSIFY_DEFAULTS, CLASSIFY_VALID } from './pr-stall-classify.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const STALL_SWEEP_MODES = Object.freeze(['off', 'shadow', 'on']);
export const STALL_SWEEP_MODE_ENV = 'WE_PR_STALL_SWEEP_MODE';
export const STALL_SWEEP_DIR_ENV = 'WE_PR_STALL_SWEEP_DIR';
/** The standard values; the classifier's policies are leaves of the same block, checked by its validators. */
export const STALL_SWEEP_DEFAULTS = Object.freeze({ mode: 'off', intervalMinutes: 15, maxActionsPerSweep: 3, maxActionsPerHour: 6,
  maxActionsPerPrHead: 1, digest: true, ...CLASSIFY_DEFAULTS });
const SCALARS = ['mode', 'digest', 'intervalMinutes', 'maxActionsPerSweep', 'maxActionsPerHour', 'maxActionsPerPrHead', 'staleHoldAutoResume', 'grantCeiling', 'maxFixListLines'];
const SETTINGS_FILE = join(ROOT, 'scripts/settings/pr-stall-sweep.json');
const envName = (k) => `WE_PR_STALL_SWEEP_${k.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()}`;
const msg = (e) => String(e?.message ?? e).split('\n')[0].slice(0, 200);

/** `prStallSweep` under the cascade. Every leaf's source is returned and logged. Never throws. */
export function resolveStallSweepSettings({ env = process.env, read = readFileSync, log = console.error } = {}) {
  const errors = [];
  let tool = {}; let layerUnreadable = false;
  try { const f = JSON.parse(read(SETTINGS_FILE, 'utf8')); if (!f || typeof f !== 'object' || Array.isArray(f)) throw new Error('settings root is not an object'); tool = 'prStallSweep' in f ? f.prStallSweep : {}; } catch (e) { errors.push(`settings: ${msg(e)}`); layerUnreadable = true; }
  const envValues = {};
  for (const k of SCALARS) {
    const d = STALL_SWEEP_DEFAULTS[k];
    const raw = env[envName(k)];
    if (raw === undefined) continue;
    envValues[k] = typeof d === 'boolean' ? (['1', 'true'].includes(raw) ? true : ['0', 'false'].includes(raw) ? false : raw)
      : typeof d === 'number' ? Number(raw) : String(raw).trim().toLowerCase();
  }
  const valid = { ...CLASSIFY_VALID, mode: (v) => STALL_SWEEP_MODES.includes(v), digest: (v) => typeof v === 'boolean',
    ...Object.fromEntries(['intervalMinutes', 'maxActionsPerSweep', 'maxActionsPerHour', 'maxActionsPerPrHead'].map((k) => [k, (v) => Number.isSafeInteger(v) && v > 0])) };
  let platform = {};
  try { const p = readPlatformPreferences({ env, readFile: read }); errors.push(...p.errors); if (p.errors.length) layerUnreadable = true; platform = 'prStallSweep' in p.prefs ? p.prefs.prStallSweep : {}; }
  catch (e) { errors.push(`platform: ${msg(e)}`); layerUnreadable = true; }
  // A scalar of the wrong SHAPE (an object where a number belongs) is dropped from its layer before the cascade, so the
  // valid value beneath it (a stricter platform limit, say) still applies.
  const scalarsOnly = (layer, name) => (layer && typeof layer === 'object' && !Array.isArray(layer) ? Object.fromEntries(Object.entries(layer).filter(([k, v]) => {
    const ok = !SCALARS.includes(k) || k === 'mode' || valid[k](v); if (!ok) errors.push(`${name}.${k}=${JSON.stringify(v)} (wrong shape, ignored)`); return ok;
  })) : {});
  // A block that is present but not an object (`false`, `"off"`, `[]`) is unusable policy, not "no settings".
  const isBlock = (b) => !!b && typeof b === 'object' && !Array.isArray(b);
  if (!isBlock(tool) || !isBlock(platform)) { layerUnreadable = true; errors.push('a prStallSweep block is not an object'); }
  tool = scalarsOnly(tool, 'tool'); platform = scalarsOnly(platform, 'platform');
  // The kill switch fails closed: a mode PRESENT in any layer but unusable (including `{}`, which the cascade's leaf
  // flattening would drop) turns the sweep OFF.
  const rawModes = [tool?.mode, platform?.mode].filter((m) => m !== undefined);
  const out = cascadePolicy('prStallSweep', tool, { standard: STALL_SWEEP_DEFAULTS, envValues, valid, platform, env, log: () => {} });
  const value = { ...out.value }; const sources = { ...out.sources }; const bad = [...out.invalid];
  // A leaf check cannot see shape (`{maxActionsPerHour: {a: 5}}` has a valid leaf): every resolved scalar is checked
  // again, and a bad one falls back to the standard.
  for (const k of SCALARS) if (!valid[k](value[k])) { bad.push(`resolved ${k}=${JSON.stringify(value[k])}`); value[k] = STALL_SWEEP_DEFAULTS[k]; sources[k] = 'standard (resolved value unusable)'; }
  // The kill switch fails closed: an unusable mode in ANY layer (env, repo file, platform) turns the sweep OFF.
  // An unreadable settings layer is unknown policy: OFF, never a lower layer's `shadow`.
  const settingsUnreadable = layerUnreadable || (env[STALL_SWEEP_MODE_ENV] !== undefined && !STALL_SWEEP_MODES.includes(envValues.mode)) || rawModes.some((m) => !STALL_SWEEP_MODES.includes(m)) || bad.some((x) => /^(?:env|tool|platform|resolved)[ .]?mode\b/.test(x));
  if (settingsUnreadable) {
    value.mode = 'off'; sources.mode = 'unusable mode value: off';
    if (!errors.length && !bad.length) errors.push('unusable mode value: off');
  }
  // The FINAL values (after the fail-closed overrides) are what get logged, with each leaf's source.
  logCascadeSources('prStallSweep', { value, sources, invalid: bad }, { env, log });
  return { value, sources, settingsUnreadable, errors: [...errors, ...bad] };
}

/** Where `pr-sweep-io#resolveStalledAfter` took the threshold from (env > settings > standard), for the pass log. */
function stalledAfterSource(env) {
  const ok = (v) => v !== undefined && v !== null && v !== '' && Number(v) > 0;
  if (ok(env[STALLED_AFTER_ENV])) return 'env';
  try { if (ok(readSettings({})?.prSweep?.stalledAfterMinutes)) return 'settings'; } catch { return 'unknown'; }
  return 'standard';
}
/** The audit dir. The env override only counts for a directory named `pr-stall-sweep`. */
export function stallSweepDir(env = process.env) {
  const o = env?.[STALL_SWEEP_DIR_ENV]?.trim();
  if (o && basename(resolve(o)) === 'pr-stall-sweep') return resolve(o);
  return join(homedir(), 'workspace', '.operations', 'pr-stall-sweep');
}
const monthOf = (now) => new Date(now).toISOString().slice(0, 7);

/** An action record must carry everything the rate limits count by; a partial one makes the history incomplete. */
const wellFormed = (r) => !!r && typeof r === 'object' && !Array.isArray(r) && typeof r.phase === 'string' && Number.isFinite(Date.parse(r.ts))
  && (!['would-do', 'intent'].includes(r.phase) || (typeof r.prHead === 'string' && /^[\w.-]+\/[\w.-]+#\d+@[0-9a-f]{40}$/.test(r.prHead)
    && typeof r.key === 'string' && r.key.startsWith(`${r.prHead}:`) && typeof r.action === 'string' && r.action !== ''));
/** EVERY audit record (all months: the per-head cap and once-per-head asks are lifetime rules). `complete:false` when a
 *  file or line cannot be read: the caller then plans nothing. @returns {{records:object[], complete:boolean}} */
export function readAuditHistory(dir) {
  const records = []; let complete = true; let names = [];
  try { names = readdirSync(dir).filter((n) => /^\d{4}-\d{2}\.jsonl$/.test(n)).sort(); } catch (e) { if (e?.code !== 'ENOENT') complete = false; }
  for (const n of names) {
    let text = '';
    try { text = readFileSync(join(dir, n), 'utf8'); } catch { complete = false; continue; }
    for (const l of text.split('\n').filter((x) => x.trim())) { try { const r = JSON.parse(l); if (wellFormed(r)) records.push(r); else complete = false; } catch { complete = false; } }
  }
  return { records, complete };
}
export function appendAudit(dir, now, records) {
  if (!records.length) return;
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, `${monthOf(now)}.jsonl`), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

/** Which automatic items to act on this pass, under the rate limits and the audit history. PURE. An item already done
 *  for this PR head (same state + action, or the same `onceKey`) is dropped silently. @returns {{act, held}} */
export function planStallActions(items, { history = [], now, limits }) {
  const done = history.filter((h) => h?.phase === 'would-do' || h?.phase === 'intent');
  let hour = done.filter((h) => Date.parse(h.ts) >= now - 3_600_000).length;
  const perHead = new Map();
  for (const h of done) perHead.set(h.prHead, (perHead.get(h.prHead) ?? 0) + 1);
  const seen = new Set(done.map((h) => `${h.key}|${h.action}`));
  const once = new Set(done.map((h) => h.onceKey).filter(Boolean));
  const act = []; const held = [];
  for (const it of items) {
    if (it.lane === 'operator') continue;
    if (seen.has(`${it.key}|${it.action}`) || (it.onceKey && once.has(it.onceKey))) continue;
    const why = act.length >= limits.maxActionsPerSweep ? 'per-sweep cap' : hour >= limits.maxActionsPerHour ? 'per-hour cap'
      : (perHead.get(it.prHead) ?? 0) >= limits.maxActionsPerPrHead ? 'per-PR-head cap' : null;
    if (why) { held.push({ ...it, held: why }); continue; }
    act.push(it); hour += 1; perHead.set(it.prHead, (perHead.get(it.prHead) ?? 0) + 1);
  }
  return { act, held };
}

/** The classifier's leaves of the resolved block (a group with no leaves, like an empty `stateLanes`, is left out). */
export const classifierSettings = (cfg) => Object.fromEntries(Object.keys(CLASSIFY_DEFAULTS).filter((k) => cfg[k] !== undefined).map((k) => [k, cfg[k]]));
/**
 * The `gh` seam the sweep hands the shared reader: it checks each RAW response before the reader normalises it (the
 * reader turns a malformed event into nothing and a missing body into ''), and throws on a malformed one, so the reader
 * records the PR as unreadable and the pass plans nothing.
 */
export const strictGh = (gh) => (bin, args, opts) => {
  const out = gh(bin, args, opts);
  const path = String(args.at(-1) ?? ''); const json = () => JSON.parse(String(out));
  const time = (v) => Number.isFinite(Date.parse(v));
  const ok = args[0] === 'api' && /\/events\?/.test(path) ? json().flat().every((e) => typeof e?.event === 'string' && time(e.created_at) && (e.event !== 'labeled' || typeof e.label?.name === 'string'))
    : args[0] === 'api' && /\/comments\?/.test(path) ? json().flat().every((c) => typeof c?.user?.login === 'string' && typeof c.body === 'string' && time(c.created_at))
      : args[0] === 'pr' && args[1] === 'view' && args.includes('commits') ? Array.isArray(json()?.commits) && json().commits.every((c) => typeof c?.oid === 'string' && time(c.committedDate))
        : true;
  if (!ok) throw new Error(`malformed gh response: ${args.slice(0, 3).join(' ')}`);
  return out;
};
/** The drain-log seam: the reader drops a malformed skip row silently, so every row of the newest one is checked first. */
export const strictDrainText = (readText = tailOf) => (path) => {
  const text = readText(path);
  const line = String(text).split('\n').filter((l) => l.includes('merge-ai-prs · skip-reasons:')).pop();
  const rows = line ? JSON.parse(line.slice(line.indexOf('skip-reasons:') + 13)) : [];
  if (!Array.isArray(rows) || !rows.every((r) => Number.isSafeInteger(r?.num) && r.num > 0 && typeof r.kind === 'string')) throw new Error('malformed drain skip row');
  return text;
};
const ghFiles = (gh) => (repo, n) => {
  const view = JSON.parse(gh('gh', ['pr', 'view', String(n), '-R', repo, '--json', 'files,changedFiles'], { encoding: 'utf8', timeout: 120_000, maxBuffer: 64 * 1024 * 1024 }));
  // Every entry must name a path: a partial list is unreadable evidence, and the whole pass then plans nothing.
  // `gh` returns at most 100 files: a list shorter than `changedFiles` is truncated evidence, never "all the files".
  if (!Array.isArray(view?.files) || view.files.length !== view.changedFiles || !view.files.every((f) => typeof f?.path === 'string' && f.path)) throw new Error('unreadable or truncated file list');
  return view.files.map((f) => f.path);
};

/**
 * One shadow pass. Returns `{mode, sources, errors, state, skipped?, items, act, held, incomplete, records}`.
 * `gh` is the ONLY GitHub seam (read verbs only: `pr list`, `pr view`, `api` GET); tests pin that.
 */
export async function runStallSweep({ now = Date.now(), env = process.env, state = {}, settings, gh = (f, a, o) => execFileSync(f, a, o),
  read, readFiles, judge = judgeRound, dir, log = console.error, force = false } = {}) {
  const s = settings ?? resolveStallSweepSettings({ env, log });
  const cfg = s.value;
  // Disabled/not-due passes still carry the metadata needed to release a disabled digest's feed suppression.
  // Under test only an explicitly passed dir can reach a writer.
  const outDir = dir ?? (isUnderTest(env) ? null : stallSweepDir(env));
  const base = { mode: cfg.mode, digest: cfg.digest, dir: outDir, settingsUnreadable: !!s.settingsUnreadable,
    sources: s.sources, errors: [...(s.errors ?? [])], state: state ?? {} };
  if (cfg.mode === 'off') return { ...base, skipped: 'off' };
  const last = Number(state?.lastRunAt);
  if (!force && Number.isFinite(last) && last <= now && now - last < cfg.intervalMinutes * 60_000) return { ...base, skipped: 'not-due' };
  if (!outDir) return { ...base, skipped: 'under-test' };

  const raw = await (read ?? createPrSweepReader({ run: strictGh(gh), readText: strictDrainText() }))({});
  const report = assessPrSweep(raw);
  const prs = new Map(raw.prs.map((p) => [`${p.repo}#${p.number}`, p]));
  const files = readFiles ?? ghFiles(gh);
  const breaks = readConfirmedBreaks({ env }); // {value, source}: the red-team break-class mapping the judge uses
  const judgeCfg = resolveRoundJudgeMode({ env, log: () => {} }); // `rounds.judge.maxGrants`, the judge's own ceiling
  // Every fetched PR, stalled or not, must carry the evidence the assessment reads: one that does not = incomplete read.
  const readable = (p) => !!p && typeof p.repo === 'string' && Number.isSafeInteger(p.number) && p.number > 0 && typeof p.headRefOid === 'string'
    && /^[0-9a-f]{40}$/i.test(p.headRefOid) && Number.isFinite(Date.parse(p.updatedAt)) && Number.isFinite(Date.parse(p.createdAt)) && Number.isFinite(Date.parse(p.headCommittedAt)) && typeof p.body === 'string' && typeof p.isDraft === 'boolean'
    // A check needs a name and a status or conclusion (CheckRun) / state (StatusContext), as pr-sweep-core reads them.
    && Array.isArray(p.statusCheckRollup) && p.statusCheckRollup.every((c) => typeof (c?.name ?? c?.context) === 'string' && [c?.status, c?.conclusion, c?.state].some((x) => typeof x === 'string' && x) && (String(c?.status).toUpperCase() !== 'COMPLETED' || typeof c.conclusion === 'string'))
    && Array.isArray(p.labels) && p.labels.every((l) => typeof (typeof l === 'string' ? l : l?.name) === 'string')
    && Array.isArray(p.labelEvents) && p.labelEvents.every((e) => typeof e?.label === 'string' && Number.isFinite(Date.parse(e.at)))
    // Each comment as the reader normalises it (a missing GitHub body becomes '' there, in pr-sweep-io).
    && Array.isArray(p.comments) && p.comments.every((c) => typeof c?.author?.login === 'string' && typeof c.body === 'string' && Number.isFinite(Date.parse(c.createdAt)));
  let readFailed = !Array.isArray(raw.prs) || !raw.prs.every(readable);
  const items = [];
  for (const row of report.prs.filter((r) => r.stalled)) {
    const pr = prs.get(`${row.repo}#${row.number}`);
    const head = String(pr?.headRefOid ?? '');
    const trigger = JUDGED_STATES[row.waitingOn];
    let verdict = null; let list = [];
    if (trigger) {
      try {
        list = await files(row.repo, row.number);
        if (!Array.isArray(list) || !list.length || !list.every((x) => typeof x === 'string' && x)) throw new Error('unreadable or empty file list');
        const cap = detectRoundCap({ comments: pr.comments, pr: row.number, head, state: row.waitingOn === 'at-round-limit' ? 'at-round-limit' : null, repo: row.repo });
        verdict = cap?.trigger === trigger ? judge({ pr: row.number, repo: row.repo, head, trigger, comments: pr.comments, files: list, setting: breaks.value, maxGrants: judgeCfg.maxGrants }) : null;
      } catch (e) { base.errors.push(`judge ${row.repo}#${row.number}: ${msg(e)}`); verdict = null; readFailed = true; }
    }
    const c = classifyStall({ row, head, verdict, files: list, card: null, settings: classifierSettings(cfg) });
    // An unreadable row or unreadable evidence anywhere makes the whole pass incomplete (it still reaches the operator).
    if (c?.reason?.startsWith('fail-closed: classifier error') || c?.action === 'unreadable-evidence' || verdict?.evidence?.failClosed) readFailed = true;
    if (c) items.push({ ...c, repo: row.repo, pr: row.number, head, prHead: `${row.repo}#${row.number}@${head.toLowerCase()}`, state: row.waitingOn, title: String(row.title ?? '').slice(0, 120), verdict: verdict?.verdict ?? null });
  }

  // Read the budget, plan and durably record under ONE lock on the audit dir, so two overlapping passes can never both
  // spend the same remaining budget. A lock or write failure plans nothing.
  const failed = (e) => { base.errors.push(`audit log: ${msg(e)}`); return { ...base, state: { lastRunAt: now }, items, act: [], held: [], incomplete: true, records: [] }; };
  try { mkdirSync(outDir, { recursive: true }); return withFileLock(join(outDir, '.lock'), () => commit()); } catch (e) { return failed(e); }
  function commit() {
  // Fail closed: an unreadable PR, file list or audit history means NO action this pass.
  const { records: history, complete: historyOk } = readAuditHistory(outDir);
  const incomplete = raw.unreadable.length > 0 || readFailed || !historyOk;
  const plan = incomplete ? { act: [], held: [] } : planStallActions(items, { history, now, limits: cfg });
  const ts = new Date(now).toISOString();
  const logged = new Set(history.map((h) => `${h.phase}|${h.key}|${h.action}|${h.held ?? ''}`));
  const fresh = (r) => !logged.has(`${r.phase}|${r.key}|${r.action}|${r.held ?? ''}`);
  const note = cfg.mode === 'on' ? { modeNote: 'on is not implemented; behaving as shadow' } : {};
  const records = [
    { ts, phase: 'pass', mode: cfg.mode, ...note, stalled: items.length, incomplete, historyOk, readFailed, settings: { value: cfg, sources: s.sources },
      // Policies owned by other features' readers, logged with value and source on every pass.
      inputs: { stalledAfterMinutes: { value: report.stalledAfterMinutes, source: raw.stalledAfterSource ?? stalledAfterSource(env) }, confirmedBreaks: breaks, judgeMaxGrants: { value: judgeCfg.maxGrants, line: judgeCfg.line } }, unreadable: raw.unreadable.slice(0, 5), errors: base.errors.slice(0, 5),
      lanes: Object.fromEntries(['system', 'policy', 'operator'].map((l) => [l, items.filter((i) => i.lane === l).length])) },
    ...plan.act.map((i) => ({ ts, phase: 'would-do', mode: cfg.mode, ...note, ...i })),
    ...plan.held.map((i) => ({ ts, phase: 'would-skip', mode: cfg.mode, ...i })).filter(fresh),
    ...(incomplete ? [] : items.filter((i) => i.lane === 'operator').map((i) => ({ ts, phase: 'operator', mode: cfg.mode, ...i })).filter(fresh)),
  ];
  // An action that is not durably recorded would escape the rate limits next pass: an unwritten log plans nothing.
  try { appendAudit(outDir, now, records); } catch (e) { return failed(e); }
  for (const r of records.filter((x) => x.phase === 'would-do')) log(`pr-stall-sweep (${cfg.mode}) would ${r.action} ${r.prHead} [${r.lane}]: ${r.reason}`);
  return { ...base, state: { lastRunAt: now }, items, act: plan.act, held: plan.held, incomplete, records };
  }
}
