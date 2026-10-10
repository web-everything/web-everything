#!/usr/bin/env node
/**
 * @file scripts/conveyor/class-sweep-check.mjs
 * @description The fixer's class-sweep check (card xet6iu0) — the cheap deterministic half of "fix the class, not the
 *   instance". A fix / ci-heal session runs it on its evidence text BEFORE posting it:
 *
 *     node <WE_ROOT>/scripts/conveyor/class-sweep-check.mjs --evidence-file=<file> --kind=fix|ci-heal \
 *       --repo=<owner/name> --pr=<n> --session=<slug> --checkout=<lane> --base=origin/<pr base branch>
 *
 *   THE SAME CLASS ANYWHERE IN THE PR (card 5536): the PR's changed files are read from the lane
 *   (`git -C <lane> diff --name-only <base>...HEAD`, argv array, no shell, bounded buffer) or from
 *   `--changed-files=<file>` (one path per line). Every finding's rows must name each of them; with neither flag, or an
 *   unreadable, oversized or EMPTY list, the PR-wide check fails closed (`pr-files-unknown`). The list and the evidence
 *   file are read with a byte bound (`readHeadBytes`), never whole.
 *
 *   It reads the ```class-sweep block (grammar: `../lib/class-sweep-rule.mjs`), prints one line, and RECORDS the
 *   structured sweep — the classes and every sibling path checked — under the coordination root:
 *   `class-sweep/<session>.json` (latest, atomic replace) and `class-sweep/log.jsonl` (append). That record is the
 *   structured field the review side and the warn-window review read.
 *
 *   MODE is a declared setting: `classSweep.mode` in `../lib/review-fix-policy-settings.json` of the WE root RUNNING
 *   this script (never the lane's copy — a lane must not be able to weaken its own check), overridable by
 *   `WE_CLASS_SWEEP`. Built-in `off` (today's behaviour). `warn` records and exits 0 whatever the result; `enforce`
 *   exits 2 on a missing / malformed / incomplete sweep.
 *
 * IMPURE: reads one file, writes the record. Every decision is in the pure rule.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, readSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { classSweepVerdict, formatClassSweep, CLASS_SWEEP_MODES, MAX_EVIDENCE_BYTES } from '../lib/class-sweep-rule.mjs';
import { resolveCoordinationRoot } from '../operations/coordination-root.mjs';

export const CLASS_SWEEP_ENV = 'WE_CLASS_SWEEP';
const SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function defaultPolicySettingsPath() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../lib/review-fix-policy-settings.json');
}

/** The declared mode: env over file over built-in `off`. An unknown value never loosens — it falls back. */
export function resolveClassSweepMode({ env = process.env, read = (p) => readFileSync(p, 'utf8'), path = defaultPolicySettingsPath() } = {}) {
  const fromEnv = env?.[CLASS_SWEEP_ENV];
  if (CLASS_SWEEP_MODES.includes(fromEnv)) return { mode: fromEnv, source: 'env', since: null };
  try {
    const file = JSON.parse(read(path))?.classSweep;
    if (CLASS_SWEEP_MODES.includes(file?.mode)) return { mode: file.mode, source: 'file', since: typeof file.since === 'string' ? file.since : null };
  } catch { /* unreadable or malformed settings → built-in */ }
  return { mode: 'off', source: 'default', since: null };
}

function parseFlags(argv) {
  const flags = {};
  for (const a of argv) {
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq === -1) flags[a.slice(2)] = true; else flags[a.slice(2, eq)] = a.slice(eq + 1);
  }
  return flags;
}

/**
 * Read at most `maxBytes` bytes of a file — never the whole of an oversized one (PR 4687: a `readFileSync` of an
 * unbounded input allocates it all before any size check). Returns the decoded head; the caller treats a result that
 * could not have fit (`bytes > maxBytes - 1`) as oversized. IMPURE.
 * @param {string} path
 * @param {number} maxBytes the most bytes to request from the file (the caller passes the bound plus one).
 * @returns {string}
 */
export function readHeadBytes(path, maxBytes) {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(maxBytes);
    let got = 0;
    while (got < maxBytes) {
      const n = readSync(fd, buf, got, maxBytes - got, got);
      if (n === 0) break;
      got += n;
    }
    return buf.subarray(0, got).toString('utf8');
  } finally { closeSync(fd); }
}

