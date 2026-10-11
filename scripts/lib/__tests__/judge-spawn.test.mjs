/**
 * @file judge-spawn.test.mjs — the juror spawn's flag contract, proved WITHOUT spawning anything (#3028).
 *
 * `buildJudgeArgv` and `parseJudgeOutcome` are pure, and that is the whole point of the seam: the recipe
 * every `judge` step depends on is assertable at zero cost and zero latency, so the one test that pays for
 * a real `claude` process (`judge-spawn.integration.test.mjs`) only has to prove the CLI still honours it.
 *
 * THE LOAD-BEARING TEST IN HERE is the `--bare` refusal. #3028 records the trap: `--bare` strips more
 * context than `--safe-mode` but forces key-based auth, so on a subscription the spawn dies "Not logged in".
 * Reproduced while writing this: exit 1, `is_error: true`, zero tokens billed. A comment would rot; three
 * tests will not, and they pin three DIFFERENT things — say which, because an earlier version of this header
 * claimed more than was actually held:
 *   1. `buildJudgeArgv` never EMITS `--bare`, across the whole care→rigor dial.
 *   2. `assertNoForbiddenArgv` REFUSES any argv carrying it, whatever produced that argv (called directly).
 *   3. `judgeSpawn`'s own CALL to that guard is pinned — the route is a flag-shaped `model`, which
 *      `buildJudgeArgv` accepts as a plain non-empty string and drops into argv as `--model --bare`. Deleting
 *      the guard call therefore turns that test red. What is still NOT pinned by any test is the guard's
 *      stated belt-and-braces case (a future edit making `buildJudgeArgv` emit `--bare` literally); that is
 *      unreachable from the public API by construction, and no test here pretends otherwise.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import {
  JUDGE_CLI,
  resolveJudgeCli,
  FORBIDDEN_ARGV,
  assertNoForbiddenArgv,
  EFFORT_LEVELS,
  DEFAULT_MODEL,
  DEFAULT_EFFORT,
  DEFAULT_BUDGET_USD,
  deriveSessionId,
  sessionSeed,
  buildJudgeArgv,
  parseJudgeOutcome,
  loadedContextTokens,
  judgeSpawn,
  assertLaneCwd,
  JUDGE_TIMEOUT_MS,
  JudgeTimeoutError,
  JudgeBudgetError,
  laneRootOf,
  sameDirectory,
  REAL_PATH,
  JudgeUnparseableError,
  resolveUnparseableRetries,
  UNPARSEABLE_RETRY_SETTING,
  retrySessionId,
} from '../judge-spawn.mjs';

const SHAPE = {
  type: 'object',
  properties: { verdict: { type: 'string' }, findings: { type: 'array', items: { type: 'string' } } },
  required: ['verdict', 'findings'],
  additionalProperties: false,
};
const SID = deriveSessionId(sessionSeed(['run-7', 'rigor']));

/** The flag/value pair a caller asked for, so assertions read as the recipe rather than as indices. */
function flagValue(argv, flag) {
  const i = argv.indexOf(flag);
  return i === -1 ? undefined : argv[i + 1];
}

describe('the recorded `--bare` trap is a gate, not a comment', () => {
  it('`FORBIDDEN_ARGV` names `--bare` — the flag that forces key-based auth and cannot see a subscription', () => {
    expect(FORBIDDEN_ARGV).toContain('--bare');
  });

  it('buildJudgeArgv NEVER emits `--bare`, across every combination of the care→rigor dial', () => {
    for (const model of ['sonnet', 'opus', 'haiku', 'claude-sonnet-5-5']) {
      for (const effort of EFFORT_LEVELS) {
        const argv = buildJudgeArgv({ mandate: 'judge it', shape: SHAPE, model, effort, budget: 1, sessionId: SID });
        expect(argv).not.toContain('--bare');
      }
    }
  });

  it('tier one uses `--safe-mode` INSTEAD — the flag that keeps the subscription login visible', () => {
    const argv = buildJudgeArgv({ mandate: 'judge it', shape: SHAPE, sessionId: SID });
    expect(argv).toContain('--safe-mode');
    expect(argv).not.toContain('--bare');
  });

  it('the runtime guard REFUSES an argv carrying `--bare`, whatever produced it', () => {
    const poisoned = [...buildJudgeArgv({ mandate: 'm', shape: SHAPE, sessionId: SID }), '--bare'];
    expect(() => assertNoForbiddenArgv(poisoned)).toThrow(/--bare/);
  });

  it('the runtime guard lets the real recipe through — the refusal is targeted, not paranoid', () => {
    expect(() => assertNoForbiddenArgv(buildJudgeArgv({ mandate: 'm', shape: SHAPE, sessionId: SID }))).not.toThrow();
  });

  it('the guard is total over an empty or absent argv', () => {
    expect(() => assertNoForbiddenArgv()).not.toThrow();
    expect(() => assertNoForbiddenArgv([])).not.toThrow();
  });

  it('judgeSpawn CALLS that guard before spawning — a flag-shaped `model` smuggles `--bare` into argv', async () => {
    // `buildJudgeArgv` only checks `model` is a non-empty string, so `--model --bare` is a well-formed argv
    // it will happily produce. This is the one route by which a forbidden flag reaches the guard through the
    // public API, and it is what pins the call site: delete `assertNoForbiddenArgv(argv)` from `judgeSpawn`
    // and this test goes red because the spawn starts.
    let started = false;
    const spawnFn = () => { started = true; };
    await expect(judgeSpawn({ mandate: 'm', input: 'i', shape: SHAPE, model: '--bare', sessionId: SID, spawnFn }))
      .rejects.toThrow(/refusing to spawn with --bare/);
    expect(started).toBe(false);
  });
});

describe('buildJudgeArgv — the recipe, pinned exactly (#3028)', () => {
  it('produces the full flag list in a fixed order for a representative per-lens call', () => {
    const argv = buildJudgeArgv({
      mandate: 'You are the rigor juror.',
      shape: SHAPE,
      model: 'opus',
      effort: 'high',
      budget: 0.75,
      sessionId: SID,
    });
    expect(argv).toEqual([
      '-p',
      '--output-format', 'json',
      '--safe-mode',
      '--tools', '',
      '--model', 'opus',
      '--effort', 'high',
      '--max-budget-usd', '0.75',
      '--no-session-persistence',
      '--session-id', SID,
      '--append-system-prompt', 'You are the rigor juror.',
      '--json-schema', JSON.stringify(SHAPE),
    ]);
  });

  it('grants no tools — `--tools ""` is the structural guarantee, not a reminder in the mandate', () => {
    const argv = buildJudgeArgv({ mandate: 'm', shape: SHAPE, sessionId: SID });
    expect(flagValue(argv, '--tools')).toBe('');
  });

  it('follows the VARIADIC `--tools ""` with an option token, so nothing is swallowed as a tool name', () => {
    const argv = buildJudgeArgv({ mandate: 'm', shape: SHAPE, sessionId: SID });
    const after = argv[argv.indexOf('--tools') + 2];
    expect(after.startsWith('--')).toBe(true);
  });

  it('carries the judged material NOWHERE in argv — the input rides stdin, so argv has no ARG_MAX ceiling', () => {
    const argv = buildJudgeArgv({ mandate: 'm', shape: SHAPE, sessionId: SID });
    expect(argv.join('')).not.toContain('THE-DIFF-SENTINEL');
    // …and there is no positional prompt slot at all: every token is a flag or a flag's value.
    expect(argv[argv.length - 2]).toBe('--json-schema');
  });

  it('enforces the shape as SERIALIZED JSON Schema, so the answer is forced rather than requested', () => {
    const argv = buildJudgeArgv({ mandate: 'm', shape: SHAPE, sessionId: SID });
    expect(JSON.parse(flagValue(argv, '--json-schema'))).toEqual(SHAPE);
  });

  it('makes the care→rigor dial two flags rather than prompt tuning', () => {
    const gentle = buildJudgeArgv({ mandate: 'm', shape: SHAPE, model: 'haiku', effort: 'low', sessionId: SID });
    const severe = buildJudgeArgv({ mandate: 'm', shape: SHAPE, model: 'opus', effort: 'max', sessionId: SID });
    expect([flagValue(gentle, '--model'), flagValue(gentle, '--effort')]).toEqual(['haiku', 'low']);
    expect([flagValue(severe, '--model'), flagValue(severe, '--effort')]).toEqual(['opus', 'max']);
    // The mandate is IDENTICAL across the dial — that is the claim.
    expect(flagValue(gentle, '--append-system-prompt')).toBe(flagValue(severe, '--append-system-prompt'));
  });

  it('caps every juror with a hard budget and keeps the session throwaway', () => {
    const argv = buildJudgeArgv({ mandate: 'm', shape: SHAPE, budget: 2.5, sessionId: SID });
    expect(flagValue(argv, '--max-budget-usd')).toBe('2.5');
    expect(argv).toContain('--no-session-persistence');
  });

  it('defaults the dial to the documented middle', () => {
    const argv = buildJudgeArgv({ mandate: 'm', shape: SHAPE, sessionId: SID });
    expect(flagValue(argv, '--model')).toBe(DEFAULT_MODEL);
    expect(flagValue(argv, '--effort')).toBe(DEFAULT_EFFORT);
    expect(flagValue(argv, '--max-budget-usd')).toBe(String(DEFAULT_BUDGET_USD));
  });

  it('is PURE — the same input yields an identical list, and no environment is read', () => {
    const a = buildJudgeArgv({ mandate: 'm', shape: SHAPE, sessionId: SID });
    const b = buildJudgeArgv({ mandate: 'm', shape: SHAPE, sessionId: SID });
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
  });

  // Live-caught 2026-09-23: JUDGE_CLI used to be the literal string 'claude', PATH-resolved at spawn time —
  // a headless review session's own environment did not carry the nvm-managed claude binary's directory on
  // PATH, so every juror it tried to spawn failed ENOENT (the review session ITSELF had started fine; only
  // the grandchild juror spawn, relying on PATH lookup from inside that session's own env, broke). Fixed by
  // resolving the binary as a sibling of the currently-running node executable (nvm's own install layout)
  // instead of a bare name — see resolveJudgeCli's own header for the full incident.
  // NOT environment-portable to assert WHICH branch this takes: an nvm-managed dev machine has a real
  // sibling (CI does not — GitHub Actions installs node via actions/setup-node, no claude binary anywhere
  // near it, confirmed live: this exact assertion failed in CI moments after this fix first shipped). Only
  // the SHAPE is a portable invariant; which branch resolveJudgeCli actually took on any given machine is
  // proven instead by the fully-injected tests below, which need no real filesystem state to hold.
  it('names the CLI once, so a caller can point at another binary without re-deriving flags — either an absolute sibling-of-node path, or the bare fallback name, never anything else', () => {
    expect(JUDGE_CLI.endsWith('/claude') || JUDGE_CLI === 'claude').toBe(true);
  });
});

