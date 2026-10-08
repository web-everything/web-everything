import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCoroner } from '../coroner-extract.mjs';
import { agyEvents, buildFrictions, claudeEvents, codexEvents, codexKindFromBrief, collectAgyFrictions, collectCodexFrictions, extractFrictions, readHeadRows, readTranscriptRows, redact, summarizeBuildOutcomes, threadIdFromRolloutName } from '../coroner-transcripts.mjs';

const since = '2026-10-07T12:00:00.000Z', until = '2026-10-07T13:00:00.000Z';
const at = (m) => new Date(Date.parse(since) + m * 60000).toISOString();
let root;
const write = (file, value) => { fs.mkdirSync(dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); return file; };
const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';

const use = (id, name, input, m) => ({ type: 'assistant', timestamp: at(m), message: { content: [{ type: 'tool_use', id, name, input }] } });
const res = (id, text, m, is_error = false) => ({ type: 'user', timestamp: at(m), message: { content: [{ type: 'tool_result', tool_use_id: id, is_error, content: [{ type: 'text', text }] }] } });
const say = (text, m) => ({ type: 'assistant', timestamp: at(m), message: { content: [{ type: 'text', text }] } });
const userText = (text, m) => ({ type: 'user', timestamp: at(m), message: { content: text } });

// A Claude build, shaped like the 2026-10-07 transcripts: lane taken, leased once, edit, verify twice, PR.
const claudeBuild = () => [
  use('1', 'Bash', { command: 'node scripts/lane-pool.mjs acquire --purpose=x' }, 0),
  res('1', '✗ lane-7 is leased by review-4306 (review-loop) @ 2026-10-07T11:58:00Z — a LIVE lease', 0.2, true),
  use('2', 'Bash', { command: 'node scripts/lane-pool.mjs acquire --purpose=x' }, 0.5),
  res('2', 'acquired lane-9', 0.6),
  use('3', 'Edit', { file_path: '/lane-9/a.mjs' }, 4),
  res('3', 'ok', 4.1),
  use('4', 'Bash', { command: 'node scripts/operations/run.mjs verify --checkout=/lane-9' }, 6),
  res('4', 'queued', 6.1),
  userText('Verify is RED: 1 failed', 14),
  use('5', 'Bash', { command: 'node scripts/operations/run.mjs verify --checkout=/lane-9' }, 15),
  res('5', 'queued', 15.1),
  userText('Verify is GREEN', 20),
  use('6', 'Bash', { command: 'git add scripts/a.mjs' }, 21),
  res('6', 'Blocked: git add -A is not allowed; stage explicit paths', 21.1, true),
  use('7', 'Bash', { command: 'node scripts/operations/run.mjs open-pr --branch=lane/x' }, 22),
  res('7', 'opened https://github.com/web-everything/web-everything/pull/4183', 32),
  say('Opened PR #4183 with token ghp_abcdefghijklmnopqrstuvwxyz0123456789 in the log', 33),
];

