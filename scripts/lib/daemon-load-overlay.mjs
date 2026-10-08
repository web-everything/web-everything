#!/usr/bin/env node
/**
 * @file scripts/lib/daemon-load-overlay.mjs
 * @description #4044 Module E — the operator's own manual "load this early" CLI for a daemon clone. `--ref` now
 *   REGISTERS the ref as a standing overlay (`we:scripts/lib/daemon-overlays.mjs#addOverlay`, Module B) and
 *   then runs a gated rebuild (`we:scripts/lib/daemon-rebuild.mjs#rebuildClone`, Module C) — the EXACT SAME
 *   rebuild-fresh-from-`origin/main`-plus-overlays → live-smoke → adopt/rollback path a daemon's own
 *   `we:scripts/lib/daemon-self-sync.mjs#withSelfSync` runs every tick, so a hand-triggered early load can
 *   never bypass the gate the daemon's own self-sync is held to, and (unlike the old one-shot merge) the ref
 *   STAYS registered — every later tick keeps rebuilding it in, auto-dropped only once `main`/its PR state make
 *   it moot (Module B/C's own clause-5 auto-drop rules), never silently forgotten after this one CLI run exits.
 *
 * HISTORY (#3383, PR #2601 follow-up, 2026-09-24): the FIRST cut called
 * `we:scripts/lib/daemon-self-sync.mjs#selfSyncCheckout` directly with `--ref` spliced in as its own `base` —
 * conflating the HOME branch (`main`) with the ref being merged IN, which made it refuse `not-on-main` before
 * ever fetching anything. That standalone merge path ({@link mergeOverlayRef}/{@link dryRunOverlay} below) is
 * KEPT, exported, for whatever still imports it directly — but `runDaemonLoadOverlay` no longer calls it: a
 * one-shot merge-then-gate never left a durable record of what was loaded, so the very next automatic rebuild
 * (which rebuilds fresh from `origin/main` + the REGISTERED overlay list, nothing else) would silently drop it
 * again. Registering it as a real overlay is the only way a manual early load survives past this one CLI run.
 *
 * DISPATCH SMOKE (xkhtg2a): an overlay that touches a dispatch-path file must also pass ONE real worker launch
 * before it stays loaded — see the "the DISPATCH SMOKE" section below. A failure removes only this overlay and
 * rebuilds without it. Settings: `overlaySafety` in daemon-rebuild-settings.json, or WE_OVERLAY_DISPATCH_SMOKE
 * (on|off), WE_OVERLAY_DISPATCH_PATHS (comma globs), WE_OVERLAY_NO_PR (warn|refuse),
 * WE_OVERLAY_DISPATCH_SMOKE_TIMEOUT_MS, WE_OVERLAY_DISPATCH_SMOKE_KIND (ci-heal|fix).
 *
 * USAGE:
 *   node scripts/lib/daemon-load-overlay.mjs --clone=<path to a daemon's dedicated clone> --ref=<branch to overlay> [--pr=N] [--base=<home branch, default main>] [--dry-run] [--wait [--wait-ms=N]] [--json]
 *   (versioned clones, card 89 S5: queues a request file for the in-tick updater; --wait blocks on its result)
 *
 * WHAT IT DOES (real run): `addOverlay(root, {ref, pr, addedBy, reason})` (Module B — validates `ref` with
 * `isSafeBranchName`, updates an existing entry in place rather than duplicating it), THEN `rebuildClone(...)`
 * (Module C) under the clone's own write lock — same object-DB rebuild, same live-smoke gate, same
 * adopt/rollback/quarantine handling every automatic tick gets. `mainOnly` is always `false` here: a manual
 * overlay load is never the main-only case (`we:skills-src/conveyor/pass-daemon.mjs`'s `drain`/
 * `merge-orphan-sweep` passes) that refuses overlays altogether.
 * `--dry-run` is STRICTLY read-only: the ref is NEVER written to the overlay list (no `addOverlay` call at
 * all) — instead {@link dryRunRebuild} (Module C) previews the plan with the ref appended AFTER the stored
 * list, VIRTUALLY, via its own `extraOverlays` option, so "what would registering this ref do" can be checked
 * before committing to it.
 * This is a ONE-SHOT CLI, not a daemon — there is no process to restart. It leaves the clone's checkout in the
 * adopted or rolled-back state and reports which, exiting non-zero only when a rebuild moved nothing because
 * it was refused/rejected (so a caller scripting this can tell "nothing to do" apart from "rejected").
 */
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
} from 'node:fs';
import { readHeadSha, isSafeBranchName } from './daemon-self-sync.mjs';
import { gitRun } from './main-staleness.mjs';
import { repairCloneRefs } from './lane-repair.mjs';
import { addOverlay, removeOverlay, appendOverlayEvent } from './daemon-overlays.mjs';
import { rebuildClone, dryRunRebuild } from './daemon-rebuild.mjs';
import { runLiveSmokeWithRetry } from './daemon-live-smoke.mjs';
import { resolveVersionedContext, submitRequest, waitForResult } from './daemon-version-runtime.mjs';
import { rollback as rollbackVersion } from './daemon-version-switch.mjs';

/** Throw unless `ref` passes {@link isSafeBranchName} — same argv-injection defense
 *  `daemon-self-sync.mjs#assertSafeBranchName` applies to a POC branch; `--ref` is operator input here, but
 *  never trust operator input over a git argv either (defense in depth, not paranoia-for-its-own-sake). */
