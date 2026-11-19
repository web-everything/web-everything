// @vitest-environment node
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveMechanicalCarrySetting } from '../human-clearance-mechanical-carry-setting.mjs';

const dirs = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const missing = () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); };
function options(platform) {
  const dir = mkdtempSync(join(tmpdir(), 'mechanical-carry-')); dirs.push(dir);
  const file = join(dir, 'platform.json');
  writeFileSync(file, JSON.stringify({ humanClearance: platform ?? {} }));
  return { env: { WE_PLATFORM_PREFERENCES_FILE: file }, readFile: missing, log: () => {} };
}
describe('R711 mechanical carry setting', () => {
  it('defaults to refuse without env or tool file', () => {
    expect(resolveMechanicalCarrySetting(options())).toEqual({ value: 'refuse', source: 'standard' });
  });
  it('env sets trust-drain-record and reports source env', () => {
    const o = options(); o.env.WE_HUMAN_CLEARANCE_MECHANICAL_CARRY = 'trust-drain-record';
    expect(resolveMechanicalCarrySetting(o)).toEqual({ value: 'trust-drain-record', source: 'env' });
  });
  it('reads the tool file key', () => {
    expect(resolveMechanicalCarrySetting({ ...options(), file: 'injected.json', readFile: file => {
      expect(file).toBe('injected.json'); return '{"humanClearance":{"mechanicalCarry":"trust-drain-record"}}';
    } })).toEqual({ value: 'trust-drain-record', source: 'tool' });
  });
  it.each(['', 'typo', false, null])('invalid %s fails closed even over a permissive platform', value => {
    const o = options({ mechanicalCarry: 'trust-drain-record' });
    expect(resolveMechanicalCarrySetting({ ...o, tool: { mechanicalCarry: value } })).toMatchObject({ value: 'refuse', source: expect.stringContaining('fail-closed') });
    o.env.WE_HUMAN_CLEARANCE_MECHANICAL_CARRY = value;
    expect(resolveMechanicalCarrySetting(o).value).toBe('refuse');
  });
  it('unreadable and malformed tool files fail closed', () => {
    for (const readFile of [() => { throw Error('denied'); }, () => '{']) {
      expect(resolveMechanicalCarrySetting({ ...options({ mechanicalCarry: 'trust-drain-record' }), readFile })).toMatchObject({ value: 'refuse', source: expect.stringContaining('fail-closed') });
    }
  });
  it('precedence is env over tool over platform over standard', () => {
    const o = options({ mechanicalCarry: 'trust-drain-record' });
    expect(resolveMechanicalCarrySetting(o)).toEqual({ value: 'trust-drain-record', source: 'platform' });
    expect(resolveMechanicalCarrySetting({ ...o, tool: { mechanicalCarry: 'refuse' } })).toEqual({ value: 'refuse', source: 'tool' });
    o.env.WE_HUMAN_CLEARANCE_MECHANICAL_CARRY = 'trust-drain-record';
    expect(resolveMechanicalCarrySetting({ ...o, tool: { mechanicalCarry: 'refuse' } })).toEqual({ value: 'trust-drain-record', source: 'env' });
  });
  it('a valid env override takes precedence over invalid or unreadable tool evidence', () => {
    const o = options(); o.env.WE_HUMAN_CLEARANCE_MECHANICAL_CARRY = 'trust-drain-record';
    for (const extra of [{ tool: { mechanicalCarry: 'typo' } }, { readFile: () => { throw Error('denied'); } }]) {
      expect(resolveMechanicalCarrySetting({ ...o, ...extra })).toEqual({ value: 'trust-drain-record', source: 'env' });
    }
  });
  it('an invalid platform setting falls back to refuse', () => {
    expect(resolveMechanicalCarrySetting(options({ mechanicalCarry: 'typo' }))).toMatchObject({ value: 'refuse', source: expect.stringContaining('fail-closed') });
  });
  it('logs the effective value and source once per distinct setting', () => {
    const log = vi.fn(), o = { ...options(), log, tool: { mechanicalCarry: 'trust-drain-record' } };
    resolveMechanicalCarrySetting(o); resolveMechanicalCarrySetting(o);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('policy · humanClearance.mechanicalCarry=trust-drain-record (tool)\n');
  });
});