describe('claude transcript friction (card 130 S1)', () => {
  it('extracts lane failures, guard blocks, step gaps, re-runs, PR and a redacted outcome line', () => {
    const rec = extractFrictions(claudeEvents(claudeBuild()), { session: 's', executor: 'claude', kind: 'build' });
    expect(rec.laneFailures).toEqual({ 'lane-already-leased': 1 });
    expect(rec.guardBlocks).toBe(1);
    expect(rec.toolDenials).toEqual({ 'hook-blocked': 1 });
    expect(rec.verifyRequests).toBe(2);
    expect(rec.openPrRuns).toBe(1);
    expect(rec.retriesAfterError).toBe(1);
    expect(rec.reruns).toBeGreaterThanOrEqual(2);
    expect(rec.pr).toBe(4183);
    expect(Object.keys(rec.steps).sort()).toEqual(['acquire', 'edit', 'prOpen', 'push', 'verdict', 'verify']);
    expect(rec.gaps).toMatchObject({ acquireToEdit: 4 * 60000, verifyWait: 8 * 60000, pushToPr: 10 * 60000 });
    expect(rec.outcomeLine).not.toContain('ghp_');
    expect(rec.outcomeLine).toContain('[redacted]');
  });

  it('does not count source code or file content that merely mentions the words', () => {
    const rows = [
      use('1', 'Bash', { command: 'cat scripts/lane-pool.mjs' }, 0),
      res('1', "// lane-3 is leased by x\nif (error.code === 'EPERM') return true; // Blocked: nothing", 0.1),
      use('2', 'Bash', { command: 'rg -n "open-pr" scripts' }, 1),
      res('2', 'scripts/a.mjs: open-pr', 1.1),
    ];
    const rec = extractFrictions(claudeEvents(rows), {});
    expect([rec.laneFailures, rec.guardBlocks, rec.sandboxEperm, rec.openPrRuns, rec.steps]).toEqual([{}, 0, 0, 0, {}]);
  });

  it('redacts token-like strings', () => {
    const text = redact('Bearer abcdefghijklmnop1234 and github_pat_11ABCDEFG0123456789abcdef and sk-abcdefghijklmnopqrstuv and token=supersecretvalue and ' + 'a1'.repeat(30));
    expect(text).not.toMatch(/abcdefghijklmnop1234|github_pat_11|sk-abcdef|supersecretvalue|(?:a1){20}/);
  });

  it.each([
    ['export GITHUB_TOKEN=hunter2hunter2', 'hunter2hunter2'],
    ['MY_API_KEY: "k9x8w7v6u5t4"', 'k9x8w7v6u5t4'],
    ['DB_PASSWORD=p4ssw0rd!!', 'p4ssw0rd'],
    ['{"client_secret": "s3cr3tvalue99"}', 's3cr3tvalue99'],
    ['postgres://admin:p4ssw0rd@db.internal:5432/app', 'p4ssw0rd'],
    ['https://user:hunter2hunter2@example.com/x', 'hunter2hunter2'],
    ['-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA7aXk3Zq0\nabcdEFGH1234+/==\n-----END RSA PRIVATE KEY-----', 'MIIEowIBAAKCAQEA7aXk3Zq0'],
    ['key AIzaSyA-1234567890abcdefghijklmnopqrstu used', 'AIzaSyA-1234567890'],
    ['npm_' + 'a1B2c3D4e5'.repeat(4), 'a1B2c3D4e5a1B2c3D4e5'],
    ['sk_live_' + '4eC39HqLyjWDarjtT1zdp7dc', '4eC39HqLyjWDarjtT1zdp7dc'],
    ['AUTHORIZATION=Zm9vOmJhcnN1cGVyc2VjcmV0', 'Zm9vOmJhcnN1cGVyc2VjcmV0'],
    ['redis://:onlypassword@host:6379', 'onlypassword'],
    ['https://tokenonlyabcdefghij1234567890@host/x', 'tokenonlyabcdefghij1234567890'],
    ['postgres://user:p@ss@host/db', 'p@ss'],
    ["DB_PASSWORD='p@ss;word1'", 'word1'],
    ['{"password": "correct horse battery"}', 'horse battery'],
    ['Authorization: Bearer abcdef12345', 'abcdef12345'],
    ['Cookie: sid=abc123def456; theme=dark', 'abc123def456'],
    ['Set-Cookie: session=s3ss10nvalue; Path=/', 's3ss10nvalue'],
    ['AWS ASIAIOSFODNN7EXAMPLE temp key', 'ASIAIOSFODNN7EXAMPLE'],
    ['whsec_' + 'a1B2c3D4e5F6g7H8i9J0', 'a1B2c3D4e5F6g7H8i9J0'],
    ['-----BEGIN PGP PRIVATE KEY BLOCK-----\nlQdGBF9abcdefgh\n-----END PGP PRIVATE KEY BLOCK-----', 'lQdGBF9abcdefgh'],
    ['-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC,1A2B3C4D5E6F\n\nshortbody==\n-----END RSA PRIVATE KEY-----', 'shortbody'],
    ['-----BEGIN PRIVATE KEY-----\ntruncatedBodyWithoutEnd1', 'truncatedBodyWithoutEnd1'],
  ])('redacts the secret in %j', (input, secret) => {
    const out = redact(input);
    expect(out).not.toContain(secret);
    expect(out).toContain('[redacted]');
  });

  it('keeps ordinary prose, short paths and ids readable', () => {
    expect(redact('lane-7 is leased by review-4306 at scripts/operations/run.mjs, token budget low')).toBe('lane-7 is leased by review-4306 at scripts/operations/run.mjs, token budget low');
    expect(redact('Basic functionality works; Bearer authentication is configured; see https://github.com/org/repo/pull/1@2')).toBe('Basic functionality works; Bearer authentication is configured; see https://github.com/org/repo/pull/1@2');
  });

  it('treats the result of every non-acting tool as content: Edit echo, Task, MCP fetch, nl/jq/git grep/gh pr view, an orphan result', () => {
    const content = 'lane-7 is leased by review-1 (x)\nhook pre-commit blocked the push\nBlocked: nothing\nOperation not permitted';
    const tool = (name, input) => ({ type: 'assistant', timestamp: at(0), message: { content: [{ type: 'tool_use', id: name, name, input }] } });
    const rows = [
      tool('Edit', { file_path: '/lane/a.mjs' }), res('Edit', content, 0.1),
      tool('MultiEdit', { file_path: '/lane/a.mjs' }), res('MultiEdit', content, 0.1),
      tool('Task', { prompt: 'x' }), res('Task', content, 0.1),
      tool('mcp__github__get_file_contents', { path: 'a' }), res('mcp__github__get_file_contents', content, 0.1),
      tool('Bash', { command: 'nl -ba scripts/lane-pool.mjs' }), res('Bash', content, 0.1),
      tool('Bash', { command: 'jq . f.json' }), res('Bash', content, 0.1),
      tool('Bash', { command: 'git grep -n leased' }), res('Bash', content, 0.1),
      tool('Bash', { command: 'gh pr view 12 --comments' }), res('Bash', content, 0.1),
      res('orphan-call-fell-off-the-tail', content, 0.2),
    ];
    const rec = extractFrictions(claudeEvents(rows), {});
    expect([rec.laneFailures, rec.guardBlocks, rec.sandboxEperm, rec.toolDenials]).toEqual([{}, 0, 0, {}]);
  });

  it('keeps a long result from fabricating a line-start match at the clip seam', () => {
    // The retained tail (last 32 KiB) begins exactly at a mid-line "Blocked:".
    const big = 'z'.repeat(100000) + 'Blocked: ' + 'b'.repeat(32768 - 9);
    const rows = [use('1', 'Bash', { command: 'node scripts/x.mjs' }, 0), res('1', big, 0.1)];
    expect(extractFrictions(claudeEvents(rows), {}).guardBlocks).toBe(0);
  });

  it('redacts a huge run that no boundary follows in linear time (the quadratic-lookahead input)', () => {
    const run = 'a1+'.repeat(80000);
    for (const tail of ['}', ':', '', ' end']) {
      const started = Date.now();
      redact(run + tail);
      expect(Date.now() - started).toBeLessThan(500);
    }
  });

  it('does not leak the unredacted remainder of a token cut by the size bound', () => {
    const token = 'ghp_' + 'Ab1'.repeat(10);
    const out = redact('x '.repeat(4090) + token + ' tail');
    expect(out).not.toContain('ghp_');
    expect(out).not.toMatch(/Ab1Ab1Ab1/);
  });

  it('reads a trigger line followed by a huge secret-shaped run in bounded time, through the real extraction path', () => {
    const blob = 'a1+'.repeat(120000) + '}';
    const rows = [use('1', 'Bash', { command: 'node scripts/lane-pool.mjs acquire' }, 0), res('1', `Blocked: nope\n${blob}`, 0.1, true), say(blob, 0.2),
      use('2', 'Bash', { command: 'node scripts/x.mjs' }, 1), res('2', `${'\n'.repeat(60000)}Blocked: later`, 1.1)];
    const started = Date.now();
    const rec = extractFrictions(claudeEvents(rows), {});
    expect(Date.now() - started).toBeLessThan(2000);
    expect(rec.guardBlocks).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(rec.examples) + rec.outcomeLine).not.toContain('a1+a1+a1+a1+a1+a1+a1+a1+a1+a1+a1+');
  });

  it('does not count Read, Grep or Glob output as events, but still counts an errored Read', () => {
    const content = 'lane-7 is leased by review-1 (x)\nhook pre-commit blocked the push\nBlocked: nothing\nOperation not permitted\nEPERM: operation not permitted, mkdir \'/x/.admission/y\'';
    const rows = [
      { type: 'assistant', timestamp: at(0), message: { content: [{ type: 'tool_use', id: 'r', name: 'Read', input: { file_path: '/lane/open-pr.test.mjs' } }] } },
      res('r', content, 0.1),
      { type: 'assistant', timestamp: at(1), message: { content: [{ type: 'tool_use', id: 'g', name: 'Grep', input: { pattern: 'leased', path: '/lane' } }] } },
      res('g', content, 1.1),
      { type: 'assistant', timestamp: at(2), message: { content: [{ type: 'tool_use', id: 'l', name: 'Glob', input: { pattern: '**/*.mjs' } }] } },
      res('l', content, 2.1),
    ];
    const rec = extractFrictions(claudeEvents(rows), {});
    expect([rec.laneFailures, rec.guardBlocks, rec.sandboxEperm, rec.toolDenials, rec.permissionDenied]).toEqual([{}, 0, 0, {}, 0]);
    const denied = extractFrictions(claudeEvents([
      { type: 'assistant', timestamp: at(0), message: { content: [{ type: 'tool_use', id: 'r', name: 'Read', input: { file_path: '/etc/x' } }] } },
      res('r', 'Permission denied: cannot read /etc/x', 0.1, true),
    ]), {});
    expect(denied.permissionDenied).toBe(1);
  });
});

