/**
 * @file codex-judge-spawn.test.mjs — the Codex `JudgeProvider`'s argv/parsing/error-mapping contract, proved
 * WITHOUT spawning anything (#xqa9ttq, mirroring `judge-spawn.test.mjs`'s own split for `judgeSpawn`).
 *
 * Every shape asserted here traces to a specific `#3371` probe — this file's own `describe` titles name which
 * one, so a reader does not have to cross-reference the probe record to see what a given test is pinning.
 */

import {
  describe, it, expect, vi,
} from 'vitest';
import {
  existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// #3383 mechanical-dispatcher Bug 2 fix — `codexJudgeSpawn` now calls `recordCodexRunScorecard` (real default:
// `../conveyor/run-quality-record.mjs`) after every real spawn. That real default's own real default, in
// turn, appends to the real shared scorecard store (`we:scripts/conveyor/run-scorecard-store.mjs`) — exactly the kind of disk side
// effect this suite (and every other suite that exercises `codexJudgeSpawn` without naming its own
// `recordScorecard` override) must never touch. Mocked at the MODULE level, once, rather than threading a
// `recordScorecard: vi.fn()` override into every one of this file's many direct `codexJudgeSpawn({...})`
// calls — the dedicated `recordCodexRunScorecard` coverage lives in `run-quality-record.test.mjs`, not here.
vi.mock('../../conveyor/run-quality-record.mjs', () => ({ recordCodexRunScorecard: vi.fn(() => null) }));
import {
  CODEX_CLI,
  CODEX_EFFORT_MAP,
  CODEX_MODEL,
  CODEX_SPAWN_ENV_ALLOWLIST,
  CodexInvalidSchemaError,
  assertNoCodexToolAllowlist,
  buildCodexJudgeArgv,
  buildCodexPrompt,
  parseCodexJudgeOutcome,
  codexLoadedContextTokens,
  codexJudgeSpawn,
  defaultCodexSpawnEnv,
  requireAllProperties,
  stripNulls,
  resolveCodexJudgeTranscriptDir,
  extractCodexJudgeThreadId,
  persistCodexJudgeTranscript,
} from '../codex-judge-spawn.mjs';
import { JudgeTimeoutError } from '../judge-spawn.mjs';

const SHAPE = {
  type: 'object',
  properties: { verdict: { type: 'string', enum: ['accept', 'reject'] }, finding: { type: 'string' } },
  required: ['verdict', 'finding'],
  additionalProperties: false,
};

describe('CODEX_CLI', () => {
  it('is the codex binary — named once, exactly like judge-spawn.mjs#JUDGE_CLI', () => {
    expect(CODEX_CLI).toBe('codex');
  });
});

describe('buildCodexJudgeArgv — the argv translation, per #3371\'s table', () => {
  const base = { schemaFile: '/tmp/schema.json', outputLastMessageFile: '/tmp/last.txt', cwd: '/tmp/scratch' };

  it('translates exec --json --output-schema <file>, never the Claude flags', () => {
    const argv = buildCodexJudgeArgv(base);
    expect(argv).toEqual([
      'exec', '--json',
      '--output-schema', '/tmp/schema.json',
      '--output-last-message', '/tmp/last.txt',
      '-s', 'read-only',
      '--skip-git-repo-check',
      '--ephemeral',
      '-C', '/tmp/scratch',
      // #3635 Fork 1 — the pin is part of the BASELINE argv now, not an optional tail.
      '-m', 'gpt-6.1-sol', '-c', 'model_reasoning_effort=medium',
    ]);
    expect(argv.join(' ')).not.toContain('--json-schema');
    expect(argv.join(' ')).not.toContain('--append-system-prompt');
    expect(argv.join(' ')).not.toContain('--tools');
  });

  it('has NO POSITIONAL PROMPT — probe 0\'s deadlock trap is avoided by never supplying one', () => {
    // The whole argv is a fixed, EVEN number of (flag, value) pairs plus the leading `exec`/`--json` pair —
    // every element is accounted for as a flag or a flag's OWN value. A stray positional prompt would be an
    // odd element out with no flag before it; there is none.
    const argv = buildCodexJudgeArgv(base);
    const FLAGS = new Set(['--json', '--output-schema', '--output-last-message', '-s', '--skip-git-repo-check', '--ephemeral', '-C', '-m', '-c']);
    expect(argv[0]).toBe('exec');
    for (let i = 1; i < argv.length; i += 1) {
      if (FLAGS.has(argv[i])) continue;
      // Not a flag itself: it must be the value immediately following one of the value-taking flags above.
      expect(FLAGS.has(argv[i - 1])).toBe(true);
    }
  });

  // ═════════════════════════════════════════════════════════════════════════════════════════════════════════
  // #3635 Fork 1, RATIFIED — "Every Codex invocation names its model explicitly."
  //
  // THE DEFECT THESE REPLACE. The two tests that used to sit here asserted the OPPOSITE contract: `adds -m
  // <model> only when a model is given` PINNED the omission (`expect(buildCodexJudgeArgv(base)).not
  // .toContain('-m')`). Since no caller in the repo ever passed `model`, that assertion was a green test
  // guarding the exact hole #3635 was opened to close — the judge seat riding `codex exec`'s implicit
  // default, which resolves server-side and is recorded nowhere.
  //
  // These assert the real argv, not merely that the call survives.
  // ═════════════════════════════════════════════════════════════════════════════════════════════════════════

  it('ALWAYS emits -m from the review route when the caller names no model', () => {
    const argv = buildCodexJudgeArgv(base);
    const at = argv.indexOf('-m');
    expect(at, 'the judge seat must never ride the CLI\'s implicit default').toBeGreaterThan(-1);
    expect(argv[at + 1]).toBe('gpt-6.1-sol');
    // The pin is the RATIFIED value, not merely "some string" — a rename of the constant that silently
    // changed the model would still have to face this.
    expect(CODEX_MODEL).toBe('gpt-6-astra');
  });

  it('emits -m exactly ONCE — the pin is a default, never appended on top of a caller\'s model', () => {
    expect(buildCodexJudgeArgv(base).filter((a) => a === '-m')).toHaveLength(1);
    expect(buildCodexJudgeArgv({ ...base, model: 'gpt-5.6-sol' }).filter((a) => a === '-m')).toHaveLength(1);
  });

  it('an explicit model still WINS over the pin — this is a default, not a hardcode', () => {
    const argv = buildCodexJudgeArgv({ ...base, model: 'gpt-5.6-sol' });
    expect(argv[argv.indexOf('-m') + 1]).toBe('gpt-5.6-sol');
    expect(argv).not.toContain(CODEX_MODEL);
  });

  it('trims a padded model rather than sending whitespace as the operand', () => {
    const argv = buildCodexJudgeArgv({ ...base, model: '  gpt-5.6-sol  ' });
    expect(argv[argv.indexOf('-m') + 1]).toBe('gpt-5.6-sol');
  });

  it('REGRESSION — no reachable input makes buildCodexJudgeArgv omit -m', () => {
    // The old contract's own inputs: omitted, and explicitly `undefined`. Both must now carry the pin.
    for (const opts of [base, { ...base, model: undefined }, { ...base, effort: 'high' }]) {
      expect(buildCodexJudgeArgv(opts), JSON.stringify(opts)).toContain('-m');
    }
  });

  it('refuses a model shaped like a flag', () => {
    // Load-bearing: `-x` as `-m`'s operand would be parsed by `codex` as a FLAG, silently changing the
    // command instead of failing it.
    expect(() => buildCodexJudgeArgv({ ...base, model: '-x' })).toThrow(/plain non-empty string/);
  });

  it('refuses an empty or non-string model rather than falling back to the implicit default', () => {
    for (const bad of ['', '   ', null, 42, {}]) {
      expect(() => buildCodexJudgeArgv({ ...base, model: bad }), JSON.stringify(bad))
        .toThrow(/plain non-empty string/);
    }
  });

  it('the pin is the SHARED ratified constant, not a third local copy of the literal', async () => {
    // The whole point of #3635's follow-up: one source, so a re-ratification cannot miss a call site.
    const routing = await import('../codex-model-routing.mjs');
    const direct = await import('../../codex-direct-task.mjs');
    const delivery = await import('../../operations/codex-delivery-provider.mjs');
    expect(CODEX_MODEL).toBe(routing.CODEX_MODEL);
    expect(direct.CODEX_MODEL).toBe(routing.CODEX_MODEL);
    expect(delivery.CODEX_DELIVERY_MODEL).toBe(routing.CODEX_MODEL);
  });

  it('maps effort through CODEX_EFFORT_MAP, via -c model_reasoning_effort=…', () => {
    for (const [from, to] of Object.entries(CODEX_EFFORT_MAP)) {
      const argv = buildCodexJudgeArgv({ ...base, effort: from });
      expect(argv).toEqual(expect.arrayContaining(['-c', `model_reasoning_effort=${to}`]));
    }
  });

  it('does NOT clamp xhigh/max/ultra — the map is an identity over every real level', () => {
    // SUPERSEDES `clamps xhigh/max DOWN to high — Codex has no level above it`. That premise was measured and
    // refuted by #3635's 2026-09-12 follow-up: `gpt-6-astra`'s catalogued `supported_reasoning_levels` are
    // `low·medium·high·xhigh·max·ultra`, and a live `codex exec -c model_reasoning_effort=<level>` ping at
    // each of the top three completed normally. The clamp was silently DOWNGRADING an explicit request.
    for (const level of ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']) {
      expect(CODEX_EFFORT_MAP[level], level).toBe(level);
    }
  });

  it('sends the UNCLAMPED level through to the argv, not just through the map', () => {
    for (const level of ['xhigh', 'max', 'ultra']) {
      expect(buildCodexJudgeArgv({ ...base, effort: level }), level)
        .toEqual(expect.arrayContaining(['-c', `model_reasoning_effort=${level}`]));
    }
  });

  it('refuses an unrecognised effort rather than passing it through silently', () => {
    expect(() => buildCodexJudgeArgv({ ...base, effort: 'ludicrous' })).toThrow(/must be one of/);
  });

  it('refuses missing schemaFile/outputLastMessageFile/cwd', () => {
    expect(() => buildCodexJudgeArgv({ ...base, schemaFile: '' })).toThrow(/schemaFile/);
    expect(() => buildCodexJudgeArgv({ ...base, outputLastMessageFile: '' })).toThrow(/outputLastMessageFile/);
    expect(() => buildCodexJudgeArgv({ ...base, cwd: '' })).toThrow(/cwd.*scratch/);
  });
});

describe('buildCodexPrompt — folding the mandate into prompt text (no --append-system-prompt equivalent)', () => {
  it('labels the two parts so a captured transcript can tell them apart', () => {
    const prompt = buildCodexPrompt('BE TERSE', 'THE-DIFF');
    expect(prompt).toContain('BE TERSE');
    expect(prompt).toContain('THE-DIFF');
    expect(prompt.indexOf('BE TERSE')).toBeLessThan(prompt.indexOf('THE-DIFF'));
  });
});

describe('assertNoCodexToolAllowlist — no configurable allow-list, not "tool-free" (probe 9, #3581 sequencing)', () => {
  it('passes for null/undefined/empty', () => {
    expect(() => assertNoCodexToolAllowlist(null)).not.toThrow();
    expect(() => assertNoCodexToolAllowlist(undefined)).not.toThrow();
    expect(() => assertNoCodexToolAllowlist([])).not.toThrow();
  });

  it('refuses any non-empty tool list', () => {
    expect(() => assertNoCodexToolAllowlist(['Read'])).toThrow(/no configurable tool allow-list/);
  });
});

describe('parseCodexJudgeOutcome — JSONL, answer is the LAST message, terminal status is the LAST event', () => {
  it('probe 1 shape: a clean turn.completed, answer from --output-last-message', () => {
    const stdout = [
      JSON.stringify({ type: 'thread.started', thread_id: '01a0-thread' }),
      JSON.stringify({ type: 'turn.started' }),
      JSON.stringify({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: '{"verdict":"reject","finding":"x"}' } }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 10 } }),
    ].join('\n');
    const out = parseCodexJudgeOutcome({ stdout, lastMessage: '{"verdict":"reject","finding":"x"}' });
    expect(out.value).toEqual({ verdict: 'reject', finding: 'x' });
    expect(out.sessionId).toBe('01a0-thread');
    expect(out.costUsd).toBe(0);
    expect(out.stopReason).toBe('turn.completed');
    expect(out.numTurns).toBe(1);
    expect(out.usage).toEqual({ input_tokens: 100, output_tokens: 10 });
  });

  it('probe 4 shape: strips nulls from the answer before returning it', () => {
    const answer = '{"summary":"s","findings":[{"summary":"f","file":null,"line":null,"parallelizable":null}]}';
    const stdout = [
      JSON.stringify({ type: 'thread.started', thread_id: 't' }),
      JSON.stringify({ type: 'turn.completed', usage: {} }),
    ].join('\n');
    const out = parseCodexJudgeOutcome({ stdout, lastMessage: answer });
    expect(out.value).toEqual({ summary: 's', findings: [{ summary: 'f' }] });
  });

  it('probe 7: falls back to the LAST agent_message item when --output-last-message is absent', () => {
    const stdout = [
      JSON.stringify({ type: 'thread.started', thread_id: 't' }),
      JSON.stringify({ type: 'turn.started' }),
      JSON.stringify({ item: { id: 'item_0', type: 'agent_message', text: 'free prose, not the answer' }, type: 'item.completed' }),
      JSON.stringify({ item: { id: 'item_1', type: 'agent_message', text: '{"verdict":"accept","finding":"ok"}' }, type: 'item.completed' }),
      JSON.stringify({ type: 'turn.completed', usage: {} }),
    ].join('\n');
    const out = parseCodexJudgeOutcome({ stdout, lastMessage: null });
    expect(out.value).toEqual({ verdict: 'accept', finding: 'ok' });
  });

  it('probe 5: the TERMINAL event is the LAST one, never the first `error` line in a retry storm', () => {
    const stdout = [
      JSON.stringify({ type: 'thread.started', thread_id: 't' }),
      JSON.stringify({ type: 'turn.started' }),
      JSON.stringify({ type: 'error', message: 'Reconnecting... 2/5 (unexpected status 401 …)' }),
      JSON.stringify({ type: 'error', message: 'Reconnecting... 1/5 (unexpected status 401 …)' }),
      JSON.stringify({ type: 'turn.failed', error: { message: 'unexpected status 401 Unauthorized: Missing bearer …' } }),
    ].join('\n');
    expect(() => parseCodexJudgeOutcome({ stdout, lastMessage: null }))
      .toThrow(/401 Unauthorized/);
    // and NOT the (wrong) first error line's text alone, if a caller matched line 1 instead of the terminal one:
    try {
      parseCodexJudgeOutcome({ stdout, lastMessage: null });
    } catch (e) {
      expect(e.message).toContain('Missing bearer');
      expect(e).not.toBeInstanceOf(CodexInvalidSchemaError);
    }
  });

  it('probe 3: invalid_json_schema 400 is a NEW error class, not a generic failure', () => {
    const schemaError = {
      type: 'error',
      error: {
        type: 'invalid_request_error', code: 'invalid_json_schema',
        message: "In context=('properties', 'findings', 'items'), 'required' is required to be supplied and to be an array including every key in properties. Missing 'file'.",
        param: 'text.format.schema',
      },
      status: 400,
    };
    const stdout = [
      JSON.stringify({ type: 'thread.started', thread_id: 't' }),
      JSON.stringify({ type: 'turn.started' }),
      JSON.stringify({ type: 'turn.failed', error: { message: JSON.stringify(schemaError) } }),
    ].join('\n');
    expect(() => parseCodexJudgeOutcome({ stdout, lastMessage: null })).toThrow(CodexInvalidSchemaError);
    try {
      parseCodexJudgeOutcome({ stdout, lastMessage: null });
    } catch (e) {
      expect(e.schemaMessage).toMatch(/Missing 'file'/);
    }
  });

  it('probe 8: a malformed schema file — empty stdout, reason on stderr only, folded in', () => {
    expect(() => parseCodexJudgeOutcome({ stdout: '', stderr: 'Output schema file <path> is not valid JSON: expected ident at line 1 column 2', lastMessage: null }))
      .toThrow(/not valid JSON/);
  });

  it('no terminal event at all (mid-run) throws a plain Error, distinct from a schema/auth failure', () => {
    const stdout = [
      JSON.stringify({ type: 'thread.started', thread_id: 't' }),
      JSON.stringify({ type: 'turn.started' }),
    ].join('\n');
    expect(() => parseCodexJudgeOutcome({ stdout, lastMessage: null })).toThrow(/no terminal/);
  });

  it('refuses a completed turn whose answer is not valid JSON, despite the schema constraint', () => {
    const stdout = JSON.stringify({ type: 'turn.completed', usage: {} });
    expect(() => parseCodexJudgeOutcome({ stdout, lastMessage: 'not json' })).toThrow(/did not parse as JSON/);
  });
});

