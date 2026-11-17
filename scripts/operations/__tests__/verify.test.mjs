/**
 * @file verify.test.mjs — the `verify` operation (#xp240uk).
 *
 * THE PROPERTY UNDER TEST is three-valuedness. A check that passed, one that failed, and one that COULD NOT
 * RUN are three different facts, and hand-rolled shell loses the third every time: a missing dependency, a
 * crashed runner or a changed summary line exits non-zero with nothing parseable, and a `grep` that finds no
 * errors calls that green. So the cases below are weighted toward `unrun` — it is the outcome the operation
 * exists to make impossible to lose.
 *
 * No npm, no vitest, no toolchain: the runner is injected in the declaration tests and the spawn is injected
 * in the io tests, so every branch is reachable on any host.
 */
import { describe, it, expect } from 'vitest';
import {
  verifyOperation, shapeRunFinding, assessChecks, VERIFY_MODES, CHECK_OUTCOMES, VERIFY_OP,
} from '../verify.mjs';
import { verifyArgv, classifyVerifyResult, createChecksRunner, VERIFY_LANE_CLI } from '../verify-io.mjs';

const check = (over = {}) => ({ name: 'verify-lane', outcome: 'pass', summary: 'verified green for abc12345', ...over });
const finding = (checks) => shapeRunFinding({ cwd: '/lane', suite: 'run', checks });

describe('the declaration', () => {
  it('declares run, check and request modes and forwards request to the runner', () => {
    expect(VERIFY_MODES).toEqual(['run', 'check', 'request']);
    const seen = [];
    const decl = verifyOperation({ runChecks: (args) => {
      seen.push(args);
      return { checks: [check({ outcome: 'unrun', reason: 'requested, pending' })] };
    } });
    const result = decl.steps.find((s) => s.name === 'run').step.fn({
      input: { checkout: '/lane-3', mode: 'request', gate: 'npm run locus:gate' },
    });
    expect(seen).toEqual([{ cwd: '/lane-3', mode: 'request', gate: 'npm run locus:gate' }]);
    expect(assessChecks(result)).toMatchObject({ ok: false, passed: 0, failed: 0, unrun: 1 });
  });

  it('derives its own command line from the declaration — no argv code', () => {
    const decl = verifyOperation({ runChecks: () => ({ checks: [check()] }) });
    expect(decl.name).toBe(VERIFY_OP);
    expect(Object.keys(decl.input)).toEqual(['checkout', 'mode', 'gate']);
    expect(decl.input.checkout.required).toBe(true);
    expect(decl.input.mode.enum).toEqual([...VERIFY_MODES]);
    // #xvj8sj0 — OPTIONAL, defaulting to empty, which the io reads as "let the home apply its own default".
    // Making it required would break every existing caller; giving it a default HERE would restate the home's.
    expect(decl.input.gate).toMatchObject({ required: false, default: '' });
  });

  // #3240 / PR #1516 correctness juror, CONFIRMED. The gate pass-through was tested only at the IO layer
  // (`verifyArgv`, `createChecksRunner`). The DECLARATION's own `run` step — which threads `view.input.gate`
  // into the injected `runChecks()` — had no test, and the juror proved it by dropping that field and watching
  // the full 869-test operations suite stay green.
  //
  // That is the same defect this PR's own commit message claims to have killed ("the runner drops the field"),
  // fixed one layer down and left standing one layer up. The two layers need separate tests because each can
  // drop the value independently.
  it('the `run` STEP threads the caller\'s gate into the injected runner (#3240)', () => {
    const seen = [];
    const decl = verifyOperation({ runChecks: (args) => { seen.push(args); return { checks: [check()] }; } });
    const runStep = decl.steps.find((s) => s.name === 'run').step;
    runStep.fn({ input: { checkout: '/lane-3', mode: 'run', gate: 'npm run locus:gate' } });
    expect(seen).toEqual([{ cwd: '/lane-3', mode: 'run', gate: 'npm run locus:gate' }]);
  });

  it('the `run` step declares a READ of input.gate — an undeclared read is refused by the engine', () => {
    // The engine only hands a step what it declared. Without `input.gate` in `reads`, the fn above would see
    // `undefined` no matter what the caller passed, so the read list is part of the wiring, not bookkeeping.
    const decl = verifyOperation({ runChecks: () => ({ checks: [check()] }) });
    expect(decl.steps.find((s) => s.name === 'run').step.reads).toContain('input.gate');
  });

  // Defaulting to `process.cwd()` is the #1178 shape: an operation that verifies whichever directory the
  // caller happened to be standing in reports on the wrong tree, and a green verdict for another checkout is
  // worse than no verdict.
  it('requires the checkout rather than defaulting to wherever the caller stands', () => {
    expect(verifyOperation({ runChecks: () => ({ checks: [] }) }).input.checkout.default).toBeUndefined();
  });

  it('refuses to build without an injected runner', () => {
    expect(() => verifyOperation({})).toThrow(/runChecks/);
  });
});

