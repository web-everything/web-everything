import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collectExecutorLogs, executorMarkdown, executorTable, parseAgyTranscript, parseCodexRollout } from '../coroner-executors.mjs';
import { runCoroner } from '../coroner-extract.mjs';

const J = (...rows) => rows.map((r) => JSON.stringify(r));
const T = '2026-10-05T17:';
const codexRollout = (id, cwd, prompt, { done = true, exits = [0, 1] } = {}) => J(
  { timestamp: `${T}00:00.000Z`, type: 'session_meta', payload: { id, session_id: id, cwd } },
  { timestamp: `${T}00:01.000Z`, type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text: prompt }] } } },
  ...exits.flatMap((code, i) => [
    { timestamp: `${T}0${i + 1}:00.000Z`, type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: `c${i}`, input: 'text(await tools.exec_command({cmd:"npm test",max_output_tokens:100}))' } },
    { timestamp: `${T}0${i + 1}:30.000Z`, type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: `c${i}`, output: [{ type: 'input_text', text: `{\\"exit_code\\":${code}}` }] } },
  ]),
  { timestamp: `${T}05:00.000Z`, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { total_tokens: 1234 } } } },
  ...(done ? [{ timestamp: `${T}06:00.000Z`, type: 'event_msg', payload: { type: 'task_complete' } }] : []),
);
const agy = (id, status = 'SUCCESS', toolState = 'DONE') => J(
  { event: 'init', conversation_id: id, init: { model: 'claude-opus-5-5-high', cwd: '/tmp/we-agy-juror-x' } },
  { event: 'step_update', step_update: { step_index: 1, state: toolState, step_type: 'tool', tool_name: 'view_file' } },
  { event: 'result', result: { conversation_id: id, status, duration_seconds: 90, usage: { total_tokens: 700 }, json_schema: {} } },
);

describe('codex rollout format', () => {
  it('counts commands, non-zero exits, tokens, duration, role and links the run record', () => {
    const run = parseCodexRollout(codexRollout('T1', '/x/we-review-seat-ab', 'review PR #77'), { pilot: {} });
    expect(run).toMatchObject({ executor: 'codex', role: 'review', task: 'pr-77', commands: 2, errors: 1, tokens: 1234, ms: 360000, outcome: 'completed', failed: false });
    const linked = parseCodexRollout(codexRollout('T2', '/x/lane-5', 'Card 9 slice S1', { done: false }), { pilot: { T2: { card: '5129', outcome: 'pr-opened' } } });
    expect(linked).toMatchObject({ task: 'card-5129', link: 'codex-pilot', outcome: 'pr-opened', failed: false });
    expect(parseCodexRollout(codexRollout('T3', '/x/lane-5', 'x', { done: false })).failed).toBe(true);
  });
  it('flags a command repeated three or more times as a loop', () => {
    expect(parseCodexRollout(codexRollout('T4', '/x/lane-5', 'x', { exits: [1, 1, 1] })).loops).toEqual([{ command: 'npm test', count: 3 }]);
  });
});

describe('agy transcript format', () => {
  it('reads status, duration, tokens, tool errors and the served model', () => {
    expect(parseAgyTranscript(agy('A1', 'SUCCESS', 'ERROR'))).toMatchObject({ executor: 'agy', role: 'review', model: 'claude-opus-5-5-high', ms: 90000, tokens: 700, commands: 1, errors: 1, failed: false });
    expect(parseAgyTranscript(agy('A2', 'ERROR')).outcome).toBe('error');
  });
});

describe('executor table and collection', () => {
  let root;
  beforeEach(() => { root = fs.mkdtempSync(join(tmpdir(), 'coroner-exec-')); });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
  const put = (rel, lines) => { const f = join(root, rel); fs.mkdirSync(join(f, '..'), { recursive: true }); fs.writeFileSync(f, lines.join('\n') + '\n'); return f; };
  const window = { since: '2026-10-05T00:00:00.000Z', until: '2026-10-06T00:00:00.000Z' };

  it('computes rounds per task, error rate and median time per executor', () => {
    const t = executorTable({ codex: [{ task: 'a', ms: 60000, failed: false }, { task: 'a', ms: 180000, failed: true }, { task: 'b', ms: 120000, failed: false }] });
    expect(t.codex).toMatchObject({ runs: 3, tasks: 2, roundsPerTask: 1.5, errorRatePct: 33.3, medianMin: 2 });
    expect(executorMarkdown(t, window)).toContain('| codex | 3 | 2 | 1.5 | 33.3% | 2 |');
  });

  it('collects windowed codex + agy logs, links via codex-pilot, and surfaces in the coroner report', () => {
    put('codex/2026/10/05/rollout-a.jsonl', codexRollout('T9', '/x/lane-5', 'x'));
    put('codex/2026/09/01/rollout-old.jsonl', codexRollout('T0', '/x/lane-5', 'x'));
    put('agy/antigravity-judge-A9.jsonl', agy('A9'));
    put('pilot.jsonl', J({ card: '5129', outcome: 'pr-opened', codex: { threadId: 'T9' } }));
    const mtime = new Date('2026-10-05T18:00:00Z'); fs.utimesSync(join(root, 'agy/antigravity-judge-A9.jsonl'), mtime, mtime);
    const env = { WE_CORONER_CODEX_SESSIONS: join(root, 'codex'), WE_CORONER_AGY_TRANSCRIPTS: join(root, 'agy'), WE_CORONER_CODEX_PILOT: join(root, 'pilot.jsonl') };
    const { runs, sources } = collectExecutorLogs(window, { env, home: root });
    expect(runs.codex.map((r) => r.task)).toEqual(['card-5129']);
    expect(runs.agy).toHaveLength(1);
    expect(sources).toMatchObject({ codex: { found: true, count: 1 }, agy: { count: 1 }, pilot: { count: 1 } });
    const dirs = Object.fromEntries(['JOBS', 'JOBS_ARCHIVE', 'PROJECTS', 'DAEMON_DIR', 'VERIFY_LOG', 'ADMISSION', 'LANES', 'COORD', 'BACKLOG'].map((k) => [`WE_CORONER_${k}`, join(root, k.toLowerCase())]));
    const out = runCoroner(['--since=2026-10-05T00:00:00.000Z', '--until=2026-10-06T00:00:00.000Z', '--json', '--no-save'], { env: { ...env, ...dirs }, home: root, now: window.until });
    expect(out.metrics.executors.codex.runs).toBe(1);
    expect(out.metrics.executors.agy.byRole).toEqual({ review: 1 });
  });
});