describe('resolveJudgeCli — PATH-independent binary resolution (live-caught 2026-09-23)', () => {
  it('resolves the sibling of process.execPath when a real exists() confirms it — the real default path, whichever branch this machine actually takes', () => {
    const resolved = resolveJudgeCli();
    // Portable across dev machines and CI alike: report the sibling path ONLY when the caller's REAL
    // existsSync() (unmocked here) agrees it is actually there; otherwise the documented fallback.
    const expected = existsSync(join(dirname(process.execPath), 'claude'))
      ? join(dirname(process.execPath), 'claude')
      : 'claude';
    expect(resolved).toBe(expected);
  });

  it('resolves the sibling of an injected execPath when the injected exists() says it is there', () => {
    const resolved = resolveJudgeCli({ execPath: '/fake/nvm/v99/bin/node', exists: () => true });
    expect(resolved).toBe('/fake/nvm/v99/bin/claude');
  });

  it('falls back to the bare name when the sibling does not exist (a non-nvm install layout)', () => {
    const resolved = resolveJudgeCli({ execPath: '/usr/local/bin/node', exists: () => false });
    expect(resolved).toBe('claude');
  });

  it('the exists() check is asked about the SIBLING path, not process.execPath itself', () => {
    const asked = [];
    resolveJudgeCli({ execPath: '/opt/node/bin/node', exists: (p) => { asked.push(p); return true; } });
    expect(asked).toEqual(['/opt/node/bin/claude']);
  });
});

describe('buildJudgeArgv — refuses a call it cannot make well-formed', () => {
  it.each([
    ['a missing mandate', { shape: SHAPE, sessionId: SID }, /mandate/],
    ['a blank mandate', { mandate: '   ', shape: SHAPE, sessionId: SID }, /mandate/],
    ['a missing shape', { mandate: 'm', sessionId: SID }, /shape/],
    ['an array shape', { mandate: 'm', shape: [], sessionId: SID }, /shape/],
    ['an effort outside the CLI enum', { mandate: 'm', shape: SHAPE, effort: 'extreme', sessionId: SID }, /effort/],
    ['a zero budget', { mandate: 'm', shape: SHAPE, budget: 0, sessionId: SID }, /budget/],
    ['a negative budget', { mandate: 'm', shape: SHAPE, budget: -1, sessionId: SID }, /budget/],
    ['a non-UUID session id', { mandate: 'm', shape: SHAPE, sessionId: 'run-7' }, /sessionId/],
    ['a missing session id', { mandate: 'm', shape: SHAPE }, /sessionId/],
  ])('throws on %s', (_label, opts, pattern) => {
    expect(() => buildJudgeArgv(opts)).toThrow(pattern);
  });
});