describe('shapeRunFinding — a runner that did not answer is refused, not assumed', () => {
  it('refuses an unknown shape rather than reporting an empty check list', () => {
    for (const raw of [null, undefined, {}, { checks: 'no' }]) expect(() => shapeRunFinding(raw)).toThrow(/must return/);
  });

  // THE ONE THAT MATTERS: an outcome the runner could not classify must not arrive as a quiet pass.
  it('refuses a check whose outcome is not one of the three', () => {
    for (const outcome of [undefined, null, 'ok', 'green', true, 'PASS']) {
      expect(() => finding([check({ outcome })])).toThrow(/must be one of pass\|fail\|unrun/);
    }
    expect(CHECK_OUTCOMES).toEqual(['pass', 'fail', 'unrun']);
  });

  it('refuses an unnamed check — it cannot be acted on', () => {
    expect(() => finding([check({ name: '  ' })])).toThrow(/no `name`/);
  });
});

describe('assessChecks — the verdict', () => {
  it('is ok only when EVERY check passed', () => {
    expect(assessChecks(finding([check(), check({ name: 'verify-lane:marker' })])).ok).toBe(true);
  });

  /**
   * `ok` is not `!failed`, and this is the difference. With zero failures and one check that never ran, a
   * `!failed` verdict reports green over a gate that did not execute — which is precisely the state a caller
   * is gating against.
   */
  it('is NOT ok when a check could not run, even with zero failures', () => {
    const v = assessChecks(finding([check(), check({ name: 'verify-lane:marker', outcome: 'unrun', reason: 'exit 1, no summary' })]));
    expect(v.failed).toBe(0);
    expect(v.unrun).toBe(1);
    expect(v.ok).toBe(false);
  });

  // A gate that did not run outranks one that failed: the failure is at least known.
  it('ranks a did-not-run above a failure in what it hands the caller', () => {
    const v = assessChecks(finding([
      check({ outcome: 'fail', errors: 2, summary: 'suites failed for abc12345' }),
      check({ name: 'verify-lane:marker', outcome: 'unrun', reason: 'killed by SIGKILL' }),
    ]));
    expect(v.blocking.map((b) => b.why)).toEqual(['did-not-run', 'failed']);
    expect(v.blocking[0].detail).toMatch(/SIGKILL/);
  });

  // Silence is not green. A suite that produced no checks has told the caller nothing.
  it('does not report ok for an empty suite, and says so', () => {
    const v = assessChecks(finding([]));
    expect(v.ok).toBe(false);
    expect(v.emptySuite).toBe(true);
  });


});

/**
 * THE SINGLE-HOME CONTRACT. The first cut of this io ran the suites itself and parsed their summary lines —
 * a second implementation of a step `we:scripts/verify-lane.mjs` already owns, and one that skipped the
 * HEAD-keyed marker `pr-land` gates on. It could therefore have reported `ok` on a lane `pr-land` refused.
 */
