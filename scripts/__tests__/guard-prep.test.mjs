import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { decide, runHook } from '../guard-prep.mjs';

const prompt = 'Build the feature and open-pr';
const event = (text = prompt, subagent_type = 'worker') => ({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { prompt: text, subagent_type } });
const prep = '\nPREP:\nAcceptance: visible outcome\nPre-mortem: missing events\nFiles: scripts/example.mjs\nTests: focused unit tests';
const here = dirname(fileURLToPath(import.meta.url));
const guard = join(here, '..', 'guard-prep.mjs');

describe('guard-prep', () => {
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
  it('allows complete prep and a reasoned waiver', () => {
    expect(decide(event(prompt + prep))).toBeNull();
    expect(decide(event(prompt + '\nprep: waived — urgent incident'))).toBeNull();
  });
  it.each(['', 'TODO', '........'])('denies empty/placeholder heading %j', (text) => {
    expect(decide(event(prompt + prep.replace('visible outcome', text)))).not.toBeNull();
  });
  it.each(['resolve the conflict', 're-run CI', 'red-team', 'review this PR', 'read-only', 'file a backlog card', 'card-only'])('allows exemption even without PREP: %s', (text) => {
    expect(decide(event(`${prompt}; ${text}`))).toBeNull();
  });
  it.each(['Explore', 'Plan', 'claude-code-guide', 'statusline-setup'])('allows read-only type %s', (type) => {
    expect(decide(event(prompt, type))).toBeNull();
  });
  it.each(['Inspect source and open-pr', 'Build locally', 'Review implementation'])('allows non-build-publication prompt %s', (text) => {
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
  it('allows waiver and writes an audit line through the boundary', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prep-hook-'));
    try {
      const logPath = join(dir, 'events.log'); const output = [];
      runHook({ read: () => JSON.stringify(event(prompt + '\nprep: waived — urgent incident')), logPath, stdout: (text) => output.push(text) });
      expect(output).toEqual([]);
      expect(JSON.parse(readFileSync(logPath, 'utf8'))).toMatchObject({ kind: 'waiver', detail: 'urgent incident' });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it.each(['malformed stdin', 'throwing decide'])('fails OPEN and logs on %s in a Node process', (mode) => {
    const dir = mkdtempSync(join(tmpdir(), 'prep-error-'));
    try {
      const logPath = join(dir, 'events.log');
      const args = mode === 'malformed stdin' ? [guard] : ['--input-type=module', '-e',
        `import { runHook } from ${JSON.stringify(pathToFileURL(guard).href)}; runHook({ read: () => '{}', decide: () => { throw new Error('injected failure'); }, logPath: process.argv[1] });`, logPath];
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
