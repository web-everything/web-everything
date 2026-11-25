/**
 * @file juror-flags.test.mjs — `--cwd` and `--model`, the JUROR flags of the derived command line (#3151).
 *
 * THE DEFECT THIS PINS. `review-pr`'s juror is TOOL-BEARING, and `assertLaneCwd` refuses to spawn one without a
 * lane of its own. That refusal is correct. What was not correct is that the ONLY way to supply the lane was
 * `JUDGE_LANE_CWD` in the environment: no `--help` output named it, the unknown-flag error listed only the
 * declared inputs, and so on 2026-08-17 at least three independent reviewers hit
 * `refusing to spawn a TOOL-BEARING juror` and each fell back to a fully manual review. A fourth found that
 * `--model=sonnet` — written into a dispatch prompt from memory — was not a flag at all.
 *
 * SO THE TESTS ARE THE TWO ROUND TRIPS A REVIEWER ACTUALLY MAKES:
 *
 *   1. **Error text → flag.** `--help` names the refusal verbatim enough to search for, and the unknown-flag
 *      message enumerates the control flags rather than only the declared inputs.
 *   2. **Flag → spawn.** A tool-bearing juror driven through `runOperationCli` with `--cwd=<a lane>` and
 *      **`JUDGE_LANE_CWD` deleted from the environment** reaches the spawn with that lane, and the REAL
 *      `assertLaneCwd` accepts it — the same run without the flag still refuses, which is what proves the flag
 *      is the thing supplying the lane and not an accident of the ambient environment.
 *
 * NOTHING HERE SPAWNS A JUROR. The `provider` handed to `createDefaultJudge` is a stub that runs the real
 * `assertLaneCwd` over the options it was given and then returns a canned answer, so the guard under test is
 * the shipped one while the subprocess is not paid for. The one child process is `run.mjs --help`, whose whole
 * point is that the derived usage text reaches an operator through the real entry point.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';

import { createRegistry, op } from '../registry.mjs';
import { compute, judge } from '../step-kinds.mjs';
import { createMemoryRunStore } from '../run-store.mjs';
import {
  CONTROL_FLAGS, JUROR_FLAGS, buildCliSpec, createDefaultJudge, declaresJudgeStep, parseOperationArgv,
  runOperationCli,
} from '../cli-adapter.mjs';
// THE SHIPPED WIRING, IMPORTED — not re-derived here. An earlier cut of this file rebuilt `run.mjs`'s factory
// as a local arrow, so deleting the flags from `run.mjs` entirely left 14 of these 15 tests green: the
// precedence was asserted, never exercised (PR review, finding A). Driving the real function is the only
// version of this test that can catch a later edit flipping `flag || env` to `env || flag`.
import { createCliJudgeFactory } from '../run.mjs';
import { assertLaneCwd } from '../../lib/judge-spawn.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUN_CLI = resolve(HERE, '..', 'run.mjs');

/** A tool-bearing declaration: one `judge` step whose request asks for tools, so `assertLaneCwd` binds. */
function toolBearingOp({ model = 'sonnet' } = {}) {
  return op('tool-bearing', {
    input: { subject: { type: 'string', required: false, default: 'a diff' } },
    verdictFrom: 'ask',
    ask: judge({
      reads: ['input.subject'],
      request: (view) => ({
        mandate: `judge ${view.input.subject}`,
        input: view.input.subject,
        shape: { type: 'object' },
        model,
        effort: 'high',
        budget: 1,
        allowedTools: ['Bash', 'Read'],
      }),
    }),
  });
}

/** A juror-less declaration — every step `compute`, so the juror flags mean nothing and must be refused. */
const jurorLessOp = op('juror-less', { input: {}, only: compute({ fn: () => ({ ok: true }) }) });

/** #xqa9ttq — a TOOL-FREE judge declaration: `--provider=codex` is refused for a tool-bearing one (#3581's
 *  tool-free-only sequencing), so the `--provider` WIRING tests below (which are about the FLAG reaching the
 *  factory, not about that refusal) use this instead of `toolBearingOp()`. */
const toolFreeOp = op('tool-free', {
  input: {},
  verdictFrom: 'ask',
  ask: judge({
    reads: [],
    request: () => ({ mandate: 'judge it', input: 'the subject', shape: { type: 'object' } }),
  }),
});

