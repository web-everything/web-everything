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
 *   2. OUTSIDE ITS LANE. The review lane it was cloned from and this checkout are snapshotted (HEAD, porcelain status
 *      with ignored files, a content hash of every listed file, and fs hashes of `.git/config`, hooks and attributes)
 *      before and compared after. Any difference voids the seat.
 *   3. ITS OWN TRANSCRIPT. Any tool call that is not one of the read-only tools ({@link READ_ONLY_AGY_TOOLS}) and did
 *      not end in an error voids the seat, wherever it pointed — this is the check that catches a write (or a network
 *      fetch) to a place no snapshot watches, such as the home directory. It is an allowlist, so it fails closed.
 * The checks never let a checkout's own git config run code: control files are compared with plain fs reads first,
 * and git runs with fsmonitor and hooks forced off.
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
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { antigravityJudgeSpawn } from './antigravity-judge-spawn.mjs';
import { buildScratchCloneArgv, parseJsonlEvents } from '../gemini-direct-task.mjs';

/** This checkout — watched for outside-the-lane changes. */
export const MODULE_REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * The ONLY agy tools a read-only juror may complete (PR #4131 review: a denylist of state-changing names fails open
 * on any tool it does not name). Any other tool step that did not end in an error — a write, a command, a network
 * fetch, a tool with no name, a tool agy adds tomorrow — voids the seat.
 */
export const READ_ONLY_AGY_TOOLS = Object.freeze([
  'view_file', 'list_dir', 'grep_search', 'find_by_name', 'view_file_outline', 'view_code_item', 'codebase_search',
]);

/**
 * git is run with fsmonitor and hooks forced off, so a checkout's config can never make the CHECK itself run a
 * program (PR #4131 review: a planted `core.fsmonitor` would turn the post-run `git status` into the payload). The
 * config/hook/attribute files are hashed with plain fs reads BEFORE any post-run git call (see {@link gitControlFiles}),
 * and a change there voids the seat without git ever touching that checkout again.
 */
const SAFE_GIT = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.untrackedCache=false'];
const defaultExec = (bin, args, opts = {}) => execFileSync(bin, bin === 'git' ? [...SAFE_GIT, ...args] : args, {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024,
  env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0' }, ...opts,
});

const realpathOr = (p) => { try { return realpathSync(p); } catch { return p; } };
const sha = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 16);
const hashFile = (path) => { try { return sha(readFileSync(path)); } catch { return null; } };

/**
 * Hashes of the files that can make git run code or rewrite content: `.git/config`, every `.git/hooks/*`,
 * `.git/info/attributes` and the top-level `.gitattributes`. Plain fs reads — no git. PURE apart from the reads.
 */
export function gitControlFiles(dir) {
  const out = {};
  for (const rel of ['.git/config', '.git/info/attributes', '.gitattributes']) out[rel] = hashFile(join(dir, rel));
  let hooks = [];
  try { hooks = readdirSync(join(dir, '.git', 'hooks')).sort(); } catch { hooks = []; }
  for (const h of hooks) out[`.git/hooks/${h}`] = hashFile(join(dir, '.git', 'hooks', h));
  return out;
}

/**
 * HEAD + porcelain status (ignored files included) + a content hash of every file the status lists, so a further
 * edit to an already-dirty file is still seen (PR #4131 review). `control` is checked first by the caller.
 */
export function snapshotCheckout(dir, exec = defaultExec, { control = gitControlFiles } = {}) {
  try {
    const head = exec('git', ['-C', dir, 'rev-parse', 'HEAD']).trim();
    const status = exec('git', ['-C', dir, 'status', '--porcelain=v1', '--untracked-files=all', '--ignored=traditional']);
    const contents = {};
    for (const line of status.split('\n').filter(Boolean)) {
      const path = line.slice(3).replace(/^.* -> /, '').replace(/^"|"$/g, '');
      if (!path.endsWith('/')) contents[path] = hashFile(join(dir, path));
    }
    return { head, status, contents, control: control(dir) };
  } catch (e) {
    return { unreadable: String(e?.message ?? e).slice(0, 200), control: control(dir) };
  }
}

const sameJson = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Which watched checkouts' git control files changed. PURE. */
export function changedControl(before = {}, after = {}) {
  return Object.keys(before).filter((dir) => !sameJson(before[dir]?.control, after[dir]));
}

/** Which watched checkouts differ between two snapshots. PURE. */
export function changedCheckouts(before = {}, after = {}) {
  return Object.keys(before).filter((dir) => {
    const a = before[dir];
    const b = after[dir];
    if (a?.unreadable) return false; // nothing to compare against — never void on our own blind spot
    return !b || b.unreadable || a.head !== b.head || a.status !== b.status || !sameJson(a.contents, b.contents);
  });
}