function assertSafeRef(ref, source) {
  if (!isSafeBranchName(ref)) {
    throw new TypeError(`daemon-load-overlay: ${source} ${JSON.stringify(ref)} is not a safe branch name — refusing to pass it to git`);
  }
  return ref;
}

/**
 * The IO: verify the clone is on `homeBranch` and clean, fetch `origin/<ref>`, and merge it in. Never leaves
 * the tree mid-merge — a conflicting merge is ALWAYS aborted before this returns. Mirrors
 * `daemon-self-sync.mjs#selfSyncCheckout`'s fail-closed shape (an unreadable HEAD/status/count is `*-failed`,
 * never coerced into "clean"/"up to date"/"on branch"), but with `homeBranch` (what the clone must already be
 * ON) and `ref` (what gets fetched and merged IN) as two independent parameters — see the file header for why
 * conflating them was the live bug this fixes.
 * @param {{root:string, ref:string, homeBranch?:string, run?:typeof gitRun, timeoutMs?:number}} o
 * @returns {{merged:boolean, commits:number, reason:string}}
 */
export function mergeOverlayRef({ root, ref, homeBranch = 'main', run = gitRun, timeoutMs = 60_000 }) {
  assertSafeRef(ref, '--ref');
  assertSafeRef(homeBranch, '--base');
  const git = (args) => run(args, { cwd: root, timeout: timeoutMs, killSignal: 'SIGKILL' });

  const head = git(['symbolic-ref', '--short', 'HEAD']);
  const onHome = head.status === 0 ? String(head.stdout ?? '').trim() === homeBranch : null;
  if (onHome === null) return { merged: false, commits: 0, reason: 'head-failed' };
  if (!onHome) return { merged: false, commits: 0, reason: 'not-on-base' };

  const status = git(['status', '--porcelain']);
  const dirty = status.status === 0 ? !!String(status.stdout ?? '').trim() : null;
  if (dirty === null) return { merged: false, commits: 0, reason: 'status-failed' };
  if (dirty) return { merged: false, commits: 0, reason: 'dirty' };

  // `--` ends option parsing (same defense-in-depth as daemon-self-sync.mjs's POC fetch): even a `ref` that
  // slipped past assertSafeRef somehow is never read as a git OPTION.
  repairCloneRefs(root, { log: (m) => console.error(m) }); // prune dangling remote-tracking refs before any fetch (no re-clone: this CLI does not hold the clone write lock)
  const fetched = git(['fetch', '--quiet', '--', 'origin', ref]).status === 0;
  if (!fetched) return { merged: false, commits: 0, reason: 'fetch-failed' };

  const count = (range) => {
    const r = git(['rev-list', '--count', range]);
    const out = String(r.stdout ?? '').trim();
    return r.status === 0 && /^\d+$/.test(out) ? Number(out) : null;
  };
  const behind = count(`HEAD..origin/${ref}`);
  if (behind === null) return { merged: false, commits: 0, reason: 'count-failed' };
  if (!behind) return { merged: false, commits: 0, reason: 'up-to-date' };

  const merge = git(['merge', `origin/${ref}`, '--no-edit', '-m', `overlay: merge origin/${ref} (daemon-load-overlay)`]);
  if (merge.status !== 0) {
    // NEVER leave the tree mid-merge — this is the exact failure mode the live incident hit by hand.
    git(['merge', '--abort']);
    return { merged: false, commits: 0, reason: 'conflict' };
  }
  return { merged: true, commits: behind, reason: 'merged' };
}

/**
 * Real, read-only preview: fetches `origin/<ref>` and reports what a real run would do — no `git merge` ever
 * runs, so the clone's tree is untouched regardless of what this reports.
 * @param {{root:string, ref:string, homeBranch?:string, run?:typeof gitRun, timeoutMs?:number}} o
 * @returns {{onHome:boolean|null, dirty:boolean|null, fetched:boolean, behind:number|null, headSha:string|null, wouldMerge:boolean}}
 */
export function dryRunOverlay({ root, ref, homeBranch = 'main', run = gitRun, timeoutMs = 60_000 }) {
  assertSafeRef(ref, '--ref');
  assertSafeRef(homeBranch, '--base');
  const git = (args) => run(args, { cwd: root, timeout: timeoutMs, killSignal: 'SIGKILL' });

  const head = git(['symbolic-ref', '--short', 'HEAD']);
  const onHome = head.status === 0 ? String(head.stdout ?? '').trim() === homeBranch : null;
  const status = git(['status', '--porcelain']);
  const dirty = status.status === 0 ? !!String(status.stdout ?? '').trim() : null;
  const fetched = git(['fetch', '--quiet', '--', 'origin', ref]).status === 0;
  const count = (range) => {
    const r = git(['rev-list', '--count', range]);
    const out = String(r.stdout ?? '').trim();
    return r.status === 0 && /^\d+$/.test(out) ? Number(out) : null;
  };
  const behind = fetched ? count(`HEAD..origin/${ref}`) : null;
  const headSha = readHeadSha({ root, run, timeoutMs });
  return {
    onHome, dirty, fetched, behind, headSha,
    wouldMerge: onHome === true && dirty === false && fetched && Number.isFinite(behind) && behind > 0,
  };
}