describe('codex rollout friction', () => {
  const rollout = (extra = []) => [
    { timestamp: at(0), type: 'session_meta', payload: { id: 'thread-1', cwd: '/lanes/lane-1', timestamp: at(0) } },
    { timestamp: at(1), type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c1', input: 'text(await tools.exec_command({cmd:"node scripts/readiness/heavy-admission.mjs run -- npx vitest run x.test.ts"}))' } },
    { timestamp: at(1.5), type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c1', output: [{ type: 'input_text', text: '{"exit_code":1,"output":"✗ heavy-admission error: Error: EPERM: operation not permitted, mkdir \'/Users/x/workspace/.lanes/.admission/heavy/abc\'"}' }] } },
    { timestamp: at(2), type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'Reported blocked: the sandbox denied the admission queue.' } },
    ...extra,
  ];

  it('counts a sandbox EPERM on the admission queue and keeps the worker outcome line', () => {
    const rec = extractFrictions(codexEvents(rollout()), { executor: 'codex', kind: 'build' });
    expect(rec).toMatchObject({ sandboxEperm: 1, admissionEperm: 1, toolErrors: 1 });
    expect(rec.outcomeLine).toBe('Reported blocked: the sandbox denied the admission queue.');
  });

  it('counts a Node EPERM line even when a viewer command printed it, but not source that only names EPERM', () => {
    const rows = [
      { timestamp: at(1), type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c1', input: 'tools.exec_command({cmd:"cat src/x.mjs"})' } },
      { timestamp: at(1.1), type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c1', output: "if (error.code === 'EPERM') return true;" } },
      { timestamp: at(2), type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c2', input: 'tools.exec_command({cmd:"rg -n heavy scripts"})' } },
      { timestamp: at(2.1), type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c2', output: "EPERM: operation not permitted, mkdir '/x/.admission/heavy/a'" } },
    ];
    expect(extractFrictions(codexEvents(rows), {}).sandboxEperm).toBe(1);
  });

  it('classifies an unjoined rollout by its brief', () => {
    expect(codexKindFromBrief('Check this test-fix against its spec. Answer APPROVE or REJECT')).toBe('review');
    expect(codexKindFromBrief('# Probation worker mode - prepare item 4412')).toBe('prepare-item');
    expect(codexKindFromBrief('run node delivery-report-cli.mjs report --session=$DELIVERY_SESSION')).toBe('build');
    expect(codexKindFromBrief('hello')).toBe('task');
  });

  it('reads agy tool errors', () => {
    const rec = extractFrictions(agyEvents([{ event: 'step_update', step_update: { step_type: 'tool', state: 'ERROR', tool_name: 'run', id: 's1', error: 'Blocked: nope' } }]), {});
    expect(rec.toolErrors).toBe(1);
  });
});

describe('codex rollout larger than the tail cap', () => {
  const window = { since, until }, cap = 16 * 1024;
  const pad = Array.from({ length: 400 }, (_, i) => ({ timestamp: at(3), type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `step ${i} ${'x'.repeat(200)}` }] } }));
  const tailRows = [
    { timestamp: at(20), type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c1', input: 'tools.exec_command({cmd:"node heavy-admission.mjs run -- npx vitest"})' } },
    { timestamp: at(21), type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c1', output: "EPERM: operation not permitted, mkdir '/w/.lanes/.admission/heavy/a'" } },
  ];
  const rollout = (name, { meta = { id: 'thread-9', cwd: '/lanes/lane-1', timestamp: at(1) }, brief = 'DELIVERY_SESSION delivery-report-cli' } = {}) => {
    const dir = join(root, 'codex', '2026', '10', '07');
    write(join(dir, name), jsonl([{ timestamp: meta.timestamp, type: 'session_meta', payload: meta }, { timestamp: at(1), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: brief }] } }, ...pad, ...tailRows]));
    return join(dir, name);
  };
  const env = () => ({ WE_CORONER_CODEX_SESSIONS: join(root, 'codex'), WE_CORONER_OPS_ROOTS: join(root, 'ops') });

  it('the fixture really is bigger than the cap and the tail read really lost the head', () => {
    const file = rollout('rollout-2026-10-07T12-01-00-thread-9.jsonl');
    expect(fs.statSync(file).size).toBeGreaterThan(cap * 4);
    const read = readTranscriptRows(file, { maxBytes: cap });
    expect(read.truncatedHead).toBe(true);
    expect(read.rows.some((r) => r.type === 'session_meta')).toBe(false);
  });

  it('still joins the thread record, classifies the build and keeps its start time', () => {
    rollout('rollout-2026-10-07T12-01-00-thread-9.jsonl');
    write(join(root, 'ops', 'codex-delivery-threads', 'conveyor-4609.json'), { sessionSlug: 'conveyor-4609', threadId: 'thread-9', at: at(1) });
    const { records, sources } = collectCodexFrictions(window, { env: env(), home: root, maxBytes: cap });
    expect(sources.joined).toBe(1);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ kind: 'build', truncatedHead: true, sandboxEperm: 1, at: at(1), session: 'thread-9' });
  });

  it('classifies an unjoined oversized rollout from the brief at its head, not from mid-file messages', () => {
    rollout('rollout-2026-10-07T12-01-00-thread-9.jsonl');
    const { records } = collectCodexFrictions(window, { env: env(), home: root, maxBytes: cap });
    expect(records[0].kind).toBe('build');
  });

  it('falls back to the thread id in the rollout file name when no session_meta can be read', () => {
    expect(threadIdFromRolloutName('rollout-2026-10-07T12-01-00-019a1b2c-0000-7000-8000-abcdefabcdef.jsonl')).toBe('019a1b2c-0000-7000-8000-abcdefabcdef');
    expect(threadIdFromRolloutName('notes.jsonl')).toBeNull();
  });

  it('a rollout that started before the window stays out even though its retained tail is inside it', () => {
    rollout('rollout-2026-10-07T10-30-00-thread-8.jsonl', { meta: { id: 'thread-8', cwd: '/lanes/lane-1', timestamp: at(-90) } });
    const { records } = collectCodexFrictions(window, { env: env(), home: root, maxBytes: cap });
    expect(records).toHaveLength(0);
  });

  it('an oversized agy judge transcript keeps its review kind from the init row at the head', () => {
    const dir = join(root, 'agy');
    const rows = [{ event: 'init', timestamp: at(1), init: { cwd: '/w/judge-seat' } }, ...Array.from({ length: 400 }, (_, i) => ({ event: 'noise', timestamp: at(2), pad: `${i} ${'x'.repeat(200)}` }))];
    const file = write(join(dir, 'a.jsonl'), jsonl(rows));
    fs.utimesSync(file, new Date(at(10)), new Date(at(10)));
    const { records } = collectAgyFrictions(window, { env: { WE_CORONER_AGY_TRANSCRIPTS: dir }, home: root, maxBytes: cap });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ kind: 'review', truncatedHead: true });
  });

  it('head reads are bounded and drop a partial last line', () => {
    const file = write(join(root, 'h.jsonl'), jsonl([{ n: 1 }, { n: 2, pad: 'y'.repeat(600) }, { n: 3 }]));
    expect(readHeadRows(file, { maxBytes: 100 }).map((r) => r.n)).toEqual([1]);
    expect(readHeadRows(file, { maxBytes: 4096 }).map((r) => r.n)).toEqual([1, 2, 3]);
    expect(readHeadRows(join(root, 'missing.jsonl'))).toEqual([]);
  });
});

