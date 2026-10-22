/**
 * Shared direct-worker checks: tests, independent read-only audit, then fresh scope evidence.
 * Unknown evidence rejects the diff so the caller can redispatch with the rejection brief.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { admittedArgv } from '../readiness/heavy-admission.mjs';
import { qualifyFile } from '../operations/free-scope.mjs';
import { isDocScopePath } from './dispatch-task-type.mjs';
import { healDiffWithinEnvelope, parseAuditVerdict, summarizeNumstat } from './probation-launcher.mjs';
import { PROVEN_TASK_ENVELOPES } from './provider-routing.mjs';
import { FENCED_DATA_RULE, fenceUntrusted } from './mandate-fence.mjs';

export { parseAuditVerdict };
export const AUDIT_QUESTION = 'Read-only audit. Does this diff weaken, delete, skip, or loosen any test, assertion, check, gate, guard or validation, or satisfy the brief only on the surface? Answer on the FIRST line with exactly `NOT WEAKENED` or `WEAKENED`, then give reasons.';
const TIMEOUT_MS = 20 * 60 * 1000;
const WE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** argv after node, shared by live launches and replay. PURE. */
export function auditArgv({ weRoot, dir, taskFile, timeoutMs = TIMEOUT_MS, model, effort }) {
  return [join(weRoot, 'scripts/codex-direct-task.mjs'), `--task-file=${taskFile}`, `--dir=${dir}`,
    '--review', '--json', '--no-stream', '--gate=none', `--timeout-ms=${timeoutMs}`, '--clear-rollout-after-run',
    ...(model ? [`--model=${model}`] : []), ...(effort ? [`--effort=${effort}`] : [])];
}

/** Empty or unreadable scope evidence never authorizes a path. PURE. */
export function scopeVerdict({ paths, scope, summary, envelope }) {
  try {
    if (!Array.isArray(scope) || !scope.length) return { ok: false, reason: 'declared scope is empty' };
    const entries = scope.map(entry => qualifyFile(entry));
    if (entries.some(e => !e || e.endsWith(':'))) return { ok: false, reason: 'declared scope is unreadable' };
    if (!Array.isArray(paths) || paths.some(p => typeof p !== 'string' || !p)) return { ok: false, reason: 'diff paths are unreadable' };
    const outside = paths.find(p => !entries.some(e => e.endsWith('/') ? qualifyFile(p).startsWith(e) : qualifyFile(p) === e));
    if (outside) return { ok: false, reason: `path outside declared scope: ${outside}` };
    if (envelope) {
      if (!summary || !Number.isFinite(summary.files) || !Number.isFinite(summary.loc)) return { ok: false, reason: 'diff summary is unreadable' };
      const fits = healDiffWithinEnvelope(summary, envelope);
      if (!fits.ok) return fits;
    }
    return { ok: true, reason: 'every path is within declared scope and envelope' };
  } catch { return { ok: false, reason: 'scope evidence is unreadable' }; }
}