describe('codexLoadedContextTokens — Codex\'s own usage key names, distinct from Claude\'s', () => {
  it('sums input_tokens + cached_input_tokens', () => {
    expect(codexLoadedContextTokens({ input_tokens: 100, cached_input_tokens: 50, output_tokens: 10 })).toBe(150);
  });
  it('defaults missing fields to 0', () => {
    expect(codexLoadedContextTokens({})).toBe(0);
    expect(codexLoadedContextTokens()).toBe(0);
  });
});

describe('defaultCodexSpawnEnv — ALLOWLISTED env, not raw process.env (round-2 review, security finding, PR #2115)', () => {
  it('keeps only the allowlisted keys present in the source env', () => {
    const out = defaultCodexSpawnEnv({
      HOME: '/home/x', PATH: '/usr/bin', GITHUB_TOKEN: 'secret-token', ANTHROPIC_API_KEY: 'secret-key',
    });
    expect(out).toEqual({ HOME: '/home/x', PATH: '/usr/bin' });
  });

  it('drops any credential-shaped var not on the allowlist, whatever it is named', () => {
    const out = defaultCodexSpawnEnv({ AWS_SECRET_ACCESS_KEY: 'x', NPM_TOKEN: 'y', SOME_FUTURE_SECRET: 'z' });
    expect(out).toEqual({});
  });

  it('never returns the source object itself', () => {
    const src = { HOME: '/home/x' };
    expect(defaultCodexSpawnEnv(src)).not.toBe(src);
  });

  it('CODEX_SPAWN_ENV_ALLOWLIST names only the vars codex exec needs to run and find its own config', () => {
    expect(CODEX_SPAWN_ENV_ALLOWLIST).toEqual(expect.arrayContaining(['HOME', 'PATH']));
    expect(CODEX_SPAWN_ENV_ALLOWLIST).not.toEqual(expect.arrayContaining(['GITHUB_TOKEN']));
  });

  it('with a scratchHome, HOME points at the scratch dir and CODEX_HOME at the source\'s real Codex dir (~-relative reads of ~/.aws etc. no longer resolve to the real home)', () => {
    expect(defaultCodexSpawnEnv({ HOME: '/home/x', PATH: '/usr/bin', GITHUB_TOKEN: 's' }, { scratchHome: '/tmp/scratch' }))
      .toEqual({ HOME: '/tmp/scratch', PATH: '/usr/bin', CODEX_HOME: '/home/x/.codex' });
  });

  it('an explicit source CODEX_HOME wins', () => {
    expect(defaultCodexSpawnEnv({ HOME: '/home/x', CODEX_HOME: '/opt/codex' }, { scratchHome: '/tmp/s' }))
      .toEqual({ HOME: '/tmp/s', CODEX_HOME: '/opt/codex' });
  });

  it('no HOME and no CODEX_HOME in source -> result has HOME \'/tmp/s\' and NO CODEX_HOME key', () => {
    const out = defaultCodexSpawnEnv({}, { scratchHome: '/tmp/s' });
    expect(out).toEqual({ HOME: '/tmp/s' });
    expect('CODEX_HOME' in out).toBe(false);
  });
});

