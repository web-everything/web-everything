/** @file Real Git/Codex and JSONL persistence adapters for the standalone audit. */
import { laneGitHardeningEnv, laneHistoryProofEnv, scrubInheritedGitEnv } from '../lib/lane-git-hardening.mjs';
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
  let settings;
  try { settings = JSON.parse(readFile(AUDIT_SETTINGS_PATH, 'utf8')); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; return {}; }
  // A JSON null/array/scalar is malformed for writer and gate alike, never a silent default.
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('audit settings malformed');
  return settings;
}

/** Resolve the audit record path exactly as appendRecord writes it: `~` = home, relative = the audited cwd. */
export function resolveAuditRecordPath(settings, { home, cwd }) {
  const configured = settings?.auditRecordPath ?? DEFAULT_RECORD_PATH;
  if (typeof configured !== 'string' || !configured.trim()) throw new Error('invalid auditRecordPath');
  return configured.startsWith('~/') ? join(home, configured.slice(2))
    : configured === '~' ? home : resolve(cwd, configured);
}

/** Separate convergence evidence from every full-audit consumer, even for a non-jsonl setting. */
export function resolveConvergeRecordPath(settings, context) {
  const path = resolveAuditRecordPath(settings, context);
  return path.endsWith('.jsonl') ? path.slice(0, -6) + '-converge.jsonl' : path + '-converge.jsonl';
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
  const recordPath = () => resolveAuditRecordPath(readAuditSettings((p, enc) => fs.readFileSync(p, enc)), { home, cwd });
  const convergeRecordPath = () => resolveConvergeRecordPath(readAuditSettings((p, enc) => fs.readFileSync(p, enc)), { home, cwd });
  return {
    recordPath, convergeRecordPath,
    readRecords(path) {
      let contents;
      try { contents = fs.readFileSync(path, 'utf8'); }
      catch (error) { if (error?.code === 'ENOENT') return []; throw error; }
      return contents.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line));
    },
    refsPointingAt: head => run('git', ['for-each-ref', `--points-at=${head}`, '--format=%(refname:short)', 'refs/remotes/origin/'], 30_000, laneHistoryProofEnv())
      .split(/\r?\n/).filter(Boolean).map(ref => ref.replace(/^origin\//, '')),
    isShallow() {
      const value = run('git', ['rev-parse', '--is-shallow-repository'], 30_000, laneHistoryProofEnv()).trim();
      if (!['true', 'false'].includes(value)) throw new Error('audit shallow status unavailable');
      return value === 'true';
    },
    remoteMainSha() {
      const env = laneGitHardeningEnv(scrubInheritedGitEnv(), { remoteProbe: true });
      // These transport overrides are not removed by the shared helper.
      delete env.GIT_SSH_VARIANT;
      delete env.GIT_PROXY_COMMAND;
      const output = run('git', ['ls-remote', 'origin', 'refs/heads/main'], 30_000, env);
      const match = /^([0-9a-fA-F]{40})\trefs\/heads\/main\r?\n?$/.exec(output);
      if (!match || match[0] !== output) throw new Error('audit remote main unavailable');
      return match[1].toLowerCase();
    },
    hasCommit(sha) {
      run('git', ['--no-replace-objects', 'cat-file', '-e', `${sha}^{commit}`], 30_000,
        laneHistoryProofEnv());
      return true;
    },
    isAncestor(prior, head) {
      const result = spawnSync('git', ['--no-replace-objects', 'merge-base', '--is-ancestor', prior, head], {
        cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 30_000,
        env: laneHistoryProofEnv(),
      });
      if (result.error || ![0, 1].includes(result.status)) throw new Error('audit ancestry unavailable');
      return result.status === 0;
    },
    fingerprint: (base, head) => netDiffFingerprint(cwd, base, head),
    resolveSha: ref => run('git', ['rev-parse', '--verify', `${ref}^{commit}`], 30_000, laneHistoryProofEnv()).trim(),
    runCodex(prompt) {
      const scratch = fs.mkdtempSync(join(scratchRoot, 'codex-audit-'));
      try {
        const indexPath = resolve(cwd, run('git', ['rev-parse', '--git-path', 'index'], 30_000, laneHistoryProofEnv()).trim());
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
          { ...laneHistoryProofEnv(), GIT_INDEX_FILE: scratchIndex }));
        if (!report || report.exitCode !== 0 || report.timedOut !== false || typeof report.lastMessage !== 'string') {
          throw new Error('Codex failed or returned incomplete evidence');
        }
        return report.lastMessage;
      } finally {
        fs.rmSync(scratch, { recursive: true, force: true });
      }
    },
    appendRecord(record, path = recordPath()) {
      if (record.mode === 'converge') path = convergeRecordPath();
      fs.mkdirSync(dirname(path), { recursive: true });
      fs.appendFileSync(path, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
    },
    now: () => new Date().toISOString(),
    stdout: text => process.stdout.write(text),
    stderr: text => process.stderr.write(text),
  };
}
