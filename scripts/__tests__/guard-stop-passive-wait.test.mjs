import { pinnedFixture } from '../hooks/__tests__/pinned-fixture.mjs';
import { pinnedHookScript, pinnedStopHookScript } from '../lib/pinned-hook-command.mjs';
import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  MAX_TRANSCRIPT_BYTES, hasPassiveWaitLanguage, findUnresolvedBackgroundedBash, findAnyMonitorCall,
  shouldBlockStop, readTranscriptTail,
} from '../guard-stop-passive-wait.mjs';

const use = (name = 'Bash', input = { run_in_background: true }, id = 'call-1') => ({
  type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] },
});
const result = (id = 'call-1') => ({
  type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'done' }] },
});
const monitorStarted = (id = 'call-1') => ({
  type: 'user',
  message: { content: [{ type: 'tool_result', tool_use_id: id, content:
    'Monitor started (task ba59nqsob, timeout 600000ms). You will be notified on each event. Keep working — do not poll or sleep. Events may arrive while you are waiting for the user — an event is not their reply.' }] },
});
const passive = "I'll wait for the background verification to finish — the monitor will notify me when it's done";

describe('guard-stop-passive-wait — both signals are required (#3383)', () => {
  it.each([
    'It will notify me', 'It will wake me', 'It will alert me', 'Notify me when done',
    'Waiting for the notification', 'Waiting for the poll', 'Waiting for the background work',
    'The monitor will alert me', 'Polling in the background', "I'll wait for the job",
    'I will wait for completion', 'I’ll wait for the notification', 'Check back later',
    'Check back shortly', 'The agent will let me know', 'The task will notify me',
  ])('recognizes passive system waiting: %s', (text) => {
    expect(hasPassiveWaitLanguage(text.toUpperCase())).toBe(true);
  });
  it.each(['your reply', 'your response', 'your input', 'you to approve', 'your guidance']) (
    'allows human-directed waiting for %s even with a pending Bash call', (human) => {
      const text = `I'm stopping here because I hit a real blocker and need your input — I'll wait for ${human} before continuing`;
      expect(hasPassiveWaitLanguage(text)).toBe(false);
      expect(shouldBlockStop({ lastAssistantText: text, transcriptEntries: [use()] })).toBeNull();
    },
  );
  it('blocks passive waiting with an unresolved background Bash call', () => {
    expect(shouldBlockStop({ lastAssistantText: passive, transcriptEntries: [use()], stopHookActive: false }))
      .toMatch(/Check its status\/output directly/);
  });
  it('allows foreground Bash, resolved background calls, and language without pending work', () => {
    for (const transcriptEntries of [[], [use('Bash', {})], [use(), result()], [result(), use()]]) {
      expect(shouldBlockStop({ lastAssistantText: passive, transcriptEntries })).toBeNull();
    }
    expect(shouldBlockStop({ lastAssistantText: 'The tests passed. Work is complete.', transcriptEntries: [use(), result()] })).toBeNull();
    expect(shouldBlockStop({ lastAssistantText: 'A real blocker needs your input.', transcriptEntries: [use()] })).toBeNull();
  });
  it.each(['Agent', 'Task', 'Monitor'])('Stop permits pending %s', (name) => {
    expect(shouldBlockStop({ hookEventName: 'Stop', lastAssistantText: passive, transcriptEntries: [use(name)] })).toBeNull();
  });
  it.each(['Agent', 'Task'])('SubagentStop still permits harness-tracked %s', (name) => {
    expect(shouldBlockStop({ hookEventName: 'SubagentStop', lastAssistantText: passive, transcriptEntries: [use(name)] })).toBeNull();
  });
  it('only SubagentStop blocks passive waiting on a Monitor call, without a background flag', () => {
    const event = { lastAssistantText: passive, transcriptEntries: [use('Monitor', {})] };
    expect(shouldBlockStop({ ...event, hookEventName: 'SubagentStop' })).toMatch(/transcript shows a Monitor call/);
    expect(shouldBlockStop({ ...event, hookEventName: 'Stop' })).toBeNull();
    expect(shouldBlockStop(event)).toBeNull();
    expect(shouldBlockStop({ ...event, hookEventName: 'SubagentStop', stopHookActive: true })).toBeNull();
    expect(shouldBlockStop({ ...event, hookEventName: 'SubagentStop', lastAssistantText: 'I need your input.' })).toBeNull();
  });
  it('finds a Monitor call even when paired with its real started acknowledgment', () => {
    const monitor = use('Monitor', {});
    // The old findUnresolvedMonitor returned null here: acknowledgment was mistaken for completion.
    expect(findAnyMonitorCall([monitor, monitorStarted()])).toBe(monitor.message.content[0]);
  });
  it('blocks passive SubagentStop regardless of Monitor result order or parallel calls', () => {
    const monitor = use('Monitor', {});
    const parallel = use('Monitor', {}, 'call-2');
    for (const transcriptEntries of [
      [monitor, monitorStarted()], [monitorStarted(), monitor],
      [monitor, parallel, monitorStarted(), monitorStarted('call-2')],
    ]) {
      expect(findAnyMonitorCall(transcriptEntries)?.id).toBe('call-1');
      expect(shouldBlockStop({ hookEventName: 'SubagentStop', lastAssistantText: passive, transcriptEntries }))
        .toMatch(/transcript shows a Monitor call/);
    }
    expect(findUnresolvedBackgroundedBash([monitor])).toBeNull();
  });
  it('ignores malformed Monitor blocks, non-assistant entries, and nested progress', () => {
    const monitor = use('Monitor', {});
    const missingId = use('Monitor', {});
    delete missingId.message.content[0].id;
    const invalidEntries = [
      null, {}, { type: 'progress', data: monitor }, { ...monitor, type: 'user' },
      { type: 'assistant', message: { content: 'Monitor' } },
      { type: 'assistant', message: { content: [null, {}] } },
      use('Monitor', {}, ''), use('Monitor', {}, 1), missingId,
    ];
    expect(findAnyMonitorCall(null)).toBeNull();
    expect(findAnyMonitorCall(invalidEntries)).toBeNull();
    expect(findAnyMonitorCall([...invalidEntries, monitor])).toBe(monitor.message.content[0]);
  });
  it('permits SubagentStop without Monitor or without passive final-message language', () => {
    const event = { hookEventName: 'SubagentStop', lastAssistantText: passive };
    expect(shouldBlockStop({ ...event, transcriptEntries: [use('Read', {}), result()] })).toBeNull();
    expect(shouldBlockStop({ ...event, transcriptEntries: [use('Monitor', {}), monitorStarted()],
      lastAssistantText: 'The verify gate passed. Work is complete.' })).toBeNull();
  });
  it('pairs by id across the entire window, including parallel calls and later resolved tools', () => {
    const parallel = use();
    parallel.message.content.push(use('Bash', { run_in_background: true }, 'call-2').message.content[0]);
    expect(findUnresolvedBackgroundedBash([parallel, result(), use('Read', {}, 'read'), result('read')])?.id).toBe('call-2');
    expect(findUnresolvedBackgroundedBash([parallel, result(), result('call-2')])).toBeNull();
    expect(findUnresolvedBackgroundedBash([{ type: 'progress', data: use() }])).toBeNull();
    expect(findUnresolvedBackgroundedBash([use('Bash', { run_in_background: 'true' })])).toBeNull();
    expect(findUnresolvedBackgroundedBash([use('Bash', { run_in_background: true }, '')])).toBeNull();
  });
  it('honors stop_hook_active without another block or a separate counter', () => {
    expect(shouldBlockStop({ lastAssistantText: passive, transcriptEntries: [use()], stopHookActive: true })).toBeNull();
  });
});

