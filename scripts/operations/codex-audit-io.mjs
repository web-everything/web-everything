/** @file Real Git/Codex and JSONL persistence adapters for the standalone audit. */
import * as realFs from 'node:fs';
import { spawnSync as realSpawnSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const DEFAULT_RECORD_PATH = '~/workspace/.operations/coordination/audits.jsonl';
const SETTINGS = new URL('../settings/prototype-load.json', import.meta.url);

/** The launcher streams JSONL before its final (potentially pretty-printed) JSON report. */
function readReport(stdout) {
  const text = String(stdout ?? '');
  for (const match of text.matchAll(/^\{/gm)) {
    try { return JSON.parse(text.slice(match.index)); } catch { /* A streamed event is not the final report. */ }
  }
  throw new Error('missing JSON report');
}

/** All filesystem and subprocess effects are injectable; no shell interprets refs or prompts. */
export function createAuditDeps({ cwd = process.cwd(), home = homedir(),
  scratchRoot = tmpdir(), fs = realFs, spawnSync = realSpawnSync } = {}) {
  const run = (command, args, timeout) => {
    const result = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout });
    if (result.error || result.status !== 0) throw new Error('audit subprocess failed or exceeded its bound');
    return result.stdout;
  };
  return {
    resolveSha: ref => run('git', ['rev-parse', '--verify', `${ref}^{commit}`], 30_000).trim(),
    runCodex(prompt) {
      const scratch = fs.mkdtempSync(join(scratchRoot, 'codex-audit-'));
      try {
        const taskFile = join(scratch, 'task.md');
        fs.writeFileSync(taskFile, prompt, { encoding: 'utf8', mode: 0o600 });
        const report = readReport(run(process.execPath, ['scripts/codex-direct-task.mjs', '--review', '--json',
          '--gate=none', `--task-file=${taskFile}`, `--dir=${cwd}`], 30 * 60_000));
        if (!report || report.exitCode !== 0 || report.timedOut !== false || typeof report.lastMessage !== 'string') {
          throw new Error('Codex failed or returned incomplete evidence');
        }
        return report.lastMessage;
      } finally {
        fs.rmSync(scratch, { recursive: true, force: true });
      }
    },
    appendRecord(record) {
      let settings;
      try { settings = JSON.parse(fs.readFileSync(SETTINGS, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; settings = {}; }
      const configured = settings.auditRecordPath ?? DEFAULT_RECORD_PATH;
      if (typeof configured !== 'string' || !configured.trim()) throw new Error('invalid auditRecordPath');
      const path = configured.startsWith('~/') ? join(home, configured.slice(2))
        : configured === '~' ? home : resolve(cwd, configured);
      fs.mkdirSync(dirname(path), { recursive: true });
      fs.appendFileSync(path, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
    },
    now: () => new Date().toISOString(),
    stdout: text => process.stdout.write(text),
    stderr: text => process.stderr.write(text),
  };
}
