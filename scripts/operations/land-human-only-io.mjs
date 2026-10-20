/**
 * @file scripts/operations/land-human-only-io.mjs
 * @description The io binding of `land-human-only` (card 334). The reader runs the drain's own gate reads on the
 *   PR's exact head (`we:scripts/merge-gate-check.mjs#gatherPrFacts` → `we:scripts/lib/merge-gate-ci.mjs#evaluatePrGates`,
 *   the required-check gate, mergeability, merge-queue state) and resolves the operator's credential by name. The sink
 *   re-checks the head, applies `ready-to-merge` the way the drain does, enqueues with the OPERATOR's own `gh` login
 *   (the real `gh` binary, never the App shim; `expectedHeadOid` pins the head), confirms `isInMergeQueue`, and posts
 *   one durable comment naming the actor and the instruction.
 *
 *   The drain's own enqueue (`we:scripts/lib/merge-queue-enqueue.mjs#enqueuePr`) is NOT called and NOT changed: its
 *   workflow-edit refusal stays. This path exists because only a person may land such a PR.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { workflowEditHold, requestOperatorQueueEntry, isAlreadyQueuedError, readMergeQueueState } from '../lib/merge-queue-enqueue.mjs';
export { readMergeQueueState } from '../lib/merge-queue-enqueue.mjs';
import { readQueueRequiredChecks } from '../lib/drain-merge-strategy.mjs';
import { reviewCiGate } from '../lib/review-ci-gate.mjs';
import { labelOnGreenVerdict } from '../merge-ai-prs.mjs';
import { loadMergeDeliveryPolicy } from '../lib/merge-delivery-policy.mjs';
import { loadDrainGateSettings } from '../lib/codeql-gate.mjs';
import { readSettings } from '../lib/settings-files.mjs';
import { GATE_IDS } from '../lib/merge-gate-inventory.mjs';
import { personalGhToken } from '../lib/gh-throttle.mjs';
import { resolveRealGhBinary } from '../lib/gh-app-shim.mjs';
import { LAND_HUMAN_ONLY_EFFECT, READY_LABEL, buildLandComment } from './land-human-only.mjs';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

// The merge-gate CLI's fact gatherer and evaluator, loaded lazily: `merge-gate-ci.mjs` resolves its own script path
// from `import.meta.url` at load time, which a non-file test environment that only imports `run.mjs` cannot do.
// A failed load is reported by the reader as unreadable gates (fail closed), never as passing ones.
let mergeGate = null;
let mergeGateLoadError = null;
async function loadMergeGate() {
  if (mergeGate || mergeGateLoadError) return;
  try {
    const [check, ci] = await Promise.all([import('../merge-gate-check.mjs'), import('../lib/merge-gate-ci.mjs')]);
    mergeGate = { gatherPrFacts: check.gatherPrFacts, readLedgerConfig: check.readLedgerConfig, readRedMainFact: check.readRedMainFact,
      readMainCiFact: check.readMainCiFact, evaluatePrGates: ci.evaluatePrGates };
  } catch (e) { mergeGateLoadError = String(e?.message ?? e).split('\n')[0]; }
}
try { await loadMergeGate(); } catch { /* recorded in mergeGateLoadError */ }
const fromMergeGate = (name) => (...args) => {
  if (!mergeGate) throw new Error(`merge-gate modules unavailable: ${mergeGateLoadError ?? 'not loaded'}`);
  return mergeGate[name](...args);
};

const PR_FIELDS = 'number,state,isDraft,baseRefName,headRefOid,labels,commits,mergeable,mergeStateStatus,statusCheckRollup,id';
const errLine = (e) => String(e?.stderr || e?.message || e).trim().split('\n').pop().slice(0, 300);
const ghJsonWith = (exec) => (args, opts = {}) => JSON.parse(String(exec('gh', args,
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000, maxBuffer: 64 * 1024 * 1024, ...opts }) || 'null'));

/** Require terminal streams and reject recognized agent/CI sessions, including ones with a pseudo-terminal. */
export function operatorTerminalPresent({ input = process.stdin, output = process.stdout, env = process.env } = {}) {
  const automated = ['CODEX_THREAD_ID', 'CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_SESSION_ID', 'CI']
    .some((key) => !!String(env[key] ?? '').trim());
  return input?.isTTY === true && output?.isTTY === true && !automated;
}
const TERMINAL_REQUIRED = 'land-human-only requires an interactive operator terminal (stdin and stdout TTY, outside agent/CI sessions); run the command yourself';