// ── xkhtg2a — the DISPATCH SMOKE ──────────────────────────────────────────────────────────────────────────────
// Incident 2026-10-08: overlay `lane/worker-contract-s3b` went onto the fix/review daemon clones and broke EVERY
// fix/ci-heal dispatch for ~1 hour. Its detached `claude -p` launch had no `--permission-mode`, so each worker hit
// "This command requires approval" and died at step 0. The rebuild's live smoke passed, because it only runs
// dispatch DRY-RUNS; it never launches a real worker. So: when the overlay being loaded touches a dispatch-path
// file, the gated load launches ONE real worker through the tree's own launch path (`defaultClaudeProvider`, the
// exact function a ci-heal dispatch calls) against a scratch completion store, and requires its first commands to
// run with no approval prompt and a completion record to be written. It runs inside the rebuild's candidate smoke
// (before anything is adopted); a failure throws there, so the rebuild holds the clone on its last-good tree WITHOUT
// dropping any other overlay, and this load then removes only its own overlay. If the overlay got adopted without
// that candidate smoke (a cached tree, or the daemon's own tick adopted it first), the live clone is smoked right
// after and the same rollback runs.

/** The derived dispatch-path set: every file a fix / ci-heal / review worker launch runs through. A setting
 *  (`overlaySafety.dispatchPaths` in daemon-rebuild-settings.json, or `WE_OVERLAY_DISPATCH_PATHS`). */
export const DISPATCH_PATH_DEFAULTS = Object.freeze([
  'scripts/operations/dispatch-lane-io.mjs',
  'scripts/operations/dispatch-lane.mjs',
  'scripts/operations/worker-wrapper*.mjs',
  'scripts/operations/detached-dispatch.mjs',
  'scripts/operations/review-dispatch.mjs',
  'scripts/operations/review-job*.mjs',
  'scripts/operations/ci-heal-pr-dispatch.mjs',
  'scripts/operations/completion-*.mjs',
  'scripts/operations/deliver-item-wrapper.mjs',
  'scripts/operations/session-role.mjs',
  'scripts/operations/dispatch-providers/*.mjs',
  'scripts/conveyor/reconcile-fix-dispatch.mjs',
  'scripts/lib/dispatch-bg-isolation.mjs',
  'scripts/lib/gh-app-shim.mjs',
  'scripts/lib/spawn-to-completion.mjs',
  'scripts/lib/advisor-trial.mjs',
  'scripts/lib/provider-routing.mjs',
  'skills-src/conveyor/dispatched-agent-system-prompt.md',
]);

const SETTINGS_FILE = join(dirname(fileURLToPath(import.meta.url)), 'daemon-rebuild-settings.json');
const DEFAULT_SMOKE_TIMEOUT_MS = 5 * 60_000;

