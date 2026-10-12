#!/usr/bin/env node
/**
 * @file scripts/operations/fix-run.mjs
 * @description Card 87 follow-up — ONE BORROWED FIX, IN ITS OWN PROCESS, ON A NON-CLAUDE EXECUTOR. The per-dispatch
 * entry point `dispatch-providers/fix.mjs#fixDetachedProvider` spawns detached when a fix borrows a builder slot
 * (`scripts/lib/fix-slot-borrow.mjs`) and the borrowed executor is not Claude.
 *
 *   node scripts/operations/fix-run.mjs --pr=7 --session=fix-7 --ref=lane/7-x --prompt-file=/tmp/.../fix-7.md \
 *     --provider=codex [--repo=owner/repo] [--lane-repo=<checkout>] [--scope=we:a.mjs] [--num=7]
 *
 * SAME CLAIM, BRIEF AND REVIEW as a Claude fix; ONLY THE LAUNCHER AND EXECUTOR DIFFER:
 *   - claim:  already taken by `reconcile-fix-dispatch.mjs#dispatchFix` (carries `borrowed`); this process never takes one.
 *   - brief:  the exact filled `fix-agent-brief.md` prompt `dispatchFix` built, handed over as `--prompt-file`.
 *   - review: after the agent exits, a push of new commits is followed by `rearm-review.mjs` — the same hand-back
 *             the brief's step 7 makes — so an independent re-review is owed; nothing here ever clears a gate.
 *
 * WHY THE LAUNCHER (not the agent) PUSHES. Codex runs in the same no-network `:workspace` sandbox as a build
 * (`codex-delivery-provider.mjs`, UNKNOWN 3): it cannot `gh`, `lane-pool` or `git push`. So this launcher owns every
 * step that needs the network or the lane pool — acquire the lane at the PR's head ref, push, re-arm, release — and
 * the agent only edits files in the lane. A preamble on the brief says so. `antigravity-*` has no delivery
 * provider on main, so it is refused up front rather than launched half-working.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, existsSync, lstatSync, readFileSync, realpathSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { REPO_ROOT } from './detached-dispatch.mjs';
// Imported FROM the leaf, never the other way round (see `fix.mjs#FIX_RUN_EXECUTORS`): this file's top-level `await`
// below deadlocks if `dispatch-providers/fix.mjs` imports it back.
import { FIX_RUN_EXECUTORS } from './dispatch-providers/fix.mjs';
import { PR_BASE_MERGE_TARGET, recordBorrowOutcome, recordRoutedOutcome, consecutiveUnproductiveOnHead, ROUTED_CODEX_MAX_UNPRODUCTIVE } from '../lib/fix-slot-borrow.mjs';
import { LANE_CONFIG_LIST_ARGS, laneGitConfigArgs, laneGitHardeningEnv } from '../lib/lane-git-hardening.mjs';

// LAZY on purpose: `deliver-item-wrapper.mjs` reaches `dispatch-providers/fix.mjs` (which imports this file) through
// `dispatch-lane-io.mjs` -> `dispatch-provider-registry.mjs`, so a static import here is a cycle that makes the
// wrapper load before its own mocked/initialised dependencies are bound.
const resolveDeliveryAgentProvider = async (name) => (await import('./deliver-item-wrapper.mjs')).resolveDeliveryAgentProvider(name);

// LAZY for the same cycle reason: `fix-dispatch-claim.mjs` reaches `dispatch-lane-io.mjs`.
// LAZY too: the complete (paginated) comment reader — a plain `--json comments` read truncates a long thread.
const readAllComments = async (pr, o) => (await import('../conveyor/pr-comments-complete.mjs')).readCompletePrComments(pr, o);
const releaseBorrowedClaim = async (o) => (await import('../conveyor/fix-dispatch-claim.mjs')).releaseSessionFixDispatchClaims(o);

export { FIX_RUN_EXECUTORS };

/** Defense in depth: even though Codex protects `.git`, the push runs OUTSIDE its sandbox with our
 *  credentials. The code-running keys are pinned inert through the shared `lane-git-hardening` helper (env form, so
 *  the pins also hold for anything git itself spawns). */
export const HARDENED_GIT_ARGS = Object.freeze(laneGitConfigArgs());

/** Lane-local config keys that name a command, proxy, remote rewrite or credential source and are NOT pinned inert
 *  (a pin to a fixed value would break legitimate auth). A lane whose local/worktree scope defines one is refused
 *  BEFORE the agent runs and again before the push — a baseline an earlier agent poisoned is not trusted. Pure. */