describe('verifyArgv — it shells the home, and the home is this repo\'s', () => {
  it('uses the request subcommand, forwarding the gate as one argument without running it', () => {
    expect(verifyArgv({ checkout: '/lane-3', mode: 'request', gate: 'npm run locus:gate && npm run check:standards' }))
      .toEqual([VERIFY_LANE_CLI, 'request', '--repo=/lane-3', '--json', '--gate=npm run locus:gate && npm run check:standards']);
    for (const gate of ['', '   ', undefined]) {
      expect(verifyArgv({ checkout: '/lane-3', mode: 'request', gate }))
        .toEqual([VERIFY_LANE_CLI, 'request', '--repo=/lane-3', '--json']);
    }
  });

  it('runs the suites through verify-lane.mjs, pointed at the named checkout', () => {
    expect(verifyArgv({ checkout: '/lane-3', mode: 'run' }))
      .toEqual([VERIFY_LANE_CLI, '--repo=/lane-3', '--json']);
  });

  it('uses the home\'s own read-only subcommand for `check`, as a positional before the flags', () => {
    expect(verifyArgv({ checkout: '/lane-3', mode: 'check' }))
      .toEqual([VERIFY_LANE_CLI, 'check', '--repo=/lane-3', '--json']);
  });

  // #xvj8sj0 — the gate pass-through. Found by the #3224 scan: the delivery-agent brief runs the home with the
  // item's LOCUS gate, and with no `gate` input, rewiring that line to the operation would have run the
  // DEFAULT suite while reporting green — the PR #1508 shape of a rewrite that silently drops what the raw
  // call did.
  describe('the caller\'s gate reaches the home (#xvj8sj0)', () => {
    it('forwards a supplied gate as ONE argv element', () => {
      // One element, not shell-split. The value is a full command line containing `&&`, and splitting it here
      // would hand the home a fragment and leak the rest toward a shell.
      expect(verifyArgv({ checkout: '/lane-3', mode: 'run', gate: 'npm run test:unit && npm run check:standards' }))
        .toEqual([VERIFY_LANE_CLI, '--repo=/lane-3', '--json', '--gate=npm run test:unit && npm run check:standards']);
    });

    it('OMITS the flag when no gate is given, so the home applies its own default', () => {
      // `--gate=` is not "use the default": the home reads it as a string and would run the EMPTY command.
      // The default itself is never restated here — one answer per question (#2644).
      for (const gate of ['', '   ', undefined]) {
        expect(verifyArgv({ checkout: '/lane-3', mode: 'run', gate })).not.toContain('--gate=');
        expect(verifyArgv({ checkout: '/lane-3', mode: 'run', gate })).toEqual([VERIFY_LANE_CLI, '--repo=/lane-3', '--json']);
      }
    });

    it('never passes a gate in `check` mode, which runs no suites at all', () => {
      // `check` reads the marker HEAD already carries. A gate there is an argument the home ignores, which
      // reads to the next author as though the mode honoured it.
      expect(verifyArgv({ checkout: '/lane-3', mode: 'check', gate: 'npm run test:unit' }))
        .toEqual([VERIFY_LANE_CLI, 'check', '--repo=/lane-3', '--json']);
    });

    it('the runner carries the gate from its caller through to the argv', () => {
      // The WIRING, not just the pure function — the PR #1510 blocker in one assertion: every test above
      // would pass while `createChecksRunner` dropped the field on the floor.
      let seen = null;
      const run = createChecksRunner({ spawn: (_exe, argv) => { seen = argv; return { status: 0, stdout: '{"status":"green","sha":"abc"}' }; } });
      run({ cwd: '/lane-3', mode: 'run', gate: 'npm run locus:gate' });
      expect(seen).toContain('--gate=npm run locus:gate');
    });
  });

  // Resolved from THIS file, never from cwd: the operation may verify another checkout, and the script that
  // runs must be this repo's rather than the verified tree's.
  it('resolves the home from its own location, not the verified tree', () => {
    expect(VERIFY_LANE_CLI).toMatch(/scripts\/verify-lane\.mjs$/);
    expect(VERIFY_LANE_CLI.startsWith('/')).toBe(true);
  });
});

