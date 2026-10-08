/**
 * @file scripts/lib/verify-revert-red.mjs
 * @description THE REVERT-RED CHECK, wired (#5466). Reads the facts from git, runs the revert transaction
 *   (`we:scripts/operations/mutation-check-io.mjs#createRevertProbe` — the mutation-check mutate → run → restore shape),
 *   and asks the pure rule (`./revert-red-rule.mjs`) for the verdict.
 *
 * TWO CALLERS, ONE PATH:
 *   - `we:scripts/verify-lane.mjs` — inside the fixer's own verify, after a GREEN gate and before the marker is written,
 *     so the harness's exact-sha / clean-tree push check (#5137) never sees the reverted tree. A fix push is decided from
 *     the fix role's own await record (`.fix-await-verify`, kind `fix`/`ci-heal`, sha == the verified head), never from a
 *     commit message. The pre-fix base is that record's `lane/*` ref as the lane last fetched it.
 *   - `node scripts/operations/run.mjs revert-red-check --checkout=<dir> --base=<sha>` — the replay path: the caller
 *     names the range and asserts it is a fix.
 *
 * Every git read goes through a HARDENED runner (`./lane-git-hardening.mjs`): the lane is agent-writable, and its
 * `.git/config` must not be able to run a command here — the same rule verify-lane follows for its own reads.
 *
 * IMPURE (git, fs through the injected probe). The decisions are all in `./revert-red-rule.mjs`.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import * as nodeFs from 'node:fs';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';

import { laneGitHardeningEnv, hardenLaneGitArgs } from './lane-git-hardening.mjs';
import { planRevert, newTestTitles, revertRedVerdict, revertRedGate, formatRevertRed } from './revert-red-rule.mjs';

const SHA_RE = /^[0-9a-f]{40}$/i;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

/** An UNTRIMMED, hardened git runner rooted at `cwd` (file contents must keep their trailing newline).
 *  `{ buffer: true }` returns the raw bytes, so a non-UTF-8 file is detected instead of silently re-encoded. */
export function hardenedGit(cwd, { exec = execFileSync, env = process.env } = {}) {
  const gitEnv = laneGitHardeningEnv(env);
  return (args, { buffer = false } = {}) => {
    const out = exec('git', hardenLaneGitArgs(args), {
      cwd, ...(buffer ? {} : { encoding: 'utf8' }), stdio: ['ignore', 'pipe', 'pipe'], env: gitEnv, maxBuffer: GIT_MAX_BUFFER,
    });
    return buffer ? Buffer.from(out) : String(out);
  };
}

/** The bytes as text when they round-trip through UTF-8 exactly and hold no NUL; otherwise `null` (binary: never reverted). */
export function textOrNull(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes ?? ''), 'utf8');
  if (buf.includes(0)) return null;
  const text = buf.toString('utf8');
  return Buffer.from(text, 'utf8').equals(buf) ? text : null;
}

/**
 * The revert JOURNAL — written before any file is reverted, removed only after the restore is verified. A run that is
 * killed between the two (an outer time ceiling, a daemon restart) leaves it behind, and the NEXT verify of the lane
 * puts the fixed content back from git before it does anything else ({@link recoverRevertRed}).
 */
export const REVERT_JOURNAL = '.revert-red-pending.json';
const journalPath = (run) => join(run(['rev-parse', '--absolute-git-dir']).trim(), REVERT_JOURNAL);

/**
 * Put back any revert a killed run left behind. Never throws.
 * @returns {{pending: boolean, ok: boolean, restored: string[], detail?: string}}
 */
