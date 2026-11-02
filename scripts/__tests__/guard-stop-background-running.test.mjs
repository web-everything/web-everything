import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { findRunningBackgroundTask, stopReason, GUARD_MARKER } from '../guard-stop-background-running.mjs';
import { MAX_TRANSCRIPT_BYTES } from '../guard-stop-passive-wait.mjs';

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
  it('fails open on junk input', () => {
    expect(findRunningBackgroundTask(null)).toBeNull();
    expect(findRunningBackgroundTask([null, {}, { message: 7 }])).toBeNull();
  });
  const run = (event) => spawnSync('node', [resolve(import.meta.dirname, '../guard-stop-background-running.mjs')], { input: JSON.stringify(event), encoding: 'utf8' });
  it.each(['timed_out', 'exited'])('recognizes terminal Monitor status %s', (status) => {
    expect(findRunningBackgroundTask([use('toolu_m', 'Monitor', {}), note('toolu_m', status)])).toBeNull();
  });
  it('honours stop_hook_active without depending on transcript feedback being persisted', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'bgstop-')), 't.jsonl');
    writeFileSync(file, bg.map((e) => JSON.stringify(e)).join('\n'));
    const event = { hook_event_name: 'SubagentStop', agent_transcript_path: file };
    expect(run({ ...event, stop_hook_active: false }).status).toBe(2);
    expect(run({ ...event, stop_hook_active: true })).toMatchObject({ status: 0, stdout: '' });
  });
  it.each([
    ['matching worker', 'session', 'worker', 2],
    ['other session', 'foreign', 'worker', 0],
    ['other agent', 'session', 'foreign', 0],
    ['both foreign', 'foreign', 'foreign', 0],
    ['legacy missing identities', undefined, undefined, 2],
  ])('ignores running tasks from other agents and sessions: %s', (_, sessionId, agentId, status) => {
    const file = join(mkdtempSync(join(tmpdir(), 'bgstop-')), 't.jsonl');
    writeFileSync(file, bg.map((e) => JSON.stringify({ ...e, sessionId, agentId })).join('\n'));
    expect(run({ hook_event_name: 'SubagentStop', agent_transcript_path: file, session_id: 'session', agent_id: 'worker' }).status).toBe(status);
  });
  it('foreign completions and refusals cannot hide the current worker task', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'bgstop-')), 't.jsonl');
    const foreign = [note('toolu_1', 'completed'), ...Array.from({ length: 3 }, () => ({ type: 'user', message: { content: GUARD_MARKER } }))];
    writeFileSync(file, [...bg.map((e) => ({ ...e, sessionId: 'session', agentId: 'worker' })),
      ...foreign.map((e) => ({ ...e, sessionId: 'session', agentId: 'foreign' }))].map((e) => JSON.stringify(e)).join('\n'));
    expect(run({ hook_event_name: 'SubagentStop', agent_transcript_path: file, session_id: 'session', agent_id: 'worker' }).status).toBe(2);
  });
  it('reads at most 2 MiB from the transcript tail with a bounded byte range', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'bgstop-')), 't.jsonl');
    const prefix = JSON.stringify({ type: 'user', message: { content: 'x'.repeat(3 * 1024 * 1024) } });
    const text = `${prefix}\n${bg.map((e) => JSON.stringify(e)).join('\n')}\n`;
    writeFileSync(file, text);
    // Native Node instrumentation: Vitest's builtin mocks do not reach this ESM reader's imports.
    const probe = spawnSync('node', ['--input-type=module', '-e', `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const open = fs.openSync;
      const read = fs.readSync;
      const close = fs.closeSync;
      const transcriptFds = new Set();
      const calls = [];
      // ESM loading may also use readSync; count only descriptors opened for this transcript.
      fs.openSync = (path, ...args) => {
        const fd = open(path, ...args);
        if (path === ${JSON.stringify(file)}) transcriptFds.add(fd);
        return fd;
      };
      fs.readSync = (fd, buffer, offset, length, position) => {
        if (transcriptFds.has(fd)) calls.push({ bufferLength: buffer.length, offset, length, position });
        return read(fd, buffer, offset, length, position);
      };
      fs.closeSync = (fd) => {
        const result = close(fd);
        transcriptFds.delete(fd);
        return result;
      };
      syncBuiltinESMExports();
      process.argv[1] = ${JSON.stringify(resolve(import.meta.dirname, '../guard-stop-background-running.mjs'))};
      // Exercise an unrelated read even on Node versions whose loader bypasses readSync.
      fs.readFileSync(process.argv[1]);
      await import(process.argv[1]);
      process.stdout.write(JSON.stringify({ calls }));
    `], { encoding: 'utf8', timeout: 10000, maxBuffer: 256 * 1024,
      input: JSON.stringify({ hook_event_name: 'SubagentStop', agent_transcript_path: file }) });
    expect(probe.status, probe.stderr).toBe(2);
    const [blocked, ranges] = probe.stdout.trim().split('\n').map((line) => JSON.parse(line));
    expect(blocked.decision).toBe('block');
    expect(blocked.reason).toContain('bk12345xy');
    const { calls } = ranges;
    expect(calls).toHaveLength(1);
    const { bufferLength, offset, length, position } = calls[0];
    expect(length).toBe(MAX_TRANSCRIPT_BYTES);
    expect(length).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(bufferLength).toBe(length);
    expect(offset).toBe(0);
    expect(position).toBe(Buffer.byteLength(text) - length);
  });
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