describe('deriveSessionId — the juror is a NAMED actor, not merely a fresh one (#3028 third guarantee)', () => {
  it('is a canonical UUID the CLI accepts for `--session-id`', () => {
    expect(deriveSessionId('run-7 rigor')).toMatch(/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
  });

  it('is RFC 9562 version 8 — honest that this is a hash, not randomness (v4) or a namespace (v5)', () => {
    expect(deriveSessionId('run-7 rigor').charAt(14)).toBe('8');
  });

  it('sets the RFC variant bits', () => {
    expect('89ab').toContain(deriveSessionId('run-7 rigor').charAt(19));
  });

  it('is deterministic, so a run record can point at the transcript it named', () => {
    expect(deriveSessionId('run-7 rigor')).toBe(deriveSessionId('run-7 rigor'));
  });

  it('separates the lenses of one panel, so jurors are distinct actors from each other', () => {
    const seen = new Set(['rigor', 'care', 'security', 'a11y', 'perf'].map((l) => deriveSessionId(sessionSeed(['run-7', l]))));
    expect(seen.size).toBe(5);
  });

  it('separates runs, so yesterday\'s juror is not today\'s', () => {
    expect(deriveSessionId(sessionSeed(['run-7', 'rigor']))).not.toBe(deriveSessionId(sessionSeed(['run-8', 'rigor'])));
  });

  it('refuses an empty seed rather than inventing an identity', () => {
    expect(() => deriveSessionId('')).toThrow(/seed/);
    expect(() => deriveSessionId(undefined)).toThrow(/seed/);
  });
});

describe('sessionSeed — the ONE injective seed encoding, replacing the ambiguous space join (#3058)', () => {
  const id = (fields) => deriveSessionId(sessionSeed(fields));

  it('THE ORIGINAL DEFECT: a space join maps two different (runId, id) pairs onto one actor', () => {
    // The join itself is the defect — these two DIFFERENT field pairs are ONE string, which on `main` both
    // derived 8f57af23-ca27-80e7-b1f3-c2510e0aa618 through `panelSeats`.
    const spaceJoin = (runId, seatId) => `${runId} ${seatId}`;
    expect(spaceJoin('a', 'b c#1')).toBe(spaceJoin('a b', 'c#1'));
    expect(deriveSessionId(spaceJoin('a', 'b c#1'))).toBe(deriveSessionId(spaceJoin('a b', 'c#1')));
    // The encoder separates exactly that pair — same fields, no longer the same seed and no longer one actor.
    expect(sessionSeed(['a', 'b c#1'])).not.toBe(sessionSeed(['a b', 'c#1']));
    expect(id(['a', 'b c#1'])).not.toBe(id(['a b', 'c#1']));
  });

  it('THE SECOND DEFECT: an absent field no longer collapses onto a present one of the same value', () => {
    // `[runId, lens].filter(Boolean).join(' ')` made these one seed with NO SPACE anywhere in the input.
    expect(id(['same-string', undefined])).not.toBe(id([undefined, 'same-string']));
    expect(id(['same-string', ''])).not.toBe(id(['', 'same-string']));
  });

  it('absent, empty and missing are three different fields, not one', () => {
    const shapes = [
      ['a'],
      ['a', undefined],
      ['a', null],
      ['a', ''],
      ['a', 'b'],
      ['', 'a'],
      [undefined, 'a'],
      ['a', 'b', undefined],
      ['a', 'b', ''],
    ];
    // `undefined` and `null` are BOTH "absent" and deliberately encode the same — the distinction the item
    // asks for is absent-vs-empty-vs-missing, and nothing in this repo means different things by the two
    // nullish values. Everything else must be pairwise distinct.
    expect(sessionSeed(['a', null])).toBe(sessionSeed(['a', undefined]));
    const distinct = shapes.filter((s) => !(s.length === 2 && s[1] === null));
    expect(new Set(distinct.map(id)).size).toBe(distinct.length);
  });

  it('is injective over field values carrying the separators a naive join would reuse', () => {
    const alphabet = ['', ' ', 'a', 'a b', 'b', '#1', 'a#1', 'a b#1', ':', '2:x', '|', 'v1|2|', '~', undefined];
    const pairs = [];
    for (const x of alphabet) for (const y of alphabet) pairs.push([x, y]);
    // Every distinct (x, y) is a distinct seed, and therefore a distinct id.
    expect(new Set(pairs.map((p) => sessionSeed(p))).size).toBe(pairs.length);
    expect(new Set(pairs.map(id)).size).toBe(pairs.length);
  });

  it('is deterministic and declares its own field count, so a decoder cannot mis-split it', () => {
    expect(sessionSeed(['a', 'b c#1'])).toBe(sessionSeed(['a', 'b c#1']));
    expect(sessionSeed(['a', 'b c#1'])).toBe('v1|2|1:a5:b c#1');
    expect(sessionSeed(['a b', 'c#1'])).toBe('v1|2|3:a b3:c#1');
    expect(sessionSeed(['a'])).toBe('v1|1|1:a');
    expect(sessionSeed(['a', undefined])).toBe('v1|2|1:a~');
    expect(sessionSeed(['a', ''])).toBe('v1|2|1:a0:');
  });

  it('refuses a field list it cannot encode rather than stringifying its way past it', () => {
    expect(() => sessionSeed([])).toThrow(/non-empty array/);
    expect(() => sessionSeed('a b')).toThrow(/non-empty array/);
    expect(() => sessionSeed(undefined)).toThrow(/non-empty array/);
    expect(() => sessionSeed(['a', 7])).toThrow(/field 1 must be a string/);
    expect(() => sessionSeed([{ runId: 'a' }])).toThrow(/field 0 must be a string/);
  });
});

describe('parseJudgeOutcome — a validated object, or a throw carrying the SPAWN\'S OWN error', () => {
  const ok = {
    is_error: false,
    stop_reason: 'tool_use',
    session_id: 'aaaaaaaa-bbbb-8ccc-9ddd-eeeeeeeeeeee',
    total_cost_usd: 0.014,
    duration_ms: 2100,
    num_turns: 1,
    usage: { input_tokens: 2, cache_creation_input_tokens: 2061, cache_read_input_tokens: 3289, output_tokens: 4 },
    structured_output: { verdict: 'reject', findings: ['divides by zero'] },
  };

  it('returns the shape-enforced answer already parsed — no prose, no fences', () => {
    const r = parseJudgeOutcome(JSON.stringify(ok));
    expect(r.value).toEqual({ verdict: 'reject', findings: ['divides by zero'] });
    expect(typeof r.value).toBe('object');
  });

  it('surfaces the spawned session id, so a caller can RECORD which actor judged', () => {
    expect(parseJudgeOutcome(JSON.stringify(ok)).sessionId).toBe('aaaaaaaa-bbbb-8ccc-9ddd-eeeeeeeeeeee');
  });

  it('reports cost, duration, turns and the forced-tool stop reason', () => {
    const r = parseJudgeOutcome(JSON.stringify(ok));
    expect(r.costUsd).toBe(0.014);
    expect(r.durationMs).toBe(2100);
    expect(r.numTurns).toBe(1);
    expect(r.stopReason).toBe('tool_use');
  });

  it('rethrows the CLI\'s own words VERBATIM — this is how the `--bare` trap surfaces', () => {
    const bare = { is_error: true, result: 'Not logged in · Please run /login' };
    expect(() => parseJudgeOutcome(JSON.stringify(bare))).toThrow('Not logged in · Please run /login');
  });

  it('when `result` is empty, throws the raw parsed object and stderr instead of a useless placeholder (#xn85i4a)', () => {
    const emptyResult = { is_error: true, result: '', stop_reason: 'end_turn', session_id: 'zzzz' };
    expect(() => parseJudgeOutcome(JSON.stringify(emptyResult), 'exit code 1'))
      .toThrow(/no result text[\s\S]*end_turn[\s\S]*zzzz[\s\S]*exit code 1/);
  });

  it('throws when the enforced shape did not land, naming the stop reason it saw instead', () => {
    const noShape = { is_error: false, stop_reason: 'end_turn', result: 'here are my thoughts' };
    expect(() => parseJudgeOutcome(JSON.stringify(noShape))).toThrow(/structured_output/);
    expect(() => parseJudgeOutcome(JSON.stringify(noShape))).toThrow(/end_turn/);
  });

  it('throws with both streams quoted when stdout is not JSON at all', () => {
    expect(() => parseJudgeOutcome('command not found', 'sh: claude: not found'))
      .toThrow(/parseable JSON[\s\S]*command not found[\s\S]*claude: not found/);
  });
});

describe('loadedContextTokens — the measured quantity, taken from the CLI, never estimated', () => {
  it('counts fresh input PLUS both cache halves, because cache reads are still context the model was given', () => {
    expect(loadedContextTokens({
      input_tokens: 2, cache_creation_input_tokens: 2061, cache_read_input_tokens: 3289, output_tokens: 4,
    })).toBe(5352);
  });

  it('ignores output tokens — they are the answer, not the context', () => {
    expect(loadedContextTokens({ input_tokens: 10, output_tokens: 9999 })).toBe(10);
  });

  it('is total over a missing or partial usage block', () => {
    expect(loadedContextTokens()).toBe(0);
    expect(loadedContextTokens({})).toBe(0);
    expect(loadedContextTokens({ input_tokens: 'nope' })).toBe(0);
  });
});

describe('judgeSpawn — the one function a `judge` step calls, exercised over an injected spawn', () => {
  /** A fake `child_process.spawn` that replays a canned stdout and records what it was asked to run. */
  function fakeSpawn(stdout, { code = 0, stderr = '' } = {}) {
    const seen = { cli: null, argv: null, opts: null, stdin: '' };
    const fn = (cli, argv, opts) => {
      seen.cli = cli; seen.argv = argv; seen.opts = opts;
      const handlers = {};
      const child = {
        stdout: { on: (e, cb) => { if (e === 'data') setTimeout(() => cb(stdout), 0); } },
        stderr: { on: (e, cb) => { if (e === 'data' && stderr) setTimeout(() => cb(stderr), 0); } },
        stdin: { on: () => {}, end: (d) => { seen.stdin = d; } },
        on: (e, cb) => { handlers[e] = cb; if (e === 'close') setTimeout(() => cb(code), 1); },
        kill: () => {},
      };
      return child;
    };
    return { fn, seen };
  }

  const okJson = JSON.stringify({
    is_error: false,
    stop_reason: 'tool_use',
    session_id: 'aaaaaaaa-bbbb-8ccc-9ddd-eeeeeeeeeeee',
    total_cost_usd: 0.02,
    duration_ms: 1900,
    num_turns: 1,
    usage: { input_tokens: 5, cache_creation_input_tokens: 100, cache_read_input_tokens: 900 },
    structured_output: { verdict: 'accept', findings: [] },
  });

  it('runs the CLI with exactly the pure function\'s argv, and writes the judged input to STDIN', async () => {
    const { fn, seen } = fakeSpawn(okJson);
    const r = await judgeSpawn({
      mandate: 'You are the rigor juror.',
      input: 'THE-DIFF-SENTINEL',
      shape: SHAPE,
      model: 'opus',
      effort: 'high',
      budget: 0.75,
      runId: 'run-7',
      lens: 'rigor',
      spawnFn: fn,
    });
    // Live-caught 2026-09-23: JUDGE_CLI is no longer always the bare literal 'claude' — it resolves to an
    // absolute sibling-of-node path when that exists (see resolveJudgeCli's own header). Assert against the
    // real constant, not a hardcoded literal that only held before that fix.
    expect(seen.cli).toBe(JUDGE_CLI);
    expect(seen.argv).toEqual(buildJudgeArgv({
      mandate: 'You are the rigor juror.', shape: SHAPE, model: 'opus', effort: 'high', budget: 0.75,
      sessionId: deriveSessionId(sessionSeed(['run-7', 'rigor'])),
    }));
    expect(seen.stdin).toBe('THE-DIFF-SENTINEL');
    expect(seen.argv.join('')).not.toContain('THE-DIFF-SENTINEL');
    expect(r.value).toEqual({ verdict: 'accept', findings: [] });
  });

  it('returns the spawned session id and the loaded-context total alongside the answer', async () => {
    const { fn } = fakeSpawn(okJson);
    const r = await judgeSpawn({ mandate: 'm', input: 'i', shape: SHAPE, runId: 'run-7', lens: 'care', spawnFn: fn });
    expect(r.sessionId).toBe('aaaaaaaa-bbbb-8ccc-9ddd-eeeeeeeeeeee');
    expect(r.loadedContextTokens).toBe(1005);
    expect(r.costUsd).toBe(0.02);
    expect(typeof r.wallMs).toBe('number');
  });

  it('derives the session id from runId+lens, so the panel\'s jurors are distinguishable actors', async () => {
    const a = fakeSpawn(okJson);
    const b = fakeSpawn(okJson);
    await judgeSpawn({ mandate: 'm', input: 'i', shape: SHAPE, runId: 'run-7', lens: 'rigor', spawnFn: a.fn });
    await judgeSpawn({ mandate: 'm', input: 'i', shape: SHAPE, runId: 'run-7', lens: 'care', spawnFn: b.fn });
    const sidOf = (seen) => seen.argv[seen.argv.indexOf('--session-id') + 1];
    expect(sidOf(a.seen)).not.toBe(sidOf(b.seen));
    expect(sidOf(a.seen)).toBe(deriveSessionId(sessionSeed(['run-7', 'rigor'])));
  });

  it('honours an explicit sessionId over the derivation', async () => {
    const { fn, seen } = fakeSpawn(okJson);
    await judgeSpawn({ mandate: 'm', input: 'i', shape: SHAPE, sessionId: SID, spawnFn: fn });
    expect(seen.argv[seen.argv.indexOf('--session-id') + 1]).toBe(SID);
  });

  it('a runId-only spawn and a lens-only spawn carrying the same string are DIFFERENT actors (#3058)', async () => {
    // The `filter(Boolean)` this replaced dropped the absent field before joining, so both of these derived
    // one id with no space anywhere in the input. Driven through the real `judgeSpawn`, not the encoder.
    const a = fakeSpawn(okJson);
    const b = fakeSpawn(okJson);
    await judgeSpawn({ mandate: 'm', input: 'i', shape: SHAPE, runId: 'same-string', spawnFn: a.fn });
    await judgeSpawn({ mandate: 'm', input: 'i', shape: SHAPE, lens: 'same-string', spawnFn: b.fn });
    const sidOf = (seen) => seen.argv[seen.argv.indexOf('--session-id') + 1];
    expect(sidOf(a.seen)).not.toBe(sidOf(b.seen));
    expect(sidOf(a.seen)).toBe(deriveSessionId(sessionSeed(['same-string', undefined])));
    expect(sidOf(b.seen)).toBe(deriveSessionId(sessionSeed([undefined, 'same-string'])));
  });

  it('a runId/lens pair that a space join would have merged stays two actors (#3058)', async () => {
    const a = fakeSpawn(okJson);
    const b = fakeSpawn(okJson);
    await judgeSpawn({ mandate: 'm', input: 'i', shape: SHAPE, runId: 'r 1', lens: 'lens', spawnFn: a.fn });
    await judgeSpawn({ mandate: 'm', input: 'i', shape: SHAPE, runId: 'r', lens: '1 lens', spawnFn: b.fn });
    const sidOf = (seen) => seen.argv[seen.argv.indexOf('--session-id') + 1];
    expect(sidOf(a.seen)).not.toBe(sidOf(b.seen));
  });

  it('an EMPTY lens and an ABSENT lens are different actors, so neither collapses onto the other', async () => {
    const a = fakeSpawn(okJson);
    const b = fakeSpawn(okJson);
    await judgeSpawn({ mandate: 'm', input: 'i', shape: SHAPE, runId: 'run-7', spawnFn: a.fn });
    await judgeSpawn({ mandate: 'm', input: 'i', shape: SHAPE, runId: 'run-7', lens: '', spawnFn: b.fn });
    const sidOf = (seen) => seen.argv[seen.argv.indexOf('--session-id') + 1];
    expect(sidOf(a.seen)).not.toBe(sidOf(b.seen));
  });

  it('still names a distinct actor when no runId or lens is supplied', async () => {
    const a = fakeSpawn(okJson);
    const b = fakeSpawn(okJson);
    await judgeSpawn({ mandate: 'm', input: 'i', shape: SHAPE, spawnFn: a.fn });
    await judgeSpawn({ mandate: 'm', input: 'i', shape: SHAPE, spawnFn: b.fn });
    const sidOf = (seen) => seen.argv[seen.argv.indexOf('--session-id') + 1];
    expect(sidOf(a.seen)).not.toBe(sidOf(b.seen));
  });

  it('passes cwd and env through to the spawn', async () => {
    const { fn, seen } = fakeSpawn(okJson);
    await judgeSpawn({ mandate: 'm', input: 'i', shape: SHAPE, sessionId: SID, cwd: '/tmp/juror', env: { A: '1' }, spawnFn: fn });
    expect(seen.opts.cwd).toBe('/tmp/juror');
    expect(seen.opts.env).toEqual({ A: '1', WE_CONVEYOR_WORKER: '1' }); // #3383: a juror is a worker, marked so tick-once refuses in it
  });

  // #landing-freeze-2779 — live incident regression guard: this spawn used to forward the caller's `env`
  // (default `process.env`) with no sanitize step, so a static, daemon-minted `GH_TOKEN`/`GITHUB_TOKEN` could
  // ride along into a tool-bearing juror unchanged, however stale it had gotten. See
  // `../../operations/detached-dispatch.mjs#defaultSpawnDetached`'s own docblock for the full mechanism.
  it('never carries a static GH_TOKEN/GITHUB_TOKEN present on the passed-in env (#landing-freeze-2779)', async () => {
    const { fn, seen } = fakeSpawn(okJson);
    await judgeSpawn({
      mandate: 'm', input: 'i', shape: SHAPE, sessionId: SID, cwd: '/tmp/juror',
      env: { A: '1', GH_TOKEN: 'stale-static-token', GITHUB_TOKEN: 'stale-static-token-2' }, spawnFn: fn,
    });
    expect(seen.opts.env).toEqual({ A: '1', WE_CONVEYOR_WORKER: '1' });
  });

  it('throws the juror\'s OWN failure text rather than a paraphrase', async () => {
    const { fn } = fakeSpawn(JSON.stringify({ is_error: true, result: 'Not logged in · Please run /login' }), { code: 1 });
    await expect(judgeSpawn({ mandate: 'm', input: 'i', shape: SHAPE, sessionId: SID, spawnFn: fn }))
      .rejects.toThrow('Not logged in · Please run /login');
  });

  it('refuses an empty input rather than spawning a juror with nothing to judge', async () => {
    let started = false;
    const spawnFn = () => { started = true; };
    await expect(judgeSpawn({ mandate: 'm', input: '   ', shape: SHAPE, sessionId: SID, spawnFn }))
      .rejects.toThrow(/input/);
    expect(started).toBe(false);
  });

  it('propagates a bad-argv refusal BEFORE spawning anything', async () => {
    let started = false;
    const spawnFn = () => { started = true; };
    await expect(judgeSpawn({ mandate: '', input: 'i', shape: SHAPE, sessionId: SID, spawnFn }))
      .rejects.toThrow(/mandate/);
    expect(started).toBe(false);
  });

  it('SIGKILLs a juror that outlives `timeoutMs` and rejects naming the budget it blew', async () => {
    // A juror that never closes: no `close` event ever fires, so the ONLY thing that can settle the promise
    // is the timeout path. No real `claude` is spawned — the seam is the injected `spawnFn`.
    let killedWith;
    let stdinClosed = false;
    const spawnFn = () => ({
      stdout: { on: () => {} },
      stderr: { on: () => {} },
      stdin: { on: () => {}, end: () => { stdinClosed = true; } },
      on: () => {},
      kill: (signal) => { killedWith = signal; },
    });
    await expect(judgeSpawn({ mandate: 'm', input: 'i', shape: SHAPE, sessionId: SID, timeoutMs: 5, spawnFn }))
      .rejects.toThrow('judge-spawn: the juror exceeded 5ms and was killed');
    // Killed, not merely abandoned — an orphaned `claude -p` would keep billing against the budget.
    expect(killedWith).toBe('SIGKILL');
    expect(stdinClosed).toBe(true);
  });

  it('survives a child whose `kill` throws — the juror is already gone, the timeout still rejects', async () => {
    const spawnFn = () => ({
      stdout: { on: () => {} },
      stderr: { on: () => {} },
      stdin: { on: () => {}, end: () => {} },
      on: () => {},
      kill: () => { throw new Error('ESRCH'); },
    });
    await expect(judgeSpawn({ mandate: 'm', input: 'i', shape: SHAPE, sessionId: SID, timeoutMs: 5, spawnFn }))
      .rejects.toThrow(/exceeded 5ms and was killed/);
  });

  /**
   * #3203 — THE WALL IS NO LONGER TOTAL LOSS.
   *
   * The kill used to `reject`, discarding every byte the juror had already written. A tool-bearing juror at
   * the wall has usually done most of the review, so the round cost full price and delivered nothing, could
   * not resume, and — because which round dies depends on how much work the juror chose to do — read as
   * flakiness rather than as a bound being hit. Two of ten measured rounds on 2026-08-19 died this way.
   */
  describe('a juror that hits the wall', () => {
    // A child that emits a COMPLETE answer and then never exits: the exact shape the old code threw away.
    const answeringChild = (payload) => {
      const handlers = {};
      return {
        stdout: { on: (_e, cb) => cb(JSON.stringify(payload)) },
        stderr: { on: () => {} },
        stdin: { on: () => {}, end: () => {} },
        on: (e, cb) => { handlers[e] = cb; },
        kill: () => { /* never closes — only the grace timer can settle this */ },
      };
    };
    const ANSWER = {
      is_error: false,
      stop_reason: 'tool_use',
      session_id: 'aaaaaaaa-bbbb-8ccc-9ddd-eeeeeeeeeeee',
      total_cost_usd: 1.42,
      duration_ms: 899_000,
      num_turns: 31,
      usage: { input_tokens: 2, output_tokens: 4 },
      structured_output: { verdict: 'reject', findings: ['found it just before the wall'] },
    };

    it('returns the review the juror had already produced, instead of discarding it', async () => {
      const r = await judgeSpawn({
        mandate: 'm', input: 'i', shape: SHAPE, sessionId: SID, timeoutMs: 5,
        spawnFn: () => answeringChild(ANSWER),
      });
      expect(r.value).toEqual({ verdict: 'reject', findings: ['found it just before the wall'] });
      expect(r.costUsd).toBe(1.42);
    });

    // "Hit the bound" and "crashed" are different facts about a review, and before this they arrived
    // identically. A caller that cannot tell them apart learns to retry rather than to look.
    it('marks the result as timed out, so the record can say which happened', async () => {
      const r = await judgeSpawn({
        mandate: 'm', input: 'i', shape: SHAPE, sessionId: SID, timeoutMs: 5,
        spawnFn: () => answeringChild(ANSWER),
      });
      expect(r.timedOut).toBe(true);
    });

    it('marks an ordinary completed juror as NOT timed out', async () => {
      const spawnFn = () => {
        const handlers = {};
        return {
          stdout: { on: (_e, cb) => cb(JSON.stringify(ANSWER)) },
          stderr: { on: () => {} },
          stdin: { on: () => {}, end: () => {} },
          on: (e, cb) => { handlers[e] = cb; if (e === 'close') setTimeout(() => cb(0), 0); },
          kill: () => {},
        };
      };
      const r = await judgeSpawn({ mandate: 'm', input: 'i', shape: SHAPE, sessionId: SID, spawnFn });
      expect(r.timedOut).toBe(false);
    });

    // Nothing parseable IS still a failure — but a TYPED one, carrying what there was.
    it('throws a JudgeTimeoutError carrying the partial streams when nothing parsed', async () => {
      const spawnFn = () => ({
        stdout: { on: (_e, cb) => cb('{"structured_output": {"verd') },
        stderr: { on: (_e, cb) => cb('reading scripts/foo.mjs\n') },
        stdin: { on: () => {}, end: () => {} },
        on: () => {},
        kill: () => {},
      });
      const err = await judgeSpawn({ mandate: 'm', input: 'i', shape: SHAPE, sessionId: SID, timeoutMs: 5, spawnFn })
        .then(() => null, (e) => e);
      expect(err).toBeInstanceOf(JudgeTimeoutError);
      expect(err.timedOut).toBe(true);
      expect(err.partialStdout).toContain('structured_output');
      expect(err.partialStderr).toContain('scripts/foo.mjs');
      // It says BOUND, not crash — that distinction is the whole point of the type.
      expect(err.message).toMatch(/JUDGE_TIMEOUT_MS/);
    });
  });

  /**
   * The bound is DERIVED, not typed: 2× the longest surviving run of the ten measured on 2026-08-19, rounded
   * UP because two of those ten were censored by the old wall — the observed maximum is a lower bound on the
   * tail, not an estimate of it.
   *
   * The second assertion is the one that earns its place. The first cut of the constant read "rounded to 15
   * minutes", which is BELOW 2 × 470s and so contradicted the derivation written directly above it; this
   * assertion, written from the derivation rather than from the number, failed and caught it.
   */
  it('defaults to a bound at least twice the longest run that survived the old wall', async () => {
    expect(JUDGE_TIMEOUT_MS).toBeGreaterThanOrEqual(2 * 470_000);
    expect(JUDGE_TIMEOUT_MS).toBe(20 * 60 * 1000);
  });

  it('reports a missing binary as a start failure naming the CLI', async () => {
    const spawnFn = () => { throw new Error('ENOENT'); };
    await expect(judgeSpawn({ mandate: 'm', input: 'i', shape: SHAPE, sessionId: SID, cli: 'nope', spawnFn }))
      .rejects.toThrow(/could not start `nope`/);
  });
});

// A TOOL-BEARING JUROR MUST RUN IN A LANE — the guarantee that replaces `--tools ""`, enforced rather than
// asserted. The first version of this feature CLAIMED the cwd was a lane and claimed `guard-lane` would deny a
// shared-tree write. Nothing set the cwd, and `--safe-mode` disables hooks, so both were false. Review caught
// it as a behavioural regression of a structural guarantee.
describe('assertLaneCwd', () => {
  const LANE = '/ws/.lanes/web-everything/lane-3';
  const DRIVER = '/ws/.lanes/web-everything/lane-9';
  // These reason about path STRINGS, so `realpath` is identity here — the symlink case gets its own suite
  // below, with a real link on disk, because a stubbed realpath cannot prove a link is followed.
  const same = (p) => p;
  const assertLane = (cwd, tools, driver = DRIVER) => assertLaneCwd(cwd, tools, driver, same);

  it('refuses a tool-bearing spawn outside a lane', () => {
    expect(() => assertLane('/ws/webeverything', ['Bash'])).toThrow(/not a lane clone/);
  });

  // THE HOLE THE FIRST FIX LEFT (PR #1178 review, blocking 1). `judgeSpawn` defaulted `cwd` to
  // `process.cwd()`, and a review normally runs inside a lane — so an omitted cwd passed the old check by
  // donating the DRIVER'S OWN lane. There is no safe default; an absent one is refused outright.
  it('refuses when no cwd was supplied at all — there is no safe default to inherit', () => {
    for (const nothing of [undefined, null, '', '   ']) {
      expect(() => assertLane(nothing, ['Bash'])).toThrow(/no `cwd` was supplied/);
    }
  });

  // Same tree, same hazard — and the shape an omitted cwd used to produce. The juror's mandate is to MUTATE
  // that tree (check out the parent commit, edit source, re-run the suite), which is the driver's diff.
  it("refuses the DRIVER'S own lane, and everything inside it", () => {
    expect(() => assertLane(DRIVER, ['Bash'])).toThrow(/DRIVER'S OWN lane/);
    expect(() => assertLane(`${DRIVER}/`, ['Bash'])).toThrow(/DRIVER'S OWN lane/);
    // A SUBDIRECTORY is the same git working tree and the same lease — an exact path compare let it through
    // and the child reported the driver's own toplevel (PR #1178 round 4, finding 1).
    expect(() => assertLane(`${DRIVER}/scripts`, ['Bash'])).toThrow(/DRIVER'S OWN lane/);
    expect(() => assertLane(`${DRIVER}/scripts/../scripts/lib`, ['Bash'])).toThrow(/DRIVER'S OWN lane/);
  });

  // A RAW SUBSTRING TEST WALKS THROUGH `..` (review finding 2). The old check was
  // `path.includes('/.lanes/')`, so this string matched while the child's real working directory was the
  // shared primary checkout.
  it('resolves the path before judging it, so `..` cannot escape', () => {
    expect(() => assertLane('/ws/.lanes/../webeverything', ['Bash'])).toThrow(/not a lane clone/);
    expect(() => assertLane('/ws/.lanes/web-everything/lane-3/../../../webeverything', ['Bash']))
      .toThrow(/not a lane clone/);
  });

  // …and it matches a real pool member, not any directory that happens to be called `.lanes`.
  it('requires the <workspace>/.lanes/<pool>/lane-N shape, not merely a `.lanes` segment', () => {
    expect(() => assertLane('/tmp/.lanes/anything', ['Bash'])).toThrow(/not a lane clone/);
    expect(() => assertLane('/tmp/.lanes/pool/notalane', ['Bash'])).toThrow(/not a lane clone/);
  });

  it('allows a tool-bearing spawn in a lane that is not the driver\'s', () => {
    expect(() => assertLane(LANE, ['Bash'])).not.toThrow();
    expect(() => assertLane('/ws/.lanes/plateau-app/lane-1/sub', ['Bash', 'Read'])).not.toThrow();
  });

  it('ignores cwd entirely for a tool-free juror, so every existing caller is unaffected', () => {
    expect(() => assertLane('/ws/webeverything', null)).not.toThrow();
    expect(() => assertLane(undefined, undefined)).not.toThrow();
  });

  it('laneRootOf names the lane, and nothing else', () => {
    expect(laneRootOf('/ws/.lanes/web-everything/lane-3/scripts/x.mjs')).toBe('/ws/.lanes/web-everything/lane-3');
    expect(laneRootOf('/ws/.lanes/web-everything/lane-12')).toBe('/ws/.lanes/web-everything/lane-12');
    expect(laneRootOf('/ws/webeverything')).toBeNull();
    expect(laneRootOf('/tmp/.lanes/pool/notalane')).toBeNull();
  });

  it('judgeSpawn refuses before spawning — the check is on the path to the process, not beside it', async () => {
    let spawned = false;
    await expect(judgeSpawn({
      mandate: 'm', input: 'i', shape: { type: 'object' }, runId: 'r', lens: 'correctness',
      allowedTools: ['Bash'], cwd: '/ws/webeverything',
      spawnFn: () => { spawned = true; throw new Error('should not reach'); },
    })).rejects.toThrow(/refusing to spawn a TOOL-BEARING juror/);
    expect(spawned).toBe(false);
  });

  // THE DEFAULT ITSELF, pinned at the spawn boundary: an omitted cwd must not become `process.cwd()`.
  it('judgeSpawn refuses a tool-bearing spawn with NO cwd, rather than inheriting its own', async () => {
    let spawned = false;
    await expect(judgeSpawn({
      mandate: 'm', input: 'i', shape: { type: 'object' }, runId: 'r', lens: 'correctness',
      allowedTools: ['Bash'],
      spawnFn: () => { spawned = true; throw new Error('should not reach'); },
    })).rejects.toThrow(/no `cwd` was supplied/);
    expect(spawned).toBe(false);
  });

  // A tool-free juror still spawns with no cwd — the directory is immaterial when nothing can write.
  it('a tool-free juror with no cwd still spawns, in the process directory', async () => {
    let seen = null;
    await expect(judgeSpawn({
      mandate: 'm', input: 'i', shape: { type: 'object' }, runId: 'r', lens: 'correctness',
      spawnFn: (cli, argv, opts) => { seen = opts.cwd; throw new Error('stop here'); },
    })).rejects.toThrow(/stop here/);
    expect(seen).toBe(process.cwd());
  });
});

/**
 * A STUBBED REALPATH CANNOT PROVE A LINK IS FOLLOWED, so this suite builds a real one on disk. `resolve`
 * normalizes `..` and `.` textually and never touches the filesystem, so a symlink wearing a lane's shape
 * passed `laneRootOf` while the child landed in the shared primary checkout — the reviewer reproduced exactly
 * that end to end (PR #1178 round 4, finding 2).
 */
describe('assertLaneCwd follows symlinks', () => {
  let dir;
  let realLane;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'judge-lane-'));
    realLane = join(dir, 'real', '.lanes', 'web-everything', 'lane-4');
    mkdirSync(realLane, { recursive: true });
    mkdirSync(join(dir, 'primary'), { recursive: true });
    mkdirSync(join(dir, 'fake', '.lanes', 'web-everything'), { recursive: true });
  });
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ } });

  it('REFUSES a lane-shaped symlink that points at something that is not a lane', () => {
    const link = join(dir, 'fake', '.lanes', 'web-everything', 'lane-7');
    symlinkSync(join(dir, 'primary'), link, 'dir');
    // The path LOOKS like a lane and `resolve` agrees; only following the link says otherwise.
    expect(laneRootOf(link)).toBe(link);
    expect(() => assertLaneCwd(link, ['Bash'], join(dir, 'other'))).toThrow(/not a lane clone/);
  });

  it('ALLOWS a symlink that really does point at a lane', () => {
    const link = join(dir, 'shortcut');
    symlinkSync(realLane, link, 'dir');
    expect(() => assertLaneCwd(link, ['Bash'], join(dir, 'primary'))).not.toThrow();
  });

  // Following the link is also what catches a link INTO the driver's own lane, which the lane-root compare
  // would otherwise miss because the two paths share no text at all.
  it("REFUSES a symlink into the DRIVER'S own lane", () => {
    const link = join(dir, 'shortcut');
    symlinkSync(realLane, link, 'dir');
    expect(() => assertLaneCwd(link, ['Bash'], realLane)).toThrow(/DRIVER'S OWN lane/);
  });

  // THE CASE-VARIANT HOLE, which survived two "fixed" claims (PR #1178 round 5, finding 1). `realpathSync`
  // echoes the caller's SPELLING; only `realpathSync.native` returns the on-disk name.
  //
  // THE FLIPPED COMPONENT MUST BE A REAL DIRECTORY, and the first version of this test got that wrong (PR
  // #1188 review, blocking 1). It flipped `/var`, which on macOS is a SYMLINK to `private/var` — and both
  // implementations resolve a symlink by reading its stored target, so both emit the same canonical
  // lowercase path. The case difference was erased before the JS-vs-native distinction could matter, and the
  // test passed with the fix reverted. Flipping a component we CREATED keeps symlink resolution out of it.
  //
  // Skipped where the filesystem is case-SENSITIVE: there the two spellings are genuinely two directories.
  it("REFUSES a differently-cased spelling of the DRIVER'S own lane", (ctx) => {
    const pool = join(dir, 'real', '.lanes', 'MixedCase');
    mkdirSync(join(pool, 'lane-8'), { recursive: true });
    const lane = join(pool, 'lane-8');
    const flipped = join(dir, 'real', '.lanes', 'mixedcase', 'lane-8');
    // `ctx.skip()`, never a bare `return` — a bare return reports as PASSED, so a test that no-ops on this
    // filesystem looks identical to one that ran (PR #1197 review, finding 1).
    if (!existsSync(flipped)) ctx.skip();
    expect(() => assertLaneCwd(flipped, ['Bash'], lane)).toThrow(/DRIVER'S OWN lane/);
  });

  // REFUSED UNDER EITHER REALPATH here, because the inode compare added for the firmlink axis subsumes the
  // case axis: two spellings of one directory share an inode whatever `realpath` returned.
  //
  // THAT DOES NOT DEMOTE `.native` TO A FAST PATH, which is how an earlier version of this comment framed it
  // (PR #1188 round 3, finding 2). `laneRootOf` is a string test, so when the case difference falls on the
  // `.lanes` or `lane-N` SEGMENTS the JS `realpathSync` yields a path that is not recognised as a lane at
  // all — and an unrecognised path is refused for the wrong reason, or a driver whose own lane goes
  // unrecognised stops being compared against. `.native` is what makes the recognition correct, and the
  // recognition is what makes the refusal correct.
  it('refuses the case-variant under either realpath, because identity does not care about spelling', (ctx) => {
    const pool = join(dir, 'real', '.lanes', 'MixedCase');
    mkdirSync(join(pool, 'lane-9'), { recursive: true });
    const lane = join(pool, 'lane-9');
    const flipped = join(dir, 'real', '.lanes', 'mixedcase', 'lane-9');
    if (!existsSync(flipped)) ctx.skip();
    expect(() => assertLaneCwd(flipped, ['Bash'], lane, realpathSync)).toThrow(/DRIVER'S OWN lane/);
    expect(() => assertLaneCwd(flipped, ['Bash'], lane, realpathSync.native)).toThrow(/DRIVER'S OWN lane/);
  });

  /**
   * THE SIXTH HOLE, and the reason this check now compares IDENTITY rather than spelling. Since macOS 10.15
   * every Mac has firmlinks, so `/Users/x` and `/System/Volumes/Data/Users/x` are ONE directory with two
   * on-disk names — and `realpathSync.native` faithfully returns whichever you asked for, because returning
   * the on-disk name is exactly what fixes the CASE axis. Four axes now (`..`, symlink, case, firmlink), four
   * rounds, one root cause: a path is a name and the question is about identity.
   *
   * Uses the REAL alias on this machine, since no temp directory can manufacture a firmlink. Skipped where
   * the alias does not exist.
   */
  it("REFUSES a firmlink alias of the DRIVER'S own lane", (ctx) => {
    const driver = realpathSync.native(process.cwd());
    const alias = `/System/Volumes/Data${driver}`;
    if (!existsSync(alias) || !laneRootOf(driver)) ctx.skip(); // not macOS, or not running from a lane
    // The two spell differently even after `.native`, which is what defeated the previous version.
    expect(realpathSync.native(alias)).not.toBe(realpathSync.native(driver));
    expect(() => assertLaneCwd(alias, ['Bash'], driver)).toThrow(/DRIVER'S OWN lane/);
  });

  it('sameDirectory answers by inode, so two names for one directory match', () => {
    // A throwaway tree (hermetic: no stat of the real lane pool). The parent dir stands in for "another directory".
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'same-dir-')));
    try {
      const here = join(root, 'here');
      mkdirSync(here);
      const link = join(root, 'link');
      symlinkSync(here, link);
      const alias = `/System/Volumes/Data${here}`;
      expect(sameDirectory(here, here)).toBe(true);
      expect(sameDirectory(here, link)).toBe(true);
      expect(sameDirectory(here, join(here, '..'))).toBe(false);
      if (existsSync(alias)) expect(sameDirectory(here, alias)).toBe(true);
      // Unstattable paths answer false rather than throwing — the refusal above is the louder signal.
      expect(sameDirectory(join(here, 'no-such-dir-xyz'), here)).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  // `dev` IS LOAD-BEARING and had no test (PR #1188 round 3, finding 1). Inode numbers are unique per
  // VOLUME, not globally, so two unrelated directories on different volumes routinely share one. Dropping
  // the `dev` comparison collapsed them into "the same directory" — fail-CLOSED, so it over-refuses rather
  // than letting a juror in, but it is a sentence claiming a guarantee that nothing defended.
  //
  // `/` and a mounted volume are on different devices on any machine that has one; skipped where none does.
  // DETERMINISTIC, on any filesystem. The real-collision version below still runs where one exists, but this
  // is the test that defends `dev` on a machine — CI included — where none does.
  it('compares dev as well as ino, with a stubbed stat so this holds on every machine', () => {
    const stat = (p) => ({ '/vol-a': { ino: 2, dev: 100 }, '/vol-b': { ino: 2, dev: 200 } }[p]);
    expect(stat('/vol-a').ino).toBe(stat('/vol-b').ino);   // same inode …
    expect(sameDirectory('/vol-a', '/vol-b', stat)).toBe(false); // … different device, so not one directory
    expect(sameDirectory('/vol-a', '/vol-a', stat)).toBe(true);
  });

  it('compares dev as well as ino, so a SHARED inode across volumes is not one directory', (ctx) => {
    // A volume root is inode 2 on most filesystems, so mounted volumes routinely collide. On this machine
    // `/`, `/System/Volumes/Preboot` and `/System/Volumes/VM` are all inode 2 on three different devices —
    // the exact configuration that makes dropping the `dev` comparison collapse them into one directory.
    const candidates = ['/', '/System/Volumes/Preboot', '/System/Volumes/VM', '/System/Volumes/Data', '/private/tmp', tmpdir()]
      .filter((p) => existsSync(p))
      .map((p) => { const st = statSync(realpathSync.native(p)); return { path: p, dev: st.dev, ino: st.ino }; });

    const byIno = new Map();
    for (const c of candidates) byIno.set(String(c.ino), [...(byIno.get(String(c.ino)) ?? []), c]);
    const collision = [...byIno.values()].find((g) => g.length > 1 && new Set(g.map((c) => c.dev)).size > 1);
    if (!collision) ctx.skip(); // no cross-volume collision here — the stubbed test above still defends `dev`

    const [a, b] = collision;
    expect(a.ino).toBe(b.ino);          // same inode …
    expect(a.dev).not.toBe(b.dev);      // … different device …
    expect(sameDirectory(a.path, b.path)).toBe(false); // … and therefore not the same directory
  });

  // NO FALLBACK. A `?? realpathSync` silently restored the hole on any platform taking that branch.
  it('uses realpathSync.native with no fallback', () => {
    expect(REAL_PATH).toBe(realpathSync.native);
  });

  // A nested pool: the greedy regex returned the INNERMOST lane, so a cwd inside the driver's own tree
  // reported a different lane root and was allowed (PR #1188 review, finding 4).
  it("refuses a nested lane pool inside the DRIVER'S own lane", () => {
    const driver = '/ws/.lanes/x/lane-1';
    expect(laneRootOf('/ws/.lanes/x/lane-1/.lanes/y/lane-2')).toBe(driver);
    expect(() => assertLaneCwd('/ws/.lanes/x/lane-1/.lanes/y/lane-2', ['Bash'], driver, (p) => p))
      .toThrow(/DRIVER'S OWN lane/);
  });

  it('REFUSES a path that does not exist — a juror cannot run there either', () => {
    expect(() => assertLaneCwd(join(dir, 'nope', '.lanes', 'p', 'lane-1'), ['Bash'], dir)).toThrow(/does not exist/);
  });
});

// The argv boundary had no test at all — review noted the coverage claim covered only the adapter side.
describe('buildJudgeArgv with allowedTools', () => {
  const base = () => ({ mandate: 'm', shape: { type: 'object' }, sessionId: deriveSessionId('seed') });

  it('emits the allow-list and follows it with an option token', () => {
    const argv = buildJudgeArgv({ ...base(), allowedTools: ['Bash', 'Read'] });
    const i = argv.indexOf('--allowedTools');
    expect(argv.slice(i, i + 3)).toEqual(['--allowedTools', 'Bash', 'Read']);
    // `--allowedTools` is variadic, so the next token MUST be an option or it is swallowed as a tool name.
    expect(argv[i + 3].startsWith('--')).toBe(true);
  });

  it('omits `--tools ""` when tools are granted, and keeps it when they are not', () => {
    expect(buildJudgeArgv({ ...base(), allowedTools: ['Bash'] })).not.toContain('--tools');
    expect(buildJudgeArgv(base())).toContain('--tools');
  });

  it('refuses a flag-shaped or non-identifier tool name at this boundary too', () => {
    for (const bad of [['--bare'], ['-x'], [''], ['Bash(git *)'], 'Bash', []]) {
      expect(() => buildJudgeArgv({ ...base(), allowedTools: bad }), JSON.stringify(bad)).toThrow();
    }
  });
});

/**
 * `budget: null` — NO SPEND CEILING (operator ruling 2026-08-18, `#xvkjndx`).
 *
 * The ceiling was never a cost control for a review; it was a silent TRUNCATION. A tool-bearing juror that
 * hits it dies mid-run reporting `stop_reason: "tool_use"`, which reads like a crash. `null` OMITS the flag
 * rather than passing a large number, so nothing has to guess what "big enough" is — and the distinction that
 * matters is that `null` is an explicit declaration while `undefined` still takes the default.
 */
describe('an unbounded juror budget', () => {
  it('OMITS --max-budget-usd entirely rather than passing a huge number', () => {
    const argv = buildJudgeArgv({ mandate: 'm', shape: SHAPE, budget: null, sessionId: SID });
    expect(argv).not.toContain('--max-budget-usd');
  });

  it('still emits the flag for a declared numeric ceiling', () => {
    const argv = buildJudgeArgv({ mandate: 'm', shape: SHAPE, budget: 2.5, sessionId: SID });
    expect(flagValue(argv, '--max-budget-usd')).toBe('2.5');
  });

  it('leaves `undefined` on the DEFAULT, so unbounded stays opt-in and is never inherited by silence', () => {
    const argv = buildJudgeArgv({ mandate: 'm', shape: SHAPE, sessionId: SID });
    expect(argv).toContain('--max-budget-usd');
  });

  it('still REFUSES the shapes that are caller bugs rather than declarations', () => {
    for (const bad of [0, -1, Number.NaN, Infinity, '1.5', {}]) {
      expect(() => buildJudgeArgv({ mandate: 'm', shape: SHAPE, budget: bad, sessionId: SID }))
        .toThrow(/positive finite number of USD, or null/);
    }
  });
});

/**
 * #3187 — THE INHERITED DEFAULT KILLED EVERY TOOL-BEARING JUROR, AND DID NOT SAY SO.
 *
 * TWO HALVES, TESTED AS TWO HALVES because they fail independently. (a) `DEFAULT_BUDGET_USD` was `0.5`, sized
 * for a TOOL-FREE juror in #3028 and never revisited when tool-bearing jurors arrived in #3072 — so a caller
 * that declared no budget inherited a ceiling BELOW every spend a tool-bearing juror actually produces. WHICH
 * callers those are is NOT restated here — `DEFAULT_BUDGET_USD`'s own "WHO INHERITS THIS" is the one list, and
 * this line previously carried a narrower copy of it (*"which today means `we:scripts/lib/judge-panel.mjs`,
 * the converge panel"*) that was WRONG: `we:scripts/operations/explore.mjs`'s tool-free `synthesize` seat
 * inherits it too, through `createDefaultJudge`, and so does anything reaching `judgePanel` without a per-seat
 * budget. A second copy of a list is a second thing to be wrong; point at the list instead.
 *
 * (b) The kill surfaces as `is_error` with `stop_reason: "tool_use"`, which names nothing about money and
 * which a CONFORMING run also carries — so it read as a crash. On the converge run that exposed this, 6 of 8 seats died this way and the panel escalated
 * `needs-human` on `mandatory-lens-absent`: a spending limit diagnosed as a panel failure.
 *
 * THE SPENDS ARE MEASURED, NOT INVENTED — four real tool-bearing `review-pr` rounds on 2026-08-18, read off
 * each run's own telemetry line: $0.6152, $0.6597, $0.6997, $0.9042. Plus one converge seat killed at $0.596
 * that finished at $0.69 when re-run identically against a 3.0 ceiling.
 */
const MEASURED_TOOL_BEARING_SPENDS_USD = Object.freeze([0.6152, 0.6597, 0.6997, 0.9042]);
/** The converge-path seat: killed having spent this, then finished at $0.69 under a wider ceiling. */
const MEASURED_CONVERGE_KILL_SPEND_USD = 0.596;

describe('#3187 (a) — the INHERITED default admits a tool-bearing juror at the measured spends', () => {
  it.each(MEASURED_TOOL_BEARING_SPENDS_USD)(
    'a juror that spends $%s finishes under the inherited ceiling instead of being killed at it',
    (spend) => {
      // STRICTLY greater: a ceiling merely EQUAL to the spend is the boundary the kill happens at, and every
      // one of these is a spend the juror had already reached when its round completed.
      expect(DEFAULT_BUDGET_USD).toBeGreaterThan(spend);
    },
  );

  it('also clears the converge seat that was actually killed, on ONE of the paths that inherit this', () => {
    expect(DEFAULT_BUDGET_USD).toBeGreaterThan(MEASURED_CONVERGE_KILL_SPEND_USD);
    expect(DEFAULT_BUDGET_USD).toBeGreaterThan(0.69); // what that same seat spent when it was allowed to finish
  });

  it('is a positive finite NUMBER, not `null` — `assertPanelBudget` cannot sum a roster of no-ceilings', () => {
    // Why the default did not simply follow `review-pr`/`review-prep` to `budget: null`: judge-panel.mjs feeds
    // this value to `assertPanelBudget`, which REFUSES a non-positive-finite per-juror budget.
    expect(typeof DEFAULT_BUDGET_USD).toBe('number');
    expect(Number.isFinite(DEFAULT_BUDGET_USD)).toBe(true);
    expect(DEFAULT_BUDGET_USD).toBeGreaterThan(0);
  });
});

describe('#3187 (a) — end to end, over a fake CLI that ENFORCES the ceiling the way the real one does', () => {
  // A REAL DIRECTORY, because `assertLaneCwd` stats it: a tool-bearing spawn is refused unless its `cwd` is an
  // existing lane clone, and the whole point of these cases is that the juror IS tool-bearing.
  let laneDir = null;
  let tmpRoot = null;
  beforeAll(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'judge-budget-lane-'));
    laneDir = join(tmpRoot, '.lanes', 'web-everything', 'lane-3');
    mkdirSync(laneDir, { recursive: true });
  });
  afterAll(() => { if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true }); });

  /**
   * A fake `claude` that reads `--max-budget-usd` OFF ITS OWN ARGV and kills the run when the round's spend
   * exceeds it — emitting the real kill shape (`is_error` + `stop_reason: "tool_use"`) rather than an answer.
   *
   * THIS IS THE POINT OF THE FIXTURE: the assertion then depends on the constant instead of restating it. A
   * plain canned-stdout spawn would pass at ANY default, because nothing in it would enforce anything.
   */
  function budgetEnforcingSpawn(spendUsd) {
    const seen = { ceiling: undefined, killed: null };
    const fn = (cli, argv) => {
      const i = argv.indexOf('--max-budget-usd');
      const ceiling = i === -1 ? null : Number(argv[i + 1]);
      seen.ceiling = ceiling;
      seen.killed = ceiling !== null && spendUsd > ceiling;
      const stdout = JSON.stringify(seen.killed
        ? { is_error: true, stop_reason: 'tool_use', result: '', total_cost_usd: spendUsd, session_id: 'kkkk' }
        : {
          is_error: false,
          stop_reason: 'tool_use',
          session_id: 'aaaaaaaa-bbbb-8ccc-9ddd-eeeeeeeeeeee',
          total_cost_usd: spendUsd,
          duration_ms: 1900,
          num_turns: 4,
          usage: { input_tokens: 5, cache_creation_input_tokens: 100, cache_read_input_tokens: 900 },
          structured_output: { verdict: 'accept', findings: [] },
        });
      return {
        stdout: { on: (e, cb) => { if (e === 'data') setTimeout(() => cb(stdout), 0); } },
        stderr: { on: () => {} },
        stdin: { on: () => {}, end: () => {} },
        on: (e, cb) => { if (e === 'close') setTimeout(() => cb(seen.killed ? 1 : 0), 1); },
        kill: () => {},
      };
    };
    return { fn, seen };
  }

  it.each(MEASURED_TOOL_BEARING_SPENDS_USD)(
    'a caller declaring NO budget completes a tool-bearing juror that spends $%s (Done-when 2)',
    async (spend) => {
      const { fn, seen } = budgetEnforcingSpawn(spend);
      const r = await judgeSpawn({
        mandate: 'You are the rigor juror.',
        input: 'THE-DIFF',
        shape: SHAPE,
        // NO `budget` — this is the whole criterion: what a caller INHERITS must not kill it.
        runId: 'run-3187',
        lens: 'rigor',
        cwd: laneDir,
        allowedTools: ['Bash', 'Read', 'Grep', 'Glob'], // tool-BEARING, which is the shape that overspends
        spawnFn: fn,
      });
      expect(seen.ceiling).toBe(DEFAULT_BUDGET_USD); // it really did inherit, rather than passing no flag
      expect(seen.killed).toBe(false);
      expect(r.value).toEqual({ verdict: 'accept', findings: [] });
      expect(r.costUsd).toBe(spend);
    },
  );

  it('and the fixture is not vacuous — a spend ABOVE the inherited ceiling still gets killed, legibly', async () => {
    const over = DEFAULT_BUDGET_USD + 0.25;
    const { fn, seen } = budgetEnforcingSpawn(over);
    await expect(judgeSpawn({
      mandate: 'm', input: 'i', shape: SHAPE, runId: 'run-3187', lens: 'rigor',
      cwd: laneDir,
      allowedTools: ['Read'],
      spawnFn: fn,
    })).rejects.toThrow(JudgeBudgetError);
    expect(seen.killed).toBe(true);
  });
});

