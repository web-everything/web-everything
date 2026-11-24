/** A test-only descendant must retain the original ruled WEAKENED audit. */
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

function probe(gate, questionHash, { mkdtempSync, mkdirSync, writeFileSync, rmSync, tmpdir, join, exec }) {
  const repo = mkdtempSync(join(tmpdir(), 'waiver-carry-'));
  const env = { ...process.env, HOME: repo, WE_PLATFORM_PREFERENCES_FILE: join(repo, 'prefs.json'),
    GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_COMMON_DIR: undefined,
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  const git = (...args) => exec('git', ['-C', repo, ...args], { env, encoding: 'utf8', timeout: 5000 }).trim();
  const commit = parent => {
    git('add', '.');
    return git('commit-tree', git('write-tree'), ...(parent ? ['-p', parent] : []), '-m', 'fixture');
  };
  try {
    git('init', '-q');
    writeFileSync(join(repo, 'main.mjs'), 'export const value = 1;');
    const base = commit();
    writeFileSync(join(repo, 'main.mjs'), 'export const value = 2;');
    const waivedSha = commit(base);
    mkdirSync(join(repo, '__tests__'));
    writeFileSync(join(repo, '__tests__/value.test.mjs'), '// test-only descendant');
    const head = commit(waivedSha);
    git('update-ref', 'refs/remotes/origin/main', base);
    const record = { head: waivedSha, base, questionHash, at: '2026-11-24T00:00:00Z',
      verdict: 'WEAKENED', findings: ['guard removed'] };
    const readFile = path => {
      if (path.endsWith('/settings/prototype-load.json')) return JSON.stringify({ auditRecordPath: '~/audit.jsonl',
        ruledWeakened: [{ ref: 'lane/fixture', sha: waivedSha, ruling: 'R123', findings: record.findings }] });
      if (path === join(repo, 'audit.jsonl')) return JSON.stringify(record);
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    };
    return gate({ repo, ref: 'lane/fixture', sha: head, env, readFile,
      fetchMain: () => {}, liveFingerprint: () => null }).ok === true;
  } finally { rmSync(repo, { recursive: true, force: true }); }
}

export default {
  id: 'waiver-carry-test-only', title: 'a waived audit carries over a test-only descendant',
  card: 'WAIVER-CARRY-NOCODE',
  fixedBy: { sha: 'uncommitted', where: 'WAIVER-CARRY-NOCODE', paths: ['scripts/operations/canonical-audit-gate.mjs'] },
  fixPresent(root) {
    try {
      return execFileSync(process.execPath, ['--input-type=module', '-e', `
        import { pathToFileURL } from 'node:url';
        import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
        import { tmpdir } from 'node:os';
        import { join } from 'node:path';
        import { execFileSync as exec } from 'node:child_process';
        const { checkCanonicalAuditForOpen } = await import(pathToFileURL(process.argv[1]).href);
        const { QUESTION_HASH } = await import(pathToFileURL(process.argv[2]).href);
        process.stdout.write(JSON.stringify(await (${probe.toString()})(checkCanonicalAuditForOpen, QUESTION_HASH, { mkdtempSync, mkdirSync, writeFileSync, rmSync, tmpdir, join, exec })));
      `, resolve(root, 'scripts/operations/canonical-audit-gate.mjs'), resolve(root, 'scripts/operations/codex-audit.mjs')],
      { encoding: 'utf8', timeout: 15000, maxBuffer: 64 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim() === 'true';
    } catch { return false; }
  },
  async run() {
    const { checkCanonicalAuditForOpen } = await import('../../../operations/canonical-audit-gate.mjs');
    const { QUESTION_HASH } = await import('../../../operations/codex-audit.mjs');
    return { violations: probe(checkCanonicalAuditForOpen, QUESTION_HASH, { mkdtempSync, mkdirSync, writeFileSync, rmSync, tmpdir, join, exec: execFileSync }) ? [] : ['test-only waiver carry refused'] };
  },
  judge(report) { return report.violations; },
};