const RISKY_LANE_CONFIG_RE = /^(credential\..*|core\.(askpass|gitproxy|editor)|merge\..+\.(driver|recursive)|gpg\..*|trailer\..+\.(cmd|command)|http\..*|https\..*|url\..+\.(insteadof|pushinsteadof)|protocol\..*|remote\..+\.(pushurl|proxy|receivepack|uploadpack|vcs)|include\.path|includeif\..+|filter\..+|alias\..+)$/i;
const SAFE_REMOTE_URL_RE = /^(https:\/\/|ssh:\/\/|git@[\w.-]+:)/i;
export function riskyLaneConfig(listOutput) {
  const parts = String(listOutput ?? '').split('\0');
  const found = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const scope = parts[i];
    if (scope !== 'local' && scope !== 'worktree') continue;
    const [key, ...rest] = parts[i + 1].split('\n');
    if (RISKY_LANE_CONFIG_RE.test(key)) found.push(key);
    else if (/^remote\..+\.url$/i.test(key) && !SAFE_REMOTE_URL_RE.test(rest.join('\n'))) found.push(key);
  }
  return found;
}

const PENDING_REARM_MAX_AGE_MS = 7 * 24 * 3_600_000;
const pendingRearmDir = () => join(homedir(), '.claude', 'conveyor', 'fix-run-pending');
const pendingKey = (repo, pr) => `${String(repo ?? 'we').replace(/[^\w.-]/g, '_')}-${String(pr).replace(/[^\w.-]/g, '_')}.json`;

/**
 * A repair that is PUSHED but not yet re-armed (the re-arm call failed): the next launch of the same PR opens its lane
 * at that pushed tip, sees no new commit, and would otherwise skip the re-arm for good. This records "owed" durably
 * between the two steps so a no-change retry can finish the hand-back. Default = a file under `~/.claude/conveyor`.
 */
export const defaultPendingRearm = (dir = pendingRearmDir()) => ({
  read(repo, pr, now = Date.now()) {
    try {
      const v = JSON.parse(readFileSync(join(dir, pendingKey(repo, pr)), 'utf8'));
      return v && typeof v.sha === 'string' && now - Number(v.at) < PENDING_REARM_MAX_AGE_MS ? v : null;
    } catch { return null; }
  },
  write(repo, pr, sha, now = Date.now()) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, pendingKey(repo, pr)), JSON.stringify({ sha, at: now }), { mode: 0o600 });
  },
  clear(repo, pr) { try { unlinkSync(join(dir, pendingKey(repo, pr))); } catch { /* already gone */ } },
});

/** Best-effort removal of the one-shot brief file (and its private directory) once the launcher has read it. */
export function removePromptFile(file) {
  try { unlinkSync(file); } catch { return; }
  const dir = dirname(file);
  if (basename(dir).startsWith('we-fix-borrow-')) { try { rmdirSync(dir); } catch { /* not empty / gone */ } }
}

const REQUIRED_FLAGS = Object.freeze(['session', 'pr', 'ref', 'prompt-file']);

/** PURE. `--k=v` argv -> launch shape; refuses a missing required flag by name. */
export function parseFixRunArgv(argv = []) {
  const flags = {};
  for (const a of Array.isArray(argv) ? argv : []) {
    if (typeof a !== 'string' || !a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq === -1) flags[a.slice(2)] = 'true';
    else flags[a.slice(2, eq)] = a.slice(eq + 1);
  }
  const missing = REQUIRED_FLAGS.filter((n) => !String(flags[n] ?? '').trim());
  if (missing.length) {
    throw new TypeError(`fix-run: missing required flag(s) ${missing.map((m) => `--${m}=`).join(', ')}`);
  }
  const opt = (k) => (String(flags[k] ?? '').trim() || null);
  return {
    pr: String(flags.pr).trim(), sessionSlug: String(flags.session).trim(), ref: String(flags.ref).trim(),
    promptFile: String(flags['prompt-file']).trim(),
    item: opt('num'), repo: opt('repo'), claimRepo: opt('claim-repo'), laneRepo: opt('lane-repo'), scope: opt('scope'),
    mergeOnto: opt('merge-onto'), provider: opt('provider') ?? 'codex', effort: opt('effort'), model: opt('model'),
  };
}

/** Prepended to the brief: the agent's sandbox has no network, so the launcher owns the networked steps. */
export const SANDBOX_PREAMBLE = [
  '## LAUNCHER OVERRIDE (read first — it wins over the brief below)',
  'You run in a sandbox with NO network, inside a lane clone that is ALREADY acquired and already at the PR head.',
  'Do NOT run `gh`, `lane-pool.mjs`, `fix-procedure.mjs`, `rearm-review.mjs` or `git push`; skip every brief step that does.',
  'The reviewer\'s finding is in the "PR CONTEXT (fetched by the launcher)" section right below. Brief step 2 / 2a\'s `gh pr view` is',
  'already done for you: take the latest changes-requested (or advisory) comment in that section as the authoritative ask.',
  'The sandbox forbids ALL `.git` writes. Edit files only; do NOT run git add, commit, merge, checkout, reset, stash or rebase.',
  'You may write a commit message to .fix-commit-msg.txt. The launcher stages, commits, pushes and re-arms review after you exit.',
  '',
  '---',
  '',
].join('\n');

const sh = (cmd, args, opts) => String(execFileSync(cmd, args, { encoding: 'utf8', ...opts }) ?? '');


