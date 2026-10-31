import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { decide, runHook } from '../guard-prep.mjs';
import * as prepBlock from '../lib/prep-block.mjs';

const prompt = 'Build the feature and open-pr';
const event = (text = prompt, subagent_type = 'worker') => ({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { prompt: text, subagent_type } });
const prep = '\nPREP:\nAcceptance: visible outcome\nPre-mortem: missing events\nFiles: scripts/example.mjs\nTests: focused unit tests';
const here = dirname(fileURLToPath(import.meta.url));
const guard = join(here, '..', 'guard-prep.mjs');

describe('guard-prep', () => {
  it.each(['Build locally', 'Fix the parser bug', 'Implement retry logic and commit'])('denies build/fix dispatch without publication wording: %s', (text) => {
    expect(decide(event(text))?.hookSpecificOutput.permissionDecision).toBe('deny');
  });
  it.each(['read-only', 'jury', 'merge conflict', 're-run', 'card-only workflow'])('denies a bare exemption label before a build: %s', (text) => {
    expect(decide(event(`${text}\nImplement X and open-pr`))?.hookSpecificOutput.permissionDecision).toBe('deny');
  });
  it.each([' Explore ', 'PLAN', ' CLAUDE-CODE-GUIDE '])('allows read-only types regardless of case and whitespace: %s', (type) => {
    expect(decide(event(prompt, type))).toBeNull();
  });
  it('denies build publication without prep with format and waiver guidance', () => {
    expect(decide(event())).toMatchObject({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: expect.stringContaining('prep: waived — <reason>') } });
  });
  it.each(['build and open-pr', 'implement and push', 'add and make a pull request', 'fix and open PR', 'refactor and push', 'write and open-pr'])('gates build/publication wording %s', (text) => {
    expect(decide(event(text))).not.toBeNull();
  });
  it.each(['worker', 'Worker ', 'WORKER', ' CODEX-RUNNER ', 'GENERAL-PURPOSE', '', '   ', null])('normalizes and gates type %j', (type) => {
    expect(decide(event(prompt, type))?.hookSpecificOutput.permissionDecision).toBe('deny');
  });
  it('gates an omitted type and the legacy Task tool', () => {
    const input = event(); delete input.tool_input.subagent_type;
    expect(decide(input)).not.toBeNull();
    expect(decide({ ...input, tool_name: 'Task' })).not.toBeNull();
  });
  it.each(['fork', ' FORK ', 'statusline-setup', 'custom-writer', 42, {}])('requires prep for writable or unknown type %j', (type) => {
    for (const tool_name of ['Agent', 'Task']) {
      expect(decide({ ...event(prompt, type), tool_name })?.hookSpecificOutput.permissionDecision).toBe('deny');
      expect(decide({ ...event(prompt + prep, type), tool_name })).toBeNull();
    }
  });
  it('allows complete prep and a reasoned waiver', () => {
    expect(decide(event(prompt + prep))).toBeNull();
    expect(decide(event(prompt + '\nprep: waived — urgent incident'))).toBeNull();
  });
  it.each(['', 'TODO', '........'])('denies empty/placeholder heading %j', (text) => {
    expect(decide(event(prompt + prep.replace('visible outcome', text)))).not.toBeNull();
  });
  it.each(['resolve the conflict', 'resolve conflict', 'rebase onto main', 're-run CI', 'rerun CI', 'retrigger CI', 'red-team the PR', 'redteam this PR', 'review the PR', 'review this PR', 'code review', 'file a backlog card', 'file the item', 'card-only'])('allows explicit exempt task without PREP, but denies a build mentioning it: %s', (text) => {
    expect(decide(event(`${text}. Fix and open-pr`))).toBeNull();
    expect(decide(event(`${prompt}; ${text}`))?.hookSpecificOutput.permissionDecision).toBe('deny');
  });
  it.each(['implement', 'build', 'add', 'fix', 'refactor', 'write'])('denies %s with an incidental exemption', (verb) => {
    expect(decide(event(`${verb} code review guard and open-pr`))?.hookSpecificOutput.permissionDecision).toBe('deny');
  });
  it.each(['fix merge conflict', 'resolve merge conflict', 're-run CI', 'retrigger CI', 'file a backlog card', 'review the PR'])('allows leading exempt task with build words in the same sentence: %s', (task) => {
    expect(decide(event(`${task}; inspect the fix and open-pr`))).toBeNull();
  });
  it.each(['merge conflict', 're-run checks', 'retrigger', 'red-team', 'redteam', 'jury', 'read-only', 'do not edit', 'no code changes'])('denies same-sentence build outside the task allowlist: %s', (text) => {
    expect(decide(event(`${text}; fix and open-pr`))?.hookSpecificOutput.permissionDecision).toBe('deny');
  });
  it.each(['implement X, rerun the tests, then open-pr', 'implement X, re-run the tests, then open-pr',
    'build X, rerun the tests, then open-pr', 'add a jury guard, then open-pr'])('denies short mixed build/rerun task: %s', (text) => {
    expect(decide(event(text))?.hookSpecificOutput.permissionDecision).toBe('deny');
  });
  it.each(['. ', '! ', '? ', '\n', '\r\n'])('ignores exemption after the first sentence/line (%j)', (separator) => {
    expect(decide(event(`Fix and open-pr${separator}jury`))?.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(decide(event(`jury${separator}Fix and open-pr`))?.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(decide(event(`review the PR${separator}Fix and open-pr`))).toBeNull();
  });
  it('uses the first 240 trimmed characters and provides prep/waiver guidance beyond the bound', () => {
    expect(decide(event(`  \nreview the PR${' '.repeat(240)}\nFix and open-pr`))).toBeNull();
    for (const length of [240, 20_000]) {
      expect(decide(event(`${'Task '.padEnd(length)}jury\nFix and open-pr`))).toMatchObject({
        hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: expect.stringContaining('prep: waived — <reason>') },
      });
    }
  });
  it.each(['Explore', 'Plan', 'claude-code-guide'])('allows read-only type %s', (type) => {
    expect(decide(event(prompt, type))).toBeNull();
  });
  it.each(['Inspect source and open-pr', 'Review implementation'])('allows non-build prompt %s', (text) => {
    expect(decide(event(text))).toBeNull();
  });
  it.each([null, {}, { ...event(), tool_name: 'Bash' }, { ...event(), hook_event_name: 'PostToolUse' }])('ignores unrelated envelope %j', (input) => {
    expect(decide(input)).toBeNull();
  });
  it('emits the deny JSON via real stdin', () => {
    const output = spawnSync(process.execPath, [guard], { input: JSON.stringify(event()), encoding: 'utf8' });
    expect(output.status).toBe(0);
    expect(JSON.parse(output.stdout)).toEqual(decide(event()));
    expect(output.stderr).toBe('');
  });
  it('denies a tool-bearing fork via real stdin', () => {
    const output = spawnSync(process.execPath, [guard], {
      input: JSON.stringify(event(prompt, 'fork')), encoding: 'utf8', timeout: 10_000,
    });
    expect(output.status).toBe(0);
    expect(output.stdout).not.toBe('');
    expect(JSON.parse(output.stdout)).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
    expect(output.stderr).toBe('');
  });
  it('allows waiver and writes an audit line through the boundary using one verdict and applicability check', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prep-hook-'));
    try {
      const logPath = join(dir, 'events.log'); const output = [];
      const originalVerdict = prepBlock.prepVerdict;
      const verdict = vi.spyOn(prepBlock, 'prepVerdict').mockImplementationOnce(originalVerdict)
        .mockImplementation(() => { throw new Error('verdict computed twice'); });
      const exemption = vi.spyOn(prepBlock, 'isPrepExempt');
      try {
        runHook({ read: () => JSON.stringify(event(prompt + '\nprep: waived — urgent incident')), logPath, stdout: (text) => output.push(text) });
        expect(output).toEqual([]);
        expect(JSON.parse(readFileSync(logPath, 'utf8'))).toMatchObject({ kind: 'waiver', detail: 'urgent incident' });
        expect(verdict.mock.calls).toEqual([[prompt + '\nprep: waived — urgent incident']]);
        expect(exemption).toHaveBeenCalledOnce();
      } finally { verdict.mockRestore(); exemption.mockRestore(); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it.each(['malformed stdin', 'throwing evaluator'])('fails OPEN and logs on %s in a Node process', (mode) => {
    const dir = mkdtempSync(join(tmpdir(), 'prep-error-'));
    try {
      const logPath = join(dir, 'events.log');
      const args = mode === 'malformed stdin' ? [guard] : ['--input-type=module', '-e',
        `import { runHook } from ${JSON.stringify(pathToFileURL(guard).href)}; runHook({ read: () => '{}', evaluate: () => { throw new Error('injected failure'); }, logPath: process.argv[1] });`, logPath];
      const output = spawnSync(process.execPath, args, { input: '{broken', encoding: 'utf8', env: { ...process.env, HOME: dir } });
      expect(output.status).toBe(0); expect(output.stdout).toBe('');
      expect(output.stderr).toMatch(/WARNING.*failing open/);
      const file = mode === 'malformed stdin' ? join(dir, 'workspace', '.operations', 'prep-gate.log') : logPath;
      expect(JSON.parse(readFileSync(file, 'utf8')).kind).toBe('hook-error');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('registers Agent and Task in settings', () => {
    const settings = JSON.parse(readFileSync(join(here, '../../.claude/settings.json'), 'utf8'));
    expect(settings.hooks.PreToolUse.find((entry) => entry.matcher === 'Agent|Task').hooks)
      .toContainEqual({ type: 'command', command: 'node scripts/guard-prep.mjs' });
  });
});