/** Drive a declaration, recording what the spawn was handed. The REAL `assertLaneCwd` runs inside it. */
async function driveWithSpawnSpy({ declaration, argv, laneEnv = undefined }) {
  const registry = createRegistry();
  registry.register(declaration);
  const seen = [];
  const provider = async (opts) => {
    // THE SHIPPED GUARD, not a re-implementation of it. `selfCwd` is left at its default (this process), which
    // is the honest arrangement: the driver is wherever vitest runs, and the temp lane is never inside it.
    assertLaneCwd(opts.cwd ?? null, opts.allowedTools ?? null);
    seen.push(opts);
    return { value: { verdict: 'pass' }, costUsd: 0.01, durationMs: 1, wallMs: 1, numTurns: 1 };
  };
  // BOTH ENVIRONMENTS ARE EMPTIED, and that redundancy is the point. The injected `env` is what the factory
  // reads, so the assertion is deterministic and parallel-safe; `process.env` is cleared too, so a regression
  // in which something reads the ambient variable DIRECTLY (bypassing the injected one) still reddens rather
  // than passing on a value this test believed it had removed.
  const env = laneEnv === undefined ? {} : { JUDGE_LANE_CWD: laneEnv };
  const before = process.env.JUDGE_LANE_CWD;
  if (laneEnv === undefined) delete process.env.JUDGE_LANE_CWD; else process.env.JUDGE_LANE_CWD = laneEnv;
  try {
    const out = await runOperationCli({
      declaration,
      registry,
      store: createMemoryRunStore(),
      sinks: {},
      // `run.mjs`'s OWN factory, with only the spawn substituted. Nothing about the flag→spawn precedence is
      // re-implemented here, so a change to it in `run.mjs` is a change to what these tests measure.
      makeJudge: createCliJudgeFactory({ env, factory: (opts) => createDefaultJudge({ ...opts, provider }) }),
      argv,
      newRunId: () => 'run-juror-flags',
    });
    return { out, seen };
  } finally {
    if (before === undefined) delete process.env.JUDGE_LANE_CWD; else process.env.JUDGE_LANE_CWD = before;
  }
}

let tmp;
let lane;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'we-juror-flags-'));
  // A lane is `<workspace>/.lanes/<pool>/lane-N` and `assertLaneCwd` realpaths it, so it must EXIST on disk.
  lane = join(tmp, '.lanes', 'web-everything', 'lane-77');
  mkdirSync(lane, { recursive: true });
});
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

// ── 1. THE FLAGS ARE DERIVED FROM THE STEP KINDS ─────────────────────────────────────────────────────────
describe('#3151 the juror flags exist only where a juror does', () => {
  it('`declaresJudgeStep` reads the kinds, so a compute-only declaration has no juror', () => {
    expect(declaresJudgeStep(toolBearingOp())).toBe(true);
    expect(declaresJudgeStep(jurorLessOp)).toBe(false);
    expect(JUROR_FLAGS.every((f) => CONTROL_FLAGS.includes(f))).toBe(true);
  });

  it('documents `--cwd` in the usage text, naming the refusal it prevents', () => {
    const usage = buildCliSpec(toolBearingOp()).usage;
    expect(usage).toContain('[--cwd=<lane>]');
    expect(usage).toContain('[--model=<alias>]');
    // THE SEARCHABLE ROUND TRIP: the words an operator has already read in the refusal.
    expect(usage).toContain('refusing to spawn a TOOL-BEARING juror');
    expect(usage).toContain('$JUDGE_LANE_CWD');
    expect(usage).toContain('lane-pool.mjs acquire');
  });

  it('says nothing about them for a juror-less declaration, and refuses them there', () => {
    expect(buildCliSpec(jurorLessOp).usage).not.toContain('--cwd');
    const parsed = parseOperationArgv(jurorLessOp, ['--cwd=/somewhere']);
    expect(parsed.ok).toBe(false);
    expect(parsed.errors.join('\n')).toContain('--cwd needs a `judge` step');
    expect(parsed.errors.join('\n')).toContain('there is no juror to point at a lane');
  });

  it('lists the control flags in the unknown-flag message — the dead end that hid `--cwd`', () => {
    const parsed = parseOperationArgv(toolBearingOp(), ['--nope=1']);
    expect(parsed.ok).toBe(false);
    const text = parsed.errors.join('\n');
    expect(text).toContain('--cwd');
    expect(text).toContain('--model');
    expect(text).toContain('--json');
  });

  it('refuses an empty value and a flag-shaped one, before a run record exists', () => {
    const empty = parseOperationArgv(toolBearingOp(), ['--cwd=']);
    expect(empty.ok).toBe(false);
    expect(empty.errors.join('\n')).toContain('--cwd must not be empty');
    const flagShaped = parseOperationArgv(toolBearingOp(), ['--model=--bare']);
    expect(flagShaped.ok).toBe(false);
    expect(flagShaped.errors.join('\n')).toContain("looks like a flag, not a value");
  });

  it('carries a `--cwd` alongside a `--resume` — a resume takes no INPUT, but may still reach a judge step', () => {
    // ACCEPTED, NOT REQUIRED, and it is a no-op on a resume that lands PAST its judge (the `review-pr` shape:
    // the juror already ran, its finding is on the record, and the resume only answers the `confirm`). It is
    // accepted anyway because a resume of a run that halted BEFORE its judge does spawn one, and the parse
    // cannot tell the two apart without the run record it has not read yet (PR review, finding E).
    const parsed = parseOperationArgv(toolBearingOp(), ['--resume=run-1', '--cwd=/a/lane']);
    expect(parsed.ok).toBe(true);
    expect(parsed.control.cwd).toBe('/a/lane');
    expect(parsed.input).toEqual({});
  });

  it('refuses a juror flag given twice, rather than letting the last spelling win', () => {
    const parsed = parseOperationArgv(toolBearingOp(), ['--cwd=/one', '--cwd=/two']);
    expect(parsed.ok).toBe(false);
    expect(parsed.errors.join('\n')).toContain('--cwd was given more than once');
  });

  it('keeps the juror flags OUT of the accepted list for a juror-less operation', () => {
    // The other half of the unknown-flag message: naming `--cwd` as accepted where it is refused would send an
    // operator round the same loop from the other side.
    const parsed = parseOperationArgv(jurorLessOp, ['--nope=1']);
    const text = parsed.errors.join('\n');
    expect(text).toContain('--json');
    expect(text).not.toContain('--cwd');
    expect(text).not.toContain('--model');
  });

  it('keeps the RESUME flags out of it too, on an operation that cannot suspend', () => {
    // A `compute`-only declaration records no run, so `--resume`/`--answer`/`--run-id` name nothing — and the
    // usage text three lines below the list already says so. Listing them was a regression this file
    // introduced by widening the list at all (PR review r2, finding 4).
    const text = parseOperationArgv(jurorLessOp, ['--nope=1']).errors.join('\n');
    expect(text).not.toContain('--resume');
    expect(text).not.toContain('--answer');
    expect(text).not.toContain('--run-id');
    // …and they ARE named for a declaration that can suspend.
    expect(parseOperationArgv(toolBearingOp(), ['--nope=1']).errors.join('\n')).toContain('--resume');
  });
});