export function recoverRevertRed({ checkout, git, fs = nodeFs } = {}) {
  const run = git ?? hardenedGit(checkout);
  let path;
  try { path = journalPath(run); } catch { return { pending: false, ok: true, restored: [] }; }
  let journal;
  try { journal = JSON.parse(fs.readFileSync(path, 'utf8')); } catch (e) {
    if (e?.code === 'ENOENT') return { pending: false, ok: true, restored: [] };
    // The journal is complete (atomic rename) BEFORE any file is reverted, so an unreadable one means no revert ever
    // happened under it: drop it rather than wedge every later verify of the lane.
    try { fs.unlinkSync(path); } catch { /* gone */ }
    return { pending: true, ok: true, restored: [], leftAlone: [], detail: 'dropped an unreadable revert journal' };
  }
  const head = String(journal?.head ?? '');
  const files = Array.isArray(journal?.files) ? journal.files : [];
  if (!SHA_RE.test(head)) {
    try { fs.unlinkSync(path); } catch { /* gone */ }
    return { pending: true, ok: true, restored: [], leftAlone: [], detail: 'dropped a revert journal that names no head' };
  }
  // A revert still IN PROGRESS (another verify of this lane, alive) is not a killed run: never restore under it.
  if (Number.isSafeInteger(journal?.pid) && journal.pid > 0 && journal.pid !== process.pid && journal.host === hostname() && pidAlive(journal.pid)) {
    return { pending: true, ok: false, restored: [], detail: `another verify (pid ${journal.pid}) is mid-revert in this lane` };
  }
  // Only a tree that is EXACTLY what the killed run left is put back: HEAD still the journaled head, and each file
  // still holding the reverted bytes it wrote. Anything else means someone moved on since — their work is never
  // overwritten; the file is reported and left alone.
  let currentHead = '';
  try { currentHead = run(['rev-parse', 'HEAD']).trim(); } catch { /* unreadable → treated as moved */ }
  const restored = [];
  const leftAlone = [];
  try {
    for (const entry of files) {
      const file = String(entry?.path ?? '');
      // A journaled file that is gone was deleted after the kill: someone moved on, so it is left alone.
      if (file && !file.startsWith('/') && !file.split('/').includes('..') && !fs.existsSync(join(checkout, file))) { leftAlone.push(file); continue; }
      const abs = safeTarget(checkout, file, fs);
      if (!abs) throw new Error(`unsafe journal path ${JSON.stringify(file)}`);
      let onDisk = null;
      try { onDisk = fs.readFileSync(abs); } catch { onDisk = null; }
      if (currentHead !== head || !onDisk || sha256(onDisk) !== String(entry?.reverted ?? '')) { leftAlone.push(file); continue; }
      const bytes = run(['show', `${head}:${file}`], { buffer: true });
      fs.writeFileSync(abs, bytes);
      if (!Buffer.from(fs.readFileSync(abs)).equals(Buffer.from(bytes))) throw new Error(`re-read of ${file} differs`);
      restored.push(file);
    }
    fs.unlinkSync(path);
    return { pending: true, ok: true, restored, leftAlone };
  } catch (e) {
    return { pending: true, ok: false, restored, leftAlone, detail: String(e?.message ?? e) };
  }
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; } };

/**
 * What a revert-red result does to the verify verdict. PURE — the one place verify-lane's exit code is decided for it.
 *   - not-restored → red in EVERY mode: the tree is no longer the verified commit (an infrastructure failure, not a
 *     check verdict; the next verify restores it from the journal).
 *   - blocking (enforce only) → red, naming the tests that did not discriminate.
 *   - anything else (every warn result) → the gate's own verdict, unchanged.
 * @returns {{exitCode: number, failureDetails: object|undefined}}
 */
export function applyRevertRedToVerdict({ exitCode, failureDetails, revertRed }) {
  if (!revertRed || exitCode !== 0) return { exitCode, failureDetails };
  if (revertRed.reason === 'not-restored') {
    return { exitCode: 1, failureDetails: { tests: [], summary: `${revertRed.line} — the lane still holds reverted source; the next verify restores it from git`, truncated: false } };
  }
  if (revertRed.blocking) {
    const flagged = [...(revertRed.nonDiscriminating ?? []), ...(revertRed.unproven ?? [])];
    return { exitCode: 1, failureDetails: { tests: flagged.map((t) => ({ file: t.file, name: t.test ? `${t.test} (passes with the fix reverted)` : null })), summary: revertRed.line, truncated: false } };
  }
  return { exitCode, failureDetails };
}

/**
 * The absolute path for `target` inside `checkout`, or `null` when it is a symlink or resolves outside the checkout.
 * The lane is agent-writable: a symlinked file or directory must not turn the revert into a write somewhere else.
 */
export function safeTarget(checkout, target, fs = nodeFs) {
  try {
    if (typeof target !== 'string' || !target || target.startsWith('/') || target.split('/').includes('..')) return null;
    const root = fs.realpathSync(checkout);
    const abs = join(checkout, target);
    if (fs.lstatSync(abs).isSymbolicLink()) return null;
    const parent = fs.realpathSync(dirname(abs));
    return parent === root || parent.startsWith(`${root}${sep}`) ? abs : null;
  } catch { return null; }
}

const tryRun = (fn) => { try { return { ok: true, value: fn() }; } catch (error) { return { ok: false, error }; } };

