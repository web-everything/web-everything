/** @file Real Git/Codex and JSONL persistence adapters for the standalone audit. */
import { netDiffFingerprint } from '../lib/net-diff-fingerprint.mjs';
import { withLedgerAppendLock } from '../lib/ledger-append-lock.mjs';
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

/** The launcher streams JSONL before its final (potentially pretty-printed) JSON report. */
function readReport(stdout) {
  const text = String(stdout ?? '');
  for (const match of text.matchAll(/^\{/gm)) {
    try { return JSON.parse(text.slice(match.index)); } catch { /* A streamed event is not the final report. */ }
  }
  throw new Error(`codex report missing (no parseable JSON report in ${text.length} bytes of output)`);
}

/**
 * All filesystem and subprocess effects are injectable; no shell interprets refs or prompts.
 * Run the op from a trusted checkout's script path against the audited repo as cwd.
 */
export function createAuditDeps({ cwd = process.cwd(), home = homedir(),
  scratchRoot = tmpdir(), fs = realFs, spawnSync = realSpawnSync,
  launcherPath = fileURLToPath(new NodeURL('../codex-direct-task.mjs', import.meta.url)) } = {}) {
  const run = (command, args, timeout, env, maxBuffer = 8 * 1024 * 1024) => {
    const result = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer, timeout, ...(env ? { env } : {}) });
    const name = command === process.execPath ? 'codex launcher' : command;
    if (result.error) {
      const code = result.error.code;
      if (code === 'ENOBUFS') throw new Error(`${name}: output overflow (exceeded maxBuffer ${maxBuffer} bytes)`);
      if (code === 'ETIMEDOUT') throw new Error(`${name}: timeout after ${timeout} ms`);
      throw new Error(`${name}: spawn error ${code ?? result.error.message}`);
    }
    if (result.status !== 0) throw new Error(`${name}: exit code ${result.status}${result.signal ? ` (signal ${result.signal})` : ''}`);
    return result.stdout;
  };
  const recordPath = () => resolveAuditRecordPath(readAuditSettings((p, enc) => fs.readFileSync(p, enc)), { home, cwd });
  const readJsonl = path => {
    let text;
    try { text = fs.readFileSync(path, 'utf8'); }
    catch (error) { if (error?.code === 'ENOENT') return []; throw error; }
    return text.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line));
  };
  const remoteHeads = pattern => run('git', ['ls-remote', '--heads', 'origin', pattern], 30_000)
    .trim().split('\n').filter(Boolean).map(line => {
      const match = /^([a-fA-F0-9]{40})\t(refs\/heads\/[^\s]+)$/.exec(line);
      if (!match) throw new Error('unreadable remote heads');
      return { sha: match[1], branch: match[2].slice('refs/heads/'.length) };
    });
  return {
    branchTip(branch) {
      const name = branch.replace(/^refs\/heads\//, '');
      const matches = remoteHeads(`refs/heads/${name}`).filter(entry => entry.branch === name);
      return matches.length === 1 ? matches[0].sha : null;
    },
    findBranch(head) {
      const matches = remoteHeads('refs/heads/lane/*').filter(entry => entry.sha === head);
      return matches.length === 1 ? matches[0].branch : null;
    },
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    nowMs: () => Date.now(),
    readRecords: () => readJsonl(recordPath()),
    isAncestor(basis, head) {
      if (basis === head) return false;
      const result = spawnSync('git', ['merge-base', '--is-ancestor', basis, head],
        { cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 30_000 });
      if (result.error || (result.status !== 0 && result.status !== 1)) throw new Error('ancestry unavailable');
      return result.status === 0;
    },
    diffFiles: (basis, head) => run('git', ['diff', '--name-only', '--no-renames', '-z', `${basis}..${head}`, '--'], 30_000)
      .split('\0').filter(Boolean),
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
          { ...process.env, GIT_INDEX_FILE: scratchIndex }, 32 * 1024 * 1024));
        if (!report) throw new Error('codex report missing');
        if (report.timedOut !== false) throw new Error('codex timed out');
        if (report.exitCode !== 0) throw new Error(`codex exit code ${report.exitCode}`);
        if (typeof report.lastMessage !== 'string') throw new Error('codex final message missing');
        return report.lastMessage;
      } finally {
        fs.rmSync(scratch, { recursive: true, force: true });
      }
    },
    appendRecord(record) {
      const path = recordPath();
      fs.mkdirSync(dirname(path), { recursive: true });
      fs.appendFileSync(path, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
    },
    escalate({ ref, head, streak, questionHash }) {
      const path = join(dirname(recordPath()), 'audit-nonconvergence.jsonl');
      // A constant key in the queue's directory serialises every writer, including path aliases.
      return withLedgerAppendLock('audit-nonconvergence', () => {
        const records = readJsonl(path);
        if (records.some(record => record.ref === ref && record.questionHash === questionHash)) return;
        fs.appendFileSync(path, `${JSON.stringify({ at: new Date().toISOString(), ref, head, streak, questionHash, kind: 'design-pass-request' })}\n`, { encoding: 'utf8', mode: 0o600 });
      }, { dir: dirname(path), waitMs: 30_000 });
    },
    now: () => new Date().toISOString(),
    stdout: text => process.stdout.write(text),
    stderr: text => process.stderr.write(text),
  };
}
