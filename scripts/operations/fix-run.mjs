#!/usr/bin/env node
import { buildStandDownComment } from '../conveyor/stand-down.mjs';
import { repeatedFindingPlan, applyScopeReset, resolveFixSafety } from '../conveyor/repeated-finding-reset.mjs';
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
 * the agent only edits files in the lane. A preamble on the brief says so. Antigravity runs Gemini in the existing lane; the launcher owns commits and pushes.
 */
import { markFixPushAwaitingCi } from '../conveyor/fix-push-ci.mjs';
import { execFileSync } from 'node:child_process';
import * as nodeFs from 'node:fs';
import { mkdirSync, mkdtempSync, rmSync, existsSync, readFileSync, realpathSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { REPO_ROOT } from './detached-dispatch.mjs';
// Imported FROM the leaf, never the other way round (see `fix.mjs#FIX_RUN_EXECUTORS`): this file's top-level `await`
// below deadlocks if `dispatch-providers/fix.mjs` imports it back.
import { FIX_RUN_EXECUTORS } from './dispatch-providers/fix.mjs';
import { PR_BASE_MERGE_TARGET, recordBorrowOutcome, recordRoutedOutcome, consecutiveUnproductiveOnHead, ROUTED_CODEX_MAX_UNPRODUCTIVE } from '../lib/fix-slot-borrow.mjs';
import { appendFixLoopRow, isInfraFixRunOutcome } from '../conveyor/fix-loop-ledger.mjs';
import { collapseRollupToLatestPerName } from '../lib/rollup-collapse.mjs';
import { riskyLaneConfig, LANE_CONFIG_LIST_ARGS, laneGitConfigArgs, laneGitHardeningEnv } from '../lib/lane-git-hardening.mjs';
import { cascadePolicy } from '../lib/policy-cascade.mjs';
import { directLaunchLogLine } from '../lib/direct-launch-settings.mjs';

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

export { riskyLaneConfig } from '../lib/lane-git-hardening.mjs';

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

/** PURE. Parse launch flags, including repair kind for card 5947 (live #5045, 2026-10-13); refuse invalid flags by name. */
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
  const repairKind = flags['repair-kind'] === undefined ? 'fix' : String(flags['repair-kind']).trim();
  if (!['fix', 'ci-heal'].includes(repairKind)) throw new TypeError(`fix-run: invalid --repair-kind=${repairKind} (supported: fix|ci-heal)`);
  return {
    repairKind, pr: String(flags.pr).trim(), sessionSlug: String(flags.session).trim(), ref: String(flags.ref).trim(),
    promptFile: String(flags['prompt-file']).trim(),
    item: opt('num'), repo: opt('repo'), claimRepo: opt('claim-repo'), laneRepo: opt('lane-repo'), scope: opt('scope'),
    mergeOnto: opt('merge-onto'), provider: opt('provider') ?? 'codex', taskKind: opt('task-kind') ?? 'fix', effort: opt('effort'), model: opt('model'),
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

export const MAX_CONFLICTED_PATHS = 100;
/** A conflicted text blob (or agent-written lane file) larger than this fails the run (execFileSync's 1 MiB default would fail far sooner). */
export const BLOB_MAX_BYTES = 64 * 1024 * 1024;
/** All agent-written files one run may stage together (each is also capped at BLOB_MAX_BYTES). */
export const STAGE_MAX_BYTES = 4 * BLOB_MAX_BYTES;
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
 * Also null for a file over BLOB_MAX_BYTES, so an agent-written giant file fails the run instead of exhausting its memory.
 * Every check is made on the ONE open descriptor that is then read (opened without following a final symlink, and
 * non-blocking so a FIFO cannot hang it), so a process the agent left running cannot swap the path between check and read.
 * `fs` is a test seam.
 */
export function readLaneFileSafe(path, lanePath, fs = nodeFs) {
  return readLaneBytesSafe(path, lanePath, fs)?.data.toString('utf8') ?? null;
}

/** {@link readLaneFileSafe}, returning the raw bytes and the opened file's mode: `{ data: Buffer, mode }` or null. */
export function readLaneBytesSafe(path, lanePath, fs = nodeFs) {
  let fd;
  try {
    const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = fs.constants;
    fd = fs.openSync(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.nlink > 1) return null; // nlink > 1: a hardlink can alias a file outside the lane
    if (st.size > BLOB_MAX_BYTES) return null;
    // The opened file must be the one at a real path inside the lane (a swapped parent directory would move it out).
    const root = fs.realpathSync(lanePath);
    const real = fs.realpathSync(path);
    const at = fs.statSync(real);
    // nlink again on the in-lane path: a file opened through a symlinked parent, then hardlinked into the lane after the
    // fstat above, has the right dev/ino but two links.
    if (!real.startsWith(root + sep) || at.dev !== st.dev || at.ino !== st.ino || at.nlink > 1) return null;
    // Read one byte past the size: a file that grew after fstat is refused, never truncated.
    const buf = Buffer.alloc(st.size + 1);
    let n = 0;
    for (let r; n < buf.length && (r = fs.readSync(fd, buf, n, buf.length - n, null)) > 0;) n += r;
    return n > st.size ? null : { data: buf.subarray(0, n), mode: st.mode };
  } catch { return null; } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* already closed */ }
  }
}