// ── 2. THE CARD'S ACCEPTANCE: A TOOL-BEARING JUROR, NO ENV VAR ───────────────────────────────────────────
describe('#3151 a tool-bearing juror spawns from the flag alone', () => {
  it('succeeds with `--cwd=<lane>` and JUDGE_LANE_CWD unset — the manual env thread is not needed', async () => {
    const { out, seen } = await driveWithSpawnSpy({
      declaration: toolBearingOp(), argv: [`--cwd=${lane}`],
    });
    expect(out.code).toBe(0);
    expect(out.stopped).toBe('complete');
    expect(seen).toHaveLength(1);
    expect(seen[0].cwd).toBe(lane);
    expect(seen[0].allowedTools).toEqual(['Bash', 'Read']);
  });

  it('still refuses with NO lane from either source — so the flag is what supplied it', async () => {
    // The refusal PROPAGATES rather than rendering as a stop: a judge is INJECTED io, and `driveRun`'s
    // `step-refused` stop (#3063) covers a DECLARATION fn throwing, not the caller's own spawner failing.
    // `run.mjs`'s top-level catch is what turns this into `error: …` and exit 1 for an operator. Pinned as it
    // is rather than changed — this card is about supplying the lane, not about re-shaping that seam.
    await expect(driveWithSpawnSpy({ declaration: toolBearingOp(), argv: [] }))
      .rejects.toThrow(/refusing to spawn a TOOL-BEARING juror — no `cwd` was supplied/);
  });

  it('honours $JUDGE_LANE_CWD when the flag is omitted — the old callers keep working', async () => {
    const { out, seen } = await driveWithSpawnSpy({
      declaration: toolBearingOp(), argv: [], laneEnv: lane,
    });
    expect(out.code).toBe(0);
    expect(seen[0].cwd).toBe(lane);
  });

  it('lets the FLAG win over the env var — the explicit act beats the ambient one', async () => {
    const other = join(tmp, 'other', '.lanes', 'web-everything', 'lane-78');
    mkdirSync(other, { recursive: true });
    const { out, seen } = await driveWithSpawnSpy({
      declaration: toolBearingOp(), argv: [`--cwd=${other}`], laneEnv: lane,
    });
    expect(out.code).toBe(0);
    expect(seen[0].cwd).toBe(other);
  });
});