function readSettingsFile() {
  try { return JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')); } catch { return null; }
}

/**
 * The overlay-safety settings: built-in defaults, then `overlaySafety` in daemon-rebuild-settings.json, then env.
 * An invalid value falls back to the default (never to "off").
 * @returns {{dispatchSmoke:'on'|'off', dispatchPaths:string[], noPr:'warn'|'refuse', smokeTimeoutMs:number, smokeKind:'ci-heal'|'fix'}}
 */
export function overlaySafetySettings(env = process.env, { readSettings = readSettingsFile } = {}) {
  const file = (readSettings() || {}).overlaySafety || {};
  const pick = (envVal, fileVal, allowed, dflt) => {
    for (const v of [envVal, fileVal]) {
      const t = typeof v === 'string' ? v.trim() : v;
      if (t !== undefined && t !== null && t !== '') return allowed.includes(t) ? t : dflt;
    }
    return dflt;
  };
  const envPaths = typeof env?.WE_OVERLAY_DISPATCH_PATHS === 'string' && env.WE_OVERLAY_DISPATCH_PATHS.trim()
    ? env.WE_OVERLAY_DISPATCH_PATHS.split(',').map((x) => x.trim()).filter(Boolean) : null;
  const filePaths = Array.isArray(file.dispatchPaths) && file.dispatchPaths.every((x) => typeof x === 'string') ? file.dispatchPaths : null;
  const timeout = Number(env?.WE_OVERLAY_DISPATCH_SMOKE_TIMEOUT_MS ?? file.smokeTimeoutMs);
  return {
    dispatchSmoke: pick(env?.WE_OVERLAY_DISPATCH_SMOKE, file.dispatchSmoke, ['on', 'off'], 'on'),
    dispatchPaths: envPaths || filePaths || [...DISPATCH_PATH_DEFAULTS],
    noPr: pick(env?.WE_OVERLAY_NO_PR, file.noPr, ['warn', 'refuse'], 'warn'),
    smokeTimeoutMs: Number.isFinite(timeout) && timeout >= 60_000 ? timeout : DEFAULT_SMOKE_TIMEOUT_MS,
    smokeKind: pick(env?.WE_OVERLAY_DISPATCH_SMOKE_KIND, file.smokeKind, ['ci-heal', 'fix'], 'ci-heal'),
  };
}

function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') { re += '.*'; i += 1; if (glob[i + 1] === '/') i += 1; } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/** The files (in input order) that match any dispatch-path pattern. PURE. */
export function matchDispatchPaths(files, patterns) {
  const res = (patterns || []).map(globToRegExp);
  return (files || []).filter((f) => res.some((r) => r.test(f)));
}

/**
 * Is `origin/<ref>` part of the tree at `tree`, and which dispatch-path files does the overlay change against main?
 * Fails CLOSED: an in-tree overlay whose diff cannot be read is `required`.
 * @returns {{inTree:boolean, required:boolean, tip?:string, files?:string[]|null, matched?:string[], reason:string}}
 */
export function overlayDispatchFiles({ tree, ref, patterns, run = gitRun }) {
  assertSafeRef(ref, '--ref');
  const git = (args) => run(args, { cwd: tree, timeout: 60_000, killSignal: 'SIGKILL' });
  const tipRes = git(['rev-parse', '--verify', '--quiet', `origin/${ref}^{commit}`]);
  const tip = tipRes.status === 0 ? String(tipRes.stdout ?? '').trim() : '';
  if (!tip) return { inTree: false, required: false, reason: 'ref-unresolved' };
  if (git(['merge-base', '--is-ancestor', tip, 'HEAD']).status !== 0) return { inTree: false, required: false, tip, reason: 'not-in-tree' };
  const baseRes = git(['merge-base', 'origin/main', tip]);
  const base = baseRes.status === 0 ? String(baseRes.stdout ?? '').trim() : '';
  const diff = base ? git(['diff', '--name-only', base, tip]) : null;
  if (!diff || diff.status !== 0) return { inTree: true, required: true, tip, files: null, matched: [], reason: 'diff-unknown' };
  const files = String(diff.stdout ?? '').split('\n').map((x) => x.trim()).filter(Boolean);
  const matched = matchDispatchPaths(files, patterns);
  return { inTree: true, required: matched.length > 0, tip, files, matched, reason: matched.length ? 'touches-dispatch-path' : 'off-dispatch-path' };
}

const PERMISSION_BLOCKER = /permission/i;

/**
 * The pass/fail rule for one real smoke worker. PURE. `marker` is what the worker's own Bash command wrote (the
 * proof a command actually ran), `record` its completion record, `denials` the denied-command lines found in its
 * transcript. `pending:true` = keep waiting (no verdict yet).
 */
export function judgeDispatchSmoke({ nonce, marker, record, denials = [], timedOut = false }) {
  const blocker = record?.result?.blocker ?? null;
  const blockerKind = typeof blocker === 'string' ? blocker : blocker?.kind;
  if (denials.length || (blockerKind && PERMISSION_BLOCKER.test(String(blockerKind))) || record?.denied) {
    return { ok: false, reason: 'commands-denied', detail: denials[0] || blockerKind || String(record?.denied) };
  }
  if (record?.status === 'done') {
    return marker === nonce ? { ok: true, reason: 'passed' } : { ok: false, reason: 'no-commands-ran', detail: 'the worker finished without running its smoke commands' };
  }
  if (timedOut) return { ok: false, reason: 'timeout', detail: marker === nonce ? 'commands ran but no completion record' : 'no command ran and no completion record' };
  return { ok: false, pending: true, reason: 'pending' };
}

/** The denied-command lines in a Claude transcript (tool results marked as errors that name an approval/permission). */
function transcriptDenials(file) {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.includes('tool_result') || !line.includes('is_error')) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    for (const item of Array.isArray(row?.message?.content) ? row.message.content : []) {
      if (item?.type !== 'tool_result' || !item.is_error) continue;
      const body = typeof item.content === 'string' ? item.content : JSON.stringify(item.content ?? '');
      if (/requires approval|permission/i.test(body)) out.push(body.slice(0, 200));
    }
  }
  return out;
}

function findTranscript(ids, home = homedir()) {
  const dir = join(home, '.claude', 'projects');
  let projects = [];
  try { projects = readdirSync(dir); } catch { return null; }
  for (const p of projects) {
    let names = [];
    try { names = readdirSync(join(dir, p)); } catch { continue; }
    const hit = names.find((n) => n.endsWith('.jsonl') && ids.some((id) => id && n.startsWith(id)));
    if (hit) return join(dir, p, hit);
  }
  return null;
}

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; }
}

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

/** Runs INSIDE the tree under test (its own modules, its own launch path): the same request `createDispatchSinks`
 *  hands `defaultClaudeProvider` for a ci-heal/fix dispatch. Prints `{handle, wrapperPid, cwd}` as its last line. */
const LAUNCH_HARNESS = `
const [tree, slug, kind, pr, sessionId, prompt] = process.argv.slice(1);
const { pathToFileURL } = await import('node:url');
const { join } = await import('node:path');
const imp = (p) => import(pathToFileURL(join(tree, p)).href);
const io = await imp('scripts/operations/dispatch-lane-io.mjs');
const iso = await imp('scripts/lib/dispatch-bg-isolation.mjs');
const cwd = io.ensureDispatchSessionCwd(io.dispatchSessionCwd(sessionId, { root: tree }));
const isolated = iso.isolateDispatchSession(cwd);
const resolveEnv = io.resolveDispatchSettingsEnv || io.resolveGhShimSettingsEnv;
let wrapperPid = null;
const handle = io.defaultClaudeProvider({
  sessionId, cwd, prompt, sessionSlug: slug, launchKind: kind, pr,
  systemPromptFile: io.DISPATCHED_AGENT_SYSTEM_PROMPT_FILE, settingsEnv: resolveEnv(cwd),
  worktreeSettings: (isolated && isolated.worktreeSettings) || null,
  reportWrapped: (pid) => { wrapperPid = pid; },
});
process.stdout.write('\\n' + JSON.stringify({ handle, wrapperPid, cwd }) + '\\n');
`;