describe('resolveCodexJudgeTranscriptDir — env override, else the home-dir default (mirrors resolveCodexHome)', () => {
  it('honours CODEX_JUDGE_TRANSCRIPT_DIR when set', () => {
    expect(resolveCodexJudgeTranscriptDir({ CODEX_JUDGE_TRANSCRIPT_DIR: '/tmp/custom-judge-transcripts' }))
      .toBe('/tmp/custom-judge-transcripts');
  });

  it('falls back to a home-dir default when unset/blank', () => {
    expect(resolveCodexJudgeTranscriptDir({})).toMatch(/\.codex-judge-transcripts$/);
    expect(resolveCodexJudgeTranscriptDir({ CODEX_JUDGE_TRANSCRIPT_DIR: '   ' })).toMatch(/\.codex-judge-transcripts$/);
  });
});

describe('extractCodexJudgeThreadId — the thread_id off `thread.started`, independent of parse success', () => {
  it('extracts the thread_id from a clean stream', () => {
    const stdout = [
      JSON.stringify({ type: 'thread.started', thread_id: 'thread-xyz' }),
      JSON.stringify({ type: 'turn.completed', usage: {} }),
    ].join('\n');
    expect(extractCodexJudgeThreadId(stdout)).toBe('thread-xyz');
  });

  it('returns null when there is no thread.started event at all (e.g. a spawn that produced nothing)', () => {
    expect(extractCodexJudgeThreadId('')).toBeNull();
    expect(extractCodexJudgeThreadId(JSON.stringify({ type: 'turn.completed' }))).toBeNull();
  });

  it('still finds the thread_id even when the stream goes on to a turn.failed — the transcript-persistence case', () => {
    const stdout = [
      JSON.stringify({ type: 'thread.started', thread_id: 'thread-failed-run' }),
      JSON.stringify({ type: 'turn.failed', error: { message: 'boom' } }),
    ].join('\n');
    expect(extractCodexJudgeThreadId(stdout)).toBe('thread-failed-run');
  });
});