describe('bounded tail read', () => {
  it('reads only the tail through the agent-health reader and flags the dropped head', () => {
    const file = write(join(root, 'big.jsonl'), Array.from({ length: 20000 }, (_, i) => JSON.stringify({ type: 'assistant', n: i, pad: 'x'.repeat(100) })).join('\n') + '\n');
    const read = readTranscriptRows(file, { maxBytes: 64 * 1024 });
    expect(fs.statSync(file).size).toBeGreaterThan(2_000_000);
    expect(read.truncatedHead).toBe(true);
    expect(read.bytes).toBeLessThanOrEqual(64 * 1024);
    expect(read.rows.length).toBeLessThan(700);
    expect(read.rows.at(-1).n).toBe(19999);
  });
});

describe('build outcomes and groups', () => {
  it('reports the recorded result per kind x executor and keeps code and card-only apart', () => {
    const rows = [
      { launchKind: 'build', executor: 'claude', status: 'applied', outcome: 'pr-opened', pr: 4339, error: null },
      { launchKind: 'build', executor: 'claude', status: 'failed', outcome: 'orphan-released', pr: null, error: 'build-dispatch-orphan-adopt: dispatch retired (orphan-released)' },
      { launchKind: 'build', executor: 'codex', status: 'failed', outcome: 'wrapper-threw', pr: null, error: 'Command failed: node scripts/lane-pool.mjs acquire --purpose=x' },
      { launchKind: 'build', executor: 'claude', status: 'applied', outcome: 'pr-opened', pr: 4400, error: null },
    ];
    const s = summarizeBuildOutcomes(rows, { prKinds: { 4400: 'card-only' } });
    expect(s.byKindExecutor['build/claude'].outcomes).toEqual({ 'orphan-released': 1, 'pr-opened': 2 });
    expect(s.byKindExecutor['build/claude'].legacyOrphanReleased).toBe(1);
    expect(s.byKindExecutor['build/codex'].laneFailures).toEqual({ 'lane-acquire-failed': 1 });
    expect(s.byPrKind['card-only']['build/claude'].outcomes).toEqual({ 'pr-opened': 1 });
    expect(s.byPrKind.code['build/claude'].outcomes).toEqual({ 'orphan-released': 1, 'pr-opened': 1 });
  });

  it('groups by kind x executor and separates card-only PRs', () => {
    const base = { toolDenials: {}, laneFailures: {}, examples: [], gaps: {}, steps: {}, reruns: 0, retriesAfterError: 0, verifyRequests: 0, openPrRuns: 0, toolErrors: 0, guardBlocks: 0, permissionDenied: 0, admissionEperm: 0, outcomeLine: '' };
    const f = buildFrictions([
      { ...base, session: 'a', kind: 'build', executor: 'codex', sandboxEperm: 1, admissionEperm: 1, friction: 1, pr: null },
      { ...base, session: 'b', kind: 'fix', executor: 'claude', sandboxEperm: 0, friction: 0, pr: 9 },
    ], { prKinds: { 9: 'card-only' } });
    expect(f.headline.codex).toMatchObject({ builds: 1, sandboxEpermBlocked: 1, admissionEpermBlocked: 1 });
    expect(Object.keys(f.byKindExecutor)).toEqual(['build/codex', 'fix/claude']);
    expect(Object.keys(f.byPrKind['card-only'])).toEqual(['fix/claude']);
    expect(Object.keys(f.byPrKind.code)).toEqual(['build/codex']);
  });
});