/** `git diff --name-status -z` output → `[{status, path}]`. Renames are disabled, so every entry has one path. */
export function parseNameStatusZ(text) {
  const parts = String(text ?? '').split('\0').filter((s) => s !== '');
  const changes = [];
  for (let i = 0; i + 1 < parts.length; i += 2) changes.push({ status: parts[i], path: parts[i + 1] });
  return changes;
}

/** The `+` lines of a unified diff, without the marker (file headers excluded). */
export function addedLines(diffText) {
  return String(diffText ?? '').split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1));
}

/**
 * Run the check for one range. Never throws: an error becomes an `unproven` verdict with the reason, so warn mode
 * records it and enforce mode blocks on it (the card's fail-closed rule).
 *
 * @param {object} o
 * @param {string} o.checkout   the lane / checkout root; the revert is applied and restored here.
 * @param {string} o.base       the pre-fix commit (sha or ref).
 * @param {string} [o.head]     the fixed commit (default `HEAD`); the working tree must hold it.
 * @param {string} o.mode       `off` | `warn` | `enforce`.
 * @param {string} [o.kind]     the fix role's record kind (default `fix` — the replay caller asserts it).
 * @param {boolean} [o.recordMatchesHead]
 * @param {number} [o.maxFiles]
 * @param {Function} o.probe    `createRevertProbe(...)`'s returned function.
 * @param {Function} [o.git]    an untrimmed git runner; defaults to {@link hardenedGit}.
 */
export async function runRevertRedCheck({ checkout, base, head = 'HEAD', mode, kind = 'fix', recordMatchesHead = true, maxFiles = 40, probe, git, fs = nodeFs } = {}) {
  const facts = { mode, changeKind: kind, recordMatchesHead };
  // Off / not a fix / wrong head: decided before any git read.
  if (revertRedGate(facts)) {
    const v = revertRedVerdict(facts);
    return { ...v, base: null, head: null, line: formatRevertRed(v) };
  }
  const run = git ?? hardenedGit(checkout);
  // A revert a killed run left behind is put back FIRST; if it cannot be, nothing else here runs on that tree.
  const recovery = recoverRevertRed({ checkout, git: run, fs });
  const fail = (reason) => {
    const v = revertRedVerdict({ ...facts, plan: null, skipReason: '' });
    const out = { ...v, reason, base: null, head: null };
    return { ...out, line: formatRevertRed(out) };
  };
  if (!recovery.ok) return fail('pending-revert-not-recovered');
  const headSha = tryRun(() => run(['rev-parse', '--verify', `${head}^{commit}`]).trim());
  const baseSha = tryRun(() => run(['rev-parse', '--verify', `${base}^{commit}`]).trim());
  if (!headSha.ok || !SHA_RE.test(headSha.value)) return fail('head-unreadable');
  if (!baseSha.ok || !SHA_RE.test(baseSha.value)) return fail('base-unreadable');
  const finish = (verdict) => ({ ...verdict, base: baseSha.value, head: headSha.value, line: formatRevertRed(verdict) });
  if (baseSha.value === headSha.value) return finish(revertRedVerdict({ ...facts, plan: planRevert({ changes: [] }) }));
  // Not an ancestor: the record's base does not describe this head. Unproven (blocks in enforce), never skipped.
  if (!tryRun(() => run(['merge-base', '--is-ancestor', baseSha.value, headSha.value])).ok) {
    return { ...fail('base-not-ancestor'), base: baseSha.value, head: headSha.value };
  }
  // A merge in the range (a fix that merged main to resolve a conflict) brings main's changes into the diff; reverting
  // those would test main, not the fix. Recorded as skipped, never guessed around.
  const merges = tryRun(() => run(['rev-list', '--merges', `${baseSha.value}..${headSha.value}`]).trim());
  if (!merges.ok) return fail('range-unreadable');
  if (merges.value) return finish(revertRedVerdict({ ...facts, plan: null, skipReason: 'merge-in-range' }));

  const diff = tryRun(() => run(['diff', '--name-status', '--no-renames', '-z', baseSha.value, headSha.value]));
  if (!diff.ok) return fail('diff-unreadable');
  const plan = planRevert({ changes: parseNameStatusZ(diff.value), maxFiles });
  const early = revertRedVerdict({ ...facts, plan, probe: null });
  if (early.status === 'skipped') return finish(early);

  const titles = {};
  const targets = [];
  const unrevertable = [];
  try {
    for (const file of plan.tests) {
      titles[file] = newTestTitles(addedLines(run(['diff', '-U0', baseSha.value, headSha.value, '--', file])));
    }
    for (const target of plan.revert) {
      // Text only (binary bytes would not survive a string round trip) and only a real file inside the checkout.
      const fixed = textOrNull(run(['show', `${headSha.value}:${target}`], { buffer: true }));
      const revert = textOrNull(run(['show', `${baseSha.value}:${target}`], { buffer: true }));
      if (fixed === null || revert === null || !safeTarget(checkout, target, fs)) unrevertable.push(target);
      else targets.push({ target, fixed, revert });
    }
  } catch {
    return fail('content-unreadable');
  }
  const runPlan = { ...plan, revert: targets.map((t) => t.target), unrevertable };
  if (targets.length === 0) return finish({ ...revertRedVerdict({ ...facts, plan: runPlan }), unrevertable });

  let journal;
  try {
    journal = journalPath(run);
    const files = targets.map((t) => ({ path: t.target, reverted: sha256(Buffer.from(t.revert, 'utf8')) }));
    // Atomic: a kill mid-write leaves a stray tmp file, never a half-written journal.
    const tmp = `${journal}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify({ head: headSha.value, files, pid: process.pid, host: hostname(), at: new Date().toISOString() })}\n`);
    fs.renameSync(tmp, journal);
  } catch {
    return fail('journal-unwritable');
  }
  let result;
  try {
    result = await probe({ cwd: checkout, targets, suite: plan.tests.map((f) => `./${f}`) });
  } catch (error) {
    // The probe restores in its own `finally`; an error escaping it still never reads as a pass.
    result = { applied: true, restored: false, detail: String(error?.message ?? error) };
  }
  // The journal goes only once the restore is VERIFIED; otherwise the next verify of this lane restores from git.
  if (result?.restored === true || result?.applied === false) { try { fs.unlinkSync(journal); } catch { /* already gone */ } }
  return { ...finish(revertRedVerdict({ ...facts, plan: runPlan, titles, probe: result })), unrevertable, probeDetail: String(result?.detail ?? '') };
}