describe('persistCodexJudgeTranscript — THE FIX: the raw JSONL is written to a durable local file', () => {
  it('writes the exact stdout bytes to <dir>/codex-judge-<threadId>.jsonl and returns that path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-judge-transcript-test-'));
    try {
      const stdout = JSON.stringify({ type: 'thread.started', thread_id: 'sess-1' }) + '\n' + JSON.stringify({ type: 'turn.completed' });
      const file = persistCodexJudgeTranscript({ stdout, threadId: 'sess-1', dir });
      expect(file).toBe(join(dir, 'codex-judge-sess-1.jsonl'));
      expect(readFileSync(file, 'utf8')).toBe(stdout);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falls back to a random `unknown-<id>` name when no threadId is available, never silently dropping the run', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-judge-transcript-test-'));
    try {
      const file = persistCodexJudgeTranscript({ stdout: 'whatever', threadId: null, dir, mkId: () => 'fixed-id' });
      expect(file).toBe(join(dir, 'codex-judge-unknown-fixed-id.jsonl'));
      expect(readFileSync(file, 'utf8')).toBe('whatever');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('creates the directory if it does not exist yet', () => {
    const parent = mkdtempSync(join(tmpdir(), 'codex-judge-transcript-test-'));
    const dir = join(parent, 'nested', 'deeper');
    try {
      const file = persistCodexJudgeTranscript({ stdout: 'x', threadId: 't', dir });
      expect(existsSync(file)).toBe(true);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('NEVER throws — a write failure is a best-effort loss, returning null, not a crashed judge call', () => {
    const boom = () => { throw new Error('disk is full'); };
    expect(() => persistCodexJudgeTranscript({ stdout: 'x', threadId: 't', dir: '/nonexistent', ensureDir: boom }))
      .not.toThrow();
    expect(persistCodexJudgeTranscript({ stdout: 'x', threadId: 't', dir: '/nonexistent', ensureDir: boom })).toBeNull();
  });
});

describe('codexJudgeSpawn — exercised over an injected spawn (real temp files, fake process)', () => {
  /** A fake `child_process.spawn` that writes the last-message file (as the real CLI does) and replays JSONL. */
  function fakeSpawn({ stdout, code = 0, writeLastMessage = null }) {
    const seen = { cli: null, argv: null, opts: null, stdin: '' };
    const fn = (cli, argv, opts) => {
      seen.cli = cli; seen.argv = argv; seen.opts = opts;
      if (writeLastMessage != null) {
        const idx = argv.indexOf('--output-last-message');
        writeFileSync(argv[idx + 1], writeLastMessage);
      }
      const child = {
        stdout: { on: (e, cb) => { if (e === 'data') setTimeout(() => cb(stdout), 0); } },
        stderr: { on: () => {} },
        stdin: { on: () => {}, end: (d) => { seen.stdin = d; } },
        on: (e, cb) => { if (e === 'close') setTimeout(() => cb(code), 1); },
        kill: () => {},
      };
      return child;
    };
    return { fn, seen };
  }

  const okJsonl = [
    JSON.stringify({ type: 'thread.started', thread_id: 'sess-1' }),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } }),
  ].join('\n');

  it('writes the (already-transformed) shape to a real temp schema file the argv points at', async () => {
    let schemaFileSeenDuringSpawn = null;
    const fn = (cli, argv) => {
      const idx = argv.indexOf('--output-schema');
      schemaFileSeenDuringSpawn = JSON.parse(readFileSync(argv[idx + 1], 'utf8'));
      const outIdx = argv.indexOf('--output-last-message');
      writeFileSync(argv[outIdx + 1], '{"verdict":"accept","finding":"ok"}');
      return {
        stdout: { on: (e, cb) => { if (e === 'data') setTimeout(() => cb(okJsonl), 0); } },
        stderr: { on: () => {} },
        stdin: { on: () => {}, end: () => {} },
        on: (e, cb) => { if (e === 'close') setTimeout(() => cb(0), 1); },
        kill: () => {},
      };
    };
    await codexJudgeSpawn({ mandate: 'm', input: 'i', shape: SHAPE, spawnFn: fn });
    expect(schemaFileSeenDuringSpawn).toEqual(SHAPE);
  });

  it('closes stdin via .end() — the exact property probe 0 found safe, with no positional prompt', async () => {
    const { fn, seen } = fakeSpawn({ stdout: okJsonl, writeLastMessage: '{"verdict":"accept","finding":"ok"}' });
    await codexJudgeSpawn({ mandate: 'BE TERSE', input: 'THE-DIFF', shape: SHAPE, spawnFn: fn });
    expect(seen.stdin).toContain('BE TERSE');
    expect(seen.stdin).toContain('THE-DIFF');
    expect(seen.argv.join(' ')).not.toContain('THE-DIFF'); // rode stdin, not argv
  });

  it('returns the thread_id as sessionId, costUsd 0, and the stripped value', async () => {
    const { fn } = fakeSpawn({ stdout: okJsonl, writeLastMessage: '{"verdict":"accept","finding":"ok"}' });
    const r = await codexJudgeSpawn({ mandate: 'm', input: 'i', shape: SHAPE, spawnFn: fn });
    expect(r.sessionId).toBe('sess-1');
    expect(r.costUsd).toBe(0);
    expect(r.value).toEqual({ verdict: 'accept', finding: 'ok' });
    expect(r.timedOut).toBe(false);
    expect(typeof r.wallMs).toBe('number');
    expect(r.argv).toEqual(expect.arrayContaining(['exec', '--json']));
  });

  it('spawns with the ALLOWLISTED env by default, never the raw process.env (round-2 review, security finding, PR #2115)', async () => {
    const priorSecret = process.env.WE_TEST_FIX_2115_SECRET;
    process.env.WE_TEST_FIX_2115_SECRET = 'do-not-leak-me';
    try {
      const { fn, seen } = fakeSpawn({ stdout: okJsonl, writeLastMessage: '{"verdict":"accept","finding":"ok"}' });
      await codexJudgeSpawn({ mandate: 'm', input: 'i', shape: SHAPE, spawnFn: fn });
      expect(seen.opts.env).not.toBe(process.env);
      expect(seen.opts.env.WE_TEST_FIX_2115_SECRET).toBeUndefined();
    } finally {
      if (priorSecret === undefined) delete process.env.WE_TEST_FIX_2115_SECRET;
      else process.env.WE_TEST_FIX_2115_SECRET = priorSecret;
    }
  });

  it('the default child env has a SCRATCH HOME (the temp workDir), not the operator\'s real HOME, and CODEX_HOME still points at the real Codex config dir', async () => {
    const { fn, seen } = fakeSpawn({ stdout: okJsonl, writeLastMessage: '{"verdict":"accept","finding":"ok"}' });
    await codexJudgeSpawn({ mandate: 'm', input: 'i', shape: SHAPE, spawnFn: fn });
    expect(seen.opts.env.HOME).toBe(seen.opts.cwd);
    if (process.env.HOME !== undefined) {
      expect(seen.opts.env.HOME).not.toBe(process.env.HOME);
    }
    expect(seen.opts.env.CODEX_HOME).toBe(process.env.CODEX_HOME || (process.env.HOME ? join(process.env.HOME, '.codex') : undefined));
  });

  it('still honors an explicit `env` override — the allowlist is only the default', async () => {
    const { fn, seen } = fakeSpawn({ stdout: okJsonl, writeLastMessage: '{"verdict":"accept","finding":"ok"}' });
    await codexJudgeSpawn({ mandate: 'm', input: 'i', shape: SHAPE, spawnFn: fn, env: { CUSTOM: 'yes' } });
    expect(seen.opts.env).toEqual({ CUSTOM: 'yes' });
  });

  // #3383 mechanical-dispatcher Bug 2 fix — THE regression test: a real judge call must score + record its
  // own run. `recordScorecard` is overridden here (module-level mock covers every OTHER test in this file);
  // this is the one test that actually asserts the call happens, with the right stamped fields.
  it('scores + records this run via recordScorecard, stamped as the advisory-review role/kind', async () => {
    const { fn } = fakeSpawn({ stdout: okJsonl, writeLastMessage: '{"verdict":"accept","finding":"ok"}' });
    const recordScorecard = () => null;
    let seen = null;
    const spy = (o) => { seen = o; return recordScorecard(o); };
    await codexJudgeSpawn({
      mandate: 'm', input: 'i', shape: SHAPE, model: 'gpt-6-astra', effort: 'medium', spawnFn: fn, recordScorecard: spy,
    });
    expect(seen).toMatchObject({
      dispatchKind: 'advisory-review', kind: 'review', role: 'advisory-review', provider: 'codex',
      model: 'gpt-6-astra', effort: 'medium',
    });
    expect(seen.stdout).toBe(okJsonl);
  });

  it('refuses a tool-bearing request before ever spawning', async () => {
    const { fn } = fakeSpawn({ stdout: okJsonl });
    let called = false;
    const spy = (...a) => { called = true; return fn(...a); };
    await expect(codexJudgeSpawn({ mandate: 'm', input: 'i', shape: SHAPE, allowedTools: ['Read'], spawnFn: spy }))
      .rejects.toThrow(/no configurable tool allow-list/);
    expect(called).toBe(false);
  });

  it('cleans up its temp working directory after the spawn settles', async () => {
    let workDirSeen = null;
    const fn = (cli, argv, opts) => {
      workDirSeen = opts.cwd;
      const outIdx = argv.indexOf('--output-last-message');
      writeFileSync(argv[outIdx + 1], '{"verdict":"accept","finding":"ok"}');
      return {
        stdout: { on: (e, cb) => { if (e === 'data') setTimeout(() => cb(okJsonl), 0); } },
        stderr: { on: () => {} },
        stdin: { on: () => {}, end: () => {} },
        on: (e, cb) => { if (e === 'close') setTimeout(() => cb(0), 1); },
        kill: () => {},
      };
    };
    await codexJudgeSpawn({ mandate: 'm', input: 'i', shape: SHAPE, spawnFn: fn });
    expect(existsSync(workDirSeen)).toBe(false);
  });

  // THE FIX — #3649's run-quality recording mechanism could not score this seat's runs because the raw
  // JSONL was captured only to parse the answer, then discarded. These prove it is now durably persisted,
  // OUTSIDE the temp working directory the test right above proves gets deleted (so the transcript survives
  // that cleanup), keyed by the same thread id the outcome reports as `sessionId`.
  describe('THE FIX — the raw JSONL is now persisted to a durable file, independent of workDir cleanup', () => {
    it('persists the transcript and returns its path as `transcriptFile`, via the real (non-injected) writer', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'codex-judge-transcript-integration-'));
      try {
        const { fn } = fakeSpawn({ stdout: okJsonl, writeLastMessage: '{"verdict":"accept","finding":"ok"}' });
        const r = await codexJudgeSpawn({ mandate: 'm', input: 'i', shape: SHAPE, spawnFn: fn, transcriptDir: dir });
        expect(r.transcriptFile).toBe(join(dir, 'codex-judge-sess-1.jsonl'));
        // THE EXACT SAME BYTES the outcome was parsed from — not a paraphrase, not a summary.
        expect(readFileSync(r.transcriptFile, 'utf8')).toBe(okJsonl);
        // Survives the workDir cleanup the test above proves happens — a DIFFERENT directory entirely.
        expect(existsSync(r.transcriptFile)).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('calls the injected `persistTranscript` with the captured stdout and the extracted thread id', async () => {
      const { fn } = fakeSpawn({ stdout: okJsonl, writeLastMessage: '{"verdict":"accept","finding":"ok"}' });
      const calls = [];
      const persistTranscript = (o) => { calls.push(o); return '/fake/transcript/path.jsonl'; };
      const r = await codexJudgeSpawn({ mandate: 'm', input: 'i', shape: SHAPE, spawnFn: fn, persistTranscript });
      expect(calls).toHaveLength(1);
      expect(calls[0].threadId).toBe('sess-1');
      expect(calls[0].stdout).toBe(okJsonl);
      expect(r.transcriptFile).toBe('/fake/transcript/path.jsonl');
    });

    it('persists the transcript even when the run goes on to a `turn.failed` — never lost on failure', async () => {
      const failedJsonl = [
        JSON.stringify({ type: 'thread.started', thread_id: 'sess-failed' }),
        JSON.stringify({ type: 'turn.failed', error: { message: 'boom' } }),
      ].join('\n');
      const { fn } = fakeSpawn({ stdout: failedJsonl });
      const calls = [];
      const persistTranscript = (o) => { calls.push(o); return '/fake/failed.jsonl'; };
      await expect(codexJudgeSpawn({ mandate: 'm', input: 'i', shape: SHAPE, spawnFn: fn, persistTranscript }))
        .rejects.toThrow(/the juror failed/);
      expect(calls).toHaveLength(1); // persisted BEFORE the parse threw, not skipped because of the throw
      expect(calls[0].threadId).toBe('sess-failed');
    });

    it('a transcript-write failure never crashes an otherwise-successful judge call — best effort only', async () => {
      const { fn } = fakeSpawn({ stdout: okJsonl, writeLastMessage: '{"verdict":"accept","finding":"ok"}' });
      const persistTranscript = () => null; // simulates a disk-write failure
      const r = await codexJudgeSpawn({ mandate: 'm', input: 'i', shape: SHAPE, spawnFn: fn, persistTranscript });
      expect(r.value).toEqual({ verdict: 'accept', finding: 'ok' });
      expect(r.transcriptFile).toBeNull();
    });

    // THE EXPLICIT CONFIRMATION THE TASK ASKS FOR: `--ephemeral` is UNTOUCHED by this fix. It protects
    // actor-identity/non-resumability (unrelated to transcript persistence) and removing it would reintroduce
    // a real risk — this module's own transcript file is what closes the observability gap instead.
    it('still passes `--ephemeral` on every real spawn — the fix persists OUR OWN copy, it does not touch the flag', async () => {
      const { fn, seen } = fakeSpawn({ stdout: okJsonl, writeLastMessage: '{"verdict":"accept","finding":"ok"}' });
      await codexJudgeSpawn({ mandate: 'm', input: 'i', shape: SHAPE, spawnFn: fn });
      expect(seen.argv).toContain('--ephemeral');
      // and it is not, say, `--no-ephemeral` or a value-taking flag masquerading as it:
      expect(seen.argv[seen.argv.indexOf('--ephemeral') + 1]).not.toBe('false');
    });
  });

  describe('a juror that hits the wall (probe 6 — no CLI timeout flag; the parent kills it)', () => {
    function neverEndingSpawn() {
      return (cli, argv) => ({
        stdout: { on: (e, cb) => { if (e === 'data') setTimeout(() => cb(JSON.stringify({ type: 'thread.started', thread_id: 't' })), 0); } },
        stderr: { on: () => {} },
        stdin: { on: () => {}, end: () => {} },
        on: () => {}, // never fires `close` — only a kill ends this
        kill: () => {},
      });
    }

    it('throws JudgeTimeoutError when the kill leaves nothing parseable', async () => {
      await expect(codexJudgeSpawn({ mandate: 'm', input: 'i', shape: SHAPE, timeoutMs: 5, spawnFn: neverEndingSpawn() }))
        .rejects.toThrow(JudgeTimeoutError);
    });

    it('recovers a partial answer if the killed stream happens to be parseable (probe 6: JSONL survives a kill)', async () => {
      const partialJsonl = [
        JSON.stringify({ type: 'thread.started', thread_id: 'killed-sess' }),
        JSON.stringify({ type: 'turn.completed', usage: {} }),
      ].join('\n');
      const fn = (cli, argv) => {
        const outIdx = argv.indexOf('--output-last-message');
        writeFileSync(argv[outIdx + 1], '{"verdict":"accept","finding":"recovered"}');
        return {
          stdout: { on: (e, cb) => { if (e === 'data') setTimeout(() => cb(partialJsonl), 0); } },
          stderr: { on: () => {} },
          stdin: { on: () => {}, end: () => {} },
          on: () => {},
          kill: () => {},
        };
      };
      const r = await codexJudgeSpawn({ mandate: 'm', input: 'i', shape: SHAPE, timeoutMs: 5, spawnFn: fn });
      expect(r.timedOut).toBe(true);
      expect(r.value).toEqual({ verdict: 'accept', finding: 'recovered' });
    });
  });
});

