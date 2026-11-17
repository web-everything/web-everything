import { afterAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderNoPromptCommandRules } from '../lib/no-prompt-command-rules.mjs';
import { applyContextPack, briefWithContextPack } from '../conveyor/fix-context-pack.mjs';
import { readFixBriefTemplate } from '../conveyor/reconcile-fix-dispatch.mjs';
import { readCiHealBriefTemplate } from '../operations/ci-heal-pr-dispatch.mjs';
import { runFixCli } from '../operations/fix-run.mjs';
const root = mkdtempSync(join(tmpdir(), 'no-prompt-empty-task-'));
const templates = join(root, 'skills-src/conveyor');
mkdirSync(templates, { recursive: true });
afterAll(() => rmSync(root, { recursive: true, force: true }));

const EMPTY = ['', ' ', '\t', '\n', '\r', '\r\n', ' \t\r\n'];
const settings = { contextPack: true, contextMaxBytes: 10000, contextLines: 20, localTests: 'proof-only' };

describe('task content is checked before generic instructions can mask it', () => {
  it.each(EMPTY)('shared renderer refuses empty or whitespace-only task %j', task => {
    expect(() => renderNoPromptCommandRules(task, 'fix')).toThrow(/empty task content/);
  });

  it.each(EMPTY)('applyContextPack refuses %j before tests instructions or evidence', task => {
    for (const contextPack of [false, true]) {
      expect(() => applyContextPack(task, { settings: { ...settings, contextPack }, inputs: {} })).toThrow(/empty task content/);
    }
  });

  it.each(EMPTY)('briefWithContextPack refuses %j before reads and outside its fallback catch', task => {
    const readInputs = vi.fn(() => ({ findings: [{ body: 'Some context' }] }));
    expect(() => briefWithContextPack(task, { settings, readInputs })).toThrow(/empty task content/);
    expect(readInputs).not.toHaveBeenCalled();
    expect(() => briefWithContextPack(task)).toThrow(/empty task content/);
  });

  describe.each([
    ['fix', 'fix-agent-brief.md', readFixBriefTemplate],
    ['ci-heal', 'fix-agent-ci-brief.md', readCiHealBriefTemplate],
  ])('%s template reader', (_kind, file, read) => {
    it.each(EMPTY)('refuses %j before packing or build requirements', task => {
      writeFileSync(join(templates, file), task);
      const pack = vi.fn(() => 'Generic packed context.');
      expect(() => read(root, pack)).toThrow(/empty task content/);
      expect(pack).not.toHaveBeenCalled();
    });
    it.each(EMPTY)('refuses a packer that erases valid task content to %j', packed => {
      writeFileSync(join(templates, file), 'Repair the specific failing test.');
      expect(() => read(root, () => packed)).toThrow(/empty task content/);
    });
  });

  it.each(EMPTY)('borrowed fix refuses %j before PR reads, context and provider resolution', async task => {
    const run = vi.fn(), resolveProvider = vi.fn(), releaseClaim = vi.fn(), recordOutcome = vi.fn();
    const writeErr = vi.fn();
    const result = await runFixCli(['--pr=7', '--session=fix-7', '--ref=lane/7-x', `--prompt-file=${join(root, 'task.md')}`, '--provider=codex', '--repo=fixture/repo', `--lane-repo=${root}`], {
      readPrompt: () => task, removePrompt: vi.fn(), pendingRearm: {}, run, resolveProvider,
      releaseClaim, recordOutcome, recordRouted: vi.fn(), appendLoopRow: vi.fn(),
      weRoot: root, write: vi.fn(), writeErr,
    });
    expect(result.code).toBe(1);
    expect(writeErr.mock.calls.flat().join(' ')).toMatch(/empty task content/);
    expect(run).not.toHaveBeenCalled();
    expect(resolveProvider).not.toHaveBeenCalled();
    expect(releaseClaim).toHaveBeenCalledOnce();
  });

});