/** Read at most MAX_EVIDENCE_BYTES + 1 bytes; a missing file is `null` (→ `missing`, never `complete`). */
function readEvidence(path, readHead) {
  if (typeof path !== 'string' || !path) return null;
  try {
    const text = readHead(path, MAX_EVIDENCE_BYTES + 1);
    return typeof text === 'string' ? text : null;
  } catch { return null; }
}

const BASE_RE = /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,200}$/;

/**
 * The PR's changed files, or null when they cannot be read (→ `pr-files-unknown`, never `complete`): unreadable,
 * oversized, or EMPTY — a PR under review always changes a file, so an empty diff is a wrong or stale base.
 */
export function readChangedFiles(flags, { readHead, git }) {
  let text = null;
  if ('changed-files' in flags) {
    // Present but empty / valueless is an unreadable list, not a cue to fall through to --checkout.
    if (typeof flags['changed-files'] !== 'string' || !flags['changed-files']) return null;
    try { text = readHead(flags['changed-files'], MAX_EVIDENCE_BYTES + 1); } catch { return null; }
  } else if (typeof flags.checkout === 'string' && flags.checkout) {
    const base = typeof flags.base === 'string' ? flags.base : 'origin/main';
    if (!BASE_RE.test(base) || base.includes('..')) return null;
    try { text = git(['-C', flags.checkout, '-c', 'core.quotepath=off', 'diff', '--name-only', '--no-renames', `${base}...HEAD`]); } catch { return null; }
  }
  // A list past the bound is never cut short (a cut list could read `complete`): it is unknown.
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_EVIDENCE_BYTES) return null;
  const files = text.split('\n').map((l) => l.trim()).filter(Boolean);
  return files.length > 0 ? files : null;
}

const defaultGit = (args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 30_000, stdio: ['ignore', 'pipe', 'ignore'] });

/**
 * Run the check. Injectable IO for tests.
 * @returns {{exitCode: number, line: string, verdict: object, recorded: boolean}}
 */
export function main(argv = process.argv.slice(2), {
  env = process.env, read = (p) => readFileSync(p, 'utf8'), now = () => new Date().toISOString(),
  root = resolveCoordinationRoot({ env }), write = writeFileSync, rename = renameSync, append = appendFileSync, mkdir = mkdirSync,
  settingsPath = defaultPolicySettingsPath(), out = (s) => process.stdout.write(`${s}\n`), git = defaultGit,
  readHead = readHeadBytes,
} = {}) {
  const flags = parseFlags(argv);
  const { mode, source, since } = resolveClassSweepMode({ env, read, path: settingsPath });
  const kind = typeof flags.kind === 'string' ? flags.kind : 'fix';
  const changedFiles = mode === 'off' ? undefined : readChangedFiles(flags, { readHead, git });
  const verdict = classSweepVerdict({ mode, changeKind: kind, evidence: readEvidence(flags['evidence-file'], readHead), changedFiles });
  const line = formatClassSweep(verdict);
  let recorded = false;
  const session = typeof flags.session === 'string' && SESSION_RE.test(flags.session) ? flags.session : null;
  if (verdict.status !== 'skipped') {
    const entry = {
      v: 1, at: now(), session, kind, repo: typeof flags.repo === 'string' ? flags.repo.slice(0, 100) : null,
      pr: /^\d+$/.test(String(flags.pr ?? '')) ? Number(flags.pr) : null, modeSource: source, since,
      status: verdict.status, reason: verdict.reason, blocking: verdict.blocking, problems: verdict.problems.slice(0, 50),
      classes: verdict.classes, sweep: verdict.sweep, unswept: verdict.unswept,
      prFiles: Array.isArray(changedFiles) ? changedFiles.length : null,
    };
    try {
      const dir = join(root, 'class-sweep');
      mkdir(dir, { recursive: true });
      if (session) {
        const target = join(dir, `${session}.json`);
        const tmp = `${target}.${process.pid}.tmp`;
        write(tmp, `${JSON.stringify(entry, null, 2)}\n`);
        rename(tmp, target);
      }
      append(join(dir, 'log.jsonl'), `${JSON.stringify(entry)}\n`);
      recorded = true;
    } catch { /* best effort: the printed line still tells the fixer */ }
  }
  if (flags.json) out(JSON.stringify({ ...verdict, line, recorded }));
  else out(line);
  return { exitCode: verdict.blocking ? 2 : 0, line, verdict, recorded };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main().exitCode;
}