// #xqa9ttq — the OpenAI-strict schema transform + response-side null strip, proved live against a real
// `codex exec` spawn in `#3371` probes 3/4 before either function existed. See `requireAllProperties`'s own
// header for the full reasoning, INCLUDING why these live in THIS file and not `jury-core.mjs` (a real
// import-graph regression, caught by the repo's ephemeral-clone CLI tests — not a style choice).
describe('#xqa9ttq requireAllProperties — the OpenAI-strict schema transform (#3371 probes 3/4)', () => {
  it('adds every property key to `required`, matching the real REVIEW_JUDGE_SHAPE-shaped 400 probe 3 reproduced', () => {
    const shape = {
      type: 'object',
      properties: {
        summary: { type: 'string' },
        findings: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              summary: { type: 'string' },
              file: { type: 'string' },
              line: { type: 'number' },
            },
            required: ['summary'],
          },
        },
      },
      required: ['summary'],
    };
    const out = requireAllProperties(shape);
    expect(out.required).toEqual(['summary', 'findings']);
    expect(out.properties.findings.items.required).toEqual(['summary', 'file', 'line']);
  });

  it('widens a newly-required property to accept `null`, but leaves an ALREADY-required one\'s type untouched', () => {
    const shape = {
      type: 'object',
      properties: {
        summary: { type: 'string' },
        file: { type: 'string' },
      },
      required: ['summary'],
    };
    const out = requireAllProperties(shape);
    // `summary` was already required — its type is exactly what the schema's author declared, unchanged.
    expect(out.properties.summary.type).toBe('string');
    // `file` was NOT required — probe 4's real response proved OpenAI sends `null` for it, so its type widens.
    expect(out.properties.file.type).toEqual(['string', 'null']);
  });

  it('widens an optional property\'s `enum` alongside its `type` — a `null` type without a `null` enum member is unsatisfiable (round-2 review, PR #2115)', () => {
    const shape = {
      type: 'object',
      properties: {
        summary: { type: 'string' },
        verdict: { type: 'string', enum: ['CONFIRMED', 'PLAUSIBLE'] },
      },
      required: ['summary'],
    };
    const out = requireAllProperties(shape);
    expect(out.properties.verdict.type).toEqual(['string', 'null']);
    expect(out.properties.verdict.enum).toEqual(['CONFIRMED', 'PLAUSIBLE', null]);
    // an already-required enum property is left untouched, exactly like an already-required plain-type one.
    expect(requireAllProperties({
      type: 'object',
      properties: { verdict: { type: 'string', enum: ['a', 'b'] } },
      required: ['verdict'],
    }).properties.verdict).toEqual({ type: 'string', enum: ['a', 'b'] });
  });

  it('does not duplicate `null` in an `enum` that already includes it', () => {
    const shape = {
      type: 'object',
      properties: { note: { type: ['string'], enum: ['a', null] } },
    };
    expect(requireAllProperties(shape).properties.note.enum).toEqual(['a', null]);
  });

  it('a property literally named `required` does not shadow the schema\'s own `required` array (PR #2115 human review)', () => {
    const shape = {
      type: 'object',
      properties: {
        summary: { type: 'string' },
        required: { type: 'boolean' },
      },
      required: ['summary'],
    };
    const out = requireAllProperties(shape);
    // `summary` was genuinely required by the schema's own `required` array — its type must stay untouched,
    // not widened, which only happens if `alreadyRequired` correctly read `out.required` and not the
    // `required` PROPERTY's own (unrelated) schema node.
    expect(out.properties.summary.type).toBe('string');
    expect(out.properties.required.type).toEqual(['boolean', 'null']);
    expect(out.required).toEqual(['summary', 'required']);
  });

  it('never mutates the input, at any depth', () => {
    const shape = {
      type: 'object',
      properties: { a: { type: 'string' }, nested: { type: 'object', properties: { b: { type: 'number' } } } },
    };
    const frozenCopy = JSON.parse(JSON.stringify(shape));
    requireAllProperties(shape);
    expect(shape).toEqual(frozenCopy);
  });

  it('leaves a leaf with no `properties` (and no `type` to widen) unchanged', () => {
    expect(requireAllProperties({ type: 'string', enum: ['a', 'b'] })).toEqual({ type: 'string', enum: ['a', 'b'] });
    expect(requireAllProperties({ $ref: '#/$defs/thing' })).toEqual({ $ref: '#/$defs/thing' });
  });

  it('passes non-object, non-array input through unchanged (including null)', () => {
    expect(requireAllProperties(null)).toBeNull();
    expect(requireAllProperties(undefined)).toBeUndefined();
    expect(requireAllProperties('x')).toBe('x');
  });
});