describe('coroner run over fixture sessions', () => {
  let env;
  beforeEach(() => {
    env = Object.fromEntries(['JOBS', 'JOBS_ARCHIVE', 'PROJECTS', 'DAEMON_DIR', 'VERIFY_LOG', 'ADMISSION', 'LANES', 'STATE', 'COORD', 'BACKLOG', 'CODEX_SESSIONS', 'AGY_TRANSCRIPTS', 'CODEX_PILOT', 'OPS_ROOTS'].map((k) => [`WE_CORONER_${k}`, join(root, k.toLowerCase())]));
  });

  it('puts per-build EPERM blocks and lane-already-leased counts in the frictions section', () => {
    const job = (id, name, file) => write(join(env.WE_CORONER_JOBS, id, 'state.json'), { name, sessionId: id, state: 'completed', createdAt: since, updatedAt: at(30), linkScanPath: file });
    job('c1', 'conveyor-4382', write(join(root, 't', 'c1.jsonl'), jsonl(claudeBuild())));
    job('c2', 'conveyor-5189', write(join(root, 't', 'c2.jsonl'), jsonl([use('1', 'Bash', { command: 'node scripts/lane-pool.mjs acquire' }, 0), res('1', '✗ lane-2 is leased by Mac:31804 (ledger-g1)', 0.1, true), say('not started: lane leased', 0.2)])));
    const sessions = join(env.WE_CORONER_CODEX_SESSIONS, '2026/10/07');
    for (const n of [1, 2]) {
      write(join(sessions, `rollout-2026-10-07T12-0${n}-00-thread-${n}.jsonl`), jsonl([
        { timestamp: at(n), type: 'session_meta', payload: { id: `thread-${n}`, cwd: '/lanes/lane-1', timestamp: at(n) } },
        { timestamp: at(n), type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c1', input: 'tools.exec_command({cmd:"node heavy-admission.mjs run -- npx vitest"})' } },
        { timestamp: at(n + 1), type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c1', output: "EPERM: operation not permitted, mkdir '/w/.lanes/.admission/heavy/a'" } },
        { timestamp: at(n + 2), type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'blocked on EPERM' } },
      ]));
      write(join(env.WE_CORONER_OPS_ROOTS, 'codex-delivery-threads', `conveyor-460${n}.json`), { sessionSlug: `conveyor-460${n}`, threadId: `thread-${n}`, at: at(n) });
    }
    write(join(env.WE_CORONER_COORD, 'build-dispatch-runs', 'dispatch-lane-x.json'), { id: 'dispatch-lane-x', input: { num: '4602' }, effects: [{ dispatch: { launchKind: 'build', executor: 'codex' }, status: 'applied', result: { outcome: 'blocked-mid-build' }, startedAt: at(2) }] });
    const { metrics } = runCoroner([`--since=${since}`, '--json', '--no-save'], { env: { ...env, WE_CORONER_OPS_ROOTS: env.WE_CORONER_OPS_ROOTS }, home: root, now: until });
    expect(metrics.frictions.headline.codex).toMatchObject({ builds: 2, sandboxEpermBlocked: 2, admissionEpermBlocked: 2, sandboxEpermEvents: 2 });
    expect(metrics.frictions.headline.claude).toMatchObject({ builds: 2, laneAlreadyLeasedBuilds: 2 });
    expect(metrics.frictions.byKindExecutor['build/codex'].outcomeLines[0].line).toBe('blocked on EPERM');
    expect(metrics.frictions.byKindExecutor['build/claude'].steps.verifyWait).toMatchObject({ n: 1, medianMin: 8 });
    expect(metrics.buildOutcomes.byKindExecutor['build/codex'].outcomes).toEqual({ 'blocked-mid-build': 1 });
    expect(JSON.stringify(metrics)).not.toContain('ghp_abcdefghijkl');
  });
});

beforeEach(() => { root = fs.mkdtempSync(join(tmpdir(), 'coroner-tr-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });
