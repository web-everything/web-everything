/** @file Real Git/Codex and JSONL persistence adapters for the standalone audit. */
import { readCardFromMain } from './audit-verdict.mjs';
import { cardHash } from './audit-base-repro.mjs';
import { resolveAuditSettings } from '../lib/audit-settings.mjs';
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
  cardsPath = join(home, 'workspace/.operations/handoff/cards-to-file.md'),
  indexPath = join(home, 'workspace/.operations/coordination/pre-existing-findings.jsonl'),
  shadowPath = join(home, 'workspace/.operations/coordination/pre-existing-shadow.jsonl'),
  settingsOptions = {},
  launcherPath = fileURLToPath(new NodeURL('../codex-direct-task.mjs', import.meta.url)) } = {}) {
  const run = (command, args, timeout, env) => {
    const result = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout, ...(env ? { env } : {}) });
    if (result.error || result.status !== 0) throw new Error('audit subprocess failed or exceeded its bound');
    return result.stdout;
  };
  let settings;
  const auditSettings = () => {
    if (!settings) {
      settings = resolveAuditSettings({ fileRead: fs.readFileSync, ...settingsOptions,
        log: message => process.stderr.write(`${message}\n`) });
      for (const name of ['preExistingMode', 'preExistingShadow', 'baseRecheckMax', 'releaseStage', 'requirePayBy', 'requireOnMain']) process.stderr.write(`audit.${name}=${settings.value[name]} source=${settings.sources[name]}\n`);
    }
    return settings;
  };
  const deps = {
    auditPolicy: () => {
      const { releaseStage, requirePayBy, requireOnMain } = auditSettings().value;
      return { releaseStage, requirePayBy, requireOnMain };
    },
    readCard: path => readCardFromMain(path, { run: spawnSync }),
    preExistingMode: () => auditSettings().value.preExistingMode,
    preExistingShadow: () => auditSettings().value.preExistingShadow,
    shadowProof(row) {
      fs.mkdirSync(dirname(shadowPath), { recursive: true });
      fs.appendFileSync(shadowPath, `${JSON.stringify(row)}\n`, { encoding: 'utf8', mode: 0o600 });
    },
    baseRecheckMax: () => auditSettings().value.baseRecheckMax,
    protectedPaths: () => [...auditSettings().value.raceBlockPaths, ...auditSettings().value.guardFloorPaths],
    readBaseFile: (path, base) => run('git', ['show', `${base}:${path}`], 30_000),
    readHeadFile: (path, head) => run('git', ['show', `${head}:${path}`], 30_000),
    diffText: (base, head) => run('git', ['diff', '-U0', `${base}...${head}`], 30_000),
    numstatText: (base, head) => run('git', ['diff', '--numstat', `${base}...${head}`], 30_000),
    async reproOnBase(question, findings, base) {
      const scratch = fs.mkdtempSync(join(scratchRoot, 'audit-base-'));
      const worktree = join(scratch, 'tree');
      try {
        run('git', ['worktree', 'add', '--detach', worktree, base], 30_000);
        return await deps.runCodex(question, worktree);
      } finally {
        try { run('git', ['worktree', 'remove', '--force', worktree], 30_000); }
        finally { fs.rmSync(scratch, { recursive: true, force: true }); }
      }
    },
    fileCard({ key, cardLine: freshCardLine, expedite, needsYou }) {
      const read = path => {
        try { return fs.readFileSync(path, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; return ''; }
      };
      const rows = read(indexPath).split('\n').filter(Boolean).map(l => JSON.parse(l));
      const prior = rows.findLast(r => r.key === key);
      let contents = read(cardsPath), lines = contents.split('\n');
      // The card line carries a timestamp: ignore it when comparing, keep the live line for an unchanged finding and base,
      // and rewrite that line in place when the base or finding evidence changed (one card per key, never stale evidence).
      const live = prior && lines.find(actual => cardHash(actual) === prior.cardLineHash);
      const untimed = line => line.replace(/^(- \[R1053\]) .*? ET:/, '$1 ET:');
      const cardLine = live && untimed(live) === untimed(freshCardLine) ? live : freshCardLine;
      if (live && cardLine !== live) {
        contents = lines.map(actual => (actual === live ? cardLine : actual)).join('\n');
        fs.writeFileSync(cardsPath, contents, { encoding: 'utf8', mode: 0o600 });
        lines = contents.split('\n');
      }
      const date = new Date().toLocaleString('en-CA', { timeZone: 'America/New_York', hour12: false });
      const cls = key.split('|').at(-1);
      const security = /^B[1-7]$/.test(cls);
      if (security && (expedite !== true || needsYou !== true)) throw new Error('security escalation required');
      const receipt = security ? { written: true, expedite: true, needsYou: true } : true;
      const securityLine = line => typeof line === 'string' && line.startsWith('- [R1053][needs-you] ')
        && line.endsWith(` ET: security pre-existing (${cls}) ${key}`);
      const needsYouLine = expedite && needsYou ? (securityLine(prior?.needsYouLine) && prior.needsYouHash === cardHash(prior.needsYouLine)
        ? prior.needsYouLine : lines.find(securityLine) || `- [R1053][needs-you] ${date} ET: security pre-existing (${cls}) ${key}`) : null;
      const expected = [cardLine, ...(needsYouLine ? [needsYouLine] : [])];
      const missing = expected.filter(line => !lines.some(actual => cardHash(actual) === cardHash(line)));
      if (missing.length) {
        fs.mkdirSync(dirname(cardsPath), { recursive: true });
        fs.appendFileSync(cardsPath, `${contents && !contents.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 });
      }
      const verified = read(cardsPath).split('\n');
      if (!expected.every(line => verified.some(actual => cardHash(actual) === cardHash(line)))) throw new Error('card persistence verification failed');
      const row = { key, cardHash: cardHash(key), cardLineHash: cardHash(cardLine),
        ...(needsYouLine ? { needsYouLine, needsYouHash: cardHash(needsYouLine) } : {}) };
      if (!missing.length && prior && Object.entries(row).every(([k, v]) => prior[k] === v)) return receipt;
      fs.mkdirSync(dirname(indexPath), { recursive: true });
      fs.appendFileSync(indexPath, `${JSON.stringify(row)}\n`, { encoding: 'utf8', mode: 0o600 });
      if (!read(indexPath).split('\n').includes(JSON.stringify(row))) throw new Error('card index verification failed');
      return receipt;
    },
    fingerprint: (base, head) => netDiffFingerprint(cwd, base, head),
    resolveSha: ref => run('git', ['rev-parse', '--verify', `${ref}^{commit}`], 30_000).trim(),
    runCodex(prompt, dir = cwd) {
      const scratch = fs.mkdtempSync(join(scratchRoot, 'codex-audit-'));
      try {
        const indexPath = resolve(dir, run('git', [...(dir === cwd ? [] : ['-C', dir]), 'rev-parse', '--git-path', 'index'], 30_000).trim());
        const scratchIndex = join(scratch, 'index');
        try { fs.copyFileSync(indexPath, scratchIndex); }
        catch (error) {
          if (error.code !== 'ENOENT') throw error;
          // Git initializes a missing index; a zero-byte file is not a valid index.
        }
        const taskFile = join(scratch, 'task.md');
        fs.writeFileSync(taskFile, prompt, { encoding: 'utf8', mode: 0o600 });
        const report = readReport(run(process.execPath, [launcherPath, '--review', '--json',
          '--gate=none', `--task-file=${taskFile}`, `--dir=${dir}`], 30 * 60_000,
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
  return deps;
}