describe('#xqa9ttq stripNulls — strip a Codex answer\'s explicit nulls before normalizeFinding (#3371 probe 4)', () => {
  it('removes every object property whose value is exactly null, recursively', () => {
    const value = {
      summary: 'x', file: null, line: null,
      nested: { a: 1, b: null, deeper: { c: null, d: 'kept' } },
    };
    expect(stripNulls(value)).toEqual({
      summary: 'x', nested: { a: 1, deeper: { d: 'kept' } },
    });
  });

  it('matches probe 4\'s exact real response shape', () => {
    const probe4Response = {
      summary: 'The added half(n) function divides by zero instead of two.',
      findings: [{
        summary: 'Divide by 2 instead of 0.', file: null, line: null, category: 'correctness',
        verdict: 'CONFIRMED', parallelizable: null,
      }],
    };
    expect(stripNulls(probe4Response)).toEqual({
      summary: 'The added half(n) function divides by zero instead of two.',
      findings: [{ summary: 'Divide by 2 instead of 0.', category: 'correctness', verdict: 'CONFIRMED' }],
    });
  });

  it('leaves a null ARRAY ELEMENT in place — dropping it would shift every later index', () => {
    expect(stripNulls([1, null, 3])).toEqual([1, null, 3]);
  });

  it('passes a bare scalar through unchanged, including null itself', () => {
    expect(stripNulls('x')).toBe('x');
    expect(stripNulls(5)).toBe(5);
    expect(stripNulls(null)).toBeNull();
  });

  it('never mutates its input', () => {
    const value = { a: 1, b: null };
    const copy = JSON.parse(JSON.stringify(value));
    stripNulls(value);
    expect(value).toEqual(copy);
  });
});


it('routes a mandatory elevated judge to Astra/high', () => {
  const argv = buildCodexJudgeArgv({ schemaFile: '/s', outputLastMessageFile: '/o', cwd: '/tmp', mandatoryLens: true, care: 'elevated' });
  expect(argv[argv.indexOf('-m') + 1]).toBe('gpt-6-astra');
  expect(argv).toContain('model_reasoning_effort=high');
});