// ── 3. `--model`, AND THE GUARD IT DOES NOT WEAKEN ───────────────────────────────────────────────────────
describe('#3151 `--model` overrides the declared juror model without reopening #3028', () => {
  it('reaches the spawn, replacing the model the declaration asked for', async () => {
    const { out, seen } = await driveWithSpawnSpy({
      declaration: toolBearingOp({ model: 'sonnet' }), argv: [`--cwd=${lane}`, '--model=opus'],
    });
    expect(out.code).toBe(0);
    expect(seen[0].model).toBe('opus');
  });

  it('uses the declared model when the flag is absent', async () => {
    const { seen } = await driveWithSpawnSpy({
      declaration: toolBearingOp({ model: 'sonnet' }), argv: [`--cwd=${lane}`],
    });
    expect(seen[0].model).toBe('sonnet');
  });

  it('is NOT run input — the run record records the declared input and nothing else', async () => {
    const { out } = await driveWithSpawnSpy({
      declaration: toolBearingOp(), argv: [`--cwd=${lane}`, '--model=opus', '--subject=a PR'],
    });
    expect(out.run.input).toEqual({ subject: 'a PR' });
    expect(JSON.stringify(out.run.input)).not.toContain('opus');
  });

  it('records WHICH model judged on the run record, not only what it cost', async () => {
    // Without this the record implies the DECLARED model — which was harmless while the model was a literal
    // and is a false record now that an operator can override it (PR review, finding B).
    const { out } = await driveWithSpawnSpy({
      declaration: toolBearingOp({ model: 'sonnet' }), argv: [`--cwd=${lane}`, '--model=opus'],
    });
    expect(out.run.telemetry).toHaveLength(1);
    expect(out.run.telemetry[0].model).toBe('opus');
    // `effort` stays the DECLARED one — there is no flag for it, and the engine does not take the caller's
    // word on it. Asserting `'high'` here proves nothing on its own (the declaration also asks for `'high'`);
    // the path is pinned where it can actually diverge, in engine.test.mjs's reported-≠-declared fixture.
    expect(out.run.telemetry[0].effort).toBe('high');
  });

  it('is guarded AFTER the merge, so a flag-shaped override cannot reach argv', async () => {
    // `createDefaultJudge` is reachable by hand, not only through the parse that already refuses this — so the
    // factory itself must assert the value it is about to SPAWN, never the one it was handed.
    const judgeFn = createDefaultJudge({ provider: async () => ({ value: {} }), model: '--bare' });
    await expect(judgeFn({ mandate: 'm', shape: {}, model: 'sonnet', effort: 'high', budget: 1 }))
      .rejects.toThrow(/refusing to spawn a juror with `model`/);
  });
});

