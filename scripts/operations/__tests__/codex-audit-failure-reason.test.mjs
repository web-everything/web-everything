import { describe, expect, it, vi } from 'vitest';
import { main } from '../codex-audit.mjs';
import { createAuditDeps as createIo } from '../codex-audit-io.mjs';

const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const fakeFs = () => ({
  mkdtempSync: vi.fn(() => '/scratch/x'), copyFileSync: vi.fn(), writeFileSync: vi.fn(), rmSync: vi.fn(),
});
const make = codexResult => {
  const spawnSync = vi.fn(command => command === 'git' ? { status: 0, stdout: '.git/index\n' } : codexResult);
  return createIo({ cwd: '/repo', home: '/h', scratchRoot: '/scratch', fs: fakeFs(), spawnSync });
};
const reasonOf = fn => { try { fn(); } catch (e) { return String(e.message); } return 'NO THROW'; };

describe('audit failure reasons (never a bare failure, never a pass)', () => {
  it('names a maxBuffer overflow', () => {
    const d = make({ error: Object.assign(new Error('spawnSync ENOBUFS'), { code: 'ENOBUFS' }), status: null, stdout: '' });
    expect(reasonOf(() => d.runCodex('p'))).toMatch(/overflow/i);
  });
  it('names a timeout', () => {
    const d = make({ error: Object.assign(new Error('spawnSync ETIMEDOUT'), { code: 'ETIMEDOUT' }), status: null, signal: 'SIGTERM', stdout: '' });
    expect(reasonOf(() => d.runCodex('p'))).toMatch(/timeout/i);
  });
  it('names a non-zero exit code', () => {
    const d = make({ status: 7, stdout: '' });
    expect(reasonOf(() => d.runCodex('p'))).toMatch(/exit code 7/);
  });
  it('names a missing report', () => {
    const d = make({ status: 0, stdout: 'not json' });
    expect(reasonOf(() => d.runCodex('p'))).toMatch(/report/i);
  });
  it('names a codex failure inside the report', () => {
    const d = make({ status: 0, stdout: JSON.stringify({ exitCode: 1, timedOut: false, lastMessage: 'x' }) });
    expect(reasonOf(() => d.runCodex('p'))).toMatch(/codex exit code 1/i);
  });
  it('names a codex timeout inside the report', () => {
    const d = make({ status: 0, stdout: JSON.stringify({ exitCode: 0, timedOut: true, lastMessage: 'x' }) });
    expect(reasonOf(() => d.runCodex('p'))).toMatch(/codex timed out/i);
  });
  it('names a missing final message', () => {
    const d = make({ status: 0, stdout: JSON.stringify({ exitCode: 0, timedOut: false }) });
    expect(reasonOf(() => d.runCodex('p'))).toMatch(/final message/i);
  });
  it('main prints the specific reason, exits 3, records nothing, for a missing verdict line', async () => {
    const errors = [];
    const deps = { resolveSha: async r => r === 'x' ? BASE : HEAD, runCodex: async () => 'I looked at it.\nLooks fine.',
      appendRecord: vi.fn(), now: () => 't', stdout: vi.fn(), stderr: t => errors.push(t) };
    expect(await main(['--base=x', `--head=${HEAD}`], deps)).toBe(3);
    expect(errors.join('')).toMatch(/UNPARSEABLE.*no verdict line/);
    expect(deps.appendRecord).not.toHaveBeenCalled();
  });
  it('main prints the io reason from a thrown runCodex', async () => {
    const errors = [];
    const deps = { resolveSha: async r => r === 'x' ? BASE : HEAD, runCodex: async () => { throw new Error('overflow: output exceeded maxBuffer'); },
      appendRecord: vi.fn(), now: () => 't', stdout: vi.fn(), stderr: t => errors.push(t) };
    expect(await main(['--base=x', `--head=${HEAD}`], deps)).toBe(3);
    expect(errors.join('')).toMatch(/UNPARSEABLE.*overflow/);
    expect(deps.appendRecord).not.toHaveBeenCalled();
  });
  it('main prints deps-missing and exits 3 when the io module cannot load', async () => {
    const errors = [];
    const code = await main(['--base=x', `--head=${HEAD}`], undefined, { loadDeps: async () => { throw Object.assign(new Error("Cannot find package 'markdown-it'"), { code: 'ERR_MODULE_NOT_FOUND' }); }, stderr: t => errors.push(t) });
    expect(code).toBe(3);
    expect(errors.join('')).toMatch(/UNPARSEABLE audit \(deps-missing: run npm ci\)/);
  });
  it('uses exactly a 32 MB buffer for the codex launcher run (max and min)', () => {
    const spawnSync = vi.fn(command => command === 'git' ? { status: 0, stdout: '.git/index\n' } : { status: 0, stdout: JSON.stringify({ exitCode: 0, timedOut: false, lastMessage: 'NOT WEAKENED' }) });
    createIo({ cwd: '/repo', home: '/h', scratchRoot: '/s', fs: fakeFs(), spawnSync }).runCodex('p');
    expect(spawnSync.mock.calls[1][2].maxBuffer).toBe(32 * 1024 * 1024);
  });
});