const singleLine = (text) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
export function agentFinalMessage(result) {
  let message = result?.finalMessage ?? '';
  for (const line of String(result?.stdout ?? '').split('\n')) {
    try {
      const event = JSON.parse(line);
      if (event.type === 'item.completed' && event.item?.type === 'agent_message') message = event.item.text;
      else if (event.type === 'agent_message') message = event.text ?? event.message;
    } catch { /* non-JSON diagnostic */ }
  }
  return String(message ?? '');
}

/** Unmerged codes an agent can resolve by editing one text file in place (both modified / both added). */
const EDITABLE_CONFLICT_CODES = new Set(['UU', 'AA']);
const UNMERGED_CODES = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

/** PURE. The unmerged rows of NUL porcelain v1 output: `[{ path, code }]`. */
export function unmergedPaths(porcelain) {
  const records = String(porcelain ?? '').split('\0');
  const out = [];
  for (let i = 0; i < records.length; i++) {
    const row = records[i];
    if (!row) continue;
    const code = row.slice(0, 2);
    if (UNMERGED_CODES.has(code)) out.push({ path: row.slice(3), code });
    else if (/[RC]/.test(code)) i++; // skip a rename's source path
  }
  return out;
}

/** A refusal the launcher itself wrote: the only kind of error whose message may be posted to the public PR. */
export class LauncherError extends Error {}

const SCRATCH_RE = /^(?:\.fix-.*(?:commit-msg|commit-message).*\.txt|\.delivery-commit-msg-.*|\.converge-.*)$/;

/**
 * PURE. Paths a conflicted merge still needs `git add` for: unmerged rows plus anything whose WORKTREE column differs
 * from the index (agent edits, deletions, untracked files). Changes the merge already staged (clean deletions, renames,
 * additions) have a blank worktree column and are skipped: their old paths are gone from the index, so `git add` fails.
 */
export function unstagedPaths(porcelain) {
  const records = String(porcelain ?? '').split('\0');
  const paths = [];
  for (let i = 0; i < records.length; i++) {
    const row = records[i];
    if (!row) continue;
    const code = row.slice(0, 2);
    if (/[RC]/.test(code[0])) i++; // the rename/copy source is never staged on its own
    if (code[1] !== ' ' || UNMERGED_CODES.has(code)) paths.push(row.slice(3));
  }
  return [...new Set(paths.filter(p => p && !SCRATCH_RE.test(basename(p))))];
}

// NUL porcelain preserves spaces/newlines and includes both sides of a rename.
export function changedPaths(porcelain) {
  const records = String(porcelain ?? '').split('\0');
  const paths = [];
  for (let i = 0; i < records.length; i++) {
    const row = records[i];
    if (!row) continue;
    paths.push(row.slice(3));
    if (/[RC]/.test(row.slice(0, 2))) paths.push(records[++i]);
  }
  return [...new Set(paths.filter(p => p && !SCRATCH_RE.test(basename(p))))];
}

/** `merge` attribute values that still produce in-file conflict markers (unspecified, set, or the built-in text/union drivers). */
const TEXT_MERGE_ATTRS = new Set(['unspecified', 'set', 'text', 'union']);
const OID_RE = /^[0-9a-f]{40,64}$/;

const MAX_CONFLICTED_PATHS = 100;
/** A conflicted text blob larger than this fails the run (execFileSync's 1 MiB default would fail far sooner). */
const BLOB_MAX_BYTES = 64 * 1024 * 1024;
const REGULAR_MODES = new Set(['100644', '100755']);

/**
 * Which unmerged paths an agent cannot resolve by editing one text file, though git leaves them with NO conflict markers
 * (so a marker scan would call them resolved): `Map<path, 'binary' | 'non-regular'>`. `git diff --numstat` cannot tell
 * (it prints `0\t0` for an unmerged path). Instead:
 *   - non-regular: any stage is a symlink or gitlink (mode 120000/160000), or the stages disagree on mode;
 *   - binary: a `merge` attribute that is unset or names another driver — read from BOTH the merged tree and HEAD, since
 *     the merge may itself rewrite `.gitattributes` while git picked the driver from ours — or any pair of the three
 *     index blobs that git diffs as binary (NUL in the first 8000 bytes of either side, as its own merge decides).
 */
