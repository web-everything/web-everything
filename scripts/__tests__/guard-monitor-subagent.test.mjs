import { pinnedFixture } from '../hooks/__tests__/pinned-fixture.mjs';
/** Pure decisions and the real stdin/JSON boundary of PreToolUse(Monitor). */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decide } from '../guard-monitor-subagent.mjs';

const event = { hook_event_name: 'PreToolUse', tool_name: 'Monitor', agent_id: 'agent-1', tool_input: {} };

describe('guard-monitor-subagent — pure decision', () => {
  it('denies a subagent Monitor call, with foreground guidance', () => {
    const output = decide(event).hookSpecificOutput;
    expect(output.hookEventName).toBe('PreToolUse');
    expect(output.permissionDecision).toBe('deny');
    expect(output.permissionDecisionReason).toMatch(/does not ensure a completion notification will reach you/);
    expect(output.permissionDecisionReason).toMatch(/root CLAUDE\.md/);
    expect(output.permissionDecisionReason).toMatch(/synchronous foreground command within this turn/);
    expect(output.permissionDecisionReason).toContain('until <condition>; do sleep N; done');
  });
  it.each(['auto', 'bypassPermissions', 'dontAsk'])('denies unattended subagent Monitor synchronously in %s mode', (permission_mode) => {
    // A deny needs no human answer and resolves immediately; ask can silently allow in headless
    // mode or leave a background subagent waiting for someone who is not watching its prompt.
    // This proves the local decision, not the upstream harness's handling of permission modes.
    expect(decide({ ...event, permission_mode }).hookSpecificOutput.permissionDecision).toBe('deny');
  });
  it.each([undefined, null, '', false, 1, {}])('allows absent or invalid subagent identity: %j', (agent_id) => {
    expect(decide({ ...event, agent_id })).toBeNull();
  });
  it.each(['Stop', 'SubagentStop', 'PostToolUse', undefined])('ignores other events: %s', (hook_event_name) => {
    expect(decide({ ...event, hook_event_name })).toBeNull();
  });
  it.each(['Bash', 'Agent', 'Task', undefined])('ignores other tools: %s', (tool_name) => {
    expect(decide({ ...event, tool_name })).toBeNull();
  });
  it.each([undefined, null, {}, [], 'bad'])('fails open on an invalid envelope: %j', (input) => {
    expect(decide(input)).toBeNull();
  });
});

describe('guard-monitor-subagent — CLI and hook wiring', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const guard = join(here, '..', 'guard-monitor-subagent.mjs');
  const run = (input) => spawnSync(process.execPath, [guard], { input, encoding: 'utf8' });
  it('emits one deny decision with exit 0 for a subagent Monitor', () => {
    const output = run(JSON.stringify(event));
    expect(output.status).toBe(0);
    expect(output.stderr).toBe('');
    expect(JSON.parse(output.stdout)).toEqual(decide(event));
    expect(JSON.parse(output.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
  });
  it.each([
    { hook_event_name: 'PreToolUse', tool_name: 'Monitor' },
    { ...event, hook_event_name: 'SubagentStop' },
    { ...event, tool_name: 'Bash' },
    null,
  ])('silently allows main-session Monitor and irrelevant envelopes: %j', (input) => {
    const output = run(JSON.stringify(input));
    expect(output.status).toBe(0);
    expect(output.stdout).toBe('');
    expect(output.stderr).toBe('');
  });
  it.each(['', '{broken'])('fails open on malformed stdin: %j', (input) => {
    const output = run(input);
    expect(output.status).toBe(0);
    expect(output.stdout).toBe('');
    expect(output.stderr).toBe('');
  });
  it('wires the Monitor matcher alongside the existing Bash guard', () => {
    const settings = JSON.parse(readFileSync(join(here, '../../.claude/settings.json'), 'utf8'));
    const f = pinnedFixture();
    try {
      const hook = settings.hooks.PreToolUse.find(entry => entry.matcher === 'Monitor').hooks[0];
      const output = f.command(f.lane, hook.command, event);
      expect(output.status, output.stderr).toBe(0);
      expect(JSON.parse(output.stdout)).toEqual(decide(event));
    } finally { f.cleanup(); }
    for (const [matcher, script] of [['Monitor', 'guard-monitor-subagent'], ['Bash', 'guard-bash']]) {
      expect(settings.hooks.PreToolUse.find((entry) => entry.matcher === matcher).hooks).toContainEqual({
        type: 'command', command: expect.stringContaining(`node "$launcher" scripts/${script}.mjs; code=$?`),
      });
    }
  });
});
