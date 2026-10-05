/**
 * Daily archive of old done/stopped/failed Claude jobs: rename direct child directories only, never delete.
 * Defaults: ~/.claude/jobs -> ~/.claude/jobs-archive/<America/New_York date>. Never move active/unknown
 * jobs or symlinks, overwrite a destination, nest the archive under jobs, or touch ~/.claude/projects
 * transcripts (including resolved aliases). Only jobsRoot is listed; only its direct children are moved.
 * Config keys: claudeJobsArchiveEnabled, claudeJobsArchiveEveryMs, claudeJobsArchiveOlderThanMs,
 * claudeJobsArchiveMaxMovesPerRun, claudeJobsArchiveTimeBudgetMs. Env wins: WE_CLAUDE_JOBS_ARCHIVE=0
 * disables, WE_CLAUDE_JOBS_ARCHIVE_AGE_DAYS sets nonnegative age, WE_CLAUDE_JOBS_ARCHIVE_MAX_PER_RUN
 * sets a nonnegative integer cap. Invalid overrides fall back to config/defaults.
 * NO archive retention for now: the archive keeps everything; pruning is a separate future card.
 * Session reaper: its only job-id-keyed state is ~/.claude/we-session-reaper/reaped.json, pruned each
 * pass to ids still listed by `claude agents --all`, so archived ids drop out on their own. Its
 * chat-spawn/chat-ended stores are keyed by session uuid and consulted only for listed sessions;
 * dispatch-scratch folders for unlisted sessions are already swept as "unregistered". Nothing follows the move.
 */
import * as nodeFs from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, dirname, basename, sep } from 'node:path';
import { CLAUDE_JOBS_ARCHIVE_DEFAULTS as defaults } from './claude-jobs-archive-config.mjs';

const knob = (value, fallback, integer = false) => typeof value === 'number' && Number.isFinite(value)
  && value >= 0 && (!integer || Number.isInteger(value)) ? value : fallback;
const envNumber = (value) => typeof value === 'string' && value.trim() ? Number(value) : NaN;
const inside = (path, root) => path === root || path.startsWith(root + sep);
// Resolve existing ancestors too, so a not-yet-created archive cannot hide under a symlink alias.
function physicalPath(path, fs) {
  try { return fs.realpathSync(path); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(physicalPath(parent, fs), basename(path));
  }
}
function guard(jobsRoot, archiveRoot, fs) {
  const jobs = physicalPath(jobsRoot, fs); const archive = physicalPath(archiveRoot, fs);
  const projects = (path) => path.split(sep).some((part, i, parts) => part === 'projects' && parts[i - 1] === '.claude');
  if (inside(archiveRoot, jobsRoot) || inside(archive, jobs) || [jobsRoot, archiveRoot, jobs, archive].some(projects)) {
    throw Error('claude-jobs-archive: unsafe jobs/archive path (nested archive or Claude projects)');
  }
}

export function archiveClaudeJobs({
  jobsRoot = join(homedir(), '.claude', 'jobs'), archiveRoot = join(homedir(), '.claude', 'jobs-archive'),
  olderThanMs: ageOpt, maxMoves: capOpt, timeBudgetMs: budgetOpt, now = Date.now(),
  dryRun = false, env = process.env, fs = nodeFs, log = () => {},
} = {}) {
  const started = Date.now();
  jobsRoot = resolve(jobsRoot); archiveRoot = resolve(archiveRoot);
  guard(jobsRoot, archiveRoot, fs);
  const olderThanMs = knob(envNumber(env.WE_CLAUDE_JOBS_ARCHIVE_AGE_DAYS) * 86400000, knob(ageOpt, defaults.claudeJobsArchiveOlderThanMs));
  const maxMoves = knob(envNumber(env.WE_CLAUDE_JOBS_ARCHIVE_MAX_PER_RUN), knob(capOpt, defaults.claudeJobsArchiveMaxMovesPerRun, true), true);
  const timeBudgetMs = knob(budgetOpt, defaults.claudeJobsArchiveTimeBudgetMs);
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const archiveDir = join(archiveRoot, date);
  guard(jobsRoot, archiveDir, fs);
  const result = { listed: 0, eligible: 0, moved: 0, young: 0, active: 0, noState: 0, unparsable: 0,
    collisions: 0, errors: 0, complete: true, disabled: env.WE_CLAUDE_JOBS_ARCHIVE === '0', dryRun, archiveDir, durationMs: 0 };
  const names = result.disabled ? [] : fs.readdirSync(jobsRoot).sort();
  result.listed = names.length;
  for (const name of names) {
    if (result.moved >= maxMoves || Date.now() - started >= timeBudgetMs) { result.complete = false; break; }
    try {
      const src = join(jobsRoot, name); const stat = fs.lstatSync(src);
      if (stat.isSymbolicLink() || !stat.isDirectory()) continue;
      const statePath = join(src, 'state.json');
      let raw, mtimeMs;
      try { raw = fs.readFileSync(statePath, 'utf8'); mtimeMs = fs.statSync(statePath).mtimeMs; }
      catch { result.noState++; continue; }
      let state;
      try { state = JSON.parse(raw); } catch { result.unparsable++; continue; }
      if (!['done', 'stopped', 'failed'].includes(state?.state)) { result.active++; continue; }
      if (!(now - mtimeMs >= olderThanMs)) { result.young++; continue; }
      result.eligible++;
      const dest = join(archiveDir, name);
      try { fs.lstatSync(dest); result.collisions++; continue; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (Date.now() - started >= timeBudgetMs) { result.complete = false; break; }
      if (!dryRun) { fs.mkdirSync(archiveDir, { recursive: true }); fs.renameSync(src, dest); }
      result.moved++;
    } catch { result.errors++; }
  }
  result.durationMs = Date.now() - started;
  log(formatClaudeJobsArchiveLine(result));
  return result;
}

export function formatClaudeJobsArchiveLine(result) {
  return `${result.dryRun ? '[dry-run] ' : ''}claude-jobs-archive: moved ${result.moved}/${result.eligible} eligible to ${result.archiveDir} (listed ${result.listed}, young ${result.young}, active ${result.active}, no-state ${result.noState}, unparsable ${result.unparsable}, collisions ${result.collisions}, errors ${result.errors}) in ${result.durationMs}ms, ${result.disabled ? 'disabled, ' : ''}${result.complete ? 'complete' : 'incomplete'}`;
}