/**
 * What the launcher stages for one changed lane path, read by the LAUNCHER (never by git: `git add` and `commit -- paths`
 * run outside the agent's sandbox with full read access, and re-open the path after any check): `{ missing: true }` for a
 * deletion (nothing read), `{ mode, data }` with the bytes to stage, or null when the path must not be staged. A regular file
 * is read through {@link readLaneBytesSafe}'s one checked descriptor, so a hardlink (it can alias a credential the sandbox
 * could link but not read), a path whose parent resolves outside the lane, a file over BLOB_MAX_BYTES, or one swapped in
 * mid-read (the file or a parent directory) is refused. A directory (`git add dir` reads every file under it) or other
 * non-regular file is refused too. A symlink is staged as its own link text, as git does — never its target's content.
 * `fs` is a test seam.
 */
export function laneStageEntry(lanePath, path, fs = nodeFs) {
  const full = join(lanePath, path);
  let st;
  try { st = fs.lstatSync(full); } catch (e) { return e?.code === 'ENOENT' || e?.code === 'ENOTDIR' ? { missing: true } : null; }
  if (st.isSymbolicLink()) {
    try {
      const root = fs.realpathSync(lanePath);
      const parent = fs.realpathSync(dirname(full));
      if (parent !== root && !parent.startsWith(root + sep)) return null;
      return { mode: '120000', data: fs.readlinkSync(full, { encoding: 'buffer' }) };
    } catch { return null; }
  }
  const read = readLaneBytesSafe(full, lanePath, fs);
  return read && { mode: read.mode & 0o100 ? '100755' : '100644', data: read.data }; // git's own exec test: owner x
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

// Job log lines have GitHub timestamps and terminal colours; keep only their readable text.
const cleanCiLog = text => String(text ?? '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
  .split('\n').map(line => line.replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\s+/, '').replace(/\r$/, '')).join('\n');
const CI_FAIL_FILE_RE = /\bFAIL\s+(\S+\.(?:test|spec|soak\.test)\.[cm]?[jt]sx?)\b/;

/** Read current failing checks and up to four job logs for card 5947 (live #5045, 2026-10-13).
 * A job API failure leaves an empty log; check links still give the agent useful context. */
export async function readCiHealInputs({ repo, pr, run = sh }) {
  const data = JSON.parse(await run('gh', ['pr', 'view', String(pr), '--json', 'title,body,statusCheckRollup',
    ...(repo ? ['--repo', repo] : [])]) || '{}');
  const checks = collapseRollupToLatestPerName(data.statusCheckRollup)
    .filter(check => ['FAILURE', 'TIMED_OUT', 'STARTUP_FAILURE'].includes(String(check?.conclusion ?? '').toUpperCase()));
  const jobs = [];
  let slug = repo;
  for (const check of checks.filter(check => /\/job\/(\d+)/.test(check.detailsUrl ?? '')).slice(0, 4)) {
    const id = /\/job\/(\d+)/.exec(check.detailsUrl)[1];
    let log = '';
    try {
      if (!slug) slug = String(await run('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'])).trim();
      log = cleanCiLog(await run('gh', ['api', `repos/${slug}/actions/jobs/${id}/logs`], { maxBuffer: BLOB_MAX_BYTES }));
    } catch { /* one inaccessible job must not refuse the repair */ }
    jobs.push({ name: check.name, detailsUrl: check.detailsUrl, log });
  }
  return { title: data.title, body: data.body, checks, jobs };
}

