import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
const transport = vi.hoisted(() => ({ remote: '', calls: [], fail: false, shallow: false }));
vi.mock('node:child_process', async original => {
  const cp = await original();
  const execFileSync = vi.fn((file, args, opts) => {
    transport.calls.push({ args, opts });
    if (args.includes('fetch')) {
      if (transport.fail) throw new Error('fixture-fetch-failed');
      args = args.map(a => a === 'https://github.com/fixture/repo.git' ? transport.remote : a);
    }
    if (transport.shallow && args.includes('--is-shallow-repository')) return 'true\n';
    try { return cp.execFileSync(file, args, opts); }
    catch (error) { throw new Error(`${args.join(' ')}: ${String(error.stderr ?? error.message)}`); }
  });
  return { ...cp, execFileSync, default: { ...cp.default, execFileSync } };
});
import { execFileSync } from 'node:child_process';
let chain, root, base, head, aiHead, allOids;
const git = args => String(execFileSync('git', args, { cwd: root, encoding: 'utf8', timeout: 5000,
  maxBuffer: 16 * 1024 * 1024, env: { PATH: process.env.PATH, HOME: root, TMPDIR: root, GIT_ALLOW_PROTOCOL: 'file', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } })).trim();
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'head-chain-writer-')); transport.remote = join(root, 'origin.git');
  git(['init', '--bare', transport.remote]);
  const stanza = (ref, mark, parent, message) => `commit refs/heads/${ref}\nmark :${mark}\ncommitter Fixture <fixture@example.test> 1700000000 +0000\ndata ${Buffer.byteLength(message)}\n${message}\n${parent ? `from :${parent}\n` : ''}\n`;
  let input = stanza('main', 1, null, 'base\n');
  for (let i = 1; i <= 150; i++) input += stanza('lane/fixture', i + 1, i, `Implement ${i}\n\n${i === 120 ? '' : 'Co-Authored-By: Claude <noreply@anthropic.com>\n'}`);
  for (let i = 1; i <= 150; i++) input += stanza('lane/ai', i + 151, i === 1 ? 1 : i + 150, `Implement ${i}\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n`);
  execFileSync('git', ['--git-dir', transport.remote, 'fast-import', '--quiet'], { cwd: root, input, encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024,
    env: { PATH: process.env.PATH, HOME: root, TMPDIR: root, GIT_ALLOW_PROTOCOL: 'file', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
  base = git(['--git-dir', transport.remote, 'rev-parse', 'main']);
  head = git(['--git-dir', transport.remote, 'rev-parse', 'lane/fixture']);
  aiHead = git(['--git-dir', transport.remote, 'rev-parse', 'lane/ai']);
  allOids = git(['--git-dir', transport.remote, 'rev-list', `${base}..${head}`]).split('\n');
});
afterAll(() => rmSync(root, { recursive: true, force: true }));
beforeEach(async () => {
  transport.calls = []; transport.fail = false; transport.shallow = false;
  vi.resetModules(); chain = await import('../pr-head-chain.mjs');
});

function record(over = {}, extra = {}) {
  const rows = [], alerts = [], warnings = [];
  const result = chain.recordPrHead({ repo: 'fixture/repo', pr: 1, headRef: 'lane/fixture', headSha: head,
    parentSha: null, baseRef: 'main', cwd: root, source: 'fix-run', ...over }, {
    env: { PATH: process.env.PATH, HOME: root, TMPDIR: root, GIT_ALLOW_PROTOCOL: 'file' }, scratchRoot: root, now: () => 1_700_000_000_000,
    append: row => { rows.push(row); return { ok: true }; }, alert: row => alerts.push(row), warn: row => warnings.push(row), ...extra,
  });
  return { result, rows, alerts, warnings };
}
describe('PR-HEAD-CHAIN-RECORD: writer', () => {
  it('records all 150 commits, the human at 120 and the sorted history digest', () => {
    const r = record();
    expect(r.result.ok, r.warnings.join('\n')).toBe(true);
    expect(r.rows[0]).toMatchObject({ authorship: 'human', baseSha: base, commits: { count: 150,
      digest: `sha256:${createHash('sha256').update(allOids.sort().join('\n')).digest('hex')}` } });
    expect(r.rows[0].commits.nonAi).toHaveLength(1);
    expect(chain.commitFacts(allOids.map(oid => ({ oid }))).commits.digest)
      .toBe(chain.commitFacts([...allOids].reverse().map(oid => ({ oid }))).commits.digest);
    expect(transport.calls.find(c => c.args.includes('fetch')).args).toContain('+refs/heads/main:refs/remotes/origin/main');
  });
  it('all AI commits and mechanical-only ranges use the shared rubric', () => {
    expect(record({ headSha: aiHead, headRef: 'lane/ai' }).rows[0].authorship).toBe('ai');
    expect(chain.commitFacts([{ oid: head, messageHeadline: "Merge branch 'main'", messageBody: '' }]).authorship).toBe('none');
  });
  it.each([['git-graft-file', 'GIT_GRAFT_FILE'], ['git-shallow-file', 'GIT_SHALLOW_FILE']])('inherited-%s-cannot-hide-human-commit', (_name, variable) => {
    const path = join(root, variable); writeFileSync(path, `${head}${variable === 'GIT_GRAFT_FILE' ? ` ${base}` : ''}\n`);
    const r = record({}, { env: { PATH: process.env.PATH, HOME: root, TMPDIR: root, GIT_ALLOW_PROTOCOL: 'file', [variable]: path, GIT_DIR: transport.remote, GIT_EXEC_PATH: '/invalid' } });
    expect(r.rows[0].authorship).toBe('human'); expect(r.rows[0].commits.count).toBe(150);
    for (const c of transport.calls) expect(c.opts.env[variable]).toBeUndefined();
  });
  it('malicious lane-local configuration is never read', () => {
    const lane = join(root, 'lane'); mkdirSync(join(lane, '.git'), { recursive: true });
    writeFileSync(join(lane, '.git', 'config'), '[include]\npath = /does-not-exist\n[core]\nsshCommand = false\n');
    expect(record({ cwd: lane }).rows[0].authorship).toBe('human');
    expect(transport.calls.every(c => c.opts.cwd !== lane)).toBe(true);
  });
  it.each(['fetch-failure', 'shallow-history'])('%s records a miss without throwing', failure => {
    transport.fail = failure === 'fetch-failure'; transport.shallow = failure === 'shallow-history';
    const r = record(); expect(r.result.ok).toBe(false); expect(r.rows).toEqual([]);
    expect(r.alerts[0]).toMatchObject({ kind: 'record-miss' }); expect(r.warnings[0]).toContain('head-chain: record-miss');
  });
});