export function binaryConflictPaths(git, paths) {
  const kinds = new Map();
  if (!paths.length) return kinds;
  if (paths.length > MAX_CONFLICTED_PATHS) throw new LauncherError(`too many conflicted files to classify (${paths.length} > ${MAX_CONFLICTED_PATHS})`);
  for (const source of [[], ['--source=HEAD']]) {
    const attrs = git('check-attr', ...source, '-z', 'merge', '--', ...paths).split('\0');
    for (let i = 0; i + 2 < attrs.length; i += 3) if (!TEXT_MERGE_ATTRS.has(attrs[i + 2])) kinds.set(attrs[i], 'binary');
  }
  const stages = new Map();
  for (const entry of git('ls-files', '-u', '-z', '--', ...paths).split('\0')) {
    const m = /^(\d+) ([0-9a-f]+) ([123])\t([\s\S]*)$/.exec(entry);
    if (!m || !OID_RE.test(m[2])) continue;
    stages.set(m[4], { ...stages.get(m[4]), [m[3]]: { mode: m[1], oid: m[2] } });
  }
  for (const [path, s] of stages) {
    const present = Object.values(s);
    if (present.some(x => !REGULAR_MODES.has(x.mode)) || new Set(present.map(x => x.mode)).size > 1) { kinds.set(path, 'non-regular'); continue; }
    const pairs = [[s[2], s[3]], [s[1], s[2]], [s[1], s[3]]].filter(([a, b]) => a && b && a.oid !== b.oid);
    if (pairs.some(([a, b]) => git('diff', '--numstat', '--no-ext-diff', '--no-textconv', a.oid, b.oid).startsWith('-\t-\t'))) kinds.set(path, 'binary');
  }
  return kinds;
}

/**
 * PURE. Conflict-marker lines in `text` at one of `sizes`, counted by line: `<`, `|` (diff3 base), `=` or `>` repeated
 * EXACTLY `size` times, then whitespace or end of line — git's own `is_conflict_marker` rule, so a Markdown blockquote or
 * a longer rule line is not a marker.
 */
export function conflictMarkerLines(text, sizes) {
  const counts = new Map();
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.replace(/\r$/, '');
    const marker = /^([<|=>])\1*/.exec(line)?.[0];
    if (!marker || !sizes.has(marker.length) || (line.length > marker.length && !/\s/.test(line[marker.length]))) continue;
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  return counts;
}

/**
 * PURE. How many copies of each marker-shaped line a correct merge of the index stages may hold: max(ours, theirs,
 * ours + theirs - base), so each side's own additions survive (a setext heading, a test fixture) while a line only the
 * base carried excuses nothing. A missing stage (an add/add conflict has no base) counts as empty.
 */
export function markerAllowance(sizes, { base = '', ours = '', theirs = '' } = {}) {
  const [b, o, t] = [base, ours, theirs].map(text => conflictMarkerLines(text, sizes));
  const allowance = new Map();
  for (const line of new Set([...o.keys(), ...t.keys()])) {
    const [nb, no, nt] = [b, o, t].map(counts => counts.get(line) ?? 0);
    allowance.set(line, Math.max(no, nt, no + nt - nb));
  }
  return allowance;
}

/** PURE. Whether a resolved file still holds a conflict marker: a marker line occurring more often than `allowance` permits. */
export function hasLeftoverMarkers(text, sizes, allowance = new Map()) {
  for (const [line, n] of conflictMarkerLines(text, sizes)) if (n > (allowance.get(line) ?? 0)) return true;
  return false;
}

/**
 * Read an agent-written file in the lane from OUTSIDE the agent's sandbox: null (never followed) for a symlink, a
 * non-regular or hardlinked file, or a path whose realpath leaves the lane — the agent must not get the launcher to read for it.
 */
export function readLaneFileSafe(path, lanePath) {
  try {
    const st = lstatSync(path);
    if (!st.isFile() || st.nlink > 1) return null; // nlink > 1: a hardlink can alias a file outside the lane
    const root = realpathSync(lanePath);
    if (!realpathSync(path).startsWith(root + sep)) return null;
    return readFileSync(path, 'utf8');
  } catch { return null; }
}

/**
 * PURE. The PR comment posted when routed codex repairs stall on one head. Notes may be agent-authored (untrusted), so
 * they go inside a fenced block with backticks stripped, `@` mentions neutralised, and the finding phrases removed —
 * the comment must never read back as a reviewer's changes-requested / advisory finding.
 */
