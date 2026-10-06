/**
 * agy-review-juror.mjs — ONE agy (Antigravity CLI) review juror, run in its OWN juror lane, with an escape check
 * (card 84, review half).
 *
 * WHY A CHECK AND NOT A SANDBOX. agy has no real confinement: `--sandbox` confines only its shell, and its in-process
 * file tools walk around it (#3633 probes 12-13; see the header of `we:scripts/gemini-direct-task.mjs`). This juror
 * runs WITHOUT `--dangerously-skip-permissions`, so agy's own headless check denies shell commands and writes and
 * allows reads inside its cwd (re-probed on agy 1.3.0, 2026-10-06). That is a permission check inside the tool we are
 * guarding against, so it is not trusted alone. After the juror finishes, three independent checks look for any
 * change it made:
 *
 *   1. ITS OWN LANE. The juror lane is a throwaway local clone of the review lane's committed HEAD (the same clone
 *      `gemini-direct-task.mjs` builds — reused, not re-implemented). A review seat is read-only, so ANY change there
 *      (a modified, added or deleted file, or a moved HEAD) voids the seat.
 *   2. OUTSIDE ITS LANE. The review lane it was cloned from and this checkout are snapshotted (HEAD + full porcelain
 *      status) before and compared after. Any difference voids the seat.
 *   3. ITS OWN TRANSCRIPT. Any write/edit/delete/command tool call that completed WITHOUT an error voids the seat,
 *      wherever it pointed — this is the check that catches a write to a path no snapshot watches.
 *
 * A voided or failed seat returns `status: 'voided' | 'failed'` with the reasons and NO answer; the caller
 * (`we:scripts/operations/review-seat-runner.mjs`) falls back to Claude for that seat. False alarms are possible
 * (another process touching a watched checkout mid-run); they fail SAFE — the seat falls back to Claude.
 *
 * REVIEWER INDEPENDENCE. Each run is a fresh agy conversation (its own conversation id, recorded as the seat's session
 * id) and starts from the diff and its own checkout only — it is never shown another juror's answer.
 *
 * Never prints a token: nothing here reads credentials; agy uses its own login.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { antigravityJudgeSpawn } from './antigravity-judge-spawn.mjs';
import { buildScratchCloneArgv, parseJsonlEvents } from '../gemini-direct-task.mjs';

/** This checkout — watched for outside-the-lane changes. */
export const MODULE_REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** A tool name that changes state. A completed (non-error) call to one voids the seat. */
export const STATE_CHANGING_TOOL = /(write|replace|edit|delete|remove|move|rename|create|run_command|exec|shell|notebook)/i;

const defaultExec = (bin, args, opts = {}) => execFileSync(bin, args, {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, ...opts,
});

const realpathOr = (p) => { try { return realpathSync(p); } catch { return p; } };

/** HEAD + porcelain status of one checkout, or a marker when it cannot be read. */
export function snapshotCheckout(dir, exec = defaultExec) {
  try {
    const head = exec('git', ['-C', dir, 'rev-parse', 'HEAD']).trim();
    const status = exec('git', ['-C', dir, 'status', '--porcelain=v1', '--untracked-files=all', '--ignored=no']);
    return { head, status };
  } catch (e) {
    return { unreadable: String(e?.message ?? e).slice(0, 200) };
  }
}

/** Which watched checkouts differ between two snapshots. PURE. */
export function changedCheckouts(before = {}, after = {}) {
  return Object.keys(before).filter((dir) => {
    const a = before[dir];
    const b = after[dir];
    if (a?.unreadable) return false; // nothing to compare against — never void on our own blind spot
    return !b || b.unreadable || a.head !== b.head || a.status !== b.status;
  });
}

/** Completed state-changing tool calls in an agy stream-json transcript. PURE. */
export function stateChangingToolCalls(transcriptText) {
  const out = [];
  for (const event of parseJsonlEvents(String(transcriptText ?? ''))) {
    const step = event?.event === 'step_update' ? event.step_update : null;
    if (!step || step.step_type !== 'tool') continue;
    const name = step.tool_name ?? step.tool_info?.name;
    if (typeof name !== 'string' || !STATE_CHANGING_TOOL.test(name)) continue;
    const errored = step.status === 'TOOL_ERROR' || step.tool_info?.error != null;
    if (step.state === 'DONE' && !errored) out.push(name);
  }
  return out;
}

/**
 * Rewrite a finding's `file` from the juror lane's absolute path to the repo-relative path every other seat cites,
 * so the citation scope and the finding identity compare like with like. PURE.
 */
export function relativizeFindings(findings, roots = []) {
  const prefixes = roots.filter(Boolean).map((r) => `${String(r).replace(/\/+$/, '')}/`);
  return (Array.isArray(findings) ? findings : []).map((f) => {
    if (!f || typeof f.file !== 'string') return f;
    const hit = prefixes.find((p) => f.file.startsWith(p));
    return hit ? { ...f, file: f.file.slice(hit.length) } : f;
  });
}