describe('#3187 (b) — a budget-terminated spawn REPORTS THE CEILING, not a bare `tool_use` stop', () => {
  /** The kill shape, as the CLI emits it: an error whose stop reason says nothing about money. */
  const killed = (extra = {}) => JSON.stringify({
    is_error: true,
    stop_reason: 'tool_use',
    total_cost_usd: 0.596,
    session_id: 'kkkkkkkk-bbbb-8ccc-9ddd-eeeeeeeeeeee',
    result: '',
    ...extra,
  });

  it('throws a JudgeBudgetError naming BOTH the spend and the ceiling', () => {
    expect(() => parseJudgeOutcome(killed(), '', 0.5)).toThrow(JudgeBudgetError);
    expect(() => parseJudgeOutcome(killed(), '', 0.5)).toThrow(/0\.596/);
    expect(() => parseJudgeOutcome(killed(), '', 0.5)).toThrow(/max-budget-usd of \$0\.5/);
  });

  it('says it is a BOUND, not a crash — the misdiagnosis is the expensive half of this bug', () => {
    expect(() => parseJudgeOutcome(killed(), '', 0.5)).toThrow(/KILLED BY ITS SPEND CEILING/);
    expect(() => parseJudgeOutcome(killed(), '', 0.5)).toThrow(/not a crash/);
  });

  it('carries the two numbers on the INSTANCE too, so a run record can file it without regex', () => {
    try {
      parseJudgeOutcome(killed(), '', 0.5);
      throw new Error('expected a throw');
    } catch (e) {
      expect(e).toBeInstanceOf(JudgeBudgetError);
      expect(e.name).toBe('JudgeBudgetError');
      expect(e.budgetExceeded).toBe(true);
      expect(e.budget).toBe(0.5);
      expect(e.costUsd).toBe(0.596);
      expect(e.stopReason).toBe('tool_use');
    }
  });

  it('fires whether or not the CLI supplied result text — BOTH old branches were silent about the budget', () => {
    // The pre-#3187 code split on `parsed.result`: non-empty rethrew the CLI's words verbatim, empty dumped
    // the parsed object. Neither named a ceiling, so the budget branch has to precede both.
    expect(() => parseJudgeOutcome(killed({ result: '' }), '', 0.5)).toThrow(JudgeBudgetError);
    expect(() => parseJudgeOutcome(killed({ result: 'Claude Code stopped' }), '', 0.5)).toThrow(JudgeBudgetError);
  });

  it('does NOT fire when no ceiling was declared — there is no number to name and none is invented', () => {
    // `budget: null` is what `review-pr` and `review-prep` declare. Such a run cannot be killed by a ceiling,
    // so a `tool_use` error there is a different failure and keeps the CLI's own words.
    expect(() => parseJudgeOutcome(killed({ result: 'something else broke' }), '', null))
      .toThrow(/the juror failed: something else broke/);
    expect(() => parseJudgeOutcome(killed({ result: 'something else broke' }), '', null))
      .not.toThrow(JudgeBudgetError);
  });

  it('does NOT fire on a CONFORMING run, which also stops for `tool_use` (the forced tool call)', () => {
    const conforming = JSON.stringify({
      is_error: false,
      stop_reason: 'tool_use',
      total_cost_usd: 0.9042,
      session_id: 'aaaa',
      structured_output: { verdict: 'accept', findings: [] },
    });
    const r = parseJudgeOutcome(conforming, '', 0.5); // a spend OVER the ceiling, but not an error
    expect(r.value).toEqual({ verdict: 'accept', findings: [] });
    expect(r.stopReason).toBe('tool_use');
  });

  it('does NOT fire on an is_error with a DIFFERENT stop reason — those keep their existing messages', () => {
    const bare = JSON.stringify({ is_error: true, result: 'Not logged in · Please run /login' });
    expect(() => parseJudgeOutcome(bare, '', 0.5)).toThrow('Not logged in · Please run /login');
    expect(() => parseJudgeOutcome(bare, '', 0.5)).not.toThrow(JudgeBudgetError);

    const emptyEndTurn = JSON.stringify({ is_error: true, result: '', stop_reason: 'end_turn', session_id: 'zzzz' });
    expect(() => parseJudgeOutcome(emptyEndTurn, 'exit code 1', 0.5)).toThrow(/no result text/);
    expect(() => parseJudgeOutcome(emptyEndTurn, 'exit code 1', 0.5)).not.toThrow(JudgeBudgetError);
  });

  it('reaches a caller through judgeSpawn, which passes the ceiling it actually spawned with', async () => {
    const { fn } = fakeSpawnAtTopLevel(killed(), { code: 1 });
    await expect(judgeSpawn({
      mandate: 'm', input: 'i', shape: SHAPE, budget: 0.5, runId: 'run-3187', lens: 'rigor', spawnFn: fn,
    })).rejects.toThrow(/max-budget-usd of \$0\.5/);
  });

  it('is a DISTINCT type from the wall-clock kill — "out of money" and "out of time" are different facts', () => {
    expect(JudgeBudgetError).not.toBe(JudgeTimeoutError);
    const e = new JudgeBudgetError({ budget: 0.5, costUsd: 0.596 });
    expect(e).not.toBeInstanceOf(JudgeTimeoutError);
    expect(e).toBeInstanceOf(Error);
  });
});

