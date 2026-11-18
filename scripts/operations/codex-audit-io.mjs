/** @file Real Git/Codex and JSONL persistence adapters for the standalone audit. */
import { netDiffFingerprint } from '../lib/net-diff-fingerprint.mjs';
import * as realFs from 'node:fs';
import { spawnSync as realSpawnSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, URL as NodeURL } from 'node:url';

const DEFAULT_RECORD_PATH = '~/workspace/.operations/coordination/audits.jsonl';
/**
 * The one settings file the audit writer reads: beside THIS script, never the audited checkout's own.
 * node:url's URL, not the global (a DOM test environment replaces the global with a non-file URL).
 */
export const AUDIT_SETTINGS_PATH = fileURLToPath(new NodeURL('../settings/prototype-load.json', import.meta.url));

/**
 * Read the writer's settings (absent file = {}, unreadable/malformed throws). Shared by the writer and
 * the open-PR gate so both resolve the same audit record file for any audited checkout (#7011).
 */
export function readAuditSettings(readFile = realFs.readFileSync) {
  try { return JSON.parse(readFile(AUDIT_SETTINGS_PATH, 'utf8')); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; return {}; }
}

/** Resolve the audit record path exactly as appendRecord writes it: `~` = home, relative = the audited cwd. */
export function resolveAuditRecordPath(settings, { home, cwd }) {
  const configured = settings?.auditRecordPath ?? DEFAULT_RECORD_PATH;
  if (typeof configured !== 'string' || !configured.trim()) throw new Error('invalid auditRecordPath');
  return configured.startsWith('~/') ? join(home, configured.slice(2))
    : configured === '~' ? home : resolve(cwd, configured);
}

/** The launcher streams JSONL before its final (potentially pretty-printed) JSON report. */
function readReport(stdout) {
  const text = String(stdout ?? '');
  for (const match of text.matchAll(/^\{/gm)) {
    try { return JSON.parse(text.slice(match.index)); } catch { /* A streamed event is not the final report. */ }
  }
  throw new Error('missing JSON report');
}

/**
 * All filesystem and subprocess effects are injectable; no shell interprets refs or prompts.
 * Run the op from a trusted checkout's script path against the audited repo as cwd.
 */
export function createAuditDeps({ cwd = process.cwd(), home = homedir(),
  scratchRoot = tmpdir(), fs = realFs, spawnSync = realSpawnSync,
  launcherPath = fileURLToPath(new NodeURL('../codex-direct-task.mjs', import.meta.url)) } = {}) {
  const run = (command, args, timeout, env) => {
    const result = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout, ...(env ? { env } : {}) });
    if (result.error || result.status !== 0) throw new Error('audit subprocess failed or exceeded its bound');
    return result.stdout;
  };
  return {
    fingerprint: (base, head) => netDiffFingerprint(cwd, base, head),
    resolveSha: ref => run('git', ['rev-parse', '--verify', `${ref}^{commit}`], 30_000).trim(),
    runCodex(prompt) {
      const scratch = fs.mkdtempSync(join(scratchRoot, 'codex-audit-'));
      try {
        const indexPath = resolve(cwd, run('git', ['rev-parse', '--git-path', 'index'], 30_000).trim());
        const scratchIndex = join(scratch, 'index');
        try { fs.copyFileSync(indexPath, scratchIndex); }
        catch (error) {
          if (error.code !== 'ENOENT') throw error;
          // Git initializes a missing index; a zero-byte file is not a valid index.
        }
        const taskFile = join(scratch, 'task.md');
        fs.writeFileSync(taskFile, prompt, { encoding: 'utf8', mode: 0o600 });
        const report = readReport(run(process.execPath, [launcherPath, '--review', '--json',
          '--gate=none', `--task-file=${taskFile}`, `--dir=${cwd}`], 30 * 60_000,
          { ...process.env, GIT_INDEX_FILE: scratchIndex }));
        if (!report || report.exitCode !== 0 || report.timedOut !== false || typeof report.lastMessage !== 'string') {
          throw new Error('Codex failed or returned incomplete evidence');
        }
        return report.lastMessage;
      } finally {
        fs.rmSync(scratch, { recursive: true, force: true });
      }
    },
    appendRecord(record) {
      const path = resolveAuditRecordPath(readAuditSettings((p, enc) => fs.readFileSync(p, enc)), { home, cwd });
      fs.mkdirSync(dirname(path), { recursive: true });
      fs.appendFileSync(path, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
    },
    now: () => new Date().toISOString(),
    stdout: text => process.stdout.write(text),
    stderr: text => process.stderr.write(text),
  };
}
