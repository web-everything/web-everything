/**
 * @file antigravity-judge-spawn.test.mjs — the Antigravity (`agy`) `JudgeProvider`'s argv/parsing/error-mapping
 * contract, proved WITHOUT spawning a real process (#3383, mirroring `codex-judge-spawn.test.mjs`'s own split).
 *
 * Every shape asserted here traces to a specific `backlog/3633-probe-antigravity-cli-against-the-judge-
 * contract.md` probe, OR to this module's own "LIVE RE-CONFIRMATION" (re-probed while the module was written,
 * same machine, same `agy` 1.2.1) — each `describe`/`it` title names which.
 */

import {
  describe, it, expect, vi,
} from 'vitest';
import {
  existsSync, readFileSync, mkdtempSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// #3383 mechanical-dispatcher Gap 1 fix — `antigravityJudgeSpawn` now calls `recordAntigravityRunScorecard`
// (real default: `run-quality-record.mjs`), which appends to the REAL, on-disk `run-scorecards.json`.
// Mocked at the MODULE level, once, so every OTHER test in this file (there are dozens, and none of them
// inject a `recordScorecard` override) never touches the real store — the dedicated `recordAntigravityRun
// Scorecard` coverage lives in `run-quality-record.test.mjs`, not here. Mirrors `codex-judge-spawn.test.mjs`'s
// own identical module-level mock verbatim.
vi.mock('../../conveyor/run-quality-record.mjs', () => ({ recordAntigravityRunScorecard: vi.fn(() => null) }));
import {
  ANTIGRAVITY_CLI,
  ANTIGRAVITY_MODEL,
  ANTIGRAVITY_EFFORT_MAP,
  ANTIGRAVITY_MODEL_EFFORT_OVERRIDES,
  ANTIGRAVITY_TOOL_FREE_CORRECTION,
  AntigravityToolDeniedError,
  assertNoAntigravityToolAllowlist,
  buildAntigravityJudgeArgv,
  buildAntigravityPrompt,
  buildAntigravityStreamInput,
  parseAntigravityJudgeOutcome,
  antigravityLoadedContextTokens,
  antigravityJudgeSpawn,
  resolveAntigravityJudgeTranscriptDir,
  resolveAntigravityModelEffort,
  extractAntigravityJudgeSessionId,
  persistAntigravityJudgeTranscript,
} from '../antigravity-judge-spawn.mjs';
import { JudgeTimeoutError } from '../judge-spawn.mjs';

const SHAPE = {
  type: 'object',
  properties: { verdict: { type: 'string', enum: ['accept', 'reject'] }, finding: { type: 'string' } },
  required: ['verdict', 'finding'],
  additionalProperties: false,
};

describe('ANTIGRAVITY_CLI', () => {
  it('is the agy binary — named once, exactly like judge-spawn.mjs#JUDGE_CLI / codex-judge-spawn.mjs#CODEX_CLI', () => {
    expect(ANTIGRAVITY_CLI).toBe('agy');
  });
});

describe('buildAntigravityJudgeArgv — the argv translation, per #3633\'s probes (5b, 9, 19)', () => {
  const base = { schemaFile: '/tmp/schema.json' };

  it('translates to the stream-json route, --disable-slash-commands MANDATORY, --json-schema UNTRANSFORMED', () => {
    const argv = buildAntigravityJudgeArgv(base);
    expect(argv).toEqual([
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--disable-slash-commands',
      '--json-schema', '/tmp/schema.json',
      '--print', '',
    ]);
  });

  it('never passes --dangerously-skip-permissions or --sandbox — that is what keeps this seat tool-free', () => {
    const argv = buildAntigravityJudgeArgv({ ...base, model: 'gemini-3.8-flash-low', effort: 'low' });
    expect(argv).not.toContain('--dangerously-skip-permissions');
    expect(argv).not.toContain('--sandbox');
  });

  it('has NO POSITIONAL PROMPT — --print is always the empty string, the prompt rides stdin instead', () => {
    const argv = buildAntigravityJudgeArgv(base);
    const printIdx = argv.indexOf('--print');
    expect(printIdx).toBeGreaterThan(-1);
    expect(argv[printIdx + 1]).toBe('');
  });

  it('adds --model <model> only when a model is given', () => {
    expect(buildAntigravityJudgeArgv(base)).not.toContain('--model');
    expect(buildAntigravityJudgeArgv({ ...base, model: 'gemini-3.1-pro-high' }))
      .toEqual(expect.arrayContaining(['--model', 'gemini-3.1-pro-high']));
  });

  it('refuses a model shaped like a flag', () => {
    expect(() => buildAntigravityJudgeArgv({ ...base, model: '-x' })).toThrow(/plain non-empty string/);
  });

  it('maps effort through ANTIGRAVITY_EFFORT_MAP, via --effort', () => {
    for (const [from, to] of Object.entries(ANTIGRAVITY_EFFORT_MAP)) {
      const argv = buildAntigravityJudgeArgv({ ...base, effort: from });
      expect(argv).toEqual(expect.arrayContaining(['--effort', to]));
    }
  });

  it('clamps xhigh/max DOWN to high — agy\'s --effort only accepts low/medium/high (#3633 probe 9)', () => {
    expect(ANTIGRAVITY_EFFORT_MAP.xhigh).toBe('high');
    expect(ANTIGRAVITY_EFFORT_MAP.max).toBe('high');
  });

  it('refuses an unrecognised effort rather than passing it through silently', () => {
    expect(() => buildAntigravityJudgeArgv({ ...base, effort: 'ludicrous' })).toThrow(/must be one of/);
  });

  it('refuses a missing schemaFile', () => {
    expect(() => buildAntigravityJudgeArgv({ schemaFile: '' })).toThrow(/schemaFile/);
  });

  // #x5s8b47 — live crash reproduced 2026-09-28: `--model gemini-3.1-pro --effort medium` was refused by
  // `agy` itself (`status: "ERROR"`, "gemini-3.1-pro has no \"medium\" effort (available: low, high)"), on
  // EVERY run of the `judgeAdvisory`/`judgeCorrectnessAdvisory` seats' quota-hold fallback onto this provider.
  it('clamps `medium` to `high` for the pinned seat model (ANTIGRAVITY_MODEL), per ANTIGRAVITY_MODEL_EFFORT_OVERRIDES', () => {
    const argv = buildAntigravityJudgeArgv({ ...base, model: ANTIGRAVITY_MODEL, effort: 'medium' });
    expect(argv).toEqual(expect.arrayContaining(['--effort', 'high']));
    expect(argv).not.toEqual(expect.arrayContaining(['--effort', 'medium']));
  });

  it('leaves `low`/`high` alone for the pinned seat model — only `medium` is unsupported', () => {
    expect(buildAntigravityJudgeArgv({ ...base, model: ANTIGRAVITY_MODEL, effort: 'low' }))
      .toEqual(expect.arrayContaining(['--effort', 'low']));
    expect(buildAntigravityJudgeArgv({ ...base, model: ANTIGRAVITY_MODEL, effort: 'high' }))
      .toEqual(expect.arrayContaining(['--effort', 'high']));
  });

  it('leaves `medium` alone for a model with no override entry, and with no model at all', () => {
    expect(buildAntigravityJudgeArgv({ ...base, model: 'gemini-3.8-flash-low', effort: 'medium' }))
      .toEqual(expect.arrayContaining(['--effort', 'medium']));
    expect(buildAntigravityJudgeArgv({ ...base, effort: 'medium' }))
      .toEqual(expect.arrayContaining(['--effort', 'medium']));
  });
});

describe('resolveAntigravityModelEffort — #x5s8b47 per-model effort clamp, layered under ANTIGRAVITY_EFFORT_MAP', () => {
  it('applies the override table entry for the pinned seat model', () => {
    expect(resolveAntigravityModelEffort(ANTIGRAVITY_MODEL, 'medium')).toBe('high');
  });

  it('passes through unchanged for a value the model has no override for', () => {
    expect(resolveAntigravityModelEffort(ANTIGRAVITY_MODEL, 'low')).toBe('low');
    expect(resolveAntigravityModelEffort(ANTIGRAVITY_MODEL, 'high')).toBe('high');
  });

  it('passes through unchanged for an unlisted model, or no model at all', () => {
    expect(resolveAntigravityModelEffort('gemini-3.8-flash-low', 'medium')).toBe('medium');
    expect(resolveAntigravityModelEffort(undefined, 'medium')).toBe('medium');
    expect(resolveAntigravityModelEffort('', 'medium')).toBe('medium');
  });

  it('ANTIGRAVITY_MODEL_EFFORT_OVERRIDES is keyed only for the pinned seat model today', () => {
    expect(Object.keys(ANTIGRAVITY_MODEL_EFFORT_OVERRIDES)).toEqual([ANTIGRAVITY_MODEL]);
  });
});

describe('buildAntigravityPrompt — folding the mandate into prompt text (no --append-system-prompt equivalent)', () => {
  it('labels the two parts so a captured transcript can tell them apart', () => {
    const prompt = buildAntigravityPrompt('BE TERSE', 'THE-DIFF');
    expect(prompt).toContain('BE TERSE');
    expect(prompt).toContain('THE-DIFF');
    expect(prompt.indexOf('BE TERSE')).toBeLessThan(prompt.indexOf('THE-DIFF'));
  });

  // #x5s8b47 — the fix for the #3633 probe-7 silent-tool-denial shape: a caller's mandate may (wrongly, once
  // it has degraded here from a quota-held Codex seat) claim a read-only shell exists; this correction must
  // ALWAYS ride the prompt, after the mandate and before the material, regardless of what the mandate said.
  it('unconditionally appends ANTIGRAVITY_TOOL_FREE_CORRECTION, between the mandate and the material', () => {
    const prompt = buildAntigravityPrompt('you can run non-mutating commands and read files', 'THE-DIFF');
    expect(prompt).toContain(ANTIGRAVITY_TOOL_FREE_CORRECTION);
    expect(prompt.indexOf('you can run non-mutating')).toBeLessThan(prompt.indexOf(ANTIGRAVITY_TOOL_FREE_CORRECTION));
    expect(prompt.indexOf(ANTIGRAVITY_TOOL_FREE_CORRECTION)).toBeLessThan(prompt.indexOf('THE-DIFF'));
  });

  it('the correction plainly states zero tools and forbids reading/running anything further', () => {
    expect(ANTIGRAVITY_TOOL_FREE_CORRECTION).toMatch(/NO tools at all/);
    expect(ANTIGRAVITY_TOOL_FREE_CORRECTION.toLowerCase()).toContain('do not try to read, list, or run anything');
  });
});

describe('buildAntigravityStreamInput — #3633 probe 5b\'s undocumented stdin route', () => {
  it('wraps the prompt in a stream-json `user` event, newline-terminated', () => {
    const line = buildAntigravityStreamInput('hello world');
    expect(line.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(line.trim());
    expect(parsed).toEqual({ event: 'user', message: { role: 'user', content: 'hello world' } });
  });
});

describe('assertNoAntigravityToolAllowlist — no configurable allow-list; the ceiling is zero tools by omission', () => {
  it('passes for null/undefined/empty', () => {
    expect(() => assertNoAntigravityToolAllowlist(null)).not.toThrow();
    expect(() => assertNoAntigravityToolAllowlist(undefined)).not.toThrow();
    expect(() => assertNoAntigravityToolAllowlist([])).not.toThrow();
  });

  it('refuses any non-empty tool list', () => {
    expect(() => assertNoAntigravityToolAllowlist(['Read'])).toThrow(/no configurable tool allow-list/);
  });
});

describe('parseAntigravityJudgeOutcome — stream-json JSONL, the answer nests under the `result` event\'s own `result` key', () => {
  it('#3633 probe 1 shape (re-confirmed live, stream-json route): a clean result event', () => {
    const stdout = [
      JSON.stringify({ event: 'init', conversation_id: 'conv-1', init: {} }),
      JSON.stringify({ event: 'step_update', step_update: { step_index: 0 } }),
      JSON.stringify({
        event: 'result',
        result: {
          conversation_id: 'conv-1', status: 'SUCCESS', response: '{"verdict":"reject","finding":"x"}',
          duration_seconds: 1.2, num_turns: 1,
          structured_output: { verdict: 'reject', finding: 'x' },
          usage: { input_tokens: 100, output_tokens: 10, cache_read_tokens: 5 },
        },
      }),
    ].join('\n');
    const out = parseAntigravityJudgeOutcome({ stdout });
    expect(out.value).toEqual({ verdict: 'reject', finding: 'x' });
    expect(out.sessionId).toBe('conv-1');
    expect(out.costUsd).toBe(0);
    expect(out.stopReason).toBe('SUCCESS');
    expect(out.numTurns).toBe(1);
    expect(out.usage).toEqual({ input_tokens: 100, output_tokens: 10, cache_read_tokens: 5 });
  });

  it('reads `line.result.structured_output`, NEVER `line.structured_output` (the nesting this module\'s own '
    + 'header records as easy to misread from #3633\'s prose)', () => {
    // A flat (doc-mode-shaped) line with a top-level `structured_output` is NOT a valid stream-json `result`
    // event — it must be ignored, and since it is the only line, this must throw "no terminal event".
    const stdout = JSON.stringify({ event: 'result', structured_output: { verdict: 'accept', finding: 'x' } });
    expect(() => parseAntigravityJudgeOutcome({ stdout })).toThrow(/no terminal/);
  });

  it('#3633 probe 7, reproduced live — status SUCCESS + empty response + ABSENT structured_output is a HARD '
    + 'FAILURE, never a clean empty-findings accept', () => {
    const stdout = JSON.stringify({
      event: 'result',
      result: {
        conversation_id: 'conv-2', status: 'SUCCESS', response: '', duration_seconds: 5.7, num_turns: 1,
        usage: {}, denied_actions: [{ action: 'command', display_name: 'RunCommand' }],
      },
    });
    expect(() => parseAntigravityJudgeOutcome({ stdout, stderr: 'jetski: no output produced …' }))
      .toThrow(AntigravityToolDeniedError);
    try {
      parseAntigravityJudgeOutcome({ stdout, stderr: 'jetski: no output produced …' });
    } catch (e) {
      expect(e.deniedActions).toEqual([{ action: 'command', display_name: 'RunCommand' }]);
      expect(e.message).toContain('RunCommand');
      expect(e.message).toContain('jetski: no output produced');
    }
  });

  it('an honest ZERO-FINDINGS answer is a PRESENT, non-empty object — never confused with the absent-key failure', () => {
    const stdout = JSON.stringify({
      event: 'result',
      result: {
        conversation_id: 'conv-3', status: 'SUCCESS', response: '{}', num_turns: 1,
        structured_output: { summary: 'nothing found', findings: [] }, usage: {},
      },
    });
    const out = parseAntigravityJudgeOutcome({ stdout });
    expect(out.value).toEqual({ summary: 'nothing found', findings: [] });
  });

  it('#3633 probe 9/17 — status ERROR (bad effort, or auth) throws the CLI\'s own words verbatim', () => {
    const stdout = JSON.stringify({
      event: 'result',
      result: {
        conversation_id: '', status: 'ERROR', response: '',
        error: 'invalid model selection (--model "" --effort "bogus"): invalid --effort "bogus" (valid: low, medium, high)',
        num_turns: 0, usage: {},
      },
    });
    expect(() => parseAntigravityJudgeOutcome({ stdout })).toThrow(/invalid --effort "bogus"/);
  });

  it('#3633 probe 8: a malformed/missing schema file — empty stdout, reason on stderr only, folded in', () => {
    expect(() => parseAntigravityJudgeOutcome({
      stdout: '',
      stderr: 'Error: invalid --json-schema: failed to read schema file "/no/such/schema.json": open …: no such file or directory',
    })).toThrow(/no terminal/);
  });

  it('no result event at all (mid-run) throws a plain Error naming what it saw', () => {
    const stdout = JSON.stringify({ event: 'init', conversation_id: 'conv-4', init: {} });
    expect(() => parseAntigravityJudgeOutcome({ stdout })).toThrow(/no terminal/);
  });

  it('refuses a structured_output that is not a JSON object (e.g. a bare array or scalar)', () => {
    const stdout = JSON.stringify({ event: 'result', result: { status: 'SUCCESS', structured_output: [] } });
    expect(() => parseAntigravityJudgeOutcome({ stdout })).toThrow(/not a JSON object/);
  });
});

describe('antigravityLoadedContextTokens — agy\'s own usage key names (#3633 probe 10)', () => {
  it('sums input_tokens + cache_read_tokens (NOT total_tokens, which excludes the cache-read half)', () => {
    expect(antigravityLoadedContextTokens({ input_tokens: 100, cache_read_tokens: 50, output_tokens: 10, total_tokens: 110 })).toBe(150);
  });
  it('defaults missing fields to 0', () => {
    expect(antigravityLoadedContextTokens({})).toBe(0);
    expect(antigravityLoadedContextTokens()).toBe(0);
  });
});

describe('resolveAntigravityJudgeTranscriptDir — env override, else the home-dir default (mirrors the Codex sibling)', () => {
  it('honours ANTIGRAVITY_JUDGE_TRANSCRIPT_DIR when set', () => {
    expect(resolveAntigravityJudgeTranscriptDir({ ANTIGRAVITY_JUDGE_TRANSCRIPT_DIR: '/tmp/custom-agy-transcripts' }))
      .toBe('/tmp/custom-agy-transcripts');
  });

  it('falls back to a home-dir default when unset/blank', () => {
    expect(resolveAntigravityJudgeTranscriptDir({})).toMatch(/\.antigravity-judge-transcripts$/);
    expect(resolveAntigravityJudgeTranscriptDir({ ANTIGRAVITY_JUDGE_TRANSCRIPT_DIR: '   ' })).toMatch(/\.antigravity-judge-transcripts$/);
  });
});

describe('extractAntigravityJudgeSessionId — the conversation_id off `init`, falling back to `result`, independent of parse success', () => {
  it('extracts the conversation_id from the init event when present', () => {
    const stdout = [
      JSON.stringify({ event: 'init', conversation_id: 'conv-xyz', init: {} }),
      JSON.stringify({ event: 'result', result: { conversation_id: 'conv-xyz', status: 'SUCCESS' } }),
    ].join('\n');
    expect(extractAntigravityJudgeSessionId(stdout)).toBe('conv-xyz');
  });

  it('falls back to the terminal result event\'s own conversation_id when there is no init event', () => {
    const stdout = JSON.stringify({ event: 'result', result: { conversation_id: 'conv-from-result', status: 'SUCCESS' } });
    expect(extractAntigravityJudgeSessionId(stdout)).toBe('conv-from-result');
  });

  it('returns null when neither event carries a non-empty conversation_id (e.g. the auth-failure shape)', () => {
    expect(extractAntigravityJudgeSessionId('')).toBeNull();
    expect(extractAntigravityJudgeSessionId(JSON.stringify({ event: 'result', result: { conversation_id: '', status: 'ERROR' } })))
      .toBeNull();
  });

  it('still finds the id even when the run goes on to a status: ERROR terminal — the transcript-persistence case', () => {
    const stdout = [
      JSON.stringify({ event: 'init', conversation_id: 'conv-failed-run', init: {} }),
      JSON.stringify({ event: 'result', result: { conversation_id: 'conv-failed-run', status: 'ERROR', error: 'boom' } }),
    ].join('\n');
    expect(extractAntigravityJudgeSessionId(stdout)).toBe('conv-failed-run');
  });
});

describe('persistAntigravityJudgeTranscript — THE FIX: the raw stream-json JSONL is written to a durable local file', () => {
  it('writes the exact stdout bytes to <dir>/antigravity-judge-<sessionId>.jsonl and returns that path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'antigravity-judge-transcript-test-'));
    try {
      const stdout = `${JSON.stringify({ event: 'init', conversation_id: 'sess-1' })}\n${JSON.stringify({ event: 'result', result: {} })}`;
      const file = persistAntigravityJudgeTranscript({ stdout, sessionId: 'sess-1', dir });
      expect(file).toBe(join(dir, 'antigravity-judge-sess-1.jsonl'));
      expect(readFileSync(file, 'utf8')).toBe(stdout);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falls back to a random `unknown-<id>` name when no sessionId is available, never silently dropping the run', () => {
    const dir = mkdtempSync(join(tmpdir(), 'antigravity-judge-transcript-test-'));
    try {
      const file = persistAntigravityJudgeTranscript({ stdout: 'whatever', sessionId: null, dir, mkId: () => 'fixed-id' });
      expect(file).toBe(join(dir, 'antigravity-judge-unknown-fixed-id.jsonl'));
      expect(readFileSync(file, 'utf8')).toBe('whatever');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('creates the directory if it does not exist yet', () => {
    const parent = mkdtempSync(join(tmpdir(), 'antigravity-judge-transcript-test-'));
    const dir = join(parent, 'nested', 'deeper');
    try {
      const file = persistAntigravityJudgeTranscript({ stdout: 'x', sessionId: 't', dir });
      expect(existsSync(file)).toBe(true);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('NEVER throws — a write failure is a best-effort loss, returning null, not a crashed judge call', () => {
    const boom = () => { throw new Error('disk is full'); };
    expect(() => persistAntigravityJudgeTranscript({ stdout: 'x', sessionId: 't', dir: '/nonexistent', ensureDir: boom }))
      .not.toThrow();
    expect(persistAntigravityJudgeTranscript({ stdout: 'x', sessionId: 't', dir: '/nonexistent', ensureDir: boom })).toBeNull();
  });
});

describe('antigravityJudgeSpawn — exercised over an injected spawn (real temp files, fake process)', () => {
  function resultJsonl(result) {
    return [
      JSON.stringify({ event: 'init', conversation_id: result.conversation_id ?? 'sess-1', init: {} }),
      JSON.stringify({ event: 'result', result }),
    ].join('\n');
  }

  const OK_RESULT = {
    conversation_id: 'sess-1', status: 'SUCCESS', response: '{"verdict":"accept","finding":"ok"}',
    num_turns: 1, structured_output: { verdict: 'accept', finding: 'ok' },
    usage: { input_tokens: 10, output_tokens: 2 },
  };

  function fakeSpawn({ stdout, code = 0 }) {
    const seen = { cli: null, argv: null, opts: null, stdin: '' };
    const fn = (cli, argv, opts) => {
      seen.cli = cli; seen.argv = argv; seen.opts = opts;
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

  it('writes the shape UNTRANSFORMED to a real temp schema file the argv points at', async () => {
    let schemaFileSeenDuringSpawn = null;
    const fn = (cli, argv) => {
      const idx = argv.indexOf('--json-schema');
      schemaFileSeenDuringSpawn = JSON.parse(readFileSync(argv[idx + 1], 'utf8'));
      return {
        stdout: { on: (e, cb) => { if (e === 'data') setTimeout(() => cb(resultJsonl(OK_RESULT)), 0); } },
        stderr: { on: () => {} },
        stdin: { on: () => {}, end: () => {} },
        on: (e, cb) => { if (e === 'close') setTimeout(() => cb(0), 1); },
        kill: () => {},
      };
    };
    await antigravityJudgeSpawn({ readHold: () => null, saveHold: () => {}, mandate: 'm', input: 'i', shape: SHAPE, spawnFn: fn });
    // UNTRANSFORMED — byte for byte the same shape, no requireAllProperties-equivalent applied (#3633 probe 3).
    expect(schemaFileSeenDuringSpawn).toEqual(SHAPE);
  });

  it('closes stdin via .end() with a single stream-json `user` event carrying the mandate + input', async () => {
    const { fn, seen } = fakeSpawn({ stdout: resultJsonl(OK_RESULT) });
    await antigravityJudgeSpawn({ readHold: () => null, saveHold: () => {}, mandate: 'BE TERSE', input: 'THE-DIFF', shape: SHAPE, spawnFn: fn });
    expect(seen.stdin).toContain('BE TERSE');
    expect(seen.stdin).toContain('THE-DIFF');
    expect(seen.argv.join(' ')).not.toContain('THE-DIFF'); // rode stdin, not argv
    const parsed = JSON.parse(seen.stdin.trim());
    expect(parsed.event).toBe('user');
    expect(parsed.message.role).toBe('user');
  });

  it('returns the conversation_id as sessionId, costUsd 0, and the structured_output value', async () => {
    const { fn } = fakeSpawn({ stdout: resultJsonl(OK_RESULT) });
    const r = await antigravityJudgeSpawn({ readHold: () => null, saveHold: () => {}, mandate: 'm', input: 'i', shape: SHAPE, spawnFn: fn });
    expect(r.sessionId).toBe('sess-1');
    expect(r.costUsd).toBe(0);
    expect(r.value).toEqual({ verdict: 'accept', finding: 'ok' });
    expect(r.timedOut).toBe(false);
    expect(typeof r.wallMs).toBe('number');
    expect(r.argv).toEqual(expect.arrayContaining(['--input-format', 'stream-json', '--disable-slash-commands']));
  });

  // #3383 mechanical-dispatcher Gap 1 fix — THE regression test: a real judge call must score + record its
  // own run, off the persisted TRANSCRIPT FILE (never raw stdout — that is the one difference from the Codex
  // sibling's own regression test). `recordScorecard` is overridden here (the module-level mock above covers
  // every OTHER test in this file); this is the one test that actually asserts the call happens.
  it('scores + records this run via recordScorecard, off the persisted transcript file, stamped as advisory-review', async () => {
    const { fn } = fakeSpawn({ stdout: resultJsonl(OK_RESULT) });
    let seen = null;
    const spy = (o) => { seen = o; return null; };
    const r = await antigravityJudgeSpawn({ readHold: () => null, saveHold: () => {},
      mandate: 'm', input: 'i', shape: SHAPE, model: 'gemini-3.1-pro', effort: 'low', spawnFn: fn, recordScorecard: spy,
      transcriptDir: mkdtempSync(join(tmpdir(), 'agy-scorecard-test-')),
    });
    expect(seen).toMatchObject({
      dispatchKind: 'advisory-review', kind: 'review', role: 'advisory-review', provider: 'antigravity',
      model: 'unknown', requestedModel: 'gemini-3.1-pro', servedModel: 'unknown', modelEvidence: 'unavailable', effort: 'low',
    });
    // the SAME transcriptFile this run's own return value reports — never raw stdout.
    expect(seen.transcriptFile).toBe(r.transcriptFile);
    expect(typeof seen.transcriptFile).toBe('string');
    rmSync(seen.transcriptFile, { force: true });
  });

  it('the silent-tool-denial failure (#3633 probe 7) surfaces as a rejection, never a clean empty answer', async () => {
    const deniedResult = {
      conversation_id: 'sess-2', status: 'SUCCESS', response: '', num_turns: 1, usage: {},
      denied_actions: [{ action: 'command', display_name: 'RunCommand' }],
    };
    const { fn } = fakeSpawn({ stdout: resultJsonl(deniedResult) });
    await expect(antigravityJudgeSpawn({ readHold: () => null, saveHold: () => {}, mandate: 'm', input: 'i', shape: SHAPE, spawnFn: fn }))
      .rejects.toThrow(AntigravityToolDeniedError);
  });

  it('refuses a tool-bearing request before ever spawning', async () => {
    const { fn } = fakeSpawn({ stdout: resultJsonl(OK_RESULT) });
    let called = false;
    const spy = (...a) => { called = true; return fn(...a); };
    await expect(antigravityJudgeSpawn({ readHold: () => null, saveHold: () => {}, mandate: 'm', input: 'i', shape: SHAPE, allowedTools: ['Read'], spawnFn: spy }))
      .rejects.toThrow(/no configurable tool allow-list/);
    expect(called).toBe(false);
  });

  it('never passes --dangerously-skip-permissions or --sandbox in the real spawned argv', async () => {
    const { fn, seen } = fakeSpawn({ stdout: resultJsonl(OK_RESULT) });
    await antigravityJudgeSpawn({ readHold: () => null, saveHold: () => {}, mandate: 'm', input: 'i', shape: SHAPE, spawnFn: fn });
    expect(seen.argv).not.toContain('--dangerously-skip-permissions');
    expect(seen.argv).not.toContain('--sandbox');
  });

  it('cleans up its temp working directory after the spawn settles', async () => {
    let workDirSeen = null;
    const fn = (cli, argv, opts) => {
      workDirSeen = opts.cwd;
      return {
        stdout: { on: (e, cb) => { if (e === 'data') setTimeout(() => cb(resultJsonl(OK_RESULT)), 0); } },
        stderr: { on: () => {} },
        stdin: { on: () => {}, end: () => {} },
        on: (e, cb) => { if (e === 'close') setTimeout(() => cb(0), 1); },
        kill: () => {},
      };
    };
    await antigravityJudgeSpawn({ readHold: () => null, saveHold: () => {}, mandate: 'm', input: 'i', shape: SHAPE, spawnFn: fn });
    expect(existsSync(workDirSeen)).toBe(false);
  });

  // THE FIX — #3649's run-quality recording mechanism could not score this seat's runs because the raw
  // stream-json JSONL was captured only to parse the answer, then discarded. These prove it is now durably
  // persisted, OUTSIDE the temp working directory the test right above proves gets deleted (so the transcript
  // survives that cleanup), keyed by the same conversation_id the outcome reports as `sessionId`.
  describe('THE FIX — the raw stream-json JSONL is now persisted to a durable file, independent of workDir cleanup', () => {
    it('persists the transcript and returns its path as `transcriptFile`, via the real (non-injected) writer', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'antigravity-judge-transcript-integration-'));
      try {
        const { fn } = fakeSpawn({ stdout: resultJsonl(OK_RESULT) });
        const r = await antigravityJudgeSpawn({ readHold: () => null, saveHold: () => {}, mandate: 'm', input: 'i', shape: SHAPE, spawnFn: fn, transcriptDir: dir });
        expect(r.transcriptFile).toBe(join(dir, 'antigravity-judge-sess-1.jsonl'));
        // THE EXACT SAME BYTES the outcome was parsed from — not a paraphrase, not a summary.
        expect(readFileSync(r.transcriptFile, 'utf8')).toBe(resultJsonl(OK_RESULT));
        // Survives the workDir cleanup the test above proves happens — a DIFFERENT directory entirely.
        expect(existsSync(r.transcriptFile)).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('calls the injected `persistTranscript` with the captured stdout and the extracted session id', async () => {
      const { fn } = fakeSpawn({ stdout: resultJsonl(OK_RESULT) });
      const calls = [];
      const persistTranscript = (o) => { calls.push(o); return '/fake/transcript/path.jsonl'; };
      const r = await antigravityJudgeSpawn({ readHold: () => null, saveHold: () => {}, mandate: 'm', input: 'i', shape: SHAPE, spawnFn: fn, persistTranscript });
      expect(calls).toHaveLength(1);
      expect(calls[0].sessionId).toBe('sess-1');
      expect(calls[0].stdout).toBe(resultJsonl(OK_RESULT));
      expect(r.transcriptFile).toBe('/fake/transcript/path.jsonl');
    });

    it('persists the transcript even when the run goes on to a `status: "ERROR"` — never lost on failure', async () => {
      const errorJsonl = [
        JSON.stringify({ event: 'init', conversation_id: 'sess-failed', init: {} }),
        JSON.stringify({ event: 'result', result: { conversation_id: 'sess-failed', status: 'ERROR', error: 'boom', usage: {} } }),
      ].join('\n');
      const { fn } = fakeSpawn({ stdout: errorJsonl });
      const calls = [];
      const persistTranscript = (o) => { calls.push(o); return '/fake/failed.jsonl'; };
      await expect(antigravityJudgeSpawn({ readHold: () => null, saveHold: () => {}, mandate: 'm', input: 'i', shape: SHAPE, spawnFn: fn, persistTranscript }))
        .rejects.toThrow(/the juror failed/);
      expect(calls).toHaveLength(1); // persisted BEFORE the parse threw, not skipped because of the throw
      expect(calls[0].sessionId).toBe('sess-failed');
    });

    it('persists the transcript even on the silent-tool-denial failure (#3633 probe 7) — the most common failure this seat sees', async () => {
      const deniedResult = {
        conversation_id: 'sess-denied', status: 'SUCCESS', response: '', num_turns: 1, usage: {},
        denied_actions: [{ action: 'command', display_name: 'RunCommand' }],
      };
      const { fn } = fakeSpawn({ stdout: resultJsonl(deniedResult) });
      const calls = [];
      const persistTranscript = (o) => { calls.push(o); return '/fake/denied.jsonl'; };
      await expect(antigravityJudgeSpawn({ readHold: () => null, saveHold: () => {}, mandate: 'm', input: 'i', shape: SHAPE, spawnFn: fn, persistTranscript }))
        .rejects.toThrow(AntigravityToolDeniedError);
      expect(calls).toHaveLength(1);
      expect(calls[0].sessionId).toBe('sess-denied');
    });

    it('a transcript-write failure never crashes an otherwise-successful judge call — best effort only', async () => {
      const { fn } = fakeSpawn({ stdout: resultJsonl(OK_RESULT) });
      const persistTranscript = () => null; // simulates a disk-write failure
      const r = await antigravityJudgeSpawn({ readHold: () => null, saveHold: () => {}, mandate: 'm', input: 'i', shape: SHAPE, spawnFn: fn, persistTranscript });
      expect(r.value).toEqual({ verdict: 'accept', finding: 'ok' });
      expect(r.transcriptFile).toBeNull();
    });

    // THE EXPLICIT CONFIRMATION #3383's own mandate asks for: persisting the transcript adds NOTHING to what
    // this seat can DO. It is still a genuinely TOOL-FREE juror — never `--dangerously-skip-permissions`,
    // never `--sandbox` — and a tool-bearing request is still refused before ever spawning. The fix is
    // strictly "read the same bytes onto disk", not a new capability.
    it('still never passes --dangerously-skip-permissions or --sandbox, and still refuses a tool-bearing request, with the new transcript params present', async () => {
      const { fn, seen } = fakeSpawn({ stdout: resultJsonl(OK_RESULT) });
      await antigravityJudgeSpawn({ readHold: () => null, saveHold: () => {},
        mandate: 'm', input: 'i', shape: SHAPE, spawnFn: fn, transcriptDir: '/tmp/whatever-agy-transcripts',
      });
      expect(seen.argv).not.toContain('--dangerously-skip-permissions');
      expect(seen.argv).not.toContain('--sandbox');

      let called = false;
      const spy = (...a) => { called = true; return fn(...a); };
      await expect(antigravityJudgeSpawn({ readHold: () => null, saveHold: () => {},
        mandate: 'm', input: 'i', shape: SHAPE, allowedTools: ['Read'], spawnFn: spy, transcriptDir: '/tmp/whatever-agy-transcripts',
      })).rejects.toThrow(/no configurable tool allow-list/);
      expect(called).toBe(false); // refused BEFORE the spawn that would have persisted anything
    });
  });

  describe('a juror that hits the wall (#3633 probe 17 — --print-timeout does not cap the auth wait; the parent kills it)', () => {
    function neverEndingSpawn() {
      return () => ({
        stdout: { on: (e, cb) => { if (e === 'data') setTimeout(() => cb(JSON.stringify({ event: 'init', conversation_id: 't' })), 0); } },
        stderr: { on: () => {} },
        stdin: { on: () => {}, end: () => {} },
        on: () => {}, // never fires `close` — only a kill ends this
        kill: () => {},
      });
    }

    it('throws JudgeTimeoutError when the kill leaves nothing parseable', async () => {
      await expect(antigravityJudgeSpawn({ readHold: () => null, saveHold: () => {}, mandate: 'm', input: 'i', shape: SHAPE, timeoutMs: 5, spawnFn: neverEndingSpawn() }))
        .rejects.toThrow(JudgeTimeoutError);
    });

    it('recovers a partial answer if the killed stream happens to be parseable', async () => {
      const partialJsonl = resultJsonl({ ...OK_RESULT, conversation_id: 'killed-sess', structured_output: { verdict: 'accept', finding: 'recovered' } });
      const fn = () => ({
        stdout: { on: (e, cb) => { if (e === 'data') setTimeout(() => cb(partialJsonl), 0); } },
        stderr: { on: () => {} },
        stdin: { on: () => {}, end: () => {} },
        on: () => {},
        kill: () => {},
      });
      const r = await antigravityJudgeSpawn({ readHold: () => null, saveHold: () => {}, mandate: 'm', input: 'i', shape: SHAPE, timeoutMs: 5, spawnFn: fn });
      expect(r.timedOut).toBe(true);
      expect(r.value).toEqual({ verdict: 'accept', finding: 'recovered' });
    });
  });
});