describe('classifyVerifyResult — the home\'s vocabulary mapped onto three outcomes', () => {
  const out = (o) => ({ status: 0, stdout: JSON.stringify(o), stderr: '' });

  it('passes only a GREEN marker', () => {
    expect(classifyVerifyResult(out({ sha: 'abc12345def', status: 'green' }))).toMatchObject({ outcome: 'pass' });
  });

  it('fails a RED marker — suites ran and found a fault', () => {
    expect(classifyVerifyResult({ status: 2, stdout: JSON.stringify({ sha: 'abc', status: 'red', exitCode: 1 }) }))
      .toMatchObject({ outcome: 'fail' });
  });

  /**
   * EVERY OTHER MARKER STATE IS `unrun`, and this is the bucket the operation exists for. A stranded
   * `running`, a `corrupt` marker, an absent one — none is a failure anybody observed, and none may satisfy a
   * gate. The home already refuses to land on these; this makes the operation agree with it by construction.
   */
  it('reports every non-verdict marker state as unrun, carrying the home\'s own detail', () => {
    for (const status of ['running', 'corrupt', 'absent', 'stale', 'untracked']) {
      const r = classifyVerifyResult(out({ sha: 'abc', status, detail: `the home said ${status}` }));
      expect({ status, outcome: r.outcome }).toEqual({ status, outcome: 'unrun' });
      expect(r.reason).toContain(status);
    }
  });

  // Exit 3 writes NO marker at all. It is emphatically not a red gate.
  it('reports a usage/git error (exit 3) as unrun, not as a failure', () => {
    expect(classifyVerifyResult({ status: 3, stdout: JSON.stringify({ reason: 'not a git repo' }) }))
      .toMatchObject({ outcome: 'unrun', reason: expect.stringMatching(/exit 3/) });
  });

  it('reports unparseable output as unrun, whatever the exit code, and keeps the tail', () => {
    for (const status of [0, 1, 2]) {
      const r = classifyVerifyResult({ status, stdout: 'Error: Cannot find module', stderr: '' });
      expect(r.outcome).toBe('unrun');
      expect(r.reason).toMatch(/Cannot find module/);
    }
  });

  it('reports a kill as unrun, saying plainly it is not a failure the suites observed', () => {
    const r = classifyVerifyResult({ status: null, signal: 'SIGKILL', stdout: '' });
    expect(r.outcome).toBe('unrun');
    expect(r.reason).toMatch(/NOT a failure/);
  });

  it('reports a spawn that never started as unrun rather than throwing', () => {
    expect(classifyVerifyResult({ error: new Error('ENOENT') })).toMatchObject({ outcome: 'unrun' });
  });
});