/**
 * Run one agy juror on `request` (a review-pr judge request: `{mandate, input, shape, lens}`) in its own clone of
 * `laneCwd`, then run the three escape checks.
 * @param {object} o
 * @param {object} o.request
 * @param {string} o.laneCwd - the review lane the Claude juror uses; the juror lane is cloned from it.
 * @param {string} o.model - the agy model (e.g. `claude-opus-5-5-high`).
 * @param {string[]} [o.watch] - further checkouts to watch; the review lane and this checkout always are.
 * @param {object} [o.deps] - injectable io for tests: `exec`, `mkTempDir`, `spawnJudge`, `readFile`, `removeDir`, `now`.
 * @returns {Promise<{status: 'ok'|'voided'|'failed', value?: object, reasons: string[], sessionId: string|null,
 *   model: string, servedModel?: string, wallMs: number, transcriptFile: string|null}>}
 */
export async function runAgyReviewJuror({ request, laneCwd, model, watch = [], deps = {} }) {
  const {
    exec = defaultExec,
    mkTempDir = (prefix) => mkdtempSync(prefix),
    spawnJudge = antigravityJudgeSpawn,
    readFile = (p) => readFileSync(p, 'utf8'),
    removeDir = (p) => rmSync(p, { recursive: true, force: true }),
    now = () => Date.now(),
    repoRoot = MODULE_REPO_ROOT,
  } = deps;
  const started = now();
  const result = (status, extra = {}) => ({
    status, reasons: [], sessionId: null, model, wallMs: now() - started, transcriptFile: null, ...extra,
  });
  if (typeof laneCwd !== 'string' || !laneCwd.trim()) {
    return result('failed', { reasons: ['no review lane to clone a juror lane from'] });
  }
  let jurorLane = null;
  try {
    jurorLane = mkTempDir(join(tmpdir(), 'we-agy-juror-'));
    exec('git', buildScratchCloneArgv({ repoRoot: laneCwd, dest: jurorLane }));
    const startHead = exec('git', ['-C', jurorLane, 'rev-parse', 'HEAD']).trim();
    const watched = [...new Set([resolve(laneCwd), resolve(repoRoot), ...watch.map((w) => resolve(w))])]
      .filter((d) => d !== resolve(jurorLane));
    const before = Object.fromEntries(watched.map((d) => [d, snapshotCheckout(d, exec)]));

    let outcome;
    let spawnError = null;
    try {
      outcome = await spawnJudge({
        mandate: request.mandate, input: request.input, shape: request.shape,
        model, cwd: jurorLane, toolPolicy: 'read-cwd', role: 'review-seat',
      });
    } catch (e) {
      spawnError = e;
    }

    // The escape checks run whether the juror answered or not: an escape is evidence even from a failed run.
    const reasons = [];
    const lane = snapshotCheckout(jurorLane, exec);
    if (lane.unreadable) reasons.push(`juror lane unreadable after the run: ${lane.unreadable}`);
    else {
      if (lane.head !== startHead) reasons.push(`juror lane HEAD moved (${startHead.slice(0, 12)} -> ${lane.head.slice(0, 12)})`);
      const changed = lane.status.split('\n').filter(Boolean);
      if (changed.length) reasons.push(`juror lane changed on a read-only seat: ${changed.slice(0, 5).join('; ')}`);
    }
    const after = Object.fromEntries(watched.map((d) => [d, snapshotCheckout(d, exec)]));
    for (const dir of changedCheckouts(before, after)) reasons.push(`change outside the juror lane: ${dir}`);
    const transcriptFile = outcome?.transcriptFile ?? spawnError?.telemetry?.transcriptFile ?? null;
    if (transcriptFile) {
      let text = '';
      try { text = readFile(transcriptFile); } catch { reasons.push('transcript unreadable — escape check incomplete'); }
      const calls = stateChangingToolCalls(text);
      if (calls.length) reasons.push(`completed state-changing tool call(s): ${[...new Set(calls)].join(', ')}`);
    } else if (!spawnError) {
      reasons.push('no transcript — escape check incomplete');
    }

    const common = { sessionId: outcome?.sessionId || null, servedModel: outcome?.servedModel, transcriptFile };
    if (reasons.length) return result('voided', { ...common, reasons });
    if (spawnError) return result('failed', { ...common, reasons: [String(spawnError.message ?? spawnError).slice(0, 500)] });
    const value = outcome.value && typeof outcome.value === 'object' ? outcome.value : {};
    return result('ok', {
      ...common,
      // macOS reports a tmpdir path both as /var/... and /private/var/...; strip either spelling.
      value: { ...value, findings: relativizeFindings(value.findings, [jurorLane, realpathOr(jurorLane), laneCwd]) },
      telemetry: outcome,
    });
  } catch (e) {
    return result('failed', { reasons: [String(e?.message ?? e).slice(0, 500)] });
  } finally {
    if (jurorLane) { try { removeDir(jurorLane); } catch { /* best effort */ } }
  }
}