/** The smoke worker's task: three commands, the first of the kind the incident's workers were refused. */
export function dispatchSmokePrompt({ tree, store, marker, nonce, slug, kind, pr }) {
  const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  return [
    'Dispatch smoke for a daemon overlay load. This is not PR work: do not acquire a lane, do not edit or create any file yourself, open nothing.',
    'Run these three Bash commands exactly as written, one at a time, and report the first output line of each:',
    '1. gh api rate_limit --jq .resources.core.limit',
    `2. node -e "require('fs').writeFileSync(process.argv[1], process.argv[2])" ${q(marker)} ${q(nonce)}`,
    `3. OPERATION_COMPLETIONS_DIR=${q(store)} node ${q(join(tree, 'scripts', 'operations', 'completion-cli.mjs'))} report --session=${slug} --kind=${kind} --pr=${pr} --status=done --outcome=not-applicable`,
    'Then finish with outcome not-applicable.',
  ].join('\n');
}

/**
 * Launch ONE real worker through `tree`'s own dispatch launch path and wait for its verdict (see
 * {@link judgeDispatchSmoke}). Its completion record and spec go to a scratch store, never the real one.
 * @returns {Promise<{ok:boolean, reason:string, detail?:string, sessionId:string, handle?:string|null, wrapperPid?:number|null, scratch:string, transcript?:string|null, ms:number}>}
 */
export async function runRealDispatchSmoke({
  tree, env = process.env, settings = overlaySafetySettings(env), spawn = spawnSync, pollMs = 2_000, home = homedir(), log = console,
}) {
  const t0 = Date.now();
  const scratch = mkdtempSync(join(tmpdir(), 'we-overlay-dispatch-smoke-'));
  const store = join(scratch, 'completions');
  mkdirSync(store, { recursive: true });
  const marker = join(scratch, 'marker.txt');
  const nonce = randomUUID();
  const kind = settings.smokeKind;
  const pr = '999998';
  const slug = `${kind}-${pr}`;
  const sessionId = randomUUID();
  const prompt = dispatchSmokePrompt({ tree, store, marker, nonce, slug, kind, pr });
  const childEnv = { ...env, OPERATION_COMPLETIONS_DIR: store, WE_POSTMORTEM_MODE: 'off' };
  const base = { sessionId, scratch };
  log.error?.(`daemon-load-overlay: dispatch smoke — launching one real ${kind} worker from ${tree} (scratch store ${store})`);
  const launch = spawn(process.execPath, ['--input-type=module', '-e', LAUNCH_HARNESS, tree, slug, kind, pr, sessionId, prompt], {
    cwd: tree, env: childEnv, encoding: 'utf8', timeout: 120_000, killSignal: 'SIGKILL',
  });
  if (launch.status !== 0) {
    return { ...base, ok: false, reason: 'launch-failed', detail: String(launch.stderr || launch.error?.message || '').trim().split('\n').slice(-3).join(' | '), ms: Date.now() - t0 };
  }
  let launched = {};
  try { launched = JSON.parse(String(launch.stdout).trim().split('\n').pop()); } catch { /* keep {} */ }
  const handle = typeof launched.handle === 'string' ? launched.handle : null;
  const wrapperPid = Number.isInteger(launched.wrapperPid) ? launched.wrapperPid : null;
  const ids = [sessionId, handle && !handle.startsWith('pid:') ? handle : null];
  const deadline = t0 + settings.smokeTimeoutMs;
  let verdict;
  let transcript = null;
  const observe = (timedOut) => {
    transcript = transcript || findTranscript(ids, home);
    const markerText = existsSync(marker) ? readFileSync(marker, 'utf8').trim() : null;
    return judgeDispatchSmoke({
      nonce, marker: markerText, record: readJson(join(store, `${slug}.json`)), denials: transcript ? transcriptDenials(transcript) : [], timedOut,
    });
  };
  for (;;) {
    verdict = observe(Date.now() >= deadline);
    if (!verdict.pending) break;
    await sleep(pollMs);
  }
  // A wrapped worker writes its own final record when `claude -p` exits — wait for it (bounded) and judge that too.
  if (verdict.ok && wrapperPid) {
    const until = Math.min(deadline, Date.now() + 90_000);
    while (isAlive(wrapperPid) && Date.now() < until) await sleep(pollMs);
    verdict = observe(false);
    if (verdict.pending) verdict = { ok: true, reason: 'passed' };
  }
  if (!verdict.ok && verdict.reason === 'timeout' && isAlive(wrapperPid)) {
    try { process.kill(wrapperPid, 'SIGTERM'); } catch { /* already gone */ }
  }
  return {
    ...base, ...verdict, handle, wrapperPid, transcript, ms: Date.now() - t0,
  };
}