/** The same canned-stdout fake as the `judgeSpawn` block above, hoisted for the #3187 block's one use of it. */
function fakeSpawnAtTopLevel(stdout, { code = 0, stderr = '' } = {}) {
  const seen = { argv: null };
  const fn = (cli, argv) => {
    seen.argv = argv;
    return {
      stdout: { on: (e, cb) => { if (e === 'data') setTimeout(() => cb(stdout), 0); } },
      stderr: { on: (e, cb) => { if (e === 'data' && stderr) setTimeout(() => cb(stderr), 0); } },
      stdin: { on: () => {}, end: () => {} },
      on: (e, cb) => { if (e === 'close') setTimeout(() => cb(code), 1); },
      kill: () => {},
    };
  };
  return { fn, seen };
}

/**
 * HELD ITEM 223 — A JUROR THAT EXITS WITH NOTHING PARSEABLE ON STDOUT IS RETRIED, AND ITS FAILURE IS RECORDED.
 *
 * Live, 2026-10-10: 15 of 119 review runs ended `blocked-on-infra` on "the juror did not emit parseable JSON on
 * stdout". The juror had done its work (its API calls are in the OTEL log, the last one a large answer turn), and the
 * same request replayed later completed 3/3 — a transient loss, not a bad request. Before this, the first such exit
 * threw away the whole run, and the exit code, signal and stderr that would have said WHY were dropped on the way.
 */
