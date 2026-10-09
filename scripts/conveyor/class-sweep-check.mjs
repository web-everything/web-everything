#!/usr/bin/env node
/**
 * @file scripts/conveyor/class-sweep-check.mjs
 * @description The fixer's class-sweep check (card xet6iu0) — the cheap deterministic half of "fix the class, not the
 *   instance". A fix / ci-heal session runs it on its evidence text BEFORE posting it:
 *
 *     node <WE_ROOT>/scripts/conveyor/class-sweep-check.mjs --evidence-file=<file> --kind=fix|ci-heal \
 *       --repo=<owner/name> --pr=<n> --session=<slug>
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
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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

/** Read at most MAX_EVIDENCE_BYTES + 1 characters' worth; a missing file is `null` (→ `missing`, never `complete`). */
function readEvidence(path, read) {
  if (typeof path !== 'string' || !path) return null;
  try {
    const text = read(path);
    return typeof text === 'string' ? text.slice(0, MAX_EVIDENCE_BYTES + 1) : null;
  } catch { return null; }
}

/**
 * Run the check. Injectable IO for tests.
 * @returns {{exitCode: number, line: string, verdict: object, recorded: boolean}}
 */
export function main(argv = process.argv.slice(2), {
  env = process.env, read = (p) => readFileSync(p, 'utf8'), now = () => new Date().toISOString(),
  root = resolveCoordinationRoot({ env }), write = writeFileSync, rename = renameSync, append = appendFileSync, mkdir = mkdirSync,
  settingsPath = defaultPolicySettingsPath(), out = (s) => process.stdout.write(`${s}\n`),
} = {}) {
  const flags = parseFlags(argv);
  const { mode, source, since } = resolveClassSweepMode({ env, read, path: settingsPath });
  const kind = typeof flags.kind === 'string' ? flags.kind : 'fix';
  const verdict = classSweepVerdict({ mode, changeKind: kind, evidence: readEvidence(flags['evidence-file'], read) });
  const line = formatClassSweep(verdict);
  let recorded = false;
  const session = typeof flags.session === 'string' && SESSION_RE.test(flags.session) ? flags.session : null;
  if (verdict.status !== 'skipped') {
    const entry = {
      v: 1, at: now(), session, kind, repo: typeof flags.repo === 'string' ? flags.repo.slice(0, 100) : null,
      pr: /^\d+$/.test(String(flags.pr ?? '')) ? Number(flags.pr) : null, modeSource: source, since,
      status: verdict.status, reason: verdict.reason, blocking: verdict.blocking, problems: verdict.problems.slice(0, 50),
      classes: verdict.classes, sweep: verdict.sweep,
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