/**
 * Wrap the rebuild's candidate smoke: after the normal live smoke PASSES, if the candidate tree contains `ref` and
 * the overlay touches the dispatch path, run the dispatch smoke against that candidate. A failure THROWS, so
 * `smokeAndAdopt` holds the clone on its last-good tree (`smoke-threw`) instead of adopting it — and, unlike a
 * failed-check verdict, never falls back to "plain main", which would drop every other overlay too.
 * `ctl` is filled with what happened ({ran, phase, required, matched, result}).
 */
export function withDispatchSmoke({
  baseSmoke = runLiveSmokeWithRetry, ref, settings, dispatchSmoke = runRealDispatchSmoke, inspect = overlayDispatchFiles, ctl = {}, log = console,
}) {
  return async (args) => {
    const result = await baseSmoke(args);
    if (result?.verdict !== 'pass') return result;
    const info = inspect({ tree: args.root, ref, patterns: settings.dispatchPaths });
    if (!info.inTree || !info.required) return result;
    const smoke = await dispatchSmoke({ tree: args.root, env: args.env, settings, log });
    Object.assign(ctl, {
      ran: true, phase: 'candidate', required: true, matched: info.matched, result: smoke,
    });
    if (!smoke.ok) {
      throw new Error(`dispatch-smoke-failed: ${smoke.reason}${smoke.detail ? ` — ${smoke.detail}` : ''}`);
    }
    log.error?.(`daemon-load-overlay: dispatch smoke PASSED for ${ref} (${smoke.ms ?? '?'}ms)`);
    return result;
  };
}

/**
 * REGISTER `--ref` as a standing overlay (Module B) and run a gated rebuild (Module C) — the real-run path.
 * `--dry-run` never calls `addOverlay` at all; it previews the plan with `ref` appended VIRTUALLY via
 * {@link dryRunRebuild}'s own `extraOverlays` option, so nothing is ever written to the overlay list on a
 * preview.
 * @param {{clone:string, ref:string, pr?:number|null, base?:string, dryRun?:boolean, env?:NodeJS.ProcessEnv,
 *   log?:Console, addedBy?:string|null, reason?:string|null, now?:string,
 *   addOverlayFn?:typeof addOverlay, rebuild?:typeof rebuildClone, dryRunRebuildFn?:typeof dryRunRebuild}} o
 * @returns {Promise<object>}
 */