describe('judgeSpawn — an unparseable stdout is retried once with a fresh session id (held item 223)', () => {
  const ANSWER_JSON = JSON.stringify({
    is_error: false, stop_reason: 'tool_use', session_id: 'aaaaaaaa-bbbb-8ccc-9ddd-eeeeeeeeeeee', total_cost_usd: 0.3,
    duration_ms: 40_000, num_turns: 3, usage: { input_tokens: 4 }, structured_output: { verdict: 'accept', findings: [] },
  });

  /** A spawn that plays one scripted child per call: `{stdout, stderr, code, signal}`. Records every argv. */
  function scriptedSpawn(children) {
    const calls = [];
    const fn = (cli, argv, opts) => {
      const c = children[Math.min(calls.length, children.length - 1)];
      calls.push({ cli, argv, opts });
      return {
        stdout: { on: (e, cb) => { if (e === 'data' && c.stdout) setTimeout(() => cb(c.stdout), 0); } },
        stderr: { on: (e, cb) => { if (e === 'data' && c.stderr) setTimeout(() => cb(c.stderr), 0); } },
        stdin: { on: () => {}, end: () => {} },
        on: (e, cb) => { if (e === 'close') setTimeout(() => cb(c.code ?? null, c.signal ?? null), 1); },
        kill: () => {},
      };
    };
    return { fn, calls };
  }
  const sidOf = (argv) => flagValue(argv, '--session-id');

  it('retries an EMPTY stdout once and returns the second attempt\'s answer', async () => {
    const { fn, calls } = scriptedSpawn([{ stdout: '', code: 1 }, { stdout: ANSWER_JSON, code: 0 }]);
    const r = await judgeSpawn({ mandate: 'm', input: 'i', shape: SHAPE, runId: 'run-7', lens: 'rigor', retries: 1, log: () => {}, spawnFn: fn });
    expect(calls).toHaveLength(2);
    expect(r.value).toEqual({ verdict: 'accept', findings: [] });
    expect(r.attempts).toBe(2);
    // The failed attempt is carried on the result, so a caller can see a retry happened and why.
    expect(r.failedAttempts).toHaveLength(1);
    expect(r.failedAttempts[0]).toMatchObject({ attempt: 1, exitCode: 1, signal: null, stdoutBytes: 0 });
  });

  it('gives each attempt its OWN derived session id — distinct, deterministic, never the first one reused', async () => {
    const { fn, calls } = scriptedSpawn([{ stdout: 'not json', code: 1 }, { stdout: ANSWER_JSON, code: 0 }]);
    await judgeSpawn({ mandate: 'm', input: 'i', shape: SHAPE, runId: 'run-7', lens: 'rigor', retries: 1, log: () => {}, spawnFn: fn });
    const [first, second] = calls.map((c) => sidOf(c.argv));
    expect(first).toBe(SID);
    expect(second).not.toBe(first);
    expect(second).toBe(retrySessionId(SID, 2));
    expect(second).toMatch(/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
    // Distinct per attempt.
    expect(retrySessionId(SID, 3)).not.toBe(retrySessionId(SID, 2));
  });

  it('still unparseable after the retry → a typed JudgeUnparseableError carrying exit code, signal and a bounded stderr tail', async () => {
    const bigStderr = `${'x'.repeat(5000)}\nTHE-LAST-STDERR-LINE`;
    const { fn, calls } = scriptedSpawn([
      { stdout: '', stderr: 'first attempt died', code: null, signal: 'SIGTERM' },
      { stdout: '', stderr: bigStderr, code: null, signal: 'SIGTERM' },
    ]);
    const err = await judgeSpawn({ mandate: 'm', input: 'i', shape: SHAPE, runId: 'run-7', lens: 'rigor', retries: 1, log: () => {}, spawnFn: fn })
      .then(() => null, (e) => e);
    expect(calls).toHaveLength(2);
    expect(err).toBeInstanceOf(JudgeUnparseableError);
    expect(err.exitCode).toBe(null);
    expect(err.signal).toBe('SIGTERM');
    expect(err.attempts).toBe(2);
    expect(err.stderrTail).toContain('THE-LAST-STDERR-LINE');
    expect(err.stderrTail.length).toBeLessThanOrEqual(1000);
    expect(err.failedAttempts.map((a) => a.signal)).toEqual(['SIGTERM', 'SIGTERM']);
    // The FIRST LINE keeps the old wording (so existing labels still match) and now names the evidence, because a
    // caller that keeps only the first line (the review job's label) must still learn exit code and signal.
    const firstLine = err.message.split('\n')[0];
    expect(firstLine).toMatch(/^judge-spawn: the juror did not emit parseable JSON on stdout/);
    expect(firstLine).toMatch(/attempt 2\/2/);
    expect(firstLine).toMatch(/signal SIGTERM/);
    expect(firstLine).toMatch(/THE-LAST-STDERR-LINE/);
    expect(firstLine.length).toBeLessThanOrEqual(400);
    // The run record's telemetry row is built from `err.telemetry`: it names the failure and the last actor.
    expect(err.telemetry).toMatchObject({
      sessionId: retrySessionId(SID, 2), exitCode: null, signal: 'SIGTERM', attempts: 2, failure: 'unparseable-stdout',
    });
    expect(typeof err.telemetry.wallMs).toBe('number');
    expect(err.telemetry.stderrTail).toContain('THE-LAST-STDERR-LINE');
  });

  it('captures a non-zero exit code with no signal', async () => {
    const { fn } = scriptedSpawn([{ stdout: '', code: 137 }]);
    const err = await judgeSpawn({ mandate: 'm', input: 'i', shape: SHAPE, sessionId: SID, retries: 0, log: () => {}, spawnFn: fn })
      .then(() => null, (e) => e);
    expect(err).toBeInstanceOf(JudgeUnparseableError);
    expect(err.exitCode).toBe(137);
    expect(err.signal).toBe(null);
    expect(err.message.split('\n')[0]).toMatch(/exit 137/);
  });

  it('retries: 0 spawns exactly once', async () => {
    const { fn, calls } = scriptedSpawn([{ stdout: '', code: 1 }, { stdout: ANSWER_JSON, code: 0 }]);
    await expect(judgeSpawn({ mandate: 'm', input: 'i', shape: SHAPE, sessionId: SID, retries: 0, log: () => {}, spawnFn: fn }))
      .rejects.toBeInstanceOf(JudgeUnparseableError);
    expect(calls).toHaveLength(1);
  });

  it('does NOT retry a juror that answered with its own error text (a real failure, not a lost output)', async () => {
    const { fn, calls } = scriptedSpawn([{ stdout: JSON.stringify({ is_error: true, result: 'Not logged in · Please run /login' }), code: 1 }]);
    await expect(judgeSpawn({ mandate: 'm', input: 'i', shape: SHAPE, sessionId: SID, retries: 1, log: () => {}, spawnFn: fn }))
      .rejects.toThrow('Not logged in');
    expect(calls).toHaveLength(1);
  });

  it('logs the retry with the setting\'s value AND where that value came from', async () => {
    const lines = [];
    const { fn } = scriptedSpawn([{ stdout: '', code: 1 }, { stdout: ANSWER_JSON, code: 0 }]);
    await judgeSpawn({
      mandate: 'm', input: 'i', shape: SHAPE, runId: 'run-7', lens: 'rigor', log: (l) => lines.push(l), spawnFn: fn,
      env: { [UNPARSEABLE_RETRY_SETTING.env]: '1' },
    });
    expect(lines.join('\n')).toMatch(new RegExp(`${UNPARSEABLE_RETRY_SETTING.key}=1 \\(source: env\\)`));
    expect(lines.join('\n')).toContain(retrySessionId(SID, 2));
  });

  it('takes the retry count from the cascade when the caller passes none (env 0 → no retry)', async () => {
    const { fn, calls } = scriptedSpawn([{ stdout: '', code: 1 }, { stdout: ANSWER_JSON, code: 0 }]);
    await expect(judgeSpawn({
      mandate: 'm', input: 'i', shape: SHAPE, sessionId: SID, log: () => {}, spawnFn: fn, env: { [UNPARSEABLE_RETRY_SETTING.env]: '0' },
    })).rejects.toBeInstanceOf(JudgeUnparseableError);
    expect(calls).toHaveLength(1);
  });
});

describe('resolveUnparseableRetries — the retry count is a cascade setting with its source', () => {
  const readOf = (obj) => () => JSON.stringify(obj);
  const key = UNPARSEABLE_RETRY_SETTING.key;
  const envKey = UNPARSEABLE_RETRY_SETTING.env;

  it('built-in default is one retry', () => {
    expect(resolveUnparseableRetries({ env: {}, readFile: readOf({}) })).toEqual({ value: 1, source: 'default' });
    expect(UNPARSEABLE_RETRY_SETTING.builtIn).toBe(1);
  });
  it('the settings file beats the built-in, env beats the settings file', () => {
    expect(resolveUnparseableRetries({ env: {}, readFile: readOf({ [key]: 2 }) })).toEqual({ value: 2, source: 'settings' });
    expect(resolveUnparseableRetries({ env: { [envKey]: '0' }, readFile: readOf({ [key]: 2 }) })).toEqual({ value: 0, source: 'env' });
  });
  it('a value that is not a small non-negative integer falls through to the next layer', () => {
    expect(resolveUnparseableRetries({ env: { [envKey]: 'lots' }, readFile: readOf({ [key]: -1 }) })).toEqual({ value: 1, source: 'default' });
    expect(resolveUnparseableRetries({ env: { [envKey]: '99' }, readFile: readOf({ [key]: '1.5' }) })).toEqual({ value: 1, source: 'default' });
  });
  it('an unreadable settings file is the built-in, never a throw', () => {
    expect(resolveUnparseableRetries({ env: {}, readFile: () => { throw new Error('ENOENT'); } })).toEqual({ value: 1, source: 'default' });
  });
});

describe('parseJudgeOutcome — a stray line around the result object does not lose the answer', () => {
  it('reads the last line that is a JSON result object when the whole stdout is not one document', () => {
    const answer = JSON.stringify({ is_error: false, stop_reason: 'tool_use', session_id: 's', structured_output: { verdict: 'accept', findings: [] } });
    expect(parseJudgeOutcome(`some warning printed to stdout\n${answer}\n`).value).toEqual({ verdict: 'accept', findings: [] });
  });
  it('still throws the unparseable error, marked as such, when no line is a result object', () => {
    let err;
    try { parseJudgeOutcome('{"structured_output": {"verd', ''); } catch (e) { err = e; }
    expect(err.message).toMatch(/did not emit parseable JSON/);
    expect(err.unparseableStdout).toBe(true);
  });
});
