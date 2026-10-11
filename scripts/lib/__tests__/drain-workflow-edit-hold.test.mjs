import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decideDrainWorkflowEditHold as decide, resolveDrainWorkflowEditHuman } from '../drain-workflow-edit-hold.mjs';

const headSha = 'a'.repeat(40);
const base = { files: ['.github/workflows/x.yml'], filesComplete: true, headSha };
describe('workflow human-only decision', () => {
  it.each(['.github/workflows/x.yml', '.github/workflows/x.yaml', '.github/actions/check/action.yml'])('holds %s without exact-head clearance', (path) => {
    expect(decide({ ...base, files: [path] })).toMatchObject({ hold: true, reason: expect.stringContaining('human-only:') });
  });
  it('off restores the old behavior even for unreadable files', () => {
    expect(decide({ setting: 'off' })).toEqual({ hold: false });
  });
  it.each([null, undefined, []])('holds incomplete/unknown files even with clearance (%s)', (files) => {
    expect(decide({ ...base, files, filesComplete: false, humanClearedSha: headSha })).toMatchObject({ hold: true, defer: true });
  });
  it('holds malformed entries', () => {
    expect(decide({ ...base, files: [{}] })).toMatchObject({ hold: true, defer: true });
  });
  it('holds an old head clearance and accepts exact head case-insensitively', () => {
    expect(decide({ ...base, humanClearedSha: 'b'.repeat(40) }).hold).toBe(true);
    expect(decide({ ...base, humanClearedSha: headSha.toUpperCase() })).toEqual({ hold: false });
  });
  it('does not mistake two missing SHAs for a clearance', () => {
    expect(decide({ ...base, headSha: null, humanClearedSha: null }).hold).toBe(true);
  });
  it('allows non-workflow docs, config, data and code', () => {
    expect(decide({ ...base, files: ['AGENTS.md', 'package.json', 'src/_data/plugs.json', 'scripts/check.mjs'] })).toEqual({ hold: false });
  });
  it('uses the shared renamed-from path rule', () => {
    expect(decide({ ...base, files: [{ filename: 'old.txt', previous_filename: '.github/workflows/x.yml' }] }).hold).toBe(true);
  });
});

const dirs = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
describe('workflow setting cascade', () => {
  it('resolves default → platform → tool → env with the winning source', () => {
    const dir = mkdtempSync(join(tmpdir(), 'workflow-hold-')); dirs.push(dir);
    const file = join(dir, 'tool.json');
    const platform = join(dir, 'platform.json');
    const env = { WE_PLATFORM_PREFERENCES_FILE: platform, WE_POLICY_CASCADE_LOG: '0' };
    const resolve = () => resolveDrainWorkflowEditHuman({ env, file });
    expect(resolve()).toEqual({ value: 'on', source: 'default' });
    writeFileSync(platform, JSON.stringify({ drainWorkflowEditHuman: 'off' }));
    expect(resolve()).toEqual({ value: 'off', source: 'platform' });
    writeFileSync(file, JSON.stringify({ drainWorkflowEditHuman: 'on' }));
    expect(resolve()).toEqual({ value: 'on', source: 'settings' });
    env.WE_DRAIN_WORKFLOW_EDIT_HUMAN = ' OFF ';
    expect(resolve()).toEqual({ value: 'off', source: 'env' });
    env.WE_DRAIN_WORKFLOW_EDIT_HUMAN = 'invalid';
    expect(resolve()).toEqual({ value: 'on', source: 'settings' });
    writeFileSync(file, '{');
    expect(resolve()).toEqual({ value: 'off', source: 'platform' });
    writeFileSync(file, JSON.stringify({ drainWorkflowEditHuman: 'invalid' }));
    writeFileSync(platform, '{');
    expect(resolve()).toEqual({ value: 'on', source: 'default' });
  });
});