// ── #xqa9ttq — `--provider` FOLLOWS THE SAME PARSE/FACTORY SHAPE `--cwd`/`--model` ESTABLISHED (#3151),
// extended by ONE MORE juror flag. Unlike `--cwd`/`--model`, it is a CLOSED ENUM (`JUDGE_PROVIDER_NAMES`),
// refused at the parse seam rather than left to fail downstream — see `parseOperationArgv`'s own comment on
// why (a command-line typo should name the flag it typo'd, not surface inside `createDefaultJudge`).
describe('#xqa9ttq `--provider` — opt-in JudgeProvider selection, additive over `--cwd`/`--model`', () => {
  it('is refused for a juror-less declaration, exactly like `--cwd`/`--model`', () => {
    const parsed = parseOperationArgv(jurorLessOp, ['--provider=codex']);
    expect(parsed.ok).toBe(false);
    expect(parsed.errors.join('\n')).toContain('--provider needs a `judge` step');
    expect(parsed.errors.join('\n')).toContain('there is no juror to pick an implementation for');
  });

  it('is listed in the unknown-flag message for a tool-bearing declaration', () => {
    const text = parseOperationArgv(toolBearingOp(), ['--nope=1']).errors.join('\n');
    expect(text).toContain('--provider');
  });

  it('accepts exactly the three named providers, and refuses anything else at the parse seam', () => {
    expect(parseOperationArgv(toolBearingOp(), [`--cwd=${lane}`, '--provider=claude']).ok).toBe(true);
    expect(parseOperationArgv(toolBearingOp(), [`--cwd=${lane}`, '--provider=codex']).ok).toBe(true);
    // #3383 — the fifth seat's provider, added the same additive way `codex` was.
    expect(parseOperationArgv(toolBearingOp(), [`--cwd=${lane}`, '--provider=antigravity']).ok).toBe(true);
    const bad = parseOperationArgv(toolBearingOp(), [`--cwd=${lane}`, '--provider=gemini']);
    expect(bad.ok).toBe(false);
    expect(bad.errors.join('\n')).toMatch(/--provider must be one of claude\|codex\|antigravity/);
  });

  it('refuses a `--provider` given twice', () => {
    const parsed = parseOperationArgv(toolBearingOp(), [`--cwd=${lane}`, '--provider=claude', '--provider=codex']);
    expect(parsed.ok).toBe(false);
    expect(parsed.errors.join('\n')).toContain('--provider was given more than once');
  });

  it('reaches `createCliJudgeFactory`\'s factory as `providerName`, exactly like `--cwd`/`--model` reach `cwd`/`model`', async () => {
    // TOOL-FREE declaration — `--provider=codex` combined with a TOOL-BEARING one is a separate, deliberate
    // refusal (#3581), covered in `judge-provider-selection.test.mjs`; this test is only about the flag
    // reaching the factory.
    const seenOpts = [];
    const registry = createRegistry();
    registry.register(toolFreeOp);
    await runOperationCli({
      declaration: toolFreeOp,
      registry,
      store: createMemoryRunStore(),
      sinks: {},
      makeJudge: createCliJudgeFactory({
        env: {},
        factory: (opts) => { seenOpts.push(opts); return createDefaultJudge({ ...opts, provider: async () => ({ value: {} }) }); },
      }),
      argv: ['--provider=codex'],
      newRunId: () => 'run-provider-flag',
    });
    expect(seenOpts).toHaveLength(1);
    expect(seenOpts[0].providerName).toBe('codex');
  });

  it('defaults `providerName` to \'claude\' when the flag is omitted and no env fallback is set', async () => {
    const seenOpts = [];
    const registry = createRegistry();
    registry.register(toolFreeOp);
    await runOperationCli({
      declaration: toolFreeOp,
      registry,
      store: createMemoryRunStore(),
      sinks: {},
      makeJudge: createCliJudgeFactory({
        env: {},
        factory: (opts) => { seenOpts.push(opts); return createDefaultJudge({ ...opts, provider: async () => ({ value: {} }) }); },
      }),
      argv: [],
      newRunId: () => 'run-provider-default',
    });
    expect(seenOpts[0].providerName).toBe('claude');
  });

  it('falls back to JUDGE_PROVIDER when the flag is omitted, and the FLAG WINS when both are set', async () => {
    const seenOpts = [];
    const registry = createRegistry();
    registry.register(toolFreeOp);
    const run = async (argv) => {
      seenOpts.length = 0;
      await runOperationCli({
        declaration: toolFreeOp,
        registry,
        store: createMemoryRunStore(),
        sinks: {},
        makeJudge: createCliJudgeFactory({
          env: { JUDGE_PROVIDER: 'codex' },
          factory: (opts) => { seenOpts.push(opts); return createDefaultJudge({ ...opts, provider: async () => ({ value: {} }) }); },
        }),
        argv,
        newRunId: () => 'run-provider-env',
      });
    };
    await run([]);
    expect(seenOpts[0].providerName).toBe('codex'); // env fallback, flag omitted
    await run(['--provider=claude']);
    expect(seenOpts[0].providerName).toBe('claude'); // explicit flag wins over the env var
  });
});

// ── 4. THE REAL ENTRY POINT PRINTS IT ────────────────────────────────────────────────────────────────────
describe('#3151 `run.mjs review-pr --help` documents the flag', () => {
  it('names `--cwd` and the refusal, through the shipped CLI in a real process', () => {
    const stdout = execFileSync(process.execPath, [RUN_CLI, 'review-pr', '--help'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(stdout).toContain('[--cwd=<lane>]');
    expect(stdout).toContain('refusing to spawn a TOOL-BEARING juror');
    // The card's other half: `--model` is a real flag on this operation now, not a dispatch-prompt fiction.
    expect(stdout).toContain('[--model=<alias>]');
  });
});


it('passes daemon exclusions from the job environment into the real judge factory', () => {
  const exclusions = [{ lens: 'security', provider: 'claude' }];
  const factory = vi.fn(() => async () => {});
  createCliJudgeFactory({ env: { WE_REVIEW_JUROR_TIMEOUT_EXCLUSIONS: JSON.stringify(exclusions) }, factory })({});
  expect(factory.mock.calls[0][0].jurorTimeoutExclusions).toEqual(exclusions);
  expect(() => createCliJudgeFactory({ env: { WE_REVIEW_JUROR_TIMEOUT_EXCLUSIONS: '{' }, factory })({})).toThrow();
});