/** PURE. Render bounded CI evidence, without a review finding, for card 5947 (live #5045, 2026-10-13). */
export function renderCiHealContext(inputs) {
  const files = new Set(), errors = new Set();
  const jobs = (inputs.jobs ?? []).map(job => {
    const lines = cleanCiLog(job.log).split('\n');
    let sawTest = false;
    for (const line of lines) {
      const match = CI_FAIL_FILE_RE.exec(line);
      if (match) { files.add(match[1]); sawTest = true; }
      if (sawTest && /AssertionError|Error:/.test(line)) errors.add(line);
    }
    return { ...job, lines, hasTests: lines.some(line => CI_FAIL_FILE_RE.test(line)) };
  }).sort((a, b) => Number(b.hasTests) - Number(a.hasTests));
  return cap([
    '## CI FAILURE CONTEXT (fetched by the launcher)',
    'Fix the code so these tests pass. The sandbox has no network: do not run gh; the launcher pushes after you exit.',
    `Title: ${String(inputs.title ?? '')}`, '', 'PR body:', cap(inputs.body, 4000),
    '', '### Failing checks', ...(inputs.checks ?? []).map(check => `- ${check.name}: ${check.detailsUrl ?? ''}`),
    '', '### Failing tests', ...[...files].map(file => `- ${file}`), ...errors,
    '', '### Failed log', ...jobs.map(job => `${job.name}\n${job.lines.slice(-120).join('\n')}`), '', '---', '',
  ].join('\n'), 16000);
}