describe('guard-stop-passive-wait — real CLI boundary and bounded transcript IO', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const guard = join(here, '..', 'guard-stop-passive-wait.mjs');
  const temp = mkdtempSync(join(tmpdir(), 'guard-stop-passive-wait-'));
  afterAll(() => rmSync(temp, { recursive: true, force: true }));
  const transcript = (name, entries) => {
    const path = join(temp, name);
    writeFileSync(path, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
    return path;
  };
  const pendingPath = transcript('pending.jsonl', [use()]);
  const resolvedPath = transcript('resolved.jsonl', [use(), result()]);
  const envelope = {
    session_id: 'session-1', hook_event_name: 'Stop', transcript_path: pendingPath,
    last_assistant_message: { type: 'text', content: passive }, stop_hook_active: false,
  };
  const run = (event) => spawnSync(process.execPath, [guard], {
    input: typeof event === 'string' ? event : JSON.stringify(event), encoding: 'utf8',
  });
  const expectAllow = (event) => {
    const output = run(event);
    expect(output.status).toBe(0);
    expect(output.stdout).toBe('');
    expect(output.stderr).toBe('');
  };
  it.each(['Stop', 'SubagentStop'])('blocks %s with the decision, active flag, event name and actionable feedback', (hook_event_name) => {
    const output = run({ ...envelope, hook_event_name });
    expect(output.status).toBe(2);
    const decision = JSON.parse(output.stdout);
    expect(decision.decision).toBe('block');
    expect(decision.stop_hook_active).toBe(true);
    expect(decision.hookSpecificOutput.hookEventName).toBe(hook_event_name);
    expect(decision.hookSpecificOutput.reason).toBe(decision.reason);
    expect(output.stderr.trim()).toBe(decision.reason);
  });
  it('also accepts the current string final-message envelope', () => {
    expect(run({ ...envelope, last_assistant_message: passive }).status).toBe(2);
  });
  it('allows resolved work, a completed report, and an active stop-hook continuation', () => {
    expectAllow({ ...envelope, transcript_path: resolvedPath });
    expectAllow({ ...envelope, last_assistant_message: 'Finished: all checks passed.' });
    expectAllow({ ...envelope, stop_hook_active: true });
  });
  it('prefers agent_transcript_path for SubagentStop, even when the parent has no pending work', () => {
    const event = { ...envelope, hook_event_name: 'SubagentStop', agent_id: 'agent-1' };
    const ownPath = transcript('own.jsonl', [{ ...use(), sessionId: 'session-1', agentId: 'agent-1' }]);
    expect(run({ ...event, transcript_path: resolvedPath, agent_transcript_path: ownPath }).status).toBe(2);
    expectAllow({ ...event, transcript_path: pendingPath, agent_transcript_path: resolvedPath });
  });
  it('keeps Stop on transcript_path even if agent_transcript_path is supplied', () => {
    expectAllow({ ...envelope, transcript_path: resolvedPath, agent_transcript_path: pendingPath });
    expect(run({ ...envelope, transcript_path: pendingPath, agent_transcript_path: resolvedPath }).status).toBe(2);
  });
  it('falls back to transcript_path when SubagentStop has no agent_transcript_path', () => {
    expectAllow({ ...envelope, hook_event_name: 'SubagentStop', agent_id: 'agent-1', transcript_path: resolvedPath });
    expect(run({ ...envelope, hook_event_name: 'SubagentStop', agent_id: 'agent-1', transcript_path: pendingPath }).status).toBe(2);
    expectAllow({ ...envelope, hook_event_name: 'SubagentStop', transcript_path: join(temp, 'missing-agent.jsonl') });
  });
  it('fails open on unreadable or malformed agent transcripts without falling back to the parent', () => {
    const bad = join(temp, 'bad-agent.jsonl');
    writeFileSync(bad, JSON.stringify(use()) + '\n{malformed\n');
    for (const agent_transcript_path of [join(temp, 'absent-agent.jsonl'), temp, bad]) {
      expectAllow({ ...envelope, hook_event_name: 'SubagentStop', agent_transcript_path });
    }
  });
  it('blocks a fully acknowledged Monitor with passive final text only through SubagentStop', () => {
    const finalText = "I'll wait for the monitor to notify me when the verify gate finishes rather than continuing to poll manually.";
    const monitorPath = transcript('monitor-started.jsonl', [
      use('Monitor', {}), monitorStarted(),
      { type: 'assistant', message: { content: [{ type: 'text', text: finalText }] } },
    ]);
    expectAllow({ ...envelope, transcript_path: monitorPath });
    const event = { ...envelope, hook_event_name: 'SubagentStop', agent_id: 'agent-1',
      transcript_path: resolvedPath, agent_transcript_path: monitorPath, last_assistant_message: finalText };
    const output = run(event);
    expect(output.status).toBe(2);
    const decision = JSON.parse(output.stdout);
    expect(decision.decision).toBe('block');
    expect(decision.reason).toMatch(/transcript shows a Monitor call/);
    expect(decision.reason).toMatch(/"started" acknowledgment does not prove/);
    expect(decision.reason).not.toMatch(/unresolved Monitor/);
    expect(output.stderr.trim()).toBe(decision.reason);
    expectAllow({ ...event, hook_event_name: 'Stop', transcript_path: monitorPath });
    expectAllow({ ...event, stop_hook_active: true });
    expectAllow({ ...event, last_assistant_message: 'I need your input.' });
  });
  it('ignores explicitly foreign session/agent entries and nested child progress', () => {
    const path = transcript('foreign.jsonl', [
      { ...use(), sessionId: 'other-session' },
      { ...use(), agentId: 'other-agent' },
      { type: 'progress', data: use() },
    ]);
    expectAllow({ ...envelope, transcript_path: path });
  });
  it('fails open on malformed stdin, missing files, and any malformed complete transcript line', () => {
    expectAllow('{broken');
    expectAllow('null');
    expectAllow({ ...envelope, transcript_path: join(temp, 'missing.jsonl') });
    expectAllow({ ...envelope, transcript_path: temp });
    const bad = join(temp, 'bad.jsonl');
    writeFileSync(bad, JSON.stringify(use()) + '\n{malformed\n');
    expectAllow({ ...envelope, transcript_path: bad });
  });
  it('caps the read and discards a cut first line, even when that line is huge', () => {
    const path = join(temp, 'large.jsonl');
    writeFileSync(path, '{invalid old content' + 'x'.repeat(MAX_TRANSCRIPT_BYTES) + '\n' + JSON.stringify(use()) + '\n');
    expect(readTranscriptTail(path)).toEqual([use()]);
    expect(run({ ...envelope, transcript_path: path }).status).toBe(2);
    writeFileSync(path, JSON.stringify(use()) + '\n' + 'x'.repeat(MAX_TRANSCRIPT_BYTES + 1));
    expect(readTranscriptTail(path)).toEqual([]);
    expectAllow({ ...envelope, transcript_path: path });
  });
  it('wires both events to the same guard and retains the existing Bash guard', () => {
    const settings = JSON.parse(readFileSync(join(here, '../../.claude/settings.json'), 'utf8'));
    const f = pinnedFixture();
    try {
      for (const hook_event_name of ['Stop', 'SubagentStop']) {
        const hook = settings.hooks[hook_event_name].flatMap(entry => entry.hooks)
          .find(hook => hook.command.includes('scripts/guard-stop-passive-wait.mjs'));
        const output = f.command(f.lane, hook.command, { ...envelope, hook_event_name });
        expect(output.status, output.stderr).toBe(2);
        expect(JSON.parse(output.stdout)).toMatchObject({ decision: 'block',
          hookSpecificOutput: { hookEventName: hook_event_name } });
      }
    } finally { f.cleanup(); }
    for (const event of ['Stop', 'SubagentStop']) {
      expect(settings.hooks[event].flatMap((entry) => entry.hooks)).toContainEqual({
        type: 'command', command: expect.stringMatching(/run-pinned-guard\.mjs.* --stop-hook scripts\/guard-stop-passive-wait\.mjs'$/),
      });
      const commands = settings.hooks[event].flatMap((entry) => entry.hooks.map((hook) => hook.command));
      expect(commands.map(pinnedStopHookScript)).toContain('scripts/guard-stop-passive-wait.mjs');
      // A Stop wrapper must never be the deny form: its exit 2 would block stopping on every retry.
      expect(commands.map(pinnedHookScript).filter(Boolean)).toEqual([]);
    }
    expect(settings.hooks.PreToolUse.find((entry) => entry.matcher === 'Bash').hooks).toContainEqual({
      type: 'command', command: expect.stringMatching(/run-pinned-guard\.mjs.* scripts\/guard-bash\.mjs; code=/),
    });
  });
});
