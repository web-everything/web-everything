#!/usr/bin/env node
/**
 * SubagentStop guard: a worker must not end its turn while a background Bash (`run_in_background`) or a
 * Monitor it started is still running. Ending then strands the work (the notification wakes nobody), which
 * broke the pinned "never end a turn on a backgrounded command" rule many times (perf2/5/6/10, R333, ...).
 * Unlike guard-stop-passive-wait.mjs this needs no passive-wait wording: a task that was started and has no
 * completion notice and no TaskStop is running, whatever the last message says.
 *
 * Only SubagentStop is guarded; the main session's Stop is never affected. Reads at most 2 MB from the end
 * of the SUBAGENT's own transcript. Any missing/unreadable/unparseable input fails OPEN (exit 0, no output).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readTranscriptTail } from './guard-stop-passive-wait.mjs';

const DONE = 'completed|failed|killed|stopped|cancelled|canceled|error';

/** First background Bash / Monitor started in this transcript with no completion notice and no TaskStop. Pure. */
export function findRunningBackgroundTask(entries) {
  if (!Array.isArray(entries)) return null;
  const started = new Map(); // tool_use id -> { name, label, taskId }
  const taskIdByUse = new Map();
  const stoppedTaskIds = new Set();
  const finishedUses = new Set();
  for (const entry of entries) {
    const content = entry?.message?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (entry.type === 'assistant' && block?.type === 'tool_use' && typeof block.id === 'string') {
          if ((block.name === 'Bash' && block.input?.run_in_background === true) || block.name === 'Monitor') {
            started.set(block.id, { name: block.name, label: String(block.input?.description || block.input?.command || '').slice(0, 120) });
          } else if (block.name === 'TaskStop' || block.name === 'KillShell') {
            const id = block.input?.task_id || block.input?.shell_id;
            if (id) stoppedTaskIds.add(id);
          }
        }
        if (entry.type === 'user' && block?.type === 'tool_result') {
          if (block.is_error === true && started.has(block.tool_use_id)) { finishedUses.add(block.tool_use_id); continue; } // the launch failed
          const text = typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '');
          const m = /(?:with ID|task[_ ]id|id)[:=\s"]+([a-z0-9]{6,})/i.exec(text);
          if (m && started.has(block.tool_use_id)) taskIdByUse.set(block.tool_use_id, m[1]);
        }
      }
    }
    if (entry?.type !== 'assistant') {
      const text = JSON.stringify(entry);
      if (text.includes('<task-notification>')) {
        const re = new RegExp(`<tool-use-id>([^<]+)</tool-use-id>.{0,600}?<status>(?:${DONE})</status>`, 'g');
        for (const m of text.matchAll(re)) finishedUses.add(m[1]);
      }
    }
  }
  for (const [id, info] of started) {
    if (finishedUses.has(id)) continue;
    const taskId = taskIdByUse.get(id);
    if (taskId && stoppedTaskIds.has(taskId)) continue;
    return { id, taskId: taskId || null, ...info };
  }
  return null;
}

export const GUARD_MARKER = '[background-task-guard]';
export const MAX_BLOCKS = 3;

export function stopReason(task) {
  const what = `${task.name}${task.taskId ? ` task ${task.taskId}` : ''}${task.label ? ` (${task.label})` : ''}`;
  return `${GUARD_MARKER} You started ${what} in the background and it is still running. Do not end your turn: its completion will not wake you. `
    + 'Run the work in the foreground instead (re-call it with a bounded wait, or its --status call), or stop it with TaskStop if you no longer need it, '
    + 'or report a concrete blocker in your final message.';
}

const IS_CLI = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (IS_CLI) {
  try {
    const event = JSON.parse(readFileSync(0, 'utf8'));
    if (event.hook_event_name !== 'SubagentStop') process.exit(0);
    const path = event.agent_transcript_path;
    if (typeof path !== 'string' || !path) process.exit(0);
    const entries = readTranscriptTail(path).filter((entry) =>
      (!entry?.sessionId || entry.sessionId === event.session_id) && (!entry?.agentId || entry.agentId === event.agent_id));
    // Bounded: after MAX_BLOCKS refusals in this transcript let the stop through rather than wedge the worker.
    const priorBlocks = entries.filter((e) => e?.type !== 'assistant' && JSON.stringify(e).includes(GUARD_MARKER)).length;
    const task = priorBlocks >= MAX_BLOCKS ? null : findRunningBackgroundTask(entries);
    if (task) {
      const reason = stopReason(task);
      console.log(JSON.stringify({ decision: 'block', reason, hookSpecificOutput: { hookEventName: 'SubagentStop', reason } }));
      console.error(reason);
      process.exitCode = 2;
    }
  } catch {
    process.exitCode = 0; // fail open: a read/parse problem never wedges a legitimate stop
  }
}