/** Lane path = last non-empty stdout line of `lane-pool acquire` (it prints the path last). */
export function parseAcquiredLanePath(stdout) {
  const lines = String(stdout ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  const path = lines.filter((l) => l.startsWith('/')).pop();
  if (!path) throw new Error(`fix-run: lane-pool acquire printed no lane path (got ${JSON.stringify(lines.slice(-2))})`);
  return path;
}

export function isNothingToRearmRefusal(err) {
  return [err?.message, err?.stderr, err?.stdout].some((text) => String(text ?? '').includes('nothing to re-arm'));
}

/** @returns {{mode:'noop'|'fail', source:string}} */
export function resolveRearmRefusalPolicy(env = process.env) {
  try {
    const r = cascadePolicy('fixRearmNothingToRearm', undefined, {
      env, standard: { mode: 'noop' },
      envValues: { mode: env?.WE_FIX_REARM_NOTHING_TO_REARM },
      valid: { mode: (x) => x === 'noop' || x === 'fail' },
    });
    return { mode: r.value?.mode === 'fail' ? 'fail' : 'noop', source: r.sources?.mode ?? 'standard' };
  } catch { return { mode: 'noop', source: 'standard' }; }
}

export function resolveAcquireWaitPolicy(env = process.env) {
  try {
    const raw = env?.WE_FIX_RUN_ACQUIRE_WAIT_MS;
    const r = cascadePolicy('fixRunAcquireWait', undefined, {
      env, standard: { ms: 120000 },
      envValues: { ms: raw === undefined || String(raw).trim() === '' ? undefined : Number(raw) },
      valid: { ms: x => Number.isInteger(x) && x >= 0 },
    });
    return { ms: r.value.ms, source: r.sources?.ms ?? 'standard' };
  } catch { return { ms: 120000, source: 'standard' }; }
}

/** Keep the actionable child diagnostic ahead of the ledger's length cap. */
export function childFailureReason(err) {
  const message = String(err?.message ?? err);
  const lines = String(err?.stderr ?? '').split('\n').map(line => line.trim()).filter(Boolean);
  if (!lines.length) return message;
  const diagnostic = lines.filter(line => line.startsWith('✗')).at(-1) ?? lines.at(-1);
  const command = message.split('\n')[0].replace(/^Command failed:\s*/, '');
  const tokens = command.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  const script = tokens.findIndex(token => /\.(?:mjs|cjs|js)["']?$/.test(token));
  const short = script >= 0
    ? [basename(tokens[script].replace(/^["']|["']$/g, '')), tokens[script + 1]?.startsWith('-') ? '' : tokens[script + 1]].filter(Boolean).join(' ')
    : basename(tokens[0] ?? 'child');
  return `${diagnostic} (${short})`;
}

/** Resolve the repair-only Gemini worker without changing delivery provider routing. */
export async function resolveFixProvider(name) {
  if (name === 'antigravity') return (await import('./agy-fix-provider.mjs')).AGY_FIX_PROVIDER;
  return resolveDeliveryAgentProvider(name);
}

/**
 * THE CLI AS A FUNCTION. Exit 1 only when the launch itself threw; "agent made no change" is exit 0.
 * Card 5947 (live #5045, 2026-10-13): CI evidence and pre-lane outcomes are launcher-owned.
 * @returns {Promise<{code:number, result:string|null}>}
 */
export async function runFixCli(argv = [], {
  run = sh,
  recordPush = undefined,
  readPrompt = (p) => readFileSync(p, 'utf8'),
  removePrompt = removePromptFile,
  pendingRearm = defaultPendingRearm(),
  resolveProvider = resolveFixProvider,
  spawnCodex = async (...args) => (await import('./codex-delivery-provider.mjs')).defaultSpawnCodexAgent(...args),
  readComments = readAllComments,
  readCiHeal = readCiHealInputs,
  appendLoopRow = appendFixLoopRow,
  releaseClaim = releaseBorrowedClaim,
  recordOutcome = recordBorrowOutcome,
  recordRouted = recordRoutedOutcome,
  readFile = readLaneFileSafe,
  stageEntry = laneStageEntry,
  fileExists = existsSync,
  weRoot = REPO_ROOT,
  write = (l) => process.stdout.write(l),
  writeErr = (l) => process.stderr.write(l),
} = {}) {
  let launch;
  let laneRelease = null;
  // How this launch (borrowed or routed) ended. Recorded in the borrow ledger (repeated failures stop the PR borrowing)
  // and, for routed non-Claude repairs, the per-head ledger (repeated failures advance the chain). The claim is released on EVERY
  // exit: a fix that ends must not keep holding its claim and a cap slot until the TTL.
  let before = null;
  let prHeadSha = null;
  let finalMessage = '';
  let abortMerge = null;
  let outcome = 'failed';
  let reason = 'launch did not complete';
  const settle = async () => {
    if (!launch?.pr) return;
    const repo = launch.claimRepo ?? 'we';
    reason = singleLine(reason);
    try { recordOutcome({ repo, pr: Number(launch.pr), outcome, reason }); } catch (e) { writeErr(`fix-run: could not record the outcome: ${String(e?.message ?? e)}\n`); }
    const head = before ?? prHeadSha;
    if (launch.provider !== 'claude' && head) {
      try {
        const id = { repo, pr: Number(launch.pr), head };
        // `reason` (may carry raw command errors) stays in the local ledger; only `note` (the agent's final message
        // or the launcher's own error) is ever posted to the PR.
        const table = recordRouted({ ...id, outcome, reason, note: finalMessage });
        if (consecutiveUnproductiveOnHead(table, id) === ROUTED_CODEX_MAX_UNPRODUCTIVE) {
          withMessageFile(escalationComment(head, table[`${repo}#${launch.pr}`].slice(-ROUTED_CODEX_MAX_UNPRODUCTIVE)), file =>
            run('gh', ['pr', 'comment', launch.pr, ...(launch.repo ? ['--repo', launch.repo] : []), '--body-file', file], { cwd: weRoot }));
        }
      } catch (e) { writeErr(`fix-run: could not record routed outcome / post escalation: ${String(e?.message ?? e)}\n`); }
    }
    if (head) {
      try {
        await appendLoopRow({ kind: 'outcome', repo, pr: Number(launch.pr), head, session: launch.sessionSlug,
          outcome, infra: isInfraFixRunOutcome(outcome, reason), reason });
      } catch (e) { writeErr(`fix-run: could not record fix-loop outcome: ${String(e?.message ?? e)}\n`); }
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
  write(`${directLaunchLogLine({ kind: 'fix' })}\n`);
  try {
    const brief = readPrompt(launch.promptFile);
    // The launcher has the network, the agent does not: fetch the reviewer's finding here and hand it over in the brief.
    const prHead = JSON.parse(run('gh', ['pr', 'view', pr, '--json', 'title,body,baseRefName,mergeable,headRefOid', ...(launch.repo ? [`--repo=${launch.repo}`] : [])], { cwd: weRoot }) || '{}');
    prHeadSha = prHead.headRefOid ?? null;
    const mergeConflictingBase = !launch.mergeOnto && prHead.mergeable === 'CONFLICTING';
    const mergeOnto = mergeConflictingBase ? PR_BASE_MERGE_TARGET : launch.mergeOnto;
    // `@pr-base`: the dispatcher or launcher needs the live PR base; never guess `main`.
    const target = mergeOnto === PR_BASE_MERGE_TARGET ? String(prHead.baseRefName ?? '').trim() : mergeOnto;
    if (mergeOnto && !target) throw new LauncherError('cannot resolve PR base for conflict merge');
    if (mergeConflictingBase) write(`fix-run: PR #${pr} conflicts with ${target}; launcher merges origin/${target} first\n`);
    let prContext;
    let repeatPlan = { action: 'patch' };
    if (launch.repairKind === 'ci-heal') {
      const inputs = await readCiHeal({ repo: launch.repo, pr, run: (cmd, args, opts) => run(cmd, args, { cwd: weRoot, ...opts }) });
      if (!inputs.checks?.length) throw new LauncherError(`no-ci-failure: PR #${pr} has no failing check to heal`);
      prContext = renderCiHealContext(inputs);
    } else {
      const comments = await readComments(pr, { repo: launch.repo });
      const safety = resolveFixSafety();
      for (const k of ['alertAtRoundCap', 'resetOnRepeatedFinding']) write(`policy · fix.${k}=${safety.value[k]} (${safety.sources[k]})\n`);
      repeatPlan = repeatedFindingPlan(comments, { enabled: safety.value.resetOnRepeatedFinding });
      if (repeatPlan.action === 'stand-down') {
        const body = buildStandDownComment({ reason: 'repeated-finding', head: prHeadSha, detail: 'Record scope-baseline: <full sha> in an operator decision comment before another repair.' });
        withMessageFile(body, file => run('gh', ['pr', 'comment', pr, ...(launch.repo ? ['--repo', launch.repo] : []), '--body-file', file], { cwd: weRoot }));
        throw new LauncherError('repeated finding: operator scope-baseline required');
      }
      prContext = target && !comments.some(c => CHANGES_COMMENT_RE.test(c.body ?? ''))
        ? `## PR CONTEXT (fetched by the launcher)\nTitle: ${prHead.title ?? ''}\n${prHead.body ?? ''}\n\n`
        : renderPrContext({ ...prHead, comments });
    }
    const acquireWait = resolveAcquireWaitPolicy();
    write(`fix-run: lane acquire wait ${acquireWait.ms}ms (${acquireWait.source})\n`);
    const poolArgs = [
      resolve(weRoot, 'scripts', 'lane-pool.mjs'), 'acquire', ...(launch.laneRepo ? [`--repo=${launch.laneRepo}`] : []),
      `--wait-ms=${acquireWait.ms}`, '--purpose=conveyor-fix', `--session=${sessionSlug}`, ...(launch.scope ? [`--scope=${launch.scope}`] : []), `--base=${ref}`,
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
    const rearm = head => {
      // Best effort: the push already landed, and a label hiccup must never stop the re-arm (the CI-lifecycle label pass relabels it).
      try { markFixPushAwaitingCi({ repo: launch.repo, pr, head }, { run: (cmd, args) => run(cmd, args, { cwd: weRoot }), recordPush }); }
      catch (e) { writeErr(`fix-run: PR #${pr} CI hand-off failed, re-arming anyway: ${String(e?.message ?? e).split('\n')[0]}\n`); }
      try {
        return run('node', [resolve(weRoot, 'scripts', 'conveyor', 'rearm-review.mjs'), pr, ...(launch.repo ? [`--repo=${launch.repo}`] : [])], { cwd: weRoot });
      } catch (e) {
        const policy = resolveRearmRefusalPolicy();
        if (policy.mode === 'noop' && isNothingToRearmRefusal(e)) {
          write(`fix-run: PR #${pr} re-arm skipped — nothing to re-arm (review label not changes/accepted); policy fixRearmNothingToRearm=noop (source ${policy.source})\n`);
          return;
        }
        throw e;
      }
    };
    // A prior run pushed this exact tip and then failed to re-arm (this lane opened AT that tip): finish the hand-back
    // now, before spending a whole agent run on it.
    if (pendingRearm.read(launch.repo, pr)?.sha === before) {
      rearm(before);
      pendingRearm.clear(launch.repo, pr);
      const result = `PR #${pr} (already pushed ${before.slice(0, 9)}; re-armed review:pending after a failed earlier re-arm)`;
      outcome = 'pushed'; reason = 'finished an earlier push';
      write(`fix-run: PR #${pr} finished - ${result}\n`);
      return { code: 0, result };
    }
    const provider = await resolveProvider(launch.provider);
    const git = (...args) => run('git', [...HARDENED_GIT_ARGS, ...args], { cwd: lanePath, env: gitEnv });
    // Never let git open a lane path to stage it: `git add` and `commit -- paths` run with OUR read access, not the
    // sandbox's, and re-open each path after any check. Each path's bytes are read through laneStageEntry's one checked
    // descriptor into a private copy under the lane's .git (the sandbox cannot write there, so nothing can be swapped in),
    // and `git add` runs with that copy as its work tree, so git's own conversions (eol, keeping CRLF a file already has in
    // the index, working-tree-encoding, core.fileMode) apply as they would to the lane file; .gitattributes comes from the
    // copy or, where unchanged, the index. Every path is read and checked before git runs, so a refusal leaves nothing in
    // the object store. The total read is capped as each file is read. The commit takes the index only.
    // (A file the sandbox cannot read could also be RENAMED into the lane with one link, but a rename needs write access to
    // its source directory, and the sandbox's deny-read paths — codex-delivery-provider.mjs#defaultDeliveryDenyPaths —
    // lie outside its writable roots, so that is a hardlink-only problem here.)
    const stageLaneFiles = (paths) => {
      const gitDir = git('rev-parse', '--absolute-git-dir').trim();
      if (!gitDir) throw new LauncherError('cannot resolve the lane git directory to stage from');
      const copy = realpathSync(mkdtempSync(join(gitDir, 'fix-run-stage-')));
      try {
        const files = [], links = [], removed = [], refused = [];
        let total = 0;
        for (const path of paths) {
          const dest = resolve(copy, path);
          const e = dest.startsWith(copy + sep) ? stageEntry(lanePath, path) : null;
          if (!e) refused.push(path);
          else if (e.missing) removed.push(path);
          // Capped as each file is read, never after: sparse files (`truncate -s 64M f{1..1000}`) cost the agent no disk but
          // would each cost us a zero-filled buffer, so at most STAGE_MAX_BYTES plus the one file just read is ever held.
          else if ((total += e.data.length) > STAGE_MAX_BYTES) throw new LauncherError(`refusing to stage over ${STAGE_MAX_BYTES} bytes of agent-written files`);
          else (e.mode === '120000' ? links : files).push([path, dest, e]);
        }
        if (refused.length) throw new LauncherError(`refusing to stage ${refused.slice(0, 5).join(', ')}: a hardlinked, non-regular, out-of-lane or over-${BLOB_MAX_BYTES}-byte file`);
        // Regular files first, symlinks last, and every parent checked by realpath: a copy written through a symlink it
        // created itself (`X -> /elsewhere` then `x/y`, one entry on a case-insensitive filesystem) would write outside it.
        for (const [path, dest, e] of [...files, ...links]) {
          mkdirSync(dirname(dest), { recursive: true });
          const parent = realpathSync(dirname(dest));
          if (parent !== copy && !parent.startsWith(copy + sep)) throw new LauncherError(`refusing to stage ${path}: its staging copy leaves the copy directory`);
          if (e.mode === '120000') symlinkSync(e.data, dest);
          else writeFileSync(dest, e.data, { mode: e.mode === '100755' ? 0o755 : 0o644, flag: 'wx' });
        }
        // Mode 0 drops every index stage of a path the agent deleted.
        if (removed.length) run('git', [...HARDENED_GIT_ARGS, 'update-index', '-z', '--index-info'], { cwd: lanePath, env: gitEnv, input: removed.map(path => `0 ${'0'.repeat(before.length)}\t${path}\0`).join('') });
        // `-f`: these paths come from the lane's own status, which already applied every ignore rule; the copy lacks the
        // lane's unchanged .gitignore files, so a negation there (`!keep.tmp`) would otherwise be lost.
        const added = [...files, ...links].map(([path]) => path);
        if (added.length) run('git', [...HARDENED_GIT_ARGS, `--git-dir=${gitDir}`, `--work-tree=${copy}`, 'add', '-f', '--', ...added], { cwd: copy, env: gitEnv });
      } finally { rmSync(copy, { recursive: true, force: true }); }
      // The index now holds the copy's stat data; refresh it against the lane so `merge --abort` does not refuse. A refresh
      // only compares (it stores no object): a file swapped into the lane now is hashed in memory at most, never committed.
      // `-q`, `--unmerged` and `--ignore-missing` apply only to the options after them, so they come first.
      git('update-index', '-q', '--unmerged', '--ignore-missing', '--refresh');
    };
    const trailer = launch.provider === 'antigravity' ? 'Co-Authored-By: Antigravity (gemini-4-argon) <noreply@google.com>'
      : (await import('./deliver-item-wrapper.mjs')).coAuthorTrailerFor(launch.provider);
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
    // Capture emitted widths before the agent runs: the merge itself may already have changed .gitattributes. Widths come
    // from the `conflict-marker-size` attribute (merged tree and HEAD, as for `merge` above; unspecified is git's 7) and
    // from every opening marker line in the file at least 7 wide: these UU/AA conflicts open with
    // HEAD, and a criss-cross merge's virtual base nests wider ones. The attribute covers a file the UTF-8 read cannot decode.
    const attrSizes = new Map(unmerged.map(path => [path, new Set()]));
    if (unmerged.length) for (const source of [[], ['--source=HEAD']]) {
      const attrs = git('check-attr', ...source, '-z', 'conflict-marker-size', '--', ...unmerged).split('\0');
      for (let i = 0; i + 2 < attrs.length; i += 3) {
        const sizes = attrSizes.get(attrs[i]);
        if (!sizes) continue;
        if (/^[1-9]\d{0,8}$/.test(attrs[i + 2])) { sizes.add(Number(attrs[i + 2])); continue; }
        // Anything else (unspecified, `+10`, `10x`, an out-of-range number): git's own parse may give 7 or the leading
        // number, so scan for both rather than guess.
        sizes.add(7);
        const lead = Number.parseInt(attrs[i + 2], 10);
        if (lead > 0 && lead < 2 ** 31) sizes.add(lead);
      }
    }
    const markerSizes = new Map(unmerged.map(path => {
      const text = readFile(join(lanePath, path), lanePath);
      // Fail closed: scanning '' for widths would silently miss a nested (wider) marker the file really holds.
      if (text == null) throw new LauncherError(`cannot read conflicted file ${path} (not a regular lane file, or over ${BLOB_MAX_BYTES} bytes)`);
      const sizes = new Set(attrSizes.get(path));
      for (const match of text.matchAll(/^(<{7,}) [^\r\n]*$/gm)) sizes.add(match[1].length);
      if (!sizes.size) sizes.add(7);
      // The index stages (1 base, 2 ours, 3 theirs) are the baseline: marker-shaped lines they carry may be content.
      const stages = Object.fromEntries(indexEntries(path).filter(e => e.stage !== '0').map(e => [e.stage, blob(e.oid)]));
      return [path, { sizes, allowance: markerAllowance(sizes, { base: stages[1], ours: stages[2], theirs: stages[3] }) }];
    }));
    let spawned;
    if (repeatPlan.action === 'reset') {
      if (target) throw new LauncherError('repeated finding: resolve base conflict before scope reset');
      const scope = String(launch.scope ?? '').split(',').map(p => p.trim().replace(/^[a-z][\w-]*:/i, '')).filter(Boolean);
      let reset;
      try { reset = applyScopeReset({ ...repeatPlan, scope, git }); }
      catch {
        const body = buildStandDownComment({ reason: 'repeated-finding', head: prHeadSha,
          detail: 'Scope reset could not be proven or replayed safely; operator intervention required.' });
        withMessageFile(body, file => run('gh', ['pr', 'comment', pr, ...(launch.repo ? ['--repo', launch.repo] : []), '--body-file', file], { cwd: weRoot }));
        throw new LauncherError('repeated finding: scope reset refused');
      }
      finalMessage = `repeated finding: restored scope-baseline ${reset.baseline} plus ${reset.replay.length} in-scope commits`;
      write(`fix-run: ${finalMessage}\n`);
    } else try {
      spawned = await provider.spawn({
        taskKind: launch.taskKind, usageTaskKind: launch.repairKind === 'ci-heal' ? 'ci-heal' : launch.taskKind, repo: launch.repo, pr, caller: 'fix-run.mjs',
        sessionId: undefined, prompt: mergePrompt + (launch.repairKind === 'ci-heal'
          ? SANDBOX_PREAMBLE.replace(/The reviewer's finding[\s\S]*?authoritative ask\.\n/, 'The failing checks and tests are in the CI FAILURE CONTEXT section below.\n')
          : SANDBOX_PREAMBLE) + prContext + brief, lane: laneNum, sessionSlug, item: launch.item ?? '', attemptTag: '',
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
    } catch (e) {
      finalMessage = agentFinalMessage(e) || finalMessage;
      throw e;
    }
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
      stageLaneFiles(stage);
      // Scan what will be COMMITTED too: staging applies .gitattributes (which the agent can write), so a file saved
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
      stageLaneFiles(paths);
      // No pathspec: `commit -- <paths>` would re-read those paths from the worktree, undoing what was staged above.
      withMessageFile(`${message.trim()}\n\n${trailer}\n`, file => git('commit', '-F', file));
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
      rearm(after);
      pendingRearm.clear(launch.repo, pr);
      result = `PR #${pr} (pushed ${after.slice(0, 9)}, re-armed review:pending)`;
      outcome = 'pushed'; reason = finalMessage || `pushed ${after.slice(0, 9)}`;
    }
    write(`fix-run: PR #${pr} finished - ${result}\n`);
    return { code: 0, result };
  } catch (e) {
    writeErr(`fix-run: PR #${pr} FAILED: ${String(e?.message ?? e)}\n`);
    outcome = 'failed'; reason = `${childFailureReason(e)}${finalMessage && !String(e?.message).includes(finalMessage) ? `: ${finalMessage}` : ''}`;
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