/**
 * The operator's own `gh` login, resolved by name: the first REAL `gh` on PATH (generated App shims skipped) and the
 * token from its stored login (`GH_TOKEN`/`GITHUB_TOKEN` stripped). Never throws, never returns the token to a
 * caller that only asked for the login.
 * @returns {{login:string|null, token:string|null, bin:string|null, error?:string}}
 */
export function resolveOperatorCredential({ resolveBin = resolveRealGhBinary, readToken = personalGhToken, exec = execFileSync,
  interactive = operatorTerminalPresent } = {}) {
  if (!interactive()) return { login: null, token: null, bin: null, error: TERMINAL_REQUIRED };
  const bin = resolveBin();
  if (!bin) return { login: null, token: null, bin: null, error: 'no real gh binary on PATH' };
  const token = readToken({ bin });
  if (!token) return { login: null, token: null, bin, error: 'the real gh has no stored login (gh auth login)' };
  try {
    const login = String(exec(bin, ['api', 'user', '-q', '.login'], { env: operatorEnv(token), encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 }) || '').trim();
    return login ? { login, token, bin } : { login: null, token: null, bin, error: 'gh api user returned no login' };
  } catch (e) { return { login: null, token: null, bin, error: errLine(e) }; }
}

/** The child env for an operator-credential call: the operator token, no inherited App token. */
export function operatorEnv(token, env = process.env) {
  const out = { ...env, GH_TOKEN: token };
  delete out.GITHUB_TOKEN;
  return out;
}

/**
 * GitHub's canonical `owner/name` for a slug, following renames/transfers (an origin still spelled with a repo's
 * old owner, e.g. `chalbert/web-everything` → `web-everything/web-everything`). Asked of github.com explicitly, never
 * a `GH_HOST`-selected server: the origin was parsed as a github.com slug. Lower-cased; null when unreadable.
 */
export function readCanonicalSlug(slug, { exec = execFileSync } = {}) {
  try {
    const out = String(exec('gh', ['api', '--hostname', 'github.com', `repos/${slug}`, '-q', '.full_name'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 }) || '').trim().toLowerCase();
    return /^[a-z0-9_-][a-z0-9_.-]*\/[a-z0-9_.-]+$/.test(out) ? out : null;
  } catch { return null; }
}

/**
 * A checkout of `repo` to run the pinned git reads in: the cwd's repo, else this repo's root. `{dir, reasons}` —
 * `dir` null when no candidate qualifies, `reasons` naming why each candidate was refused (for the operator).
 * A candidate qualifies when its github.com `origin` slug IS `repo`, or GitHub resolves that slug to `repo` (a
 * renamed/transferred repo whose clones keep the old spelling). An unreadable resolution refuses (fail closed).
 * Whether the checkout can actually see the PR's pinned head is checked downstream by the pinned-diff read
 * (`fetch` + `cat-file -e <head>`), which also fails closed.
 */