/**
 * Tool steps in an agy stream-json transcript that were NOT a read-only tool and did NOT end in an error, judged on
 * each step's LAST update (a denied call is first ACTIVE, then an error). Fail closed: a tool step with no name counts.
 * PURE.
 */
export function stateChangingToolCalls(transcriptText) {
  const last = new Map();
  let n = 0;
  for (const event of parseJsonlEvents(String(transcriptText ?? ''))) {
    const step = event?.event === 'step_update' ? event.step_update : null;
    if (!step || step.step_type !== 'tool') continue;
    const key = step.step_index != null ? JSON.stringify([step.conversation_id ?? null, step.step_index]) : `#${n++}`;
    last.set(key, step);
  }
  const out = [];
  for (const step of last.values()) {
    const name = step.tool_name ?? step.tool_info?.name;
    const errored = step.status === 'TOOL_ERROR' || step.tool_info?.error != null;
    if (errored) continue;
    if (typeof name !== 'string' || !READ_ONLY_AGY_TOOLS.includes(name)) out.push(typeof name === 'string' ? name : '<unnamed tool>');
  }
  return out;
}

/** Drop local absolute paths (lanes, this checkout, the home directory) from a free-text reason. PURE. */
export function scrubPaths(text, roots = [], home = homedir()) {
  let out = String(text ?? '');
  for (const r of [...roots.filter(Boolean).flatMap((x) => [x, realpathOr(x)]), home].filter(Boolean).sort((a, b) => b.length - a.length)) {
    out = out.split(r).join('<local>');
  }
  return out.slice(0, 300);
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
    // Reasons name a checkout by its ROLE, never its absolute path: they reach the run record and, for a skipped
    // advisory seat, the PR comment (PR #4131 review: no local username or lane layout there).
    const label = (d) => (d === resolve(laneCwd) ? 'the review lane' : d === resolve(repoRoot) ? 'this checkout' : `watched checkout #${watched.indexOf(d) + 1}`);
    const before = Object.fromEntries(watched.map((d) => [d, snapshotCheckout(d, exec)]));
    const laneControl = gitControlFiles(jurorLane);

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
    // Control files FIRST, by fs alone: a checkout whose git config/hooks/attributes changed is never handed to git.
    const laneControlChanged = !sameJson(laneControl, gitControlFiles(jurorLane));
    if (laneControlChanged) reasons.push('juror lane git config, hooks or attributes changed');
    else {
      const lane = snapshotCheckout(jurorLane, exec);
      if (lane.unreadable) reasons.push('juror lane unreadable after the run');
      else {
        if (lane.head !== startHead) reasons.push(`juror lane HEAD moved (${startHead.slice(0, 12)} -> ${lane.head.slice(0, 12)})`);
        const changed = lane.status.split('\n').filter(Boolean);
        if (changed.length) reasons.push(`juror lane changed on a read-only seat: ${changed.slice(0, 5).join('; ')}`);
      }
    }
    const controlAfter = Object.fromEntries(watched.map((d) => [d, gitControlFiles(d)]));
    const controlChanged = new Set(changedControl(before, controlAfter));
    for (const dir of controlChanged) reasons.push(`git config, hooks or attributes changed outside the juror lane: ${label(dir)}`);
    const after = Object.fromEntries(watched.filter((d) => !controlChanged.has(d)).map((d) => [d, snapshotCheckout(d, exec)]));
    const comparable = Object.fromEntries(Object.entries(before).filter(([d]) => !controlChanged.has(d)));
    for (const dir of changedCheckouts(comparable, after)) reasons.push(`change outside the juror lane: ${label(dir)}`);
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
    if (spawnError) return result('failed', { ...common, reasons: [scrubPaths(spawnError.message ?? spawnError, [jurorLane, laneCwd, repoRoot])] });
    const value = outcome.value && typeof outcome.value === 'object' ? outcome.value : {};
    return result('ok', {
      ...common,
      // macOS reports a tmpdir path both as /var/... and /private/var/...; strip either spelling.
      value: { ...value, findings: relativizeFindings(value.findings, [jurorLane, realpathOr(jurorLane), laneCwd]) },
      telemetry: outcome,
    });
  } catch (e) {
    return result('failed', { reasons: [scrubPaths(e?.message ?? e, [jurorLane, laneCwd, repoRoot])] });
  } finally {
    if (jurorLane) { try { removeDir(jurorLane); } catch { /* best effort */ } }
  }
}