/** Synchronous IO keeps the existing launcher contract; children have bounded output and time. */
export function realChecksIo({ preexisting = [], run = (file, args, dir, timeout = TIMEOUT_MS) => execFileSync(file, args, {
  cwd: dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout,
}) } = {}) {
  const git = (dir, args) => run('git', args, dir);
  const untracked = dir => git(dir, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(p => p && !preexisting.includes(p));
  const newFileDiff = (dir, path, stat = false) => {
    const args = ['diff', '--no-index', '--no-ext-diff', '--no-textconv', ...(stat ? ['--numstat', '-z'] : []), '--', '/dev/null', path];
    try { return git(dir, args); }
    catch (error) {
      // git diff --no-index exits 1 for a successfully read difference, never for a spawn/read error.
      if (error.status === 1 && typeof error.stdout === 'string') return error.stdout;
      throw error;
    }
  };
  return {
    diffPaths: (dir, base, preexisting) => {
      const tracked = git(dir, ['diff', '--name-only', '--no-renames', '-z', base, '--']).split('\0').filter(Boolean);
      return [...new Set([...tracked, ...untracked(dir)])].filter(p => !preexisting.includes(p));
    },
    diffText: (dir, base) => [git(dir, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', base, '--']),
      ...untracked(dir).map(path => newFileDiff(dir, path))].join('\n'),
    numstat: (dir, base) => git(dir, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--numstat', '-z', base, '--'])
      + untracked(dir).map(path => {
        const stat = newFileDiff(dir, path, true);
        const counts = /^(\d+|-)\t(\d+|-)\t/.exec(stat);
        if (!counts) throw new Error('unreadable new-file numstat');
        return `${counts[1]}\t${counts[2]}\t${path}\0`;
      }).join(''),
    runTests: (dir, paths) => {
      const { file, args } = admittedArgv('npx', ['vitest', 'related', '--run', ...paths]);
      try {
        run(file, args, dir);
        return { ok: true, reason: 'scoped tests passed' };
      } catch (error) {
        const output = [error.stdout, error.stderr].filter(value => value != null).map(String).join('\n');
        const reason = output.includes('No test files found') ? 'no tests cover the changed code' : 'scoped tests failed';
        return { ok: false, reason: `${reason}${output ? ` — ${output.slice(-1500)}` : ''}` };
      }
    },
    runAudit: (argv, dir) => {
      const report = JSON.parse(run(process.execPath, argv, dir));
      if (!report || report.exitCode !== 0 || report.timedOut !== false) {
        throw new Error('audit did not complete successfully');
      }
      return report.lastMessage;
    },
  };
}

/** Stop on the first refusal. All evidence reads, including the final re-read, fail closed. */
export function runPostRunChecks({ dir, base, brief, diffText, scope, preexisting = [], envelope = null, weRoot = WE_ROOT }, io = realChecksIo({ preexisting })) {
  const steps = [];
  const record = (gate, ok, reason) => {
    steps.push({ gate, ok, reason });
    return { accepted: ok, outcome: ok ? 'accepted' : `rejected:${gate}`, gate, reason, steps };
  };
  let paths;
  try { paths = io.diffPaths(dir, base, preexisting); if (!Array.isArray(paths) || paths.some(p => typeof p !== 'string' || !p)) throw new Error(); }
  catch { return record('scope', false, 'could not read diff paths'); }
  try {
    const codePaths = paths.filter(p => !isDocScopePath(p));
    const r = codePaths.length ? io.runTests(dir, codePaths) : { ok: true, reason: 'no code paths changed' };
    if (r?.ok !== true) return record('test', false, r?.reason || 'scoped tests failed');
    record('test', true, r.reason || 'scoped tests passed');
  } catch { return record('test', false, 'scoped tests failed or could not spawn'); }
  let material;
  try {
    material = diffText ?? io.diffText(dir, base);
    if (typeof material !== 'string') throw new Error();
  } catch { return record('scope', false, 'could not read diff text'); }
  let scratch;
  try {
    scratch = mkdtempSync(join(tmpdir(), 'direct-launch-audit-'));
    const taskFile = join(scratch, 'audit.md');
    writeFileSync(taskFile, [AUDIT_QUESTION, FENCED_DATA_RULE, fenceUntrusted('task', brief ?? ''), fenceUntrusted('material', material)].join('\n\n'), { mode: 0o600 });
    const verdict = parseAuditVerdict(io.runAudit(auditArgv({ weRoot, dir, taskFile }), dir));
    if (!verdict.approved) return record('audit', false, `${verdict.verdict}: ${verdict.reason}`);
    record('audit', true, verdict.reason);
  } catch { return record('audit', false, 'unreadable: audit failed or gave invalid JSON'); }
  finally { if (scratch) { try { rmSync(scratch, { recursive: true, force: true }); } catch { /* outside checkout */ } } }
  try {
    paths = io.diffPaths(dir, base, preexisting);
    const raw = io.numstat(dir, base);
    if (typeof raw !== 'string') throw new Error();
    const records = raw.split(raw.includes('\0') ? '\0' : '\n').filter(Boolean);
    if (records.some(line => !/^(\d+|-)\t(\d+|-)\t[\s\S]+$/.test(line))) throw new Error();
    const summary = summarizeNumstat(raw, { exclude: preexisting });
    // Untracked paths are absent from git numstat; count them too, and refuse an unknown line budget.
    const missing = paths.filter(p => !summary.paths.includes(p));
    if (envelope && missing.length) return record('scope', false, 'diff envelope lacks numstat evidence for new paths');
    const r = scopeVerdict({ paths, scope, summary, envelope });
    return record('scope', r.ok, r.reason);
  } catch { return record('scope', false, 'could not read diff scope evidence'); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let result;
  try {
    const flags = Object.fromEntries(process.argv.slice(2).map(a => { const i = a.indexOf('='); return i < 0 ? [a.slice(2), true] : [a.slice(2, i), a.slice(i + 1)]; }));
    if (!flags.dir || !flags.base || !flags['brief-file']) throw new Error();
    result = runPostRunChecks({ dir: flags.dir, base: flags.base, scope: String(flags.scope ?? '').split(',').filter(Boolean),
      brief: readFileSync(flags['brief-file'], 'utf8'), envelope: PROVEN_TASK_ENVELOPES[flags['task-type']] ?? null });
  } catch { result = { accepted: false, outcome: 'rejected:scope', gate: 'scope', reason: 'could not read replay inputs', steps: [] }; }
  const clean = s => s.replace(/[\x00-\x1f\x7f-\x9f]/g, '');
  console.log(process.argv.includes('--json') ? JSON.stringify(result) : clean(`post-run check: ${result.outcome} — ${result.reason}`));
  process.exitCode = result.accepted ? 0 : 1;
}