export function locateClone(repo, { candidates = [process.cwd(), REPO_ROOT], exec = execFileSync,
  canonical = (slug) => readCanonicalSlug(slug, { exec }) } = {}) {
  const identity = String(repo).trim().toLowerCase();
  // These operations address github.com owner/name slugs. Local paths and other hosts cannot establish that identity.
  const originPattern = /^(?:https?:\/\/github\.com\/|git:\/\/github\.com\/|ssh:\/\/(?:git@)?github\.com(?::22)?\/|git@github\.com:)([a-z0-9_-][a-z0-9_.-]*\/[a-z0-9_-][a-z0-9_.-]*?)(?:\.git)?\/?$/i;
  const reasons = [];
  const seen = new Set();
  for (const dir of candidates) {
    let top;
    try {
      top = String(exec('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).trim();
    } catch { reasons.push(`${dir}: not a git checkout`); continue; }
    if (seen.has(top)) continue;
    seen.add(top);
    let url;
    try {
      url = String(exec('git', ['-C', top, 'remote', 'get-url', 'origin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).trim();
    } catch { reasons.push(`${top}: no origin remote`); continue; }
    const slug = originPattern.exec(url)?.[1].toLowerCase();
    // An unparsed origin can contain credentials (userinfo, query, or fragment); never echo it into run records.
    if (!slug) { reasons.push(`${top}: origin is not a github.com owner/name`); continue; }
    if (slug === identity) return { dir: top, reasons };
    const resolved = canonical(slug);
    if (resolved === identity) return { dir: top, reasons };
    reasons.push(resolved ? `${top}: origin ${slug} is ${resolved}, not ${identity}`
      : `${top}: origin ${slug} is not ${identity}, and GitHub's canonical name for it could not be read`);
  }
  return { dir: null, reasons };
}

/** `locateClone`'s checkout path alone (null when none qualifies). */
export function cloneFor(repo, options = {}) {
  return locateClone(repo, options).dir;
}

const labelNames = (pr) => (pr?.labels ?? []).map((l) => (typeof l === 'string' ? l : l?.name));

/**
 * The `read` finding. Every gate's facts, read on the head the PR shows at read time. IO is injectable.
 */
export function createLandHumanOnlyReader({ exec = execFileSync, credential = () => resolveOperatorCredential(),
  clone = (repo) => locateClone(repo, { exec }), gather = fromMergeGate('gatherPrFacts'), evaluate = fromMergeGate('evaluatePrGates'),
  requiredChecks = readQueueRequiredChecks, warn = (m) => process.stderr.write(`${m}\n`),
  // The merge-gate CLI's own fact sources, injectable so tests never reach git or GitHub through them.
  loadPolicy = () => loadMergeDeliveryPolicy({ toolSettings: readSettings(), knownGates: GATE_IDS }),
  redMainOf = fromMergeGate('readRedMainFact'), mainCiOf = fromMergeGate('readMainCiFact'), ledgerConfigOf = fromMergeGate('readLedgerConfig'),
  blockOnCodeQLOf = () => loadDrainGateSettings().drainBlocksOnCodeQL } = {}) {
  const readJson = ghJsonWith(exec);
  return ({ repo, pr }) => {
    const num = Number(pr);
    const live = readJson(['pr', 'view', String(num), '--repo', repo, '--json', PR_FIELDS]);
    const head = live?.headRefOid;
    let defaultBranch = null;
    try { defaultBranch = readJson(['repo', 'view', repo, '--json', 'defaultBranchRef'])?.defaultBranchRef?.name ?? null; } catch { /* gate fails closed */ }
    const cred = credential();
    const queue = readMergeQueueState({ repo, pr: num, readJson });
    const queueError = queue.error || (queue.head !== head ? 'PR head moved since the initial read; re-run' : null);
    const labelPresent = labelNames(live).includes(READY_LABEL);
    const labelDecision = labelPresent ? { label: false, reason: null } : labelOnGreenVerdict(live, { requiredCheck: 'test', label: READY_LABEL });

    const located = clone(repo);
    const cwd = typeof located === 'string' ? located : located?.dir ?? null;
    const why = Array.isArray(located?.reasons) && located.reasons.length ? ` — checked ${located.reasons.join('; ')}` : '';
    let gateRows = null, gateRowsError = null, surface = { hold: true, humanOnly: false, error: 'not read' };
    if (!cwd) gateRowsError = surface.error = `no checkout of ${repo} to read the pinned diff from (run from a clone whose origin is github.com/${repo})${why}`;
    else {
      const policy = loadPolicy();
      const facts = gather({ repo, num, cwd, defaultBranch, ledgerConfig: ledgerConfigOf(),
        redMain: redMainOf({ cwd, policy }), mainCi: mainCiOf({ repo, defaultBranch: defaultBranch || 'main' }),
        expectedHeadSha: head, exec });
      const gp = facts.gatePaths;
      surface = gp && Array.isArray(gp.files) ? workflowEditHold({ files: gp.files, expectedCount: gp.files.length })
        : { hold: true, humanOnly: false, error: gp?.error ?? 'pinned change list unreadable' };
      if (facts.prReadError) gateRowsError = facts.prReadError;
      else {
        // The label this operation is about to apply counts only when the drain's own labelling decision would apply it.
        const withLabel = !labelPresent && labelDecision.label === true
          ? { ...facts, pr: { ...facts.pr, labels: [...(facts.pr.labels ?? []), { name: READY_LABEL }] } } : facts;
        const result = evaluate(withLabel, { policy, blockOnCodeQL: blockOnCodeQLOf(),
          mergeEvent: 'pull_request', write: warn });
        gateRows = result.results;
      }
    }
    const names = requiredChecks({ repo, branch: defaultBranch || 'main' });
    const ci = Array.isArray(names) ? { names, ...reviewCiGate({ headSha: head, requiredChecks: names, checks: live?.statusCheckRollup }) } : { names: null, allowed: false };
    return {
      repo, number: num, head, defaultBranch, nodeId: live?.id ?? null,
      pr: { state: live?.state, isDraft: live?.isDraft === true, baseRefName: live?.baseRefName, mergeable: live?.mergeable, mergeStateStatus: live?.mergeStateStatus },
      operatorLogin: cred.login ?? null, ...(cred.error ? { credentialError: cred.error } : {}),
      inMergeQueue: !queueError && queue.inQueue === true, ...(queueError ? { queueError } : {}),
      labelPresent, labelDecision, surface, gateRows, gateRowsError, requiredChecks: ci,
    };
  };
}

/**
 * The sink. Order: head re-check → label → enqueue (operator credential) → verify → comment. A head that moved
 * throws before anything is written; an enqueue or verify failure is recorded on the PR and returned `failed`.
 */
export function createLandHumanOnlySinks({ exec = execFileSync, credential = () => resolveOperatorCredential({ exec }),
  interactive = operatorTerminalPresent } = {}) {
  const readJson = ghJsonWith(exec);
  const gh = (args) => exec('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });
  const comment = (repo, pr, body) => {
    const dir = mkdtempSync(join(tmpdir(), 'land-human-only-'));
    try {
      const path = join(dir, 'body.md');
      writeFileSync(path, body, 'utf8');
      return String(gh(['pr', 'comment', String(pr), '--repo', repo, '--body-file', path]) || '').trim();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  };
  return {
    [LAND_HUMAN_ONLY_EFFECT]: async ({ verdict }) => {
      // Check here as well as at credential resolution: a resumed run or another adapter may supply a saved plan.
      if (!interactive()) throw new Error(TERMINAL_REQUIRED);
      const { repo, pr, head } = verdict;
      const live = readJson(['pr', 'view', String(pr), '--repo', repo, '--json', 'id,headRefOid,labels']);
      if (live?.headRefOid !== head) throw new Error(`PR #${pr}'s head moved to ${live?.headRefOid} since the plan (${head}); nothing written — re-run against the new head`);
      const cred = credential();
      const login = String(cred.login ?? '').trim().toLowerCase();
      if (!cred.token || login !== verdict.operatorLogin || login !== verdict.actor) {
        throw new Error(`the operator credential changed since the plan (${cred.login ?? cred.error ?? 'none'} vs ${verdict.operatorLogin}); nothing written`);
      }
      let labelled = false;
      if (!labelNames(live).includes(READY_LABEL)) { gh(['pr', 'edit', String(pr), '--repo', repo, '--add-label', READY_LABEL]); labelled = true; }
      let error = null;
      try {
        const out = requestOperatorQueueEntry({ nodeId: live.id, headSha: head, bin: cred.bin, env: operatorEnv(cred.token), exec });
        const errs = Array.isArray(out?.errors) ? out.errors.map((x) => x?.message).join('; ') : '';
        if (errs && !isAlreadyQueuedError(errs)) error = errs;
      } catch (e) { if (!isAlreadyQueuedError(errLine(e))) error = errLine(e); }
      if (!error) {
        const q = readMergeQueueState({ repo, pr, readJson });
        if (q.error) error = `isInMergeQueue unreadable: ${q.error}`;
        else if (q.head !== head) error = 'PR head moved during enqueue verification; the planned head is not confirmed queued';
        else if (!q.inQueue) error = 'enqueue returned but isInMergeQueue is false';
      }
      const queued = !error;
      let commentUrl = null, commentError = null;
      try { commentUrl = comment(repo, pr, buildLandComment(verdict, { queued, error })); }
      catch (e) { commentError = errLine(e); }
      const audit = { commentUrl, ...(commentError ? { commentError } : {}) };
      return queued ? { outcome: 'applied', ok: true, queued, labelled, ...audit }
        : { outcome: 'failed', ok: false, queued, labelled, ...audit, error };
    },
  };
}
