import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { findRunningBackgroundTask, stopReason, GUARD_MARKER } from '../guard-stop-background-running.mjs';

const use = (id, name, input) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
const ack = (id, text) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: text }] } });
const note = (id, status) => ({ type: 'user', message: { content: `<task-notification>\n<task-id>t1</task-id>\n<tool-use-id>${id}</tool-use-id>\n<status>${status}</status>\n</task-notification>` } });
const bg = [use('toolu_1', 'Bash', { command: 'node scripts/operations/run.mjs prototype-load', run_in_background: true }),
  ack('toolu_1', 'Command running in background with ID: bk12345xy. Output is being written to /tmp/x')];

describe('guard-stop-background-running', () => {
  it('names a background Bash that is still running', () => {
    const task = findRunningBackgroundTask(bg);
    expect(task).toMatchObject({ id: 'toolu_1', name: 'Bash', taskId: 'bk12345xy' });
    expect(stopReason(task)).toContain('bk12345xy');
    expect(stopReason(task)).toContain('prototype-load');
  });
  it('names a Monitor that was started', () => {
    expect(findRunningBackgroundTask([use('toolu_m', 'Monitor', { description: 'watch rebuild' }), ack('toolu_m', 'Monitor started, task id: mon98765z')]))
      .toMatchObject({ name: 'Monitor', taskId: 'mon98765z' });
  });
  it('ignores foreground Bash and finished or stopped tasks', () => {
    expect(findRunningBackgroundTask([use('toolu_f', 'Bash', { command: 'ls' }), ack('toolu_f', 'ok')])).toBeNull();
    expect(findRunningBackgroundTask([...bg, note('toolu_1', 'completed')])).toBeNull();
    expect(findRunningBackgroundTask([...bg, use('toolu_s', 'TaskStop', { task_id: 'bk12345xy' }), ack('toolu_s', 'stopped')])).toBeNull();
  });
  it('still reports a task whose notice is for a different tool use', () => {
    expect(findRunningBackgroundTask([...bg, note('toolu_other', 'completed')])).not.toBeNull();
  });
  it('a failed launch is not a running task', () => {
    const failed = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', is_error: true, content: 'spawn failed' }] } };
    expect(findRunningBackgroundTask([bg[0], failed])).toBeNull();
  });
  it('lets the stop through after three refusals instead of wedging', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'bgstop-')), 't.jsonl');
    const refusal = { type: 'user', message: { content: `Stop hook feedback: ${GUARD_MARKER} You started Bash` } };
    writeFileSync(file, [...bg, refusal, refusal, refusal].map((e) => JSON.stringify(e)).join('\n'));
    expect(spawnSync('node', [resolve(import.meta.dirname, '../guard-stop-background-running.mjs')], { input: JSON.stringify({ hook_event_name: 'SubagentStop', agent_transcript_path: file }), encoding: 'utf8' }).status).toBe(0);
    expect(stopReason(findRunningBackgroundTask(bg))).toContain(GUARD_MARKER);
  });
  it('a failed TaskStop does not count, and a harness-backgrounded Bash does', () => {
    const failedStop = [use('toolu_s', 'TaskStop', { task_id: 'bk12345xy' }), { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_s', is_error: true, content: 'no such task' }] } }];
    expect(findRunningBackgroundTask([...bg, ...failedStop])).not.toBeNull();
    const auto = [use('toolu_a', 'Bash', { command: 'sleep 999' }), ack('toolu_a', 'Command running in background with ID: auto777abc. Output is being written to /tmp/y')];
    expect(findRunningBackgroundTask(auto)).toMatchObject({ taskId: 'auto777abc' });
  });
  it('reads the Monitor acknowledgment format and honours a TaskStop of it', () => {
    const mon = [use('toolu_m', 'Monitor', { description: 'w' }), ack('toolu_m', 'Monitor started (task ba59nqsob, timeout 300000ms). You will be notified.')];
    expect(findRunningBackgroundTask(mon)).toMatchObject({ taskId: 'ba59nqsob' });
    expect(findRunningBackgroundTask([...mon, use('toolu_t', 'TaskStop', { task_id: 'ba59nqsob' }), ack('toolu_t', 'ok')])).toBeNull();
  });
  it('a TaskOutput that shows a terminal status ends the task', () => {
    const done = [use('toolu_o', 'TaskOutput', { task_id: 'bk12345xy' }), ack('toolu_o', '<status>completed</status> output...')];
    expect(findRunningBackgroundTask([...bg, ...done])).toBeNull();
    expect(findRunningBackgroundTask([...bg, use('toolu_o', 'TaskOutput', { task_id: 'bk12345xy' }), ack('toolu_o', '<status>running</status>')])).not.toBeNull();
  });
  it('fails open on junk input', () => {
    expect(findRunningBackgroundTask(null)).toBeNull();
    expect(findRunningBackgroundTask([null, {}, { message: 7 }])).toBeNull();
  });
  const run = (event) => spawnSync('node', [resolve(import.meta.dirname, '../guard-stop-background-running.mjs')], { input: JSON.stringify(event), encoding: 'utf8' });
  it('CLI blocks a subagent stop, never the main-session Stop, and fails open on unreadable state', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'bgstop-')), 't.jsonl');
    writeFileSync(file, bg.map((e) => JSON.stringify(e)).join('\n'));
    const blocked = run({ hook_event_name: 'SubagentStop', agent_transcript_path: file });
    expect(blocked.status).toBe(2);
    expect(JSON.parse(blocked.stdout).decision).toBe('block');
    expect(run({ hook_event_name: 'Stop', transcript_path: file, agent_transcript_path: file }).status).toBe(0);
    expect(run({ hook_event_name: 'SubagentStop', agent_transcript_path: '/nonexistent/x.jsonl' })).toMatchObject({ status: 0, stdout: '' });
    expect(spawnSync('node', [resolve(import.meta.dirname, '../guard-stop-background-running.mjs')], { input: 'not json', encoding: 'utf8' }).status).toBe(0);
  });
});