describe('createChecksRunner', () => {
  it('makes one request spawn and keeps acceptance pending until a check reads green', () => {
    const calls = [];
    const run = createChecksRunner({ spawn: (cmd, argv) => {
      calls.push({ cmd, argv });
      return { status: 0, stdout: JSON.stringify({ sha: 'abc', status: argv.includes('request') ? 'requested' : 'green' }) };
    } });
    const requested = run({ cwd: '/lane-3', mode: 'request', gate: 'npm run locus:gate' });
    expect(calls).toEqual([{ cmd: process.execPath, argv: [VERIFY_LANE_CLI, 'request', '--repo=/lane-3', '--json', '--gate=npm run locus:gate'] }]);
    expect(requested.checks[0]).toMatchObject({ outcome: 'unrun', reason: 'requested, pending' });
    expect(assessChecks(shapeRunFinding(requested))).toMatchObject({ ok: false, passed: 0, failed: 0, unrun: 1 });
    expect(assessChecks(shapeRunFinding(run({ cwd: '/lane-3', mode: 'check' })))).toMatchObject({ ok: true, passed: 1 });
  });

  it.each(['cached', 'green', 'red'])('never reports a request response as a result, even %s', (status) => {
    const run = createChecksRunner({ spawn: () => ({ status: 0, stdout: JSON.stringify({ sha: 'abc', status }) }) });
    expect(assessChecks(shapeRunFinding(run({ cwd: '/lane-3', mode: 'request' }))))
      .toMatchObject({ ok: false, passed: 0, failed: 0, unrun: 1 });
  });

  it.each([1, 2, 3])('keeps a refused request (exit %s, no daemon) unrun and preserves the recovery detail', (status) => {
    const run = createChecksRunner({ spawn: () => ({ status, stdout: JSON.stringify({
      status: 'no-server', reason: 'verify-daemon-not-alive', detail: 'No verify daemon is alive; start the verify daemon, then re-run request.',
    }) }) });
    const result = run({ cwd: '/lane-3', mode: 'request' });
    expect(result.checks[0]).toMatchObject({ outcome: 'unrun', reason: expect.stringContaining('start the verify daemon') });
    expect(assessChecks(shapeRunFinding(result))).toMatchObject({ ok: false, passed: 0, failed: 0, unrun: 1 });
  });

  it.each([
    { status: 1, stdout: '{"status":"green"}' },
    { status: 2, stdout: '{"status":"red"}' },
    { status: 0, stdout: 'not JSON' },
    { status: 0, stdout: '{}' },
    { status: null, signal: 'SIGKILL', stdout: '{"status":"requested"}' },
    { error: new Error('ENOENT') },
  ])('fails closed for incomplete or unsuccessful request evidence: %j', (response) => {
    const run = createChecksRunner({ spawn: () => response });
    expect(assessChecks(shapeRunFinding(run({ cwd: '/lane-3', mode: 'request' }))))
      .toMatchObject({ ok: false, passed: 0, failed: 0, unrun: 1 });
  });

  it('makes exactly one call to the home and shapes its answer', () => {
    const calls = [];
    const spawn = (cmd, argv) => { calls.push(argv); return { status: 0, stdout: JSON.stringify({ sha: 'abc', status: 'green' }) }; };
    const r = createChecksRunner({ spawn })({ cwd: '/lane-3', mode: 'run' });
    expect(calls).toHaveLength(1);
    expect(r.checks).toHaveLength(1);
    expect(r.checks[0]).toMatchObject({ name: 'verify-lane', outcome: 'pass' });
  });

  it('includes the configured admission ceiling in the spawn timeout (#3383)', () => {
    // Independently specified expectations — NOT recomputed via verifySpawnTimeoutMs — so reverting the spawn's
    // bound to the suites-only 30 minutes fails here: a gate queued behind heavy commands would be killed as
    // `unrun` before its suites even started.
    const timeoutFor = (env) => {
      let seen;
      const spawn = (_cmd, _argv, opts) => { seen = opts.timeout; return { status: 0, stdout: '{"status":"green","sha":"abc"}' }; };
      createChecksRunner({ spawn, env })({ cwd: '/x', mode: 'run' });
      return seen;
    };
    const MIN = 60_000;
    expect(timeoutFor({})).toBe((120 + 30 + 5) * MIN); // default 120-minute admission ceiling
    expect(timeoutFor({ WE_HEAVY_ADMISSION_CEILING_MS: String(10 * MIN) })).toBe((10 + 30 + 5) * MIN);
  });

  it('never throws when the home cannot be spawned', () => {
    const spawn = () => { throw new Error('ENOENT'); };
    expect(createChecksRunner({ spawn })({ cwd: '/x', mode: 'run' }).checks[0].outcome).toBe('unrun');
  });
});

it('preserves failure evidence through classification, shaping and actionable assessment', () => {
  const failureDetails = { tests: [{ file: 'suite.test.ts', name: 'nested > broken' }], summary: 'assertion failed', truncated: false };
  const stdout = JSON.stringify({ status: 'red', sha: 'abc', exitCode: 1, failureDetails });
  const classified = classifyVerifyResult({ status: 2, stdout });
  const verdict = assessChecks(finding([check(classified)]));
  expect(verdict.ok).toBe(false);
  expect(verdict.checks[0].failureDetails).toEqual(failureDetails);
  expect(verdict.blocking[0].detail).toContain('suite.test.ts > nested > broken');
  for (const over of [{ signal: 'SIGTERM' }, { status: 3 }, { stdout: 'bad' }]) {
    const result = classifyVerifyResult({ status: 2, stdout, ...over });
    expect(result.outcome).toBe('unrun');
    expect(result.failureDetails).toBeUndefined();
  }
});
