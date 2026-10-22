import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { analyzeOrchestratorTurns, collectOrchestratorSessions, CORRECTION_PATTERNS, SCHEDULED_PROMPT_MARKERS, WRONG_PREMISE_PATTERN } from '../coroner-orchestrator.mjs';
import { redact } from '../coroner-transcripts.mjs';

const window = { since: '2026-10-20T12:00:00.000Z', until: '2026-10-20T13:00:00.000Z' };
const at = (n) => new Date(Date.parse(window.since) + n * 60000).toISOString();
const turn = (type, content, n = 1, extra = {}) => ({ type, timestamp: at(n), message: { content }, ...extra });
const assistant = (s, n, extra = {}) => turn('assistant', [{ type: 'text', text: s }], n, extra);
const toolResult = (s, n, id = 'worker') => turn('user', [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: s }] }], n);
const toolCall = (name, id, n = 0) => turn('assistant', [{ type: 'tool_use', name, id, input: {} }], n);
// Redacted reports from the live session; no real transcripts or operator paths are read.
const workerStops = [
  'I stopped before building anything: the brief rests on a wrong premise.',
  "the brief's premise was slightly off.",
  "I didn't build the fix: its premise turned out to be wrong for #5502",
  'The premise was wrong.',
  'The brief rests on a false premise.',
];
const notification = (result) => `<task-notification><summary>Wrong premise</summary><result>${result}</result></task-notification>`;
let root, env;
function write(file, data) { fs.mkdirSync(dirname(file), { recursive: true }); fs.writeFileSync(file, data); return file; }
function session(id, rows) {
  return write(join(env.WE_CORONER_ORCH_DIR, `${id}.jsonl`), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}
const collect = (options = {}) => collectOrchestratorSessions(window, { env, home: root, ...options });
beforeEach(() => {
  root = fs.mkdtempSync(join(tmpdir(), 'coroner-orch-'));
  env = {
    WE_CORONER_ORCH_DIR: join(root, 'sessions'), RULINGS_DIGEST_PATH: join(root, 'rulings.md'),
    FIX_READY_STORE: join(root, 'fix-ready.jsonl'), HEALTH_WATCH_SELF_SYNC_DIR: join(root, 'sync'), WE_CORONER_NO_CI: '1',
  };
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('orchestrator facts', () => {
  it('detects bounded patterns, ignores injected users and tools, and captures the last assistant text', () => {
    const result = analyzeOrchestratorTurns([
      turn('assistant', [{ type: 'text', text: 'First claim' }, { type: 'text', text: 'Last claim' }]),
      toolResult('Why stop? wrong', 2),
      turn('user', '<system-reminder>Why stop?</system-reminder>', 3),
      turn('user', 'Caveat: wrong command-output', 4),
      turn('user', '<local-command-stdout>wrong</local-command-stdout>', 5),
      turn('user', 'Why? We ruled R12 again?', 6),
      turn('user', 'Careful', 7),
      turn('user', 'stopping wrongly somewhere', 8),
    ], { window });
    expect(result.corrections).toHaveLength(2);
    expect(result.corrections[0]).toMatchObject({ at: at(6), atEt: '08:06', quote: 'Why? We ruled R12 again?', priorClaim: 'Last claim', digestIds: ['R12'] });
    expect(result.corrections[1].priorClaim).toBe('');
    expect(result.wastedTurns.map((t) => t.kind)).toEqual(['corrected-claim']);
    expect(CORRECTION_PATTERNS.every((p) => p instanceof RegExp)).toBe(true);
  });

  it('detects every requested correction phrase and matches at least four ruling words at 60 percent', () => {
    const phrases = ['WHY', "didn't we", 'did not we', 'you could not', "you couldn't", 'I thought', 'careful', 'wrong', 'not what I', 'we ruled', 'we said', 'again?', 'stop'];
    const result = analyzeOrchestratorTurns([
      ...phrases.map((s) => turn('user', s)),
      turn('user', 'Careful: always prove live runtime behavior R8'),
    ], { window, digestIds: [
      { id: 'R1', quote: 'always prove live runtime behavior before loading' },
      { id: 'R2', quote: 'prove live' },
      { id: 'R3', quote: 'build inspect ship code elsewhere' },
    ] });
    expect(result.corrections).toHaveLength(14);
    expect(result.corrections.at(-1).digestIds).toEqual(['R1', 'R8']);
    expect(result.rulingMisses.map((r) => [r.id, r.count])).toEqual([['R1', 1], ['R8', 1]]);
  });

  it('counts only Agent/Task tool reports, excluding assistant brief quotes and other tools', () => {
    const result = analyzeOrchestratorTurns([
      ...workerStops.map((s) => assistant(s, 1)),
      toolCall('Bash', 'shell'), toolResult(workerStops[0], 2, 'shell'),
      toolResult(workerStops[0], 2, 'unknown'),
      toolCall('Agent', 'agent'), toolResult(workerStops[1], 3, 'agent'),
      toolCall('Task', 'task'), toolResult(workerStops[2], 4, 'task'),
    ], { window });
    expect(result.wastedTurns.map((t) => t.kind)).toEqual(['wrong-premise', 'wrong-premise']);
    expect(result.wastedTurns.map((t) => t.quote)).toEqual(workerStops.slice(1, 3));
    expect(result.corrections).toEqual([]);
  });

  it.each(['string', 'text blocks'])('scans notification results in %s without corrections or queue duplicates', async (shape) => {
    const rows = workerStops.flatMap((s, i) => {
      const body = notification(s);
      return [
        { type: 'queue-operation', operation: 'enqueue', timestamp: at(i + 1), content: body },
        turn('user', shape === 'string' ? body : [{ type: 'text', text: 'Worker report follows' }, { type: 'text', text: body }], i + 1),
      ];
    });
    rows.push(turn('user', notification('Completed successfully; no changes needed.'), 10));
    session('main', rows);
    for (const result of [analyzeOrchestratorTurns(rows, { window }), (await collect()).totals]) {
      expect(result.corrections).toEqual([]);
      expect(result.wastedTurns.map((t) => t.quote)).toEqual(workerStops);
      expect(result.wastedTurns.every((t) => t.kind === 'wrong-premise')).toBe(true);
    }
    for (const s of workerStops) expect(WRONG_PREMISE_PATTERN.test(s)).toBe(true);
  });

  it('skips meta and scheduled loop prompts without consuming real user turns or the prior claim', async () => {
    const rows = [
      { type: 'system', subtype: 'compact_boundary', timestamp: at(0) },
      assistant('Earlier claim', 1),
      ...Array.from({ length: 7 }, () => turn('user', 'Why stop? Wrong premise', 2, { isMeta: true })),
      turn('user', 'PR movement sweep: why stop again?', 3),
      turn('user', [{ type: 'text', text: 'PR movement sweep: wrong' }], 4),
      turn('user', 'Why stop?', 5),
    ];
    session('main', rows);
    for (const result of [analyzeOrchestratorTurns(rows, { window }), (await collect()).totals]) {
      expect(result.corrections).toHaveLength(1);
      expect(result.corrections[0].priorClaim).toBe('Earlier claim');
      expect(result.lostAfterCompaction).toBe(1);
      expect(result.wastedTurns.map((t) => t.kind)).toEqual(['corrected-claim']);
    }
    expect(SCHEDULED_PROMPT_MARKERS).toContain('PR movement sweep');
  });

  it.each([
    ["Didn't we rule that any blocker are either debug or prototype", 'Didn’t we rule that any blocker are either debug or prototype'],
    ['Didn’t we rule that any blocker are either debug or prototype', "Didn't we rule that any blocker are either debug or prototype"],
    ['‘alpha’ “beta” gamma delta', "'alpha' \"beta\" gamma delta"],
  ])('normalizes curly punctuation in both digest and correction words: %s', (digestQuote, correction) => {
    const result = analyzeOrchestratorTurns([turn('user', correction.startsWith('Did') ? correction : `Careful ${correction}`)], {
      window, digestIds: [{ id: 'R1', quote: digestQuote }],
    });
    expect(result.corrections[0].digestIds).toEqual(['R1']);
  });

  it('de-duplicates streamed usage by message id, accepting a later cumulative update within the window', () => {
    const usage = (output) => ({ id: 'msg-1', content: [], usage: { input_tokens: 10, output_tokens: output, cache_read_input_tokens: 20, cache_creation_input_tokens: 30 } });
    const result = analyzeOrchestratorTurns([
      turn('assistant', '', -1, { message: usage(1000) }),
      turn('assistant', '', 1, { message: usage(2) }),
      turn('assistant', '', 2, { message: usage(2) }),
      turn('assistant', '', 3, { message: usage(5) }),
      turn('assistant', '', 60, { message: { ...usage(1000), id: 'outside' } }),
    ], { window });
    expect(result.tokens).toEqual({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 20, cache_creation_input_tokens: 30 });
  });

  it('tracks six real user turns after compact markers, with overlapping fallout counted once', () => {
    const result = analyzeOrchestratorTurns([
      { type: 'system', subtype: 'compact_boundary', timestamp: at(0) },
      turn('user', 'This session is being continued from a previous conversation', 1, { isCompactSummary: true }),
      toolResult('ordinary tool result', 2),
      turn('user', '<system-reminder>wrong</system-reminder>', 2),
      ...Array.from({ length: 7 }, (_, i) => turn('user', 'Careful', i + 3)),
    ], { window });
    expect(result.compactions).toHaveLength(2);
    expect(result.compactions.map((c) => c.correctionsAfter.length)).toEqual([6, 6]);
    expect(result.lostAfterCompaction).toBe(6);
    expect(result.frictions.find((f) => f.kind === 'lost-after-compaction').count).toBe(6);
  });

  it('redacts secrets, strips paths and caps all published quotes', () => {
    const secret = 'sk-ant-api03-' + 'a'.repeat(60);
    const s = `Wrong /Users/operator/private.txt /private/tmp/result token=${secret} ${'words '.repeat(80)}`;
    const result = analyzeOrchestratorTurns([assistant(s, 1), turn('user', s, 2)], { window });
    for (const q of [result.corrections[0].quote, result.corrections[0].priorClaim, ...result.wastedTurns.map((t) => t.quote), ...result.frictions.flatMap((f) => f.examples)]) {
      expect(q.length).toBeLessThanOrEqual(160);
      expect(q).toBe(redact(q));
      expect(q.includes(secret)).toBe(false);
      expect(q.includes('/Users/')).toBe(false);
      expect(q.includes('/private/')).toBe(false);
    }
  });
});

describe('streaming collection', () => {
  it.each(['stat', 'open', 'read'])('reports transcript %s EACCES errors without exposing paths or error messages', async (stage) => {
    const file = session('denied', [turn('user', 'Wrong', 1)]);
    session('readable', [turn('user', 'Careful', 2)]);
    const denied = () => Object.assign(new Error(`private evidence: ${file}`), { code: 'EACCES' });
    const io = { ...fs,
      statSync(path, ...args) {
        if (path === file && stage === 'stat') throw denied();
        return fs.statSync(path, ...args);
      },
      createReadStream(path, options) {
        if (path !== file || stage === 'stat') return fs.createReadStream(path, options);
        if (stage === 'open') return fs.createReadStream(path, { ...options, fs: {
          ...fs, open(_path, _flags, _mode, callback) { queueMicrotask(() => callback(denied())); },
        } });
        let started = false;
        return new Readable({ read() {
          if (started) return;
          started = true;
          this.push(JSON.stringify(turn('user', 'Wrong partial evidence', 1)) + '\n');
          setImmediate(() => this.destroy(denied()));
        } });
      },
    };
    const report = await collect({ io });
    expect(report.errors).toEqual([{ file: 'denied.jsonl', code: 'EACCES' }]);
    expect(report.partial).toBe(true);
    expect(report.sessions.map((s) => s.id)).toEqual(['readable']);
    expect(report.totals.corrections.map((c) => c.quote)).toEqual(['Careful']);
    expect(JSON.stringify(report)).not.toContain('private evidence');
    expect(JSON.stringify(report)).not.toContain(root);
  });

  it('ignores an absent explicit session candidate but records a discovered file disappearing', async () => {
    const absent = await collect({ sessionId: 'absent' });
    expect(absent).toMatchObject({ sessions: [], errors: [], partial: false });
    const io = { ...fs, readdirSync(dir, ...args) {
      return dir === env.WE_CORONER_ORCH_DIR ? ['vanished.jsonl'] : fs.readdirSync(dir, ...args);
    } };
    expect(await collect({ io })).toMatchObject({ errors: [{ file: 'vanished.jsonl', code: 'ENOENT' }], partial: true });
  });

  it('bounds bytes per file and across files, publishing small truncated reports', async () => {
    const rows = Array.from({ length: 2000 }, (_, i) => turn('user', `Wrong ${i}`, 1));
    const file = session('a', rows);
    session('b', rows);
    session('c', rows);
    const prefix = fs.readFileSync(file).subarray(0, 2048);
    const report = await collect({ env: { ...env, WE_CORONER_ORCH_FILE_CAP: '2048', WE_CORONER_ORCH_TOTAL_CAP: '3072' } });
    expect(report.sessions.map((s) => s.truncated)).toEqual([true, true, true]);
    expect(report.totals.truncated).toBe(true);
    expect(report.sessions[0].corrections).toHaveLength(prefix.toString().split('\n').length - 1);
    expect(report.sessions[2].corrections).toEqual([]);
    expect(JSON.stringify(report).length).toBeLessThan(15000);
  });

  it('retains the latest capped facts per session and in totals with dropped counts', async () => {
    const rows = Array.from({ length: 120 }, (_, i) => [
      { type: 'system', subtype: 'compact_boundary', timestamp: at(1) },
      assistant(`Claim ${i}`, 1), turn('user', `Wrong ${i}`, 1),
    ]).flat();
    session('a', rows);
    session('b', rows);
    const report = await collect();
    for (const s of report.sessions) {
      expect(s.corrections).toHaveLength(100);
      expect(s.corrections[0].quote).toBe('Wrong 20');
      expect(s.corrections.at(-1).quote).toBe('Wrong 119');
      expect(s.wastedTurns).toHaveLength(100);
      expect(s.compactions).toHaveLength(50);
      expect(s.dropped).toEqual({ corrections: 20, wastedTurns: 20, compactions: 70 });
    }
    expect(report.totals.corrections).toHaveLength(100);
    expect(report.totals.wastedTurns).toHaveLength(100);
    expect(report.totals.compactions).toHaveLength(50);
    expect(report.totals.dropped).toEqual({ corrections: 140, wastedTurns: 140, compactions: 190 });
    for (const s of [...report.sessions, report.totals]) {
      expect(s.frictions.every((f) => f.examples.length <= 3)).toBe(true);
    }
    expect(JSON.stringify(report).length).toBeLessThan(350000);
  });

  it('falls back to dated digest quotes and matches the full correction before truncating it', async () => {
    const correction = '...I thought we just had a separate track to bring all to main but that the prototype was beeing kept as the place to run. Didn’t we rule that any blocker are either debug or prototype';
    write(env.RULINGS_DIGEST_PATH, [
      '# R99 | 2026-10-20 | S:rulings-check | "I thought we just had a separate track to bring all to main" | Ignore comment',
      'R1 | 2026-10-20 | S:rulings-check | "Didn\'t we rule that any blocker are either debug or prototype" | Isolate blockers before production dispatch',
      'R2 | 2026-10-20 | policy | “Unrelated words stay separate” | Unrelated rule',
    ].join('\n'));
    session('main', [turn('user', correction)]);
    const result = (await collect()).totals;
    expect(result.corrections).toHaveLength(1);
    expect(result.corrections[0].digestIds).toEqual(['R1']);
    expect(result.corrections[0].quote.length).toBeLessThanOrEqual(160);
    expect(result.rulingMisses.map((r) => r.id)).toEqual(['R1']);
  });

  it('keeps Agent/Task call provenance across streaming rows, including calls before the window', async () => {
    session('main', [
      toolCall('Agent', 'agent', -1), toolResult(workerStops[0], 1, 'agent'),
      toolCall('Task', 'task', 2), toolResult(workerStops[1], 3, 'task'),
      assistant(workerStops[2], 4), toolCall('Bash', 'shell', 5), toolResult(workerStops[2], 6, 'shell'),
    ]);
    const result = (await collect()).totals;
    expect(result.wastedTurns.map((t) => t.quote)).toEqual(workerStops.slice(0, 2));
    expect(result.corrections).toEqual([]);
  });
  it('skips an oversized line before parsing and includes the valid lines on both sides, including EOF', async () => {
    const file = session('main', [assistant('A claim', 1)]);
    fs.appendFileSync(file, JSON.stringify(turn('user', 'Why ' + 'x'.repeat(4 * 1024 * 1024), 2)) + '\n');
    fs.appendFileSync(file, JSON.stringify(turn('user', 'Why R9?', 3)));
    // A streaming-only IO rejects any attempt to read a transcript wholesale.
    const io = { ...fs, readFileSync(file, ...args) {
      if (file.endsWith('.jsonl')) throw new Error('whole transcript read');
      return fs.readFileSync(file, ...args);
    } };
    const report = await collect({ io });
    expect(report.sessions[0].corrections).toHaveLength(1);
    expect(report.sessions[0].corrections[0].priorClaim).toBe('A claim');
  });

  it('leaves coverage unjudged and offers digest S checks only as candidates', async () => {
    write(env.RULINGS_DIGEST_PATH, '| R1 | S:prototype-first-load | Load a prototype before production dispatch |\n| R7 | S:rulings-check | Inject digest after compaction |\n');
    session('main', [
      { type: 'system', subtype: 'compact_boundary', timestamp: at(0) },
      turn('user', notification('The brief rests on a wrong premise'), 1),
      turn('user', 'Why R7?', 2),
    ]);
    const { frictions } = await collect();
    expect(frictions.every((f) => f.status === 'UNJUDGED')).toBe(true);
    const candidates = Object.fromEntries(frictions.map((f) => [f.kind, f.candidateCoveredBy]));
    expect(candidates['operator-correction']).toBeUndefined();
    expect(candidates['ruling-miss']).toBe('R7');
    expect(candidates['wrong-premise-stop']).toBe('R1');
    expect(candidates['lost-after-compaction']).toBe('R7');
  });

  it('filters old files and session ids, ignores nested workers, and preserves preceding window context', async () => {
    session('main', [
      { type: 'system', subtype: 'compact_boundary', timestamp: at(-3) },
      turn('user', 'Continue', -2), assistant('Earlier claim', -1), turn('user', 'Wrong', 1),
      turn('user', 'Wrong', 60),
    ]);
    const old = session('old', [turn('user', 'Wrong', 1)]);
    fs.utimesSync(old, new Date(at(-5)), new Date(at(-5)));
    session('nested/worker', [turn('user', 'Wrong', 1)]);
    expect((await collect()).sessions.map((s) => s.id)).toEqual(['main']);
    const report = await collect({ sessionId: 'main' });
    expect(report.totals.corrections[0].priorClaim).toBe('Earlier claim');
    expect(report.totals.corrections).toHaveLength(1);
    expect(report.totals.lostAfterCompaction).toBe(1);
    await expect(collect({ sessionId: '../main' })).rejects.toThrow('invalid orchestrator session id');
    expect(await collect({ env: { ...env, WE_CORONER_NO_ORCH: '1' } })).toBe(null);
  });

  it('derives the project slug from the repo root', async () => {
    const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
    const projects = join(root, 'projects');
    write(join(projects, repo.replaceAll('/', '-'), 'derived.jsonl'), JSON.stringify(turn('user', 'Why?', 1)));
    const report = await collect({ env: { ...env, WE_CORONER_ORCH_DIR: '', WE_CORONER_PROJECTS: projects } });
    expect(report.sessions.map((s) => s.id)).toEqual(['derived']);
  });

  it('counts unique adopted fixes and merged PRs once across sessions with one bounded gh call', async () => {
    const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2, cache_creation_input_tokens: 3 };
    for (const id of ['a', 'b']) session(id, [turn('assistant', '', 1, { message: { id: 'same-id-in-different-sessions', usage } })]);
    write(env.FIX_READY_STORE, [
      { sha: 'abcdef123456', at: at(1) }, { sha: 'abcdef123456', at: at(2) }, { sha: 'not-adopted', at: at(2) }, { sha: 'old-fix', at: at(-1) },
    ].map((r) => JSON.stringify(r)).join('\n'));
    write(join(env.HEALTH_WATCH_SELF_SYNC_DIR, 'daemon.rebuild.json'), JSON.stringify({ adopted: { at: at(3), applied: [{ sha: 'abcdef1' }] }, candidate: { applied: [{ sha: 'not-adopted' }] } }));
    const calls = [];
    const gh = (args) => { calls.push(args); return [{ number: 1, mergedAt: at(1) }, { number: 1, mergedAt: at(1) }, { number: 2, mergedAt: at(60) }]; };
    const report = await collect({ env: { ...env, WE_CORONER_NO_CI: '' }, gh });
    expect(calls).toHaveLength(1);
    expect(report.totals.tokensPerOutcome).toMatchObject({ mergedPrs: 1, loadedFixes: 1, outcomes: 2, tokensPerOutcome: 20, outcomesPartial: false });
    expect(report.totals.tokens.input_tokens).toBe(20);
    calls.length = 0;
    const skipped = await collect({ gh });
    expect(calls).toHaveLength(0);
    expect(skipped.totals.tokensPerOutcome).toMatchObject({ mergedPrs: null, outcomes: 1, outcomesPartial: true });
    const failed = await collect({ env: { ...env, WE_CORONER_NO_CI: '' }, gh: () => { throw new Error('offline'); } });
    expect(failed.totals.tokensPerOutcome.mergedPrs).toBe(null);
  });

  it('counts by adoption time, including earlier readiness and SHA prefixes in either direction', async () => {
    write(env.FIX_READY_STORE, [
      { sha: 'abcdef123456', at: at(1) },
      { sha: '1234567', at: at(-60) },
      { sha: 'fedcba987654', at: at(-60) },
      { sha: 'abcdef', at: at(1) },
      { sha: '7654321', at: at(1) },
    ].map((r) => JSON.stringify(r)).join('\n'));
    const adoption = (name, time, shas) => write(join(env.HEALTH_WATCH_SELF_SYNC_DIR, `${name}.rebuild.json`),
      JSON.stringify({ adopted: { at: time, applied: shas.map((sha) => ({ sha })) } }));
    adoption('tomorrow', at(24 * 60), ['abcdef1']);
    adoption('today', at(0), ['123456789abc', 'fedcba9']);
    adoption('duplicate', at(5), ['123456789abc']);
    adoption('boundary', at(60), ['7654321']);
    adoption('undated', undefined, ['7654321']);
    expect((await collect()).totals.tokensPerOutcome.loadedFixes).toBe(2);
    const tomorrow = { since: at(24 * 60), until: at(24 * 60 + 60) };
    expect((await collectOrchestratorSessions(tomorrow, { env, home: root })).totals.tokensPerOutcome.loadedFixes).toBe(1);
  });
});