export async function runDaemonLoadOverlay({
  clone, ref, pr = null, base = 'main', dryRun = false, env = process.env, log = console,
  addedBy, reason = null, now,
  addOverlayFn = addOverlay, rebuild = rebuildClone, dryRunRebuildFn = dryRunRebuild,
  wait = false, waitMs, versions, submit = submitRequest, waitFor = waitForResult, rollbackVersionFn = rollbackVersion,
  settings, baseSmoke = runLiveSmokeWithRetry, dispatchSmoke = runRealDispatchSmoke, inspect = overlayDispatchFiles,
  removeOverlayFn = removeOverlay, appendEventFn = appendOverlayEvent,
}) {
  if (!clone || typeof clone !== 'string') throw new TypeError('daemon-load-overlay: --clone=<path> is required');
  if (!ref || typeof ref !== 'string') throw new TypeError('daemon-load-overlay: --ref=<branch to overlay> is required');
  const root = resolve(clone);
  const by = addedBy ?? (typeof env?.USER === 'string' && env.USER ? env.USER : null);

  if (dryRun) {
    const preview = await dryRunRebuildFn({ root, env, extraOverlays: [{ ref, pr }] });
    return { root, ref, homeBranch: base, dryRun: true, ...preview };
  }

  // xkhtg2a — an overlay with no PR has no review behind it (the 2026-10-08 incident's entries showed pr=null).
  const safety = settings || overlaySafetySettings(env);
  const warnings = [];
  if (pr == null) {
    if (safety.noPr === 'refuse') {
      log.error?.(`daemon-load-overlay: REFUSED — ${ref} has NO PR (overlaySafety.noPr=refuse). Open a PR and pass --pr=<N>.`);
      return { root, ref, homeBranch: base, registered: false, refused: true, reason: 'no-pr' };
    }
    warnings.push('no-pr');
    log.error?.(`daemon-load-overlay: WARNING — loading ${ref} with NO PR. Nothing reviewed this code and nothing ties it to a merge; pass --pr=<N>. (overlaySafety.noPr=warn; set refuse to block this.)`);
  }

  addOverlayFn(root, {
    ref, pr, addedBy: by, reason, now,
  }, { env });
  // Card 89 S5: a versioned clone has no lock to take and is never rebuilt from this CLI. The request file is
  // the daemon's in-tick updater's input; `--wait` blocks on its result file instead of on a clone lock.
  const vctx = versions === undefined ? resolveVersionedContext({ root, env }) : versions;
  const smokeOn = safety.dispatchSmoke === 'on';

  // A worker launch that THROWS is a failed smoke (a rollback), never an unhandled rejection that leaves the overlay registered.
  const smokeTree = async (tree) => {
    try { return await dispatchSmoke({ tree, env, settings: safety, log }); } catch (e) {
      return { ok: false, reason: 'smoke-threw', detail: String((e && e.message) || e).split('\n')[0] };
    }
  };
  const notRun = (why) => {
    warnings.push('dispatch-smoke-not-run');
    log.error?.(`daemon-load-overlay: WARNING — NO dispatch smoke ran for ${ref}: ${why}. It stays registered and unsmoked.`);
  };

  // ROLLBACK — remove ONLY this overlay, then recover through `rebuildWithout`: main + every other overlay, unchanged.
  const rollBack = async (out, ctl, rebuildWithout) => {
    const why = `dispatch-smoke-failed: ${ctl.result.reason}${ctl.result.detail ? ` — ${ctl.result.detail}` : ''}`;
    log.error?.(`daemon-load-overlay: ${ref} FAILED the dispatch smoke (${ctl.phase}): ${why}. Removing it and recovering without it (other overlays untouched). Evidence: ${ctl.result.scratch ?? 'n/a'}${ctl.result.transcript ? `, transcript ${ctl.result.transcript}` : ''}`);
    removeOverlayFn(root, ref, { env, why });
    try {
      appendEventFn(root, {
        kind: 'removed', ref, pr, by: 'daemon-load-overlay', reason: why,
      }, { env });
    } catch { /* the audit line is best-effort; the removal above is what matters */ }
    let rebuilt;
    try { rebuilt = await rebuildWithout(); } catch (e) { rebuilt = { reason: `error: ${String((e && e.message) || e).split('\n')[0]}`, adopted: false }; }
    return {
      ...out, registered: false, adopted: false, rolledBack: true, reason: 'dispatch-smoke-failed',
      rollback: { reason: rebuilt.reason, adopted: !!rebuilt.adopted }, head: rebuilt.head !== undefined ? rebuilt.head : out.head,
      alerts: [...(out.alerts || []), ...(rebuilt.alerts || [])],
    };
  };

  if (vctx) {
    const requestId = submit(vctx, { ref, pr, by });
    // The in-tick updater is the one that builds and adopts, so this CLI can only smoke what a --wait result reports
    // adopted. Without --wait nothing has been built yet: say so loudly rather than let "registered" read as "smoked".
    if (!wait) {
      if (smokeOn) notRun("it is queued for the versioned clone's in-tick updater and nothing here will smoke it; re-run with --wait to smoke the adopted version");
      return {
        root, ref, homeBranch: base, registered: true, versioned: true, requestId, pending: true, warnings,
        ...(smokeOn ? { dispatchSmoke: { ran: false, skipped: 'versioned-no-wait' } } : {}),
      };
    }
    const result = await waitFor(vctx, requestId, waitMs != null ? { timeoutMs: waitMs } : {});
    const out = {
      root, ref, homeBranch: base, registered: true, versioned: true, requestId, request: result,
      mergedAnything: !!result.moved, adopted: !!result.adopted, reason: result.reason ?? result.status, head: result.head,
      timedOut: result.status === 'timeout', warnings,
    };
    if (!smokeOn) return out;
    if (!result.adopted) {
      notRun(`the updater did not adopt a version (${out.reason}); a later tick may adopt it without a smoke`);
      return { ...out, dispatchSmoke: { ran: false, skipped: 'not-adopted' } };
    }
    // Smoke the version THIS request adopted (the result names it) — `current` may have moved on since. Today the
    // updater builds origin/main only (`overlaysApplied: false`), so the overlay is usually not in it: then say so.
    const versionId = typeof result.versionId === 'string' && /^[0-9A-Za-z][0-9A-Za-z._-]*$/.test(result.versionId) ? result.versionId : null;
    const tree = versionId ? join(vctx.dir, 'versions', versionId) : null;
    let info = { inTree: false, required: false };
    if (tree) {
      try { info = inspect({ tree, ref, patterns: safety.dispatchPaths }); } catch { info = { inTree: true, required: true, matched: [], reason: 'inspect-threw' }; } // fail CLOSED
    }
    if (!info.inTree) {
      notRun(`it is not in the adopted versioned tree${tree ? ` (${tree})` : ' (the result names no version)'}`);
      return { ...out, dispatchSmoke: { ran: false, skipped: 'overlay-not-in-versioned-tree' } };
    }
    if (!info.required) return { ...out, dispatchSmoke: { ran: false, skipped: 'not-dispatch-path' } };
    const ctl = {
      ran: true, phase: 'post-adopt', required: true, matched: info.matched, result: await smokeTree(tree),
    };
    if (ctl.result.ok) return { ...out, dispatchSmoke: ctl };
    // The overlay is removed from the list, and the adopted version is rolled back with the daemon's own version
    // rollback (it flips `current` to `previous` and holds the rejected sha until main moves) — re-requesting a build
    // would only rebuild origin/main, which already contains this tree.
    return rollBack({ ...out, dispatchSmoke: ctl }, ctl, async () => {
      const rolled = await rollbackVersionFn({
        clone: vctx.clone, home: vctx.home, settings: vctx.settings, by: 'daemon-load-overlay', reason: `dispatch-smoke-failed: ${ref}`,
      });
      return { reason: rolled?.status ?? 'unknown', adopted: rolled?.status === 'switched', head: null };
    });
  }
  const ctl = { ran: false, phase: null, required: null, result: null };
  const runSmoke = smokeOn ? withDispatchSmoke({
    baseSmoke, ref, settings: safety, dispatchSmoke, inspect, ctl, log,
  }) : baseSmoke;
  const rebuildResult = await rebuild({
    root, env, log, mainOnly: false, runSmoke,
  });

  // Adopted without the candidate dispatch smoke (a cached/proven tree skips the smoke; a daemon tick that took the
  // lock first adopts with its own plain smoke): smoke the LIVE clone now, if the overlay is in it and needs one.
  if (smokeOn && !ctl.ran) {
    const info = inspect({ tree: root, ref, patterns: safety.dispatchPaths });
    if (info.inTree && info.required) {
      Object.assign(ctl, {
        ran: true, phase: 'post-adopt', required: true, matched: info.matched, result: await smokeTree(root),
      });
    } else if (!info.inTree) {
      notRun(`it is not in the live tree (${rebuildResult.reason ?? 'rebuild not adopted'})`);
    }
  }

  const out = {
    root, ref, homeBranch: base, registered: true, mergedAnything: !!rebuildResult.moved,
    adopted: !!rebuildResult.adopted, reason: rebuildResult.reason, alerts: rebuildResult.alerts, head: rebuildResult.head,
    warnings, ...(ctl.ran ? { dispatchSmoke: { ...ctl } } : {}),
  };
  if (!ctl.ran || ctl.result?.ok) return out;

  return rollBack(out, ctl, () => rebuild({
    root, env, log, mainOnly: false, runSmoke: baseSmoke,
  }));
}

function parseFlags(argv) {
  const flags = {};
  for (const a of argv) {
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq === -1) flags[a.slice(2)] = true;
    else flags[a.slice(2, eq)] = a.slice(eq + 1);
  }
  return flags;
}

const IS_CLI = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (IS_CLI) {
  const flags = parseFlags(process.argv.slice(2));
  const clone = typeof flags.clone === 'string' ? flags.clone : null;
  const ref = typeof flags.ref === 'string' ? flags.ref : null;
  const base = typeof flags.base === 'string' ? flags.base : 'main';
  const pr = flags.pr !== undefined ? Number(flags.pr) : null;
  const reason = typeof flags.reason === 'string' ? flags.reason : null;
  const addedBy = typeof flags.by === 'string' ? flags.by : (process.env.USER || null);
  const dryRun = !!flags['dry-run'];
  const wait = !!flags.wait;
  const waitMs = flags['wait-ms'] !== undefined && Number(flags['wait-ms']) > 0 ? Number(flags['wait-ms']) : undefined;
  runDaemonLoadOverlay({
    clone, ref, pr, base, dryRun, addedBy, reason, wait, waitMs,
  })
    .then((result) => {
      if (flags.json) {
        process.stdout.write(`${JSON.stringify(result)}\n`);
      } else if (result.refused) {
        process.stdout.write(`daemon-load-overlay: REFUSED ${ref} (${result.reason}) — nothing registered (${result.root})\n`);
      } else if (result.rolledBack) {
        const d = result.dispatchSmoke || {};
        process.stdout.write(`daemon-load-overlay: ${ref} FAILED the dispatch smoke (${d.phase}: ${d.result?.reason}${d.result?.detail ? ` — ${d.result.detail}` : ''}) — `
          + `ROLLED BACK: overlay removed, ${result.rollback?.adopted ? 'recovered without it' : 'recovery was NOT done — the bad tree may still be live'} (${result.rollback?.reason}) at ${result.root}, head ${result.head ?? 'n/a'}\n`
          + `  evidence: ${d.result?.scratch ?? 'n/a'}${d.result?.transcript ? ` transcript ${d.result.transcript}` : ''}\n`);
      } else if (result.dryRun) {
        process.stdout.write(
          `daemon-load-overlay --dry-run: ${result.root} onMain=${result.onMain} safe=${result.unsafe?.safe} `
          + `wouldDo=${result.wouldDo} finalSha=${result.plan?.finalSha ?? 'n/a'}\n`,
        );
      } else if (result.versioned) {
        process.stdout.write(result.pending
          ? `daemon-load-overlay: registered ${ref} — versioned clone, request ${result.requestId} queued for the in-tick updater (use --wait to block on its result) (${result.root})\n`
          : `daemon-load-overlay: registered ${ref} — versioned request ${result.requestId} ${result.timedOut ? 'TIMED OUT' : `answered: ${result.reason}`} (${result.root})\n`);
      } else if (!result.mergedAnything) {
        process.stdout.write(`daemon-load-overlay: registered ${ref} — nothing adopted this pass (${result.reason}) (${result.root})\n`);
      } else if (result.adopted) {
        process.stdout.write(`daemon-load-overlay: registered ${ref} and ADOPTED onto ${result.head} at ${result.root} (${result.reason})\n`);
      } else {
        process.stdout.write(`daemon-load-overlay: registered ${ref} but the rebuild was REJECTED (${result.reason}) at ${result.root}\n`);
      }
      for (const a of result.alerts || []) process.stdout.write(`  ! ${a.kind}\n`);
      if (!flags.json && result.dispatchSmoke?.result?.ok) {
        process.stdout.write(`  dispatch smoke PASSED (${result.dispatchSmoke.phase}, ${result.dispatchSmoke.result.ms}ms, session ${result.dispatchSmoke.result.sessionId})\n`);
      }
      process.exitCode = (result.mergedAnything && !result.adopted) || result.timedOut || result.refused || result.rolledBack ? 1 : 0;
    })
    .catch((e) => {
      process.stderr.write(`daemon-load-overlay: fatal: ${String((e && e.message) || e)}\n`);
      process.exitCode = 1;
    });
}
