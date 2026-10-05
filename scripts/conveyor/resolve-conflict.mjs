#!/usr/bin/env node
/**
 * Sanctioned, lane-only conflict resolution for unattended dispatched fixers.
 *
 * WHY: PR #3964, fixer fix-3964 (session 5fedac15, 2026-10-05 08:13–08:17 ET),
 * in lane-5, tried `git checkout --theirs scripts/operations/review-pr-io.mjs`.
 * Claude Code auto-mode denied it as "[Irreversible Local Destruction]". With nobody
 * watching claude --bg, the fixer reported blocked-on-infra and released its claim,
 * inviting the same denial after every 15-minute retry. This narrow helper reads
 * index stages instead, and is explicitly allowed by the dispatcher's settings.
 *
 * Pure argument/path/planning functions sit apart from the injectable git IO shell.
 * All requested files are preflighted before writing any resolution. Only an active
 * merge in a lane clone is eligible; logs live outside the lane and .git so recording
 * evidence cannot dirty the checkout. Logging failure never masks the actual result.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync, rmSync, lstatSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const isLaneClonePath = (p) => typeof p === 'string' && /\/\.lanes\/[^/]+\/lane-\d+$/.test(p);

/** PURE: reject traversal rather than silently normalizing an ambiguous target. */
function validateFile(file) {
  if (!file || isAbsolute(file) || file.split(/[\\/]/).includes('..') || file.includes('\0')) throw new Error(`Unsafe repo-relative path: ${file}`);
}
export function parseArgs(argv) {
  const result = { dir: '.', files: [], take: undefined };
  for (const arg of argv) {
    const match = /^--(dir|file|take)=(.*)$/.exec(arg);
    if (!match) throw new Error(`Unknown argument: ${arg}`);
    if (match[1] === 'file') result.files.push(...match[2].split(','));
    else result[match[1]] = match[2];
  }
  return result;
}

/** PURE: missing side means deletion; union needs both sides and permits an empty add/add base. */
export function planResolution({ take, stages }) {
  if (!['ours', 'theirs', 'union'].includes(take)) throw new Error('--take must be ours, theirs, or union');
  const stage = take === 'ours' ? 2 : take === 'theirs' ? 3 : null;
  if (stage) return { take, stage, action: stages[stage] == null ? 'deleted' : 'resolved', content: stages[stage] };
  if (stages[2] == null || stages[3] == null) throw new Error('Union requires both ours and theirs; choose a side for a deletion');
  return { take, stage, action: 'resolved', base: stages[1] ?? Buffer.alloc(0), ours: stages[2], theirs: stages[3] };
}

/** IO shell: git returns Buffers; argv arrays and literal pathspecs keep filenames out of shell syntax. */
export function resolveConflicts({ dir = process.cwd(), files = [], take, argumentError }, io = {}) {
  const git = io.git ?? ((args, cwd) => execFileSync('git', ['--literal-pathspecs', ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] }));
  const logPath = io.logPath ?? process.env.WE_RESOLVE_CONFLICT_LOG ?? join(homedir(), '.claude', 'conveyor', 'resolve-conflict.log.jsonl');
  const result = { ok: false, dir, take, files: [], loggedTo: null };
  try {
    if (argumentError) throw new Error(argumentError);
    dir = git(['rev-parse', '--show-toplevel'], dir).toString().trim(); result.dir = dir;
    if (!isLaneClonePath(dir)) throw new Error(`Refusing non-lane clone: ${dir}`);
    try { git(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], dir); } catch { throw new Error('No merge in progress (MERGE_HEAD missing)'); }
    if (!files.length) throw new Error('At least one --file is required');
    const plans = [...new Set(files)].map((file) => {
      validateFile(file);
      // Never follow a working-tree symlink outside the lane, including symlink parents.
      let path = dir;
      for (const part of file.split('/')) {
        path = join(path, part);
        try { if (lstatSync(path).isSymbolicLink()) throw new Error(`Refusing symlink path: ${file}`); }
        catch (e) { if (e.code !== 'ENOENT') throw e; }
      }
      const entries = git(['ls-files', '-u', '-z', '--', file], dir).toString();
      if (!entries) throw new Error(`File is not unmerged: ${file}`);
      const stages = {};
      for (const entry of entries.split('\0').filter(Boolean)) {
        const match = /^(\d+) [a-f0-9]+ ([123])\t(.*)$/s.exec(entry);
        if (!match || match[3] !== file || !['100644', '100755'].includes(match[1])) throw new Error(`Unsupported conflict path or mode: ${file}`);
        stages[match[2]] = git(['show', `:${match[2]}:${file}`], dir);
      }
      return { file, ...planResolution({ take, stages }) };
    });
    for (const plan of plans) {
      const target = join(dir, plan.file);
      if (plan.action === 'deleted') {
        git(['rm', '--cached', '-q', '--', plan.file], dir); rmSync(target, { force: true });
      } else {
        let content = plan.content;
        if (take === 'union') {
          const temp = mkdtempSync(join(tmpdir(), 'we-conflict-'));
          try {
            for (const side of ['ours', 'base', 'theirs']) writeFileSync(join(temp, side), plan[side]);
            content = git(['merge-file', '-p', '--union', ...['ours', 'base', 'theirs'].map((s) => join(temp, s))], dir);
          } finally { rmSync(temp, { recursive: true, force: true }); }
        }
        mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, content);
        git(['add', '--', plan.file], dir);
      }
      result.files.push({ file: plan.file, take, stage: plan.stage, action: plan.action });
    }
    result.ok = true;
  } catch (e) { result.reason = e.message; }
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, `${JSON.stringify({ ts: new Date().toISOString(), ...result, requestedFiles: files, session: process.env.LANE_SESSION ?? null })}\n`);
    result.loggedTo = logPath;
  } catch { /* Evidence is best-effort, never a second failure. */ }
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let options;
  try { options = parseArgs(process.argv.slice(2)); }
  catch (e) { options = { files: [], take: undefined }; options.argumentError = e.message; }
  const result = resolveConflicts(options);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) { process.stderr.write(`${result.reason}\n`); process.exitCode = 2; }
}