export function escalationComment(head, entries) {
  const clean = (t) => singleLine(t).replace(/`/g, "'").replace(/@/g, '@\u200b').replace(new RegExp(CHANGES_COMMENT_RE.source, 'gi'), '[…]');
  // Notes contain the agent's final message or the launcher's own error, never raw child-process errors.
  // Both use the same sanitising and 200-character cap.
  const lines = entries.map(o => `- ${clean(o.outcome)}: ${clean(o.note || o.outcome).slice(0, 200)}`).join('\n');
  return `**fix-run: codex repair unproductive on ${String(head).slice(0, 9)}**\n\n\`\`\`text\n${lines}\n\`\`\`\n\nThe next repair falls back to Claude.`;
}

function withMessageFile(message, action) {
  const dir = mkdtempSync(join(tmpdir(), 'we-fix-message-'));
  const file = join(dir, 'message.txt');
  try { writeFileSync(file, message, { mode: 0o600 }); return action(file); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

const CHANGES_COMMENT_RE = /changes requested|THIS IS AN ADVISORY REVIEW/i;
const cap = (t, n) => (String(t ?? '').length > n ? `${String(t).slice(0, n)}\n[... truncated ...]` : String(t ?? ''));

/**
 * PURE. `gh pr view --json title,body,comments` output -> the section the launcher prepends to the brief. The agent's
 * sandbox has no network, so it cannot read the reviewer's finding itself (live 2026-10-07: codex answered "the finding
 * was omitted" and committed nothing, 4 launches in a row). Throws when there is no changes-requested / advisory
 * comment: launching an agent with nothing to fix is a failure, not a no-change.
 */
export function renderPrContext(json) {
  const pr = typeof json === 'string' ? JSON.parse(json) : json;
  const comments = Array.isArray(pr?.comments) ? pr.comments : [];
  const found = comments.filter((c) => CHANGES_COMMENT_RE.test(String(c?.body ?? '')));
  const latest = found.sort((a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? ''))).at(-1);
  if (!latest) throw new LauncherError('no-finding: the PR has no changes-requested or advisory comment to apply');
  return [
    '## PR CONTEXT (fetched by the launcher)',
    `Title: ${String(pr?.title ?? '')}`,
    '', 'PR body:', cap(pr?.body, 8000),
    '', `LATEST finding comment (authoritative ask)${latest.createdAt ? `, posted ${latest.createdAt}` : ''}:`, cap(latest.body, 12000),
    '', '---', '', '',
  ].join('\n');
}

/** Lane path = last non-empty stdout line of `lane-pool acquire` (it prints the path last). */
export function parseAcquiredLanePath(stdout) {
  const lines = String(stdout ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  const path = lines.filter((l) => l.startsWith('/')).pop();
  if (!path) throw new Error(`fix-run: lane-pool acquire printed no lane path (got ${JSON.stringify(lines.slice(-2))})`);
  return path;
}

/**
 * THE CLI AS A FUNCTION. Exit 1 only when the launch itself threw; "agent made no change" is exit 0.
 * @returns {Promise<{code:number, result:string|null}>}
 */
export async function runFixCli(argv = [], {
  run = sh,
  readPrompt = (p) => readFileSync(p, 'utf8'),
  removePrompt = removePromptFile,
  pendingRearm = defaultPendingRearm(),
  resolveProvider = resolveDeliveryAgentProvider,
  spawnCodex = async (...args) => (await import('./codex-delivery-provider.mjs')).defaultSpawnCodexAgent(...args),
  readComments = readAllComments,
  releaseClaim = releaseBorrowedClaim,
  recordOutcome = recordBorrowOutcome,
  recordRouted = recordRoutedOutcome,
  readFile = readLaneFileSafe,
  fileExists = existsSync,
  weRoot = REPO_ROOT,
  write = (l) => process.stdout.write(l),
  writeErr = (l) => process.stderr.write(l),
} = {}) {
  let launch;
  let laneRelease = null;
  // How this launch (borrowed or routed) ended. Recorded in the borrow ledger (repeated failures stop the PR borrowing)
  // and, for routed codex, the per-head ledger (repeated failures fall back to Claude). The claim is released on EVERY
  // exit: a fix that ends must not keep holding its claim and a cap slot until the TTL.
  let before = null;
  let finalMessage = '';
  let abortMerge = null;
  let outcome = 'failed';
  let reason = 'launch did not complete';
  const settle = async () => {
    if (!launch?.pr) return;
    const repo = launch.claimRepo ?? 'we';
    reason = singleLine(reason);
    try { recordOutcome({ repo, pr: Number(launch.pr), outcome, reason }); } catch (e) { writeErr(`fix-run: could not record the outcome: ${String(e?.message ?? e)}\n`); }
    if (launch.provider === 'codex' && before) {
      try {
        const id = { repo, pr: Number(launch.pr), head: before };
        // `reason` (may carry raw command errors) stays in the local ledger; only `note` (the agent's final message
        // or the launcher's own error) is ever posted to the PR.
        const table = recordRouted({ ...id, outcome, reason, note: finalMessage });
        if (consecutiveUnproductiveOnHead(table, id) === ROUTED_CODEX_MAX_UNPRODUCTIVE) {
          withMessageFile(escalationComment(before, table[`${repo}#${launch.pr}`].slice(-ROUTED_CODEX_MAX_UNPRODUCTIVE)), file =>
            run('gh', ['pr', 'comment', launch.pr, ...(launch.repo ? ['--repo', launch.repo] : []), '--body-file', file], { cwd: weRoot }));
        }
      } catch (e) { writeErr(`fix-run: could not record routed outcome / post escalation: ${String(e?.message ?? e)}\n`); }
    }
    try {
      const r = await releaseClaim({ repo, pr: Number(launch.pr), who: launch.sessionSlug });
      write(`fix-run: PR #${launch.pr} ${outcome} (${reason}); claim ${r?.released?.length ? 'released' : 'not held / already released'}\n`);
    } catch (e) {
      writeErr(`fix-run: claim release failed: ${String(e?.message ?? e)}\n`);
      write(`fix-run: PR #${launch.pr} ${outcome} (${reason}); claim release failed\n`);
    }
  };
  try {
    launch = parseFixRunArgv(argv);
    if (!FIX_RUN_EXECUTORS.includes(launch.provider)) {
      throw new TypeError(`fix-run: executor ${JSON.stringify(launch.provider)} has no fix launcher (supported: ${FIX_RUN_EXECUTORS.join('|')})`);
    }
  } catch (e) {
    writeErr(`error: ${String(e?.message ?? e)}\n`);
    const raw = (Array.isArray(argv) ? argv : []).find((a) => typeof a === 'string' && a.startsWith('--prompt-file='));
    if (raw) removePrompt(raw.slice('--prompt-file='.length)); // never leave the brief behind on a refused launch
    reason = String(e?.message ?? e);
    await settle();
    return { code: 1, result: null };
  }
  const { pr, sessionSlug, ref } = launch;
  write(`fix-run: starting borrowed repair of PR #${pr} (session ${sessionSlug}, provider ${launch.provider}) - pid ${process.pid}\n`);
  try {
    const brief = readPrompt(launch.promptFile);
    // The launcher has the network, the agent does not: fetch the reviewer's finding here and hand it over in the brief.
    const prHead = JSON.parse(run('gh', ['pr', 'view', pr, '--json', 'title,body,baseRefName,mergeable', ...(launch.repo ? [`--repo=${launch.repo}`] : [])], { cwd: weRoot }) || '{}');
    const mergeConflictingBase = !launch.mergeOnto && prHead.mergeable === 'CONFLICTING';
    const mergeOnto = mergeConflictingBase ? PR_BASE_MERGE_TARGET : launch.mergeOnto;
    // `@pr-base`: the dispatcher or launcher needs the live PR base; never guess `main`.
    const target = mergeOnto === PR_BASE_MERGE_TARGET ? String(prHead.baseRefName ?? '').trim() : mergeOnto;
    if (mergeOnto && !target) throw new LauncherError('cannot resolve PR base for conflict merge');
    if (mergeConflictingBase) write(`fix-run: PR #${pr} conflicts with ${target}; launcher merges origin/${target} first\n`);
    const comments = await readComments(pr, { repo: launch.repo });
    const prContext = target && !comments.some(c => CHANGES_COMMENT_RE.test(c.body ?? ''))
      ? `## PR CONTEXT (fetched by the launcher)\nTitle: ${prHead.title ?? ''}\n${prHead.body ?? ''}\n\n`
      : renderPrContext({ ...prHead, comments });
    const poolArgs = [
      resolve(weRoot, 'scripts', 'lane-pool.mjs'), 'acquire', ...(launch.laneRepo ? [`--repo=${launch.laneRepo}`] : []),
      '--purpose=conveyor-fix', `--session=${sessionSlug}`, ...(launch.scope ? [`--scope=${launch.scope}`] : []), `--base=${ref}`,
    ];
    const lanePath = parseAcquiredLanePath(run('node', poolArgs, { cwd: weRoot }));
    const laneNum = basename(lanePath).replace(/^lane-/, '');
    laneRelease = () => run('node', [
      resolve(weRoot, 'scripts', 'lane-pool.mjs'), 'release', ...(launch.laneRepo ? [`--repo=${launch.laneRepo}`] : []),
      `--lane=${laneNum}`, `--session=${sessionSlug}`,
    ], { cwd: weRoot });
    const gitEnv = { ...laneGitHardeningEnv(process.env), GIT_LITERAL_PATHSPECS: '1' };
    const laneConfig = () => run('git', [...LANE_CONFIG_LIST_ARGS], { cwd: lanePath, env: gitEnv });
    before = run('git', ['rev-parse', 'HEAD'], { cwd: lanePath }).trim();
    const configBefore = laneConfig();
    const risky = riskyLaneConfig(configBefore);
    if (risky.length) throw new LauncherError(`lane git config defines command/credential/remote-rewrite keys (${risky.join(', ')}); refusing to run in it`);
    const rearm = () => run('node', [resolve(weRoot, 'scripts', 'conveyor', 'rearm-review.mjs'), pr, ...(launch.repo ? [`--repo=${launch.repo}`] : [])], { cwd: weRoot });
    // A prior run pushed this exact tip and then failed to re-arm (this lane opened AT that tip): finish the hand-back
    // now, before spending a whole agent run on it.
    if (pendingRearm.read(launch.repo, pr)?.sha === before) {
      rearm();
      pendingRearm.clear(launch.repo, pr);
      const result = `PR #${pr} (already pushed ${before.slice(0, 9)}; re-armed review:pending after a failed earlier re-arm)`;
      outcome = 'pushed'; reason = 'finished an earlier push';
      write(`fix-run: PR #${pr} finished - ${result}\n`);
      return { code: 0, result };
    }
    const provider = await resolveProvider(launch.provider);
    const git = (...args) => run('git', [...HARDENED_GIT_ARGS, ...args], { cwd: lanePath, env: gitEnv });
    const trailer = (await import('./deliver-item-wrapper.mjs')).coAuthorTrailerFor(launch.provider);
    const mergeHeadPath = () => git('rev-parse', '--git-path', 'MERGE_HEAD').trim();
    const inMerge = () => { const path = mergeHeadPath(); return !!path && fileExists(resolve(lanePath, path)); };
    const commitMerge = () => git('commit', '--no-edit', '--trailer', trailer);
    const blob = (oid) => run('git', [...HARDENED_GIT_ARGS, 'cat-file', 'blob', oid], { cwd: lanePath, env: gitEnv, maxBuffer: BLOB_MAX_BYTES });
    // Index entries for exactly `path` (a pathspec could also match other names, e.g. one holding `*`).
    const indexEntries = (path) => git('ls-files', '-s', '-z', '--', path).split('\0')
      .map(entry => /^(\d+) ([0-9a-f]+) ([0-3])\t([\s\S]*)$/.exec(entry))
      .filter(m => m && OID_RE.test(m[2]) && m[4] === path)
      .map(m => ({ mode: m[1], oid: m[2], stage: m[3] }));
    let unmerged = [];
    let mergePrompt = '';
    if (target) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(target)) throw new LauncherError(`invalid merge ref: ${target}`);
      git('check-ref-format', '--branch', target);
      git('fetch', 'origin', target);
      // Runs from the catch after the agent may have rewritten the lane config: `merge --abort` checks files out through
      // any smudge filter, so re-verify the config first and, on a mismatch, leave the lane to be discarded instead.
      abortMerge = () => {
        if (!inMerge()) return;
        const now = laneConfig();
        if (now !== configBefore || riskyLaneConfig(now).length) throw new LauncherError('lane git config changed; not running merge --abort in it');
        git('merge', '--abort');
      };
      try { git('merge', '--no-commit', '--no-ff', `origin/${target}`); }
      catch (e) {
        const conflicts = unmergedPaths(git('status', '--porcelain=v1', '-z'));
        if (!inMerge() || !conflicts.length) throw e;
        // Only a text both-modified/both-added conflict can be resolved by editing one file. Anything else (binary,
        // modify/delete, rename) is aborted BEFORE the agent runs and recorded as failed; after ROUTED_CODEX_MAX_UNPRODUCTIVE such
        // consecutive unproductive runs on the same head, the next repair falls back to Claude.
        const kinds = binaryConflictPaths(git, conflicts.map(c => c.path));
        const bad = conflicts.filter(c => !EDITABLE_CONFLICT_CODES.has(c.code) || kinds.has(c.path));
        if (bad.length) {
          git('merge', '--abort');
          throw new LauncherError(`conflict not resolvable by editing files: ${bad.map(c => `${c.path}(${kinds.has(c.path) ? `${c.code} ${kinds.get(c.path)}` : c.code})`).join(', ')}`);
        }
        unmerged = conflicts.map(c => c.path);
      }
      if (!unmerged.length && inMerge()) commitMerge();
      if (unmerged.length) mergePrompt = `The launcher has ALREADY started git merge origin/${target}; the conflicted files are: ${unmerged.join(', ')}. Resolve them by editing the files only. Do NOT run any git command that writes (merge, add, commit, checkout, reset, stash, rebase) — the sandbox forbids .git writes; the launcher stages and commits after you exit.\n\n`;
    }
    // Capture emitted widths before the agent runs: the merge itself may already have changed .gitattributes.
    // These UU/AA conflicts use HEAD as the opening label (optionally followed by a path).
    const markerSizes = new Map(unmerged.map(path => {
      const text = readFile(join(lanePath, path), lanePath);
      const sizes = new Set();
      for (const match of (text ?? '').matchAll(/^(<+) HEAD(?::[^\r\n]*)?\r?$/gm)) sizes.add(match[1].length);
      if (!sizes.size) sizes.add(7);
      // The index stages (1 base, 2 ours, 3 theirs) are the baseline: marker-shaped lines they carry may be content.
      const stages = Object.fromEntries(indexEntries(path).filter(e => e.stage !== '0').map(e => [e.stage, blob(e.oid)]));
      return [path, { sizes, allowance: markerAllowance(sizes, { base: stages[1], ours: stages[2], theirs: stages[3] }) }];
    }));
    const spawned = await provider.spawn({
      sessionId: undefined, prompt: mergePrompt + SANDBOX_PREAMBLE + prContext + brief, lane: laneNum, sessionSlug, item: launch.item ?? '', attemptTag: '',
      ...(launch.model ? { model: launch.model } : {}), ...(launch.effort ? { effort: launch.effort } : {}),
    }, { resolveLane: () => lanePath, ...(launch.provider === 'codex' ? {
      spawnAgent: async (...args) => {
        try {
          const result = await spawnCodex(...args);
          finalMessage = agentFinalMessage(result);
          return result;
        } catch (e) { finalMessage = agentFinalMessage(e); throw e; }
      },
    } : {}) });
    finalMessage = agentFinalMessage(spawned) || finalMessage;
    const configAfterAgent = laneConfig();
    if (configAfterAgent !== configBefore || riskyLaneConfig(configAfterAgent).length) throw new LauncherError('lane git config changed while the agent ran; refusing to push');
    const statusAfterAgent = git('status', '--porcelain=v1', '-z', '--untracked-files=all');
    const paths = changedPaths(statusAfterAgent);
    if (inMerge()) {
      // Every conflicted path is a text UU/AA conflict (checked above), so it must still exist as a regular file in the
      // lane with no conflict markers; a missing, symlinked, hardlinked or escaping path counts as unresolved.
      const unresolved = unmerged.filter(path => {
        if (!fileExists(join(lanePath, path))) return true;
        const text = readFile(join(lanePath, path), lanePath);
        // Every marker kind (incl. a lone separator or diff3 base line) at this file's captured width; see hasLeftoverMarkers.
        if (text == null) return true;
        const { sizes, allowance } = markerSizes.get(path);
        return hasLeftoverMarkers(text, sizes, allowance);
      });
      const refuse = (paths) => {
        git('merge', '--abort');
        throw new LauncherError(`conflict unresolved in ${paths.join(', ')}: ${finalMessage || 'agent committed nothing'}`);
      };
      if (unresolved.length) refuse(unresolved);
      const stage = [...new Set([...unmerged, ...unstagedPaths(statusAfterAgent)])];
      if (stage.length) git('add', '--', ...stage);
      // Scan what will be COMMITTED too: `git add` applies .gitattributes (which the agent can write), so a file saved
      // under e.g. working-tree-encoding=UTF-16LE hides its markers from the UTF-8 read above but not from its staged blob.
      const unresolvedStaged = unmerged.filter(path => {
        const entries = indexEntries(path);
        if (entries.length !== 1 || entries[0].stage !== '0' || !REGULAR_MODES.has(entries[0].mode)) return true;
        const { sizes, allowance } = markerSizes.get(path);
        return hasLeftoverMarkers(blob(entries[0].oid), sizes, allowance);
      });
      if (unresolvedStaged.length) refuse(unresolvedStaged);
      commitMerge();
    } else if (paths.length) {
      const supplied = join(lanePath, '.fix-commit-msg.txt');
      const own = fileExists(supplied) ? readFile(supplied, lanePath) : null; // null for a symlink: ignore it
      const message = own?.trim() ? own.slice(0, 4000) : `fix(PR #${pr}): ${finalMessage.split('\n')[0] || 'apply review finding'}`;
      git('add', '--', ...paths);
      withMessageFile(`${message.trim()}\n\n${trailer}\n`, file => git('commit', '-F', file, '--', ...paths));
    }
    const after = run('git', ['rev-parse', 'HEAD'], { cwd: lanePath }).trim();
    let result;
    if (after === before) {
      outcome = 'no-change'; reason = finalMessage || 'agent committed nothing';
      result = `no-change (${singleLine(reason)}; claim released, PR is re-planned)`;
    } else {
      // Defense in depth (config was already re-checked right after the agent): this push runs outside the sandbox with
      // our credentials, so refuse again if the repo-local config (remote URL, sshCommand, insteadOf, credential helper, includes...) changed or is now
      // risky, and run the push with the code-running keys pinned inert (env, so no gap after the check) and no hooks.
      const configAfter = laneConfig();
      if (configAfter !== configBefore || riskyLaneConfig(configAfter).length) {
        throw new LauncherError('lane git config changed while the agent ran; refusing to push');
      }
      // Record the owed re-arm BEFORE the push (best effort): a crash anywhere after the push must not lose it.
      try { pendingRearm.write(launch.repo, pr, after); } catch (e) { writeErr(`fix-run: could not record the pending re-arm: ${String(e?.message ?? e)}\n`); }
      run('git', [...HARDENED_GIT_ARGS, 'push', '--no-verify', 'origin', `HEAD:refs/heads/${ref}`], { cwd: lanePath, env: gitEnv }); // never --force
      rearm();
      pendingRearm.clear(launch.repo, pr);
      result = `PR #${pr} (pushed ${after.slice(0, 9)}, re-armed review:pending)`;
      outcome = 'pushed'; reason = finalMessage || `pushed ${after.slice(0, 9)}`;
    }
    write(`fix-run: PR #${pr} finished - ${result}\n`);
    return { code: 0, result };
  } catch (e) {
    writeErr(`fix-run: PR #${pr} FAILED: ${String(e?.message ?? e)}\n`);
    outcome = 'failed'; reason = `${String(e?.message ?? e)}${finalMessage && !String(e?.message).includes(finalMessage) ? `: ${finalMessage}` : ''}`;
    if (!finalMessage && e instanceof LauncherError) {
      finalMessage = e.message;
    }
    try { abortMerge?.(); } catch (abortError) { writeErr(`fix-run: merge abort failed: ${abortError.message}\n`); }
    return { code: 1, result: null };
  } finally {
    removePrompt(launch.promptFile); // one-shot, untrusted text: gone on every exit, success or not
    try { laneRelease?.(); } catch (e) { writeErr(`fix-run: lane release failed: ${String(e?.message ?? e)}\n`); }
    await settle();
  }
}

const IS_CLI = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (IS_CLI) {
  const { code } = await runFixCli(process.argv.slice(2));
  process.exitCode = code;
}