/**
 * The verify-lane entry: decide from the fix role's own await record whether this verified head is a fix push, then run.
 * @param {object} o
 * @param {string} o.repo        the lane root.
 * @param {string} o.headSha     the sha verify-lane verified.
 * @param {object|null} o.record the lane's `.fix-await-verify` record (or null).
 * @param {object} o.settings    `{ mode, maxFiles }` from the declared verify settings.
 * @param {Function} o.probe
 * @param {Function} [o.git]
 */
export async function revertRedForVerify({ repo, headSha, record, settings = {}, probe, git } = {}) {
  const kind = typeof record?.kind === 'string' ? record.kind : null;
  const matches = Boolean(record) && SHA_RE.test(String(record?.sha ?? '')) && String(record.sha).toLowerCase() === String(headSha ?? '').toLowerCase();
  const ref = typeof record?.ref === 'string' && /^lane\/[A-Za-z0-9._/-]+$/.test(record.ref) && !record.ref.includes('..') ? record.ref : null;
  const facts = { mode: settings.mode, changeKind: kind, recordMatchesHead: matches };
  if (revertRedGate(facts)) {
    const v = revertRedVerdict(facts);
    return { ...v, base: null, head: headSha ?? null, line: formatRevertRed(v) };
  }
  if (!ref) {
    // A fix record with no usable ref names no pre-fix base: unproven (blocks in enforce), never skipped.
    const v = { ...revertRedVerdict({ ...facts, plan: null }), reason: 'fix-record-has-no-ref' };
    return { ...v, base: null, head: headSha, line: formatRevertRed(v) };
  }
  return runRevertRedCheck({
    checkout: repo, base: `refs/remotes/origin/${ref}`, head: headSha, mode: settings.mode, kind,
    recordMatchesHead: matches, maxFiles: settings.maxFiles, probe, git,
  });
}

/** Append one result to the coordination-root log (best effort): the warn window's counts come from here (A5). */
export function appendRevertRedLog(entry, { root, append = appendFileSync, mkdir = mkdirSync } = {}) {
  try {
    const dir = join(root, 'revert-red');
    mkdir(dir, { recursive: true });
    append(join(dir, 'log.jsonl'), `${JSON.stringify(entry)}\n`);
    return true;
  } catch {
    return false;
  }
}
