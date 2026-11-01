// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { appendVerifyRemoteReport, heartbeatOwnedSlot } from '../readiness/heavy-admission.mjs';
import { keepAliveScript } from '../lib/test-keepalive.mjs';
import { stripGateOnlyOptions, GATE_TIMEOUT_FLOORS } from '../readiness/forge-gate-options.mjs';
import { phaseAdmissionPlan, laneConfigMaySetTimeouts, laneWrapperStripsGateOptions, shouldConfirmRemoteRed, readRemoteReport, remoteInfrastructureFailure, phaseRunLocation, overallRunLocation, decidePhaseRemote } from '../lib/verify-remote-routing.mjs';
import { runInNewContext } from 'node:vm';
import { fstatSync, readSync } from 'node:fs';

vi.mock('node:fs', async importOriginal => {
  const fs = await importOriginal();
  return { ...fs, fstatSync: vi.fn(fs.fstatSync), readSync: vi.fn(fs.readSync) };
});

describe('gate-only option stripping', () => {
  it('drops only the trailing block, once each, at or above vitest defaults', () => {
    expect(GATE_TIMEOUT_FLOORS).toEqual({ '--testTimeout': 5000, '--hookTimeout': 10000 });
    expect(stripGateOnlyOptions(['a', '--passWithNoTests', '--testTimeout=15000', '--hookTimeout=30000'])).toEqual(['a']);
    expect(stripGateOnlyOptions(['a', '--testTimeout=5000', '--hookTimeout=10000'])).toEqual(['a']);
    expect(stripGateOnlyOptions(['a', '--testTimeout=4999'])).toEqual(['a', '--testTimeout=4999']);
    expect(stripGateOnlyOptions(['a', '--hookTimeout=9999', '--passWithNoTests'])).toEqual(['a', '--hookTimeout=9999']);
    expect(stripGateOnlyOptions(['--passWithNoTests', 'a'])).toEqual(['--passWithNoTests', 'a']);
    expect(stripGateOnlyOptions(['a', '--testTimeout', '15000'])).toEqual(['a', '--testTimeout', '15000']);
    expect(stripGateOnlyOptions(['a', '--testTimeout=015000'])).toEqual(['a', '--testTimeout=015000']);
    expect(stripGateOnlyOptions(['a', '--passWithNoTests', '--passWithNoTests'])).toBeNull();
    expect(stripGateOnlyOptions([])).toEqual([]);
  });
});

describe('timeout preservation', () => {
  it.each([
    '--testTimeout=15000 --hookTimeout=30000',
    '--hookTimeout=30000 --testTimeout=15000 --passWithNoTests',
    '--testTimeout=5000 --hookTimeout=10000',
    '--passWithNoTests',
  ])('hands the nested wrapper every gate option under remote policy: %s', flags => {
    const command = `npx vitest run 'scripts/changed test.test.mjs' ${flags}`;
    expect(phaseAdmissionPlan({ command, decision: { remote: true } }))
      .toEqual({ command: `npm run test:unit -- 'scripts/changed test.test.mjs' ${flags}`, takeLocalSlot: false, setHeld: false });
  });
  it.each([
    "'--testTimeout=15000' --hookTimeout='30000'",
    "--test'Timeout'=15000",
    '--testTimeout 15000 --hookTimeout 30000',
    '--testTimeout=15000 --testTimeout=30000',
    '--testTimeout=15000 --reporter=dot',
  ])('keeps unsupported gate options intact under remote policy: %s', flags => {
    const command = `npx vitest run 'scripts/changed test.test.mjs' ${flags}`;
    expect(phaseAdmissionPlan({ command, decision: { remote: true } }))
      .toEqual({ command, takeLocalSlot: true, setHeld: true });
  });

  it.each([false, true])('a Forge-dispatched phase that falls back locally still runs with its original timeouts (phase=%s)', async phaseAdmission => {
    const source = readFileSync(resolve(repo, 'scripts/verify-lane.mjs'), 'utf8');
    const admissionStart = source.indexOf('async function acquireAdmission(');
    const admissionEnd = source.indexOf('const admission = await acquireAdmission(', admissionStart);
    const runStart = source.indexOf('async function timedRunGate(');
    const runEnd = source.indexOf('// runVitestOnBase', runStart);
    expect(admissionStart).toBeGreaterThan(-1);
    expect(admissionEnd).toBeGreaterThan(admissionStart);
    expect(runStart).toBeGreaterThan(-1);
    expect(runEnd).toBeGreaterThan(runStart);
    const command = 'npx vitest run scripts/changed.test.mjs --testTimeout=15000 --hookTimeout=30000';
    const acquireSlotBlocking = vi.fn(async () => ({ ok: true, slot: 0, waitedMs: 0 }));
    const decidePhaseRemote = vi.fn(async () => ({ remote: true }));
    // Simulate Forge becoming unavailable: the child runs locally and needs the requested
    // timeout for a six-second edited test. A stripped command produces the original red.
    const runGate = vi.fn(async (childCommand, _args, { forgeDispatch }) => ({
      exitCode: childCommand.includes('--testTimeout=15000') && childCommand.includes('--hookTimeout=30000') ? 0 : 1,
      remoteAttempt: forgeDispatch, ranOn: { location: 'local' },
    }));
    const context = {
      phaseAdmission, phaseAdmissionPlan, decidePhaseRemote, acquireSlotBlocking,
      phaseAdmissionKind: () => ({ kind: 'files' }), classifyCommandKind: () => 'selected',
      admissionPhases: {}, laneMatch: null, GATE: command, ADMISSION_TIMEOUT_MS: 1000,
      shouldConfirmRemoteRed, remoteInfrastructureFailure, mergeRunLocation: (a, b) => a === b ? a : 'mixed',
      runGate, recordOutcome: vi.fn(), buildPhaseOutcome: value => value,
      ranOnPhases: {}, phaseMs: {}, remoteUnconfirmed: false, phaseTimeout: null, vitestAdmittedLocally: false,
      resolvedGate: { decision: { changedFiles: ['scripts/changed.test.mjs'] } },
      slotHeartbeat: null, setInterval: vi.fn(() => ({ unref() {} })), clearInterval: vi.fn(),
      heartbeatOwnedSlot: vi.fn(), releaseOwnedSlot: vi.fn(),
      ADMISSION_LOCK_ROOT: '', ADMISSION_CAP: 1, REPO: repo, SLOT_HEARTBEAT_MS: 1000,
      PHASE_TIMEOUT_MS: 60000, MARKER_NONCE_SUFFIX: '', performance,
      process: { env: {}, stderr: { write: vi.fn() } },
    };
    const acquireAdmission = runInNewContext(`${source.slice(admissionStart, admissionEnd)}; acquireAdmission`, context);
    context.admission = await acquireAdmission('vitest', command);
    context.firstPhaseAdmission = context.admission;
    context.currentAdmission = context.admission;
    const timedRunGate = runInNewContext(`${source.slice(runStart, runEnd)}; timedRunGate`, context);
    const result = await timedRunGate('vitestMs', command);
    expect(result.exitCode).toBe(0);
    expect(runGate).toHaveBeenCalledTimes(1);
    expect(runGate).toHaveBeenCalledWith('npm run test:unit -- scripts/changed.test.mjs --testTimeout=15000 --hookTimeout=30000',
      undefined, { forgeDispatch: true });
    expect(acquireSlotBlocking).not.toHaveBeenCalled();
    expect(decidePhaseRemote).toHaveBeenCalledTimes(1);
    expect(context.vitestAdmittedLocally).toBe(true);
  });
});

// A lane checkout that predates #6154: its wrapper forwards every option to Forge, which rejects them.
function oldLane({ config = "export default { test: {} };\n", files = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'verify-old-lane-'));
  mkdirSync(join(root, 'scripts/readiness'), { recursive: true });
  writeFileSync(join(root, 'scripts/readiness/heavy-admission.mjs'), 'export const remoteArgv = requested => requested;\n');
  if (config !== null) writeFileSync(join(root, 'vitest.config.ts'), config);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, name), text);
  return root;
}

describe('daemon-side gate option stripping (lanes without #6154)', () => {
  const gate = "npx vitest run 'a.test.mjs' --passWithNoTests --testTimeout=15000 --hookTimeout=30000"
    + " && TZ=UTC npx vitest run 'b.test.mjs' --testTimeout=15000 --hookTimeout=30000";

  it('detects which wrapper the lane carries, and this repo (the daemon snapshot) sets no config timeout', () => {
    expect(laneWrapperStripsGateOptions(repo)).toBe(true);
    expect(laneConfigMaySetTimeouts(repo)).toBe(false);
    const root = oldLane();
    try { expect(laneWrapperStripsGateOptions(root)).toBe(false); } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('hands an old lane the Forge-compatible command; a #6154+ lane keeps every option for its own fallback', () => {
    const root = oldLane();
    try {
      expect(phaseAdmissionPlan({ command: gate, cwd: root, decision: { remote: true } })).toEqual({
        command: "npm run test:unit -- 'a.test.mjs' && TZ=UTC npm run test:unit -- 'b.test.mjs'",
        takeLocalSlot: false, setHeld: false, stripped: true,
      });
      // The daemon-local plan never changes.
      expect(phaseAdmissionPlan({ command: gate, cwd: root, decision: { remote: false } })).toEqual({ command: gate, takeLocalSlot: true, setHeld: true });
      expect(phaseAdmissionPlan({ command: 'npx vitest run a.test.mjs', cwd: root, decision: { remote: true } }))
        .toEqual({ command: 'npm run test:unit -- a.test.mjs', takeLocalSlot: false, setHeld: false });
    } finally { rmSync(root, { recursive: true, force: true }); }
    expect(phaseAdmissionPlan({ command: gate, cwd: repo, decision: { remote: true } })).toEqual({
      command: "npm run test:unit -- 'a.test.mjs' --passWithNoTests --testTimeout=15000 --hookTimeout=30000"
        + " && TZ=UTC npm run test:unit -- 'b.test.mjs' --testTimeout=15000 --hookTimeout=30000",
      takeLocalSlot: false, setHeld: false,
    });
  });

  it.each([
    ['config sets testTimeout', { config: 'export default { test: { testTimeout: 60000 } };\n' }],
    ['imported shared config sets hookTimeout', { config: "import s from './shared';\nexport default s;\n", files: { 'shared.ts': 'export default { test: { hookTimeout: 60000 } };\n' } }],
    ['config imports a file that cannot be resolved', { config: "import s from './missing';\nexport default s;\n" }],
    ['no config file at all', { config: null }],
    ['a workspace file exists', { files: { 'vitest.workspace.ts': 'export default [];\n' } }],
  ])('a stripped timeout would let the lane config win, so the command stays local and intact: %s', (_label, shape) => {
    const root = oldLane(shape);
    try {
      expect(laneConfigMaySetTimeouts(root)).toBe(true);
      expect(phaseAdmissionPlan({ command: gate, cwd: root, decision: { remote: true } })).toEqual({ command: gate, takeLocalSlot: true, setHeld: true });
      // Dropping only --passWithNoTests never depends on the config.
      expect(phaseAdmissionPlan({ command: 'npx vitest run a.test.mjs --passWithNoTests', cwd: root, decision: { remote: true } }))
        .toEqual({ command: 'npm run test:unit -- a.test.mjs', takeLocalSlot: false, setHeld: false, stripped: true });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each([
    'npx vitest run --passWithNoTests',
    'npx vitest run --testTimeout=15000 --hookTimeout=30000',
    'npx vitest run a.test.mjs --testTimeout=4999',
    'npx vitest run a.test.mjs --passWithNoTests --passWithNoTests',
    "npx vitest run a.test.mjs '--testTimeout=15000'",
  ])('fails closed on an old lane when the strip is empty, partial or unrecognized: %s', command => {
    const root = oldLane();
    try {
      expect(phaseAdmissionPlan({ command, cwd: root, decision: { remote: true } })).toEqual({ command, takeLocalSlot: true, setHeld: true });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('a stripped red that already ran locally stands; a remote one is confirmed with the original command', () => {
    const plan = { takeLocalSlot: false, stripped: true };
    for (const location of ['local', 'mixed']) expect(shouldConfirmRemoteRed({ plan, exitCode: 1, ranOn: { location } })).toBe(false);
    expect(shouldConfirmRemoteRed({ plan, exitCode: 1, ranOn: { location: 'remote' } })).toBe(true);
  });
});

describe('proven local fallback verdict', () => {
  it.each([1, 2, 75, 124])('never confirms an already local failure (exit %i)', exitCode => {
    const ranOn = phaseRunLocation(readRemoteReport('report', () => JSON.stringify({ location: 'local-fallback', exitCode })));
    expect(shouldConfirmRemoteRed({ plan: { takeLocalSlot: false }, exitCode, ranOn })).toBe(false);
  });

  it.each(['remote', 'unknown', undefined])('preserves confirmation for unproven local execution: %s', location => {
    expect(shouldConfirmRemoteRed({ plan: { takeLocalSlot: false }, exitCode: 1,
      ...(location ? { ranOn: { location } } : {}) })).toBe(true);
  });

  it.each([
    [['remote', 0], ['local-fallback', 1]],
    [['local-fallback', 0], ['remote', 1]],
    [['remote', 0], ['local-fallback', 0], ['local-fallback', 1]],
  ])('never confirms a mixed chain verdict: %j', (...segments) => {
    const reports = readRemoteReport('report', () => segments.map(([location, exitCode]) =>
      JSON.stringify({ location, exitCode, ...(location === 'remote' ? { receiptId: 'run-123456' } : {}) })).join('\n'));
    const ranOn = phaseRunLocation(reports, { remoteAttempt: true });
    expect(ranOn.location).toBe('mixed');
    expect(shouldConfirmRemoteRed({ plan: { takeLocalSlot: false }, exitCode: 1, ranOn })).toBe(false);
  });

  // Execute the production orchestration with admission and child IO injected. No fixture Git writes.
  // A second (passing) child is deliberately available to expose an unconditional retry into green.
  it.each([false, true].flatMap(phaseAdmission => [
    ['vitestMs', 'npx vitest run scripts/changed.test.mjs', ['local-fallback']],
    ['standardsMs', 'npm run check:standards', ['local-fallback']],
    ['vitestMs', 'npx vitest run a.test.mjs --passWithNoTests --testTimeout=15000 --hookTimeout=30000 && npx vitest run scripts/changed.test.mjs --passWithNoTests --testTimeout=15000 --hookTimeout=30000', ['remote', 'local-fallback']],
    ['vitestMs', 'npx vitest run a.test.mjs && npx vitest run scripts/changed.test.mjs', ['local-fallback', 'remote']],
  ].map(([phase, command, locations]) => ({ phaseAdmission, phase, command, locations }))))(
    'retains the failed child and its evidence: $phase, $locations, phaseAdmission=$phaseAdmission', async ({ phaseAdmission, phase, command, locations }) => {
      const source = readFileSync(resolve(repo, 'scripts/verify-lane.mjs'), 'utf8');
      const start = source.indexOf('async function timedRunGate(');
      const end = source.indexOf('// runVitestOnBase', start);
      expect(start).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      const failure = { exitCode: 1, remoteAttempt: true,
        ranOn: phaseRunLocation(readRemoteReport('report', () => locations.map((location, i) => JSON.stringify({
          location, exitCode: i === locations.length - 1 ? 1 : 0,
          ...(location === 'remote' ? { receiptId: 'run-123456' } : {}),
        })).join('\n'))),
        failureDetails: { summary: 'local failure in scripts/changed.test.mjs' },
        output: { stdout: '', stderr: 'FAIL scripts/changed.test.mjs' } };
      const runGate = vi.fn().mockResolvedValueOnce(failure).mockResolvedValue({ exitCode: 0, ranOn: { location: 'local' } });
      const acquireAdmission = vi.fn(async () => ({ ok: true }));
      const recordOutcome = vi.fn();
      const context = {
        phaseAdmission, firstPhaseAdmission: { remote: true }, admission: { remote: true }, currentAdmission: null,
        phaseAdmissionPlan, shouldConfirmRemoteRed, remoteInfrastructureFailure, mergeRunLocation: (a, b) => a === b ? a : 'mixed',
        runGate, acquireAdmission, recordOutcome, buildPhaseOutcome: value => value,
        ranOnPhases: {}, phaseMs: {}, remoteUnconfirmed: false, phaseTimeout: null, vitestAdmittedLocally: false,
        resolvedGate: { decision: { changedFiles: ['scripts/changed.test.mjs'] } },
        slotHeartbeat: null, setInterval: vi.fn(() => ({ unref() {} })), clearInterval: vi.fn(),
        heartbeatOwnedSlot: vi.fn(), releaseOwnedSlot: vi.fn(),
        ADMISSION_LOCK_ROOT: '', ADMISSION_CAP: 1, REPO: repo, SLOT_HEARTBEAT_MS: 1000,
        PHASE_TIMEOUT_MS: 10000, MARKER_NONCE_SUFFIX: '', performance,
        process: { stderr: { write: vi.fn() } },
      };
      const timedRunGate = runInNewContext(`${source.slice(start, end)}; timedRunGate`, context);
      const result = await timedRunGate(phase, command);
      expect(result).toBe(failure);
      expect(runGate).toHaveBeenCalledTimes(1);
      expect(runGate).toHaveBeenCalledWith(phaseAdmissionPlan({ command, decision: { remote: true } }).command,
        undefined, { forgeDispatch: true });
      expect(acquireAdmission).not.toHaveBeenCalled();
      expect(recordOutcome).toHaveBeenCalledWith(phase.replace(/Ms$/, ''), expect.objectContaining({ exitCode: 1,
        failureDetails: failure.failureDetails }));
      expect(context.ranOnPhases[phase.replace(/Ms$/, '')]).toEqual(failure.ranOn);
      expect(context.process.stderr.write).not.toHaveBeenCalled();
    });
});

describe('verify remote routing', () => {
  it.each([
    ['remote green never reruns', false, 0, false],
    ['remote red confirms locally', false, 1, true],
    ['remote nested deferral confirms locally', false, 75, true],
    ['remote termination unconfirmed never reruns', false, 124, false],
    ['local-planned red never reruns', true, 1, false],
    ['unknown plan never reruns', undefined, 1, false],
    ['missing exit code never reruns', false, undefined, false],
    ['unreadable exit code never reruns', false, '1', false],
  ])('%s', (_name, takeLocalSlot, exitCode, expected) => {
    expect(shouldConfirmRemoteRed({ plan: { takeLocalSlot }, exitCode })).toBe(expected);
    if (exitCode === 124) expect(remoteInfrastructureFailure({ exitCode, remoteAttempt: !takeLocalSlot })).toMatchObject({ reason: 'remote-termination-unconfirmed' });
  });
  it.each([
    ['watchdog timeout without a signal', { exitCode: 2, timedOut: true }],
    ['watchdog timeout with SIGKILL', { exitCode: 2, signal: 'SIGKILL', timedOut: true }],
    ['signal normalized to exit 2', { exitCode: 2, signal: 'SIGTERM' }],
    ['shell-inferred signal', { exitCode: 143 }],
  ])('remote infrastructure failure never confirms locally: %s', (_name, result) => {
    expect(shouldConfirmRemoteRed({ plan: { takeLocalSlot: false }, ...result })).toBe(false);
  });
  it.each([
    'npm run test:unit',
    "npm run test:unit -- 'path with spaces.test.mjs' --reporter=dot",
    'npm run check:standards -- --scope=x',
    "npm run check:standards -- --local --files='src/one file.mjs,src/two.mjs'",
    'node scripts/readiness/heavy-admission.mjs run -- vitest run',
    'node ./scripts/readiness/heavy-admission.mjs run --wait-ms=540000 -- npx vitest run one.test.mjs',
  ])('skips local admission only for eligible wrapper: %s', command => {
    expect(phaseAdmissionPlan({ command, decision: { remote: true } })).toEqual({ command, takeLocalSlot: false, setHeld: false });
    expect(phaseAdmissionPlan({ command, decision: { remote: false } })).toEqual({ command, takeLocalSlot: true, setHeld: true });
  });
  it('resolves direct wrappers against the target checkout, including quoted absolute paths', () => {
    const cwd = '/tmp/target-checkout';
    for (const path of ['scripts/readiness/heavy-admission.mjs', './scripts/readiness/heavy-admission.mjs',
      "'/tmp/target-checkout/scripts/readiness/heavy-admission.mjs'"]) {
      expect(phaseAdmissionPlan({ cwd, command: `node ${path} run -- vitest run`, decision: { remote: true } }).takeLocalSlot).toBe(false);
    }
    expect(phaseAdmissionPlan({ cwd, command: `node ${resolve(repo, 'scripts/readiness/heavy-admission.mjs')} run -- vitest run`,
      decision: { remote: true } }).takeLocalSlot).toBe(true);
    expect(phaseAdmissionPlan({ cwd, command: 'node', decision: { remote: true } }).takeLocalSlot).toBe(true);
  });
  it.each([
    'npm run test:unit',
    'npm run check:standards',
    'node scripts/readiness/heavy-admission.mjs run -- vitest run',
  ].flatMap(wrapper => [
    `${wrapper} && node scan.mjs`,
    `${wrapper} || node scan.mjs`,
    `${wrapper}; node scan.mjs`,
    `${wrapper} | node scan.mjs`,
    `${wrapper} & node scan.mjs`,
    `${wrapper}\nnode scan.mjs`,
    `${wrapper}\rnode scan.mjs`,
    `${wrapper} > output`,
    `${wrapper} $(node scan.mjs)`,
    `${wrapper} \`node scan.mjs\``,
    `node scan.mjs && ${wrapper}`,
    `echo ${wrapper}`,
  ]))('compound wrappers and unsupported shell syntax retain local admission for the entire command: %s', command => {
    expect(phaseAdmissionPlan({ command, decision: { remote: true } }))
      .toEqual({ command, takeLocalSlot: true, setHeld: true });
  });
  it.each(['npm run test:unit --prefix=other', 'node other/heavy-admission.mjs run -- vitest run',
    'node /tmp/foreign/scripts/readiness/heavy-admission.mjs run -- vitest run',
    "node 'other/scripts/readiness/heavy-admission.mjs' run -- vitest run",
    'node ../other/scripts/readiness/heavy-admission.mjs run -- vitest run'])(
    'unsupported wrapper forms retain local admission: %s', command => {
      expect(phaseAdmissionPlan({ command, decision: { remote: true } }))
        .toEqual({ command, takeLocalSlot: true, setHeld: true });
    });
  it.each([
    "'scripts/one.test.mjs' 'scripts/two.test.mjs'",
    ...['default', 'dot', 'verbose', 'basic', 'tap'].map(reporter => `scripts/one.test.mjs --reporter=${reporter}`),
  ])('remote selected Vitest run uses the wrapper without a slot or HELD: %s', args => {
    expect(phaseAdmissionPlan({ command: `npx vitest run ${args}`, decision: { remote: true } })).toEqual({
      command: `npm run test:unit -- ${args}`, takeLocalSlot: false, setHeld: false,
    });
  });
  it.each([
    '--passWithNoTests --testTimeout=15000 --hookTimeout=30000',
    '--testTimeout=15000 --hookTimeout=30000 --passWithNoTests',
    '--passWithNoTests',
    '--testTimeout=15000',
    '--hookTimeout=30000',
    '--testTimeout=5000 --hookTimeout=10000',
    '--reporter=dot --passWithNoTests --testTimeout=15000 --hookTimeout=30000',
  ])('selected Vitest run with trailing gate flags goes to the wrapper with every flag intact: %s', flags => {
    const files = "'scripts/path with spaces.test.mjs' 'scripts/two.test.mjs'";
    expect(phaseAdmissionPlan({ command: `npx vitest run ${files} ${flags}`, decision: { remote: true } })).toEqual({
      command: `npm run test:unit -- ${files} ${flags}`, takeLocalSlot: false, setHeld: false,
    });
  });
  it('the daemon selected-tests gate chain is remote-eligible segment by segment', () => {
    const one = "npx vitest run 'a.test.mjs' --passWithNoTests --testTimeout=15000 --hookTimeout=30000";
    const two = "TZ=UTC npx vitest run 'b.test.mjs' --testTimeout=15000 --hookTimeout=30000";
    expect(phaseAdmissionPlan({ command: `${one} && ${two}`, decision: { remote: true } })).toEqual({
      command: "npm run test:unit -- 'a.test.mjs' --passWithNoTests --testTimeout=15000 --hookTimeout=30000"
        + " && TZ=UTC npm run test:unit -- 'b.test.mjs' --testTimeout=15000 --hookTimeout=30000",
      takeLocalSlot: false, setHeld: false,
    });
    expect(phaseAdmissionPlan({ command: `${one} && ${two}`, decision: { remote: false } }))
      .toEqual({ command: `${one} && ${two}`, takeLocalSlot: true, setHeld: true });
  });
  it.each([
    // Forge drops env keys outside its allowlist, so the scoped scanner would run unscoped there.
    `npx vitest run a.test.mjs && VERIFY_SCAN_FILES='["x.mjs"]' npx vitest run scan.test.mjs --testTimeout=15000`,
    'npx vitest run a.test.mjs && VERIFY_SCAN_FILES=x.mjs npx vitest run scan.test.mjs',
    'VERIFY_SCAN_FILES=x.mjs npx vitest run scan.test.mjs',
    'WE_VITEST_MAX_WORKERS=0 npx vitest run a.test.mjs',
    // CI bypasses the nested wrapper's admission; with no outer slot it would run unslotted.
    'CI=true npx vitest run a.test.mjs --testTimeout=15000',
    'npx vitest run a.test.mjs && CI=1 npx vitest run b.test.mjs',
    'NODE_ENV=test npx vitest run a.test.mjs',
    'WE_VITEST_MAX_WORKERS=2 npx vitest run a.test.mjs',
    'DIFF_COVERAGE_BASE=origin/main npx vitest run a.test.mjs',
    "'TZ'=UTC npx vitest run a.test.mjs",
    'TZ=UTC npx vitest related a.mjs --run',
    'npx vitest run a.test.mjs && npx vitest related b.mjs --run --passWithNoTests',
    'npx vitest run a.test.mjs && npx vitest run b.test.mjs --unknown',
    'npx vitest run a.test.mjs && npx vitest run',
    'npx vitest run a.test.mjs &&  npx vitest run b.test.mjs',
    'npx vitest run a.test.mjs && npm run check:standards',
    'npx vitest run a.test.mjs --passWithNoTests --passWithNoTests',
    'npx vitest run a.test.mjs --testTimeout=15000 --testTimeout=20000',
  ])('a chain or env segment Forge cannot run as written keeps the whole command local: %s', command => {
    expect(phaseAdmissionPlan({ command, decision: { remote: true } })).toEqual({ command, takeLocalSlot: true, setHeld: true });
  });
  it('local selected Vitest run retains its command, slot and HELD', () => {
    const command = "npx vitest run 'scripts/one.test.mjs' --testTimeout=15000 --hookTimeout=30000 --passWithNoTests";
    expect(phaseAdmissionPlan({ command, decision: { remote: false } })).toEqual({ command, takeLocalSlot: true, setHeld: true });
    expect(phaseAdmissionPlan({ command })).toEqual({ command, takeLocalSlot: true, setHeld: true });
  });
  it.each([
    'node scan.mjs',
    "VERIFY_SCAN_FILES='one.mjs' npx vitest run scan.test.mjs",
    'npx vitest run guard.test.mjs --reporter=default --reporter=json --outputFile.json=report.json',
    "npx vitest run guard.test.mjs --reporter json --outputFile 'report.json'",
    'npx vitest run guard.test.mjs --outputFile.json=report.json',
    'npx vitest run --maxWorkers=1 --minWorkers=1 --no-file-parallelism retry.test.mjs',
    'npx vitest run retry.test.mjs --maxWorkers 1',
    'npx vitest related source.mjs --run --passWithNoTests',
    'npx vitest run',
  ])('guard, retry, scan and unknown commands stay local and unchanged: %s', command => {
    expect(phaseAdmissionPlan({ command, decision: { remote: true } })).toEqual({ command, takeLocalSlot: true, setHeld: true });
  });
  it.each([
    '--unknown --passWithNoTests --testTimeout=15000 --hookTimeout=30000',
    '--reporter=json --passWithNoTests --testTimeout=15000 --hookTimeout=30000',
    '--testTimeout=fast --passWithNoTests',
    '--testTimeout=1',
    '--testTimeout=4999 --hookTimeout=30000 --passWithNoTests',
    '--hookTimeout=1',
    '--testTimeout=15000 --hookTimeout=9999 --passWithNoTests',
    '--hookTimeout=30000ms --passWithNoTests',
    '--passWithNoTests=true --testTimeout=15000',
    '--testTimeout=15000 --reporter=dot',
    '--passWithNoTests other.test.mjs',
  ])('unknown or non-trailing local flags keep the original command and local admission: %s', flags => {
    const command = `npx vitest run scripts/one.test.mjs ${flags}`;
    expect(phaseAdmissionPlan({ command, decision: { remote: true } })).toEqual({ command, takeLocalSlot: true, setHeld: true });
  });
  it.each([
    "'one.test.mjs' && npm run check:standards",
    'one.test.mjs && node scripts/readiness/heavy-admission.mjs run -- vitest run two.test.mjs',
    'one.test.mjs | tee output',
    'one.test.mjs; echo done',
    'one.test.mjs > output',
    '$(echo one.test.mjs)',
    '`echo one.test.mjs`',
    '$TEST_FILE',
    '*.test.mjs',
    '"one.test.mjs"',
    "'unclosed.test.mjs",
    "'one.test.mjs'\necho done",
    "'one.test.mjs'\n",
    "'one.test.mjs' # comment",
  ])('unsupported shell arguments fail closed to the original local command: %s', args => {
    const command = `npx vitest run ${args}`;
    expect(phaseAdmissionPlan({ command, decision: { remote: true } })).toEqual({ command, takeLocalSlot: true, setHeld: true });
  });
  it('claims remote only with a completed remote report and preserves the receipt', () => {
    expect(phaseRunLocation([{ location: 'remote', receiptId: 'run-123456', exitCode: 0 }])).toEqual({ location: 'remote', receiptId: 'run-123456' });
    expect(phaseRunLocation([{ location: 'local-fallback', exitCode: 0 }])).toEqual({ location: 'local' });
    expect(overallRunLocation({ vitest: { location: 'remote' }, scan: { location: 'local' } }).location).toBe('mixed');
  });
  it('an unknown phase location makes the overall location unknown, never mixed or local', () => {
    expect(overallRunLocation({ vitest: { location: 'unknown' }, scan: { location: 'local' } }).location).toBe('unknown');
    expect(overallRunLocation({ vitest: { location: 'mixed' }, scan: { location: 'unknown' } }).location).toBe('unknown');
    expect(overallRunLocation({ vitest: { location: 'local' }, scan: { location: 'local' } }).location).toBe('local');
    expect(overallRunLocation({ vitest: { location: 'mixed' }, scan: { location: 'local' } }).location).toBe('mixed');
    expect(overallRunLocation({}).location).toBe('local');
  });
  it('unreadable, malformed and oversized reports of a dispatched attempt fail closed to unknown, never local', () => {
    for (const read of [() => { throw Error('unreadable'); }, () => '{', () => 'x'.repeat(65537)]) {
      expect(phaseRunLocation(readRemoteReport('report', read), { remoteAttempt: true })).toEqual({ location: 'unknown' });
      // A caller that does not say whether it dispatched is treated as dispatched.
      expect(phaseRunLocation(readRemoteReport('report', read))).toEqual({ location: 'unknown' });
    }
  });
  it('an attempt never dispatched to the remote wrapper is local without a report', () => {
    expect(phaseRunLocation([], { remoteAttempt: false })).toEqual({ location: 'local' });
  });
  it('the default report reader accepts only a bounded regular file: never a symlink, FIFO or directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'verify-report-reader-'));
    try {
      const report = JSON.stringify({ location: 'remote', receiptId: 'run-123456', exitCode: 0 });
      const file = join(root, 'report.jsonl');
      writeFileSync(file, report + '\n');
      vi.mocked(readSync).mockClear();
      expect(readRemoteReport(file)).toEqual([JSON.parse(report)]);
      expect(readSync).toHaveBeenCalledTimes(1);
      expect(readSync).toHaveBeenLastCalledWith(expect.any(Number), expect.any(Buffer), 0, 65537, 0);
      symlinkSync(file, join(root, 'link.jsonl'));
      expect(readRemoteReport(join(root, 'link.jsonl'))).toEqual([]);
      execFileSync('mkfifo', [join(root, 'fifo.jsonl')]);
      expect(readRemoteReport(join(root, 'fifo.jsonl'))).toEqual([]);
      mkdirSync(join(root, 'dir.jsonl'));
      expect(readRemoteReport(join(root, 'dir.jsonl'))).toEqual([]);
      writeFileSync(join(root, 'big.jsonl'), report + '\n' + ' '.repeat(65536));
      vi.mocked(readSync).mockClear();
      expect(readRemoteReport(join(root, 'big.jsonl'))).toEqual([]);
      expect(readSync).not.toHaveBeenCalled();
      // Grow a valid file after the size check: no unbounded read may follow fstat.
      const actualFstat = vi.mocked(fstatSync).getMockImplementation();
      vi.mocked(fstatSync).mockImplementationOnce(fd => {
        const stat = actualFstat(fd);
        writeFileSync(file, report + '\n' + ' '.repeat(131072));
        return stat;
      });
      expect(readRemoteReport(file)).toEqual([]);
      expect(readSync).toHaveBeenCalledTimes(1);
      expect(readSync).toHaveBeenLastCalledWith(expect.any(Number), expect.any(Buffer), 0, 65537, 0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it.each([
    { location: 'remote', exitCode: 0 },
    ...['', ' ', null, 123].map(receiptId => ({ location: 'remote', receiptId, exitCode: 0 })),
    ...[undefined, null, '0', 0.5, -1, 255].map(exitCode => ({ location: 'remote', receiptId: 'run-123456', exitCode })),
  ])('incomplete remote report fails closed to unknown: %j', report => {
    const reports = readRemoteReport('report', () => JSON.stringify(report));
    expect(reports).toEqual([]);
    expect(phaseRunLocation(reports, { remoteAttempt: true })).toEqual({ location: 'unknown' });
  });
  it('accepts a completed remote report only with receipt and integer exit code', () => {
    const report = { location: 'remote', receiptId: 'run-123456', exitCode: 0 };
    expect(phaseRunLocation(readRemoteReport('report', () => JSON.stringify(report))))
      .toEqual({ location: 'remote', receiptId: 'run-123456' });
  });
  it('exit 124 is infrastructure/unconfirmed rather than a test verdict', () => {
    expect(remoteInfrastructureFailure({ exitCode: 124, remoteAttempt: true, ranOn: { location: 'unknown' } })).toMatchObject({ reason: 'remote-termination-unconfirmed' });
    expect(remoteInfrastructureFailure({ exitCode: 124, remoteAttempt: true, ranOn: { location: 'remote' } })).toMatchObject({ reason: 'remote-termination-unconfirmed' });
    expect(remoteInfrastructureFailure({ exitCode: 124, remoteAttempt: true })).toMatchObject({ reason: 'remote-termination-unconfirmed' });
    expect(remoteInfrastructureFailure({ exitCode: 1, remoteAttempt: true })).toBeNull();
  });
  it('a local exit 124 (never dispatched, a local confirmation, or a proven local fallback) is not remote-unconfirmed', () => {
    expect(remoteInfrastructureFailure({ exitCode: 124 })).toBeNull();
    expect(remoteInfrastructureFailure({ exitCode: 124, remoteAttempt: false, ranOn: { location: 'local', remoteRedConfirmedLocally: true } })).toBeNull();
    expect(remoteInfrastructureFailure({ exitCode: 124, remoteAttempt: true, ranOn: { location: 'local' } })).toBeNull();
  });
  it('report writes are best effort and heartbeat of a non-owned slot is harmless', () => {
    const root = mkdtempSync(join(tmpdir(), 'verify-report-'));
    try {
      expect(() => appendVerifyRemoteReport({ WE_VERIFY_REMOTE_REPORT: join(root, 'missing/report') }, { location: 'remote', exitCode: 0 })).not.toThrow();
      expect(heartbeatOwnedSlot({ lockRoot: root, cap: 1, fastSlots: 0, owner: 'unowned' })).toBeNull();
    } finally { rmSync(root, { recursive:true, force:true }); }
  });
  it('health doubt or throw keeps the phase local', async () => {
    const policy = { settings: { remote: { enabled: true, mode: 'always', clientPath: null } }, sources: {} };
    const env = { LANE_POOL_ROOT: tmpdir() };
    for (const checkHealth of [async () => ({ ok: false }), async () => { throw Error('unknown'); }]) {
      expect((await decidePhaseRemote({ policy, cwd: '.', env, checkHealth })).remote).toBe(false);
    }
    const checkHealth = vi.fn(async () => ({ ok: true }));
    expect((await decidePhaseRemote({ policy, cwd: '.', env, checkHealth })).remote).toBe(true);
  });
});

// Native child-process fixture: only admission IO and the nested npm wrapper are faked.
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
const repo = process.cwd();
describe('verify-lane remote phase spawn', () => {
  const cases = [
    ['remote', 0, 'remote', false],
    ['local', 0, 'local', true],
    ['local-fallback', 0, 'local', false],
    ['unconfirmed', 124, 'unknown', false],
    ['unreadable', 0, 'unknown', false],
    ['raw', 0, 'local', true],
    ['raw', 0, 'local', true, 'npm run test:unit && node raw.cjs'],
    // Stripped by the daemon: the fixture lane's own wrapper would forward the options to Forge.
    ['remote', 0, 'remote', false, "npx vitest run 'one.test.mjs' 'path with spaces.test.mjs' --reporter=dot --passWithNoTests --testTimeout=15000 --hookTimeout=30000",
      ['run', 'test:unit', '--', 'one.test.mjs', 'path with spaces.test.mjs', '--reporter=dot']],
    ['remote', 0, 'remote', false, "npx vitest run 'one.test.mjs' 'path with spaces.test.mjs' --reporter=dot",
      ['run', 'test:unit', '--', 'one.test.mjs', 'path with spaces.test.mjs', '--reporter=dot']],
    ['raw', 0, 'local', true, 'npx vitest run one.test.mjs --unknown --passWithNoTests --testTimeout=15000 --hookTimeout=30000',
      ['vitest', 'run', 'one.test.mjs', '--unknown', '--passWithNoTests', '--testTimeout=15000', '--hookTimeout=30000']],
    ['local', 0, 'local', true, "npx vitest run 'one.test.mjs'", ['vitest', 'run', 'one.test.mjs']],
    ['local-fallback', 0, 'local', false, "npx vitest run 'one.test.mjs'", ['run', 'test:unit', '--', 'one.test.mjs']],
    ['raw', 0, 'local', true, 'npx vitest run guard.test.mjs --reporter=json --outputFile.json=report.json',
      ['vitest', 'run', 'guard.test.mjs', '--reporter=json', '--outputFile.json=report.json']],
    ['raw', 0, 'local', true, 'npx vitest run --maxWorkers=1 --minWorkers=1 --no-file-parallelism retry.test.mjs',
      ['vitest', 'run', '--maxWorkers=1', '--minWorkers=1', '--no-file-parallelism', 'retry.test.mjs']],
    ['raw', 0, 'local', true, "VERIFY_SCAN_FILES='one.mjs' npx vitest run scan.test.mjs", ['vitest', 'run', 'scan.test.mjs']],
    ...[false, true].map(phaseAdmission => ['remote', 0, 'remote', false,
      "npx vitest run 'one.test.mjs'",
      ['run', 'test:unit', '--', 'one.test.mjs'], phaseAdmission]),
    ['remote', 0, 'local', false, 'npm run check:standards', undefined, undefined, 75],
    ['remote', 0, 'local', false, 'npm run test:unit', undefined, undefined, 1],
    ['local', 1, 'local', true, 'npm run test:unit', undefined, undefined, 0, 1],
    ...[false, true].flatMap(phaseAdmission => [0, 1].map(localExit => ['remote', localExit, 'local', false,
      "npx vitest run 'one.test.mjs'",
      ['run', 'test:unit', '--', 'one.test.mjs'], phaseAdmission, 1, localExit])),
    ['remote', 1, 'local', false, "npx vitest run 'one.test.mjs'", ['run', 'test:unit', '--', 'one.test.mjs'], true, 1, 1, 0],
    ...[false, true].map(phaseAdmission => ['remote', 1, 'local', false, "npx vitest run 'one.test.mjs'", ['run', 'test:unit', '--', 'one.test.mjs'], phaseAdmission, 1, 1, 1]),
  ];
  function verifyRemotePhase(mode, code, location, held, gateCommand, expectedArgs, phaseAdmission, remoteExit = 0, localExit = 0, retryExit, localBehavior = '') {
    const root = mkdtempSync(join(tmpdir(), 'verify-routing-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: root });
      execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-qm', 'fixture'], { cwd: root });
      // The fixture lane carries no heavy-admission of its own (a pre-#6154 lane) and a config without timeouts.
      writeFileSync(join(root, 'vitest.config.ts'), 'export default { test: {} };\n');
      const events = join(root, 'events.jsonl');
      const heavy = pathToFileURL(resolve(repo, 'scripts/readiness/heavy-admission.mjs')).href;
      const routing = pathToFileURL(resolve(repo, 'scripts/lib/verify-remote-routing.mjs')).href;
      const gate = pathToFileURL(resolve(repo, 'scripts/lib/verify-lane-gate.mjs')).href;
      const laterPhases = phaseAdmission !== undefined;
      const confirmed = mode === 'remote' && remoteExit !== 0 && remoteExit !== 124;
      // A red that survives the isolated retry is compared with origin/main; that unheld spawn needs its own slot.
      // Standards stays green there, since only a Vitest-only red is compared with the base.
      const baseCompared = retryExit !== undefined && retryExit !== 0;
      const watchdogKill = mode === 'watchdog' || localBehavior === 'watchdog';
      const signalKill = mode === 'signal' || localBehavior === 'signal';
      // Exit 124 is remote-unconfirmed only for the dispatched attempt; a local confirmation's 124 is a local exit code.
      const infrastructureReason = watchdogKill ? 'verify-timeout' : signalKill ? 'verify-signal'
        : code === 124 && !confirmed ? 'remote-termination-unconfirmed' : null;
      const phasePlan = { command: `${gateCommand} && npm run check:standards`, testCommand: gateCommand,
        standardsCommand: 'npm run check:standards', scanCommands: [], gateReasons: [],
        decision: { mode: 'shrink', reasons: [], settingsSource: { standards: 'fixture' }, changedFiles: ['one.test.mjs'], targets: ['one.test.mjs'],
          referencedTests: [], relatedFiles: ['one.test.mjs'], standards: { run: true, scoped: false, policy: 'always' } } };
      const loader = join(root, 'loader.mjs');
      writeFileSync(loader, `export async function load(url, context, next) {
        if (url === ${JSON.stringify(pathToFileURL(resolve(repo, 'scripts/lib/host-load.mjs')).href)}) return {format:'module',shortCircuit:true,source:
          'export * from ' + JSON.stringify(url+'?actual') + '; export function hostLoadAdmission() { return {admitted:true}; }'};
        if (url === ${JSON.stringify(gate)} && process.env.ROUTING_PHASES === '1') return {format:'module',shortCircuit:true,source:
          'export * from ' + JSON.stringify(url+'?actual') + ';' +
          'export function resolveDefaultGate() { return ' + ${JSON.stringify(JSON.stringify(phasePlan))} + '; }'};
        if (url === ${JSON.stringify(heavy)} && process.env.ROUTING_NESTED !== '1') return {format:'module',shortCircuit:true,source:
          'export * from ' + JSON.stringify(url+'?actual') + ';' +
          "import {appendFileSync} from 'node:fs';" +
          "export async function acquireSlotBlocking({kind}) { appendFileSync(process.env.ROUTING_EVENTS, JSON.stringify({event:'acquire',kind})+'\\\\n'); return {ok:true,slot:0,waitedMs:0}; }" +
          "export function releaseOwnedSlot() { appendFileSync(process.env.ROUTING_EVENTS, JSON.stringify({event:'release'})+'\\\\n'); } export function heartbeatOwnedSlot() { appendFileSync(process.env.ROUTING_EVENTS, JSON.stringify({event:'heartbeat'})+'\\\\n'); }"};
        if (url === ${JSON.stringify(routing)}) return {format:'module',shortCircuit:true,source:
          'export * from ' + JSON.stringify(url+'?actual') + ';' +
          "export async function decidePhaseRemote() { return {remote:process.env.ROUTING_MODE !== 'local',reason:'fixture policy'}; }"};
        return next(url,context);
      }`);
      const preload = join(root, 'preload.mjs');
      writeFileSync(preload, `import {register} from 'node:module'; register(${JSON.stringify(pathToFileURL(loader).href)}, import.meta.url);`);
      const bin = join(root, 'bin'); mkdirSync(bin);
      const wrapper = `#!${process.execPath}
const fs=require('node:fs');
const mode=process.env.ROUTING_MODE;
const held=process.env.WE_HEAVY_ADMISSION_HELD === '1';
const retry=process.argv.includes('--maxWorkers=1');
const localBehavior=held ? process.env.ROUTING_LOCAL_BEHAVIOR : '';
const exitCode=process.env.ROUTING_STANDARDS_EXIT && process.argv.includes('check:standards') ? Number(process.env.ROUTING_STANDARDS_EXIT)
  : held ? (retry ? Number(process.env.ROUTING_RETRY_EXIT) : Number(process.env.ROUTING_LOCAL_EXIT)) : Number(process.env.ROUTING_REMOTE_EXIT);
fs.appendFileSync(process.env.ROUTING_EVENTS,JSON.stringify({event:'spawn',held, env:{WE_HEAVY_ADMISSION_HELD:process.env.WE_HEAVY_ADMISSION_HELD,WE_FORGE_GATE_DISPATCH:process.env.WE_FORGE_GATE_DISPATCH}, report:!!process.env.WE_VERIFY_REMOTE_REPORT, executable:require('node:path').basename(process.argv[1]), args:process.argv.slice(2)})+'\\n');
if(mode==='nested-local') {
  const child = require('node:child_process').spawnSync(process.execPath, ['--import', ${JSON.stringify(preload)}, ${JSON.stringify(resolve(repo, 'scripts/readiness/heavy-admission.mjs'))}, 'run', '--repo='+process.cwd(), '--', process.execPath, 'nested-child.cjs'], {
    stdio:'inherit', env:{...process.env, ROUTING_NESTED:'1', LANE_POOL_ROOT:${JSON.stringify(join(root, 'pool'))}, WE_PLATFORM_PREFERENCES:${JSON.stringify(join(root, 'preferences.json'))}, CI:'', WE_HEAVY_ADMISSION:'on'}
  });
  process.exit(child.status ?? 3);
}
if(mode==='local-fallback') {
  if(held && !retry) throw Error('double local admission');
  if(!held) fs.appendFileSync(process.env.ROUTING_EVENTS,JSON.stringify({event:'nested-acquire'})+'\\n');
}
if(['remote','local-fallback'].includes(mode) && !held)fs.appendFileSync(process.env.WE_VERIFY_REMOTE_REPORT,JSON.stringify({location:mode,receiptId:'run-123456',exitCode})+'\\n');
if(mode==='unreadable')fs.writeFileSync(process.env.WE_VERIFY_REMOTE_REPORT,'{');
if(exitCode) {
  const local=held || mode==='local-fallback';
  const file=local ? (process.env.ROUTING_RETRY_EXIT ? 'local.test.mjs' : 'one.test.mjs') : 'remote.test.mjs';
  fs.writeSync(2,' FAIL  '+file+' > '+(local?'local':'remote')+' failure\\nAssertionError: fixture failure\\n');
  fs.writeSync(1,' Test Files  1 failed (1)\\n Tests  1 failed (1)\\n Duration  1s\\n');
}
if((mode === 'watchdog' && !held) || localBehavior === 'watchdog') { ${keepAliveScript({ maxLifetimeMs: 15000 })} }
else if(mode === 'signal' && !held) process.kill(process.pid, 'SIGTERM');
else if(localBehavior === 'signal') setTimeout(() => process.kill(process.pid, 'SIGTERM'), 1200);
else if(mode === 'remote' && (!held || process.env.ROUTING_LOCAL_DELAY === '1')) setTimeout(() => process.exit(exitCode), 1200);
else process.exit(mode==='unconfirmed'?124:exitCode);
`;
      writeFileSync(join(bin, 'npm'), wrapper, { mode: 0o755 });
      writeFileSync(join(bin, 'npx'), wrapper, { mode: 0o755 });
      writeFileSync(join(root, 'raw.cjs'), wrapper.replace(/^#!.*\n/, ''));
      const foreignWrapper = join(root, 'foreign/scripts/readiness/heavy-admission.mjs');
      mkdirSync(resolve(foreignWrapper, '..'), { recursive: true });
      writeFileSync(foreignWrapper, "import {createRequire} from 'node:module'; const require=createRequire(import.meta.url);\n" + wrapper.replace(/^#!.*\n/, ''));
      mkdirSync(join(root, 'pool'));
      writeFileSync(join(root, 'preferences.json'), JSON.stringify({ heavyAdmission: { remote: { enabled: false } } }));
      writeFileSync(join(root, 'nested-child.cjs'), `const fs=require('node:fs');
const events=fs.readFileSync(process.env.ROUTING_EVENTS,'utf8');
const again=events.includes('nested-child');
fs.appendFileSync(process.env.ROUTING_EVENTS,JSON.stringify({event:'nested-child',held:process.env.WE_HEAVY_ADMISSION_HELD==='1'})+'\\n');
if(!again)process.stderr.write(' FAIL  one.test.mjs > first local failure\\nAssertionError: first local failure\\n');
process.exit(again?0:1);`);
      if (retryExit !== undefined) {
        writeFileSync(join(root, 'local.test.mjs'), '// untouched fixture\n');
        execFileSync('git', ['add', 'local.test.mjs'], { cwd: root });
        execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'untouched test'], { cwd: root });
        execFileSync('git', ['branch', 'origin/main'], { cwd: root });
      }
      const command = gateCommand ?? (mode === 'raw' ? 'node raw.cjs' : 'npm run test:unit');
      const result = spawnSync(process.execPath, ['--import', preload, resolve(repo, 'scripts/verify-lane.mjs'),
        ...(laterPhases ? [] : ['--gate=' + command]), '--json'], {
        cwd: root, encoding: 'utf8', timeout: 30000,
        env: { ...process.env, PATH: bin + ':' + process.env.PATH, ROUTING_MODE: mode, ROUTING_EVENTS: events,
          ROUTING_REMOTE_EXIT: String(remoteExit), ROUTING_LOCAL_EXIT: String(localExit),
          ROUTING_LOCAL_DELAY: confirmed && !laterPhases ? '1' : '0',
          ROUTING_RETRY_EXIT: retryExit === undefined ? '' : String(retryExit), WE_VERIFY_ISOLATED_RETRY: 'untouched',
          ROUTING_STANDARDS_EXIT: baseCompared || (mode === 'local-fallback' && retryExit !== undefined) ? '0' : '',
          WE_VERIFY_RUN_ALL_PHASES: '1', WE_FORGE_GATE_DISPATCH: '1',
          ...(watchdogKill ? { WE_VERIFY_PHASE_TIMEOUT_MS: '2000' } : {}), ROUTING_LOCAL_BEHAVIOR: localBehavior,
          ROUTING_PHASES: laterPhases ? '1' : '0',
          ...(laterPhases ? { WE_VERIFY_PHASE_ADMISSION: phaseAdmission ? '1' : '0', WE_VERIFY_ALWAYS_RUN_TESTS: '' } : {}),
          WE_BUILD_FINAL_GATE: 'related', WE_BUILD_FINAL_GATE_STANDARDS: 'selected', WE_VERIFY_SLOT_HEARTBEAT_MS: '1000' },
      });
      expect(result.error, result.stderr).toBeUndefined();
      const expectedStatus = infrastructureReason ? 3 : code === 0 ? 0 : 2;
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(expectedStatus);
      const marker = JSON.parse(readFileSync(join(root, '.git/.lane-verify'), 'utf8'));
      const observed = readFileSync(events, 'utf8').trim().split('\n').map(JSON.parse);
      const confirmationCount = confirmed ? (laterPhases && !baseCompared ? 2 : 1) : 0;
      expect(observed.filter(e => e.event === 'acquire')).toHaveLength((held ? 1 : confirmationCount) + (retryExit !== undefined ? 1 : 0) + (baseCompared ? 1 : 0));
      expect(observed.filter(e => e.event === 'release')).toHaveLength(observed.filter(e => e.event === 'acquire').length);
      expect(observed.find(e => e.event === 'spawn')).toMatchObject({held,report:true});
      for (const spawn of observed.filter(e => e.event === 'spawn')) {
        expect(spawn.env).toEqual(spawn.held
          ? { WE_HEAVY_ADMISSION_HELD: '1' }
          : { WE_FORGE_GATE_DISPATCH: '1' });
      }
      if (expectedArgs) expect(observed.find(e => e.event === 'spawn')).toMatchObject({
        executable: held ? 'npx' : 'npm', args: expectedArgs,
      });
      if (command === 'npm run test:unit && node raw.cjs') {
        expect(observed.filter(e => e.event === 'spawn').map(e => ({ executable: e.executable, args: e.args, held: e.held })))
          .toEqual([
            { executable: 'npm', args: ['run', 'test:unit'], held: true },
            { executable: 'raw.cjs', args: [], held: true },
          ]);
      }
      if (laterPhases) {
        expect(marker.phases.admissionMode).toBe(phaseAdmission ? 'phase' : 'gate');
        // Shared gate admission must never replay the first phase's rewritten Vitest command.
        expect(observed.filter(e => e.event === 'spawn').map(e => ({ executable: e.executable, args: e.args })))
          .toEqual([
            { executable: 'npm', args: expectedArgs },
            ...(confirmed ? [{ executable: 'npx', args: ['vitest', ...gateCommand.split(' ').slice(2).map(arg => arg.replaceAll("'", ''))] }] : []),
            ...(retryExit !== undefined ? [{ executable: 'npx', args: ['vitest', 'run', '--maxWorkers=1', '--minWorkers=1', '--no-file-parallelism', './local.test.mjs'] }] : []),
            { executable: 'npm', args: ['run', 'check:standards'] },
            ...(baseCompared ? [{ executable: 'npx', args: ['vitest', 'run', '--maxWorkers=1', '--minWorkers=1', '--no-file-parallelism', './local.test.mjs'] }] : []),
            ...(confirmed && !baseCompared ? [{ executable: 'npm', args: ['run', 'check:standards'] }] : []),
          ]);
        expect(marker.ranOn.phases.standards).toEqual(confirmed && !baseCompared
          ? { location: 'local', remoteRedConfirmedLocally: true }
          : mode === 'local-fallback' ? { location: 'local' } : { location: 'remote', receiptId: 'run-123456' });
        if (confirmed) expect(observed.filter(e => e.event === 'acquire').map(e => e.kind)).toEqual(
          baseCompared ? (phaseAdmission ? ['files', 'files', 'files'] : ['selected', 'selected', 'selected'])
            : phaseAdmission ? (retryExit !== undefined ? ['files', 'files', 'other'] : ['files', 'other']) : ['selected', 'selected']);
      }
      expect(observed.filter(e => e.event === 'nested-acquire')).toHaveLength(mode === 'local-fallback' ? (laterPhases ? 2 : 1) : 0);
      const phase = laterPhases || command.startsWith('npm run test:unit') ? 'vitest' : command.startsWith('npm run check:standards') ? 'standards' : 'gate';
      // The base-compare case keeps standards remote and green, so the gate as a whole ran mixed.
      expect(marker.ranOn).toMatchObject({ location: baseCompared ? 'mixed' : location, phases: { [phase]: { location } } });
      if (confirmed) {
        expect(marker.ranOn.phases[phase]).toEqual({ location: 'local', remoteRedConfirmedLocally: true });
        expect(result.stderr.split(`verify-lane: remote phase red (exit ${remoteExit}) - confirming locally`)).toHaveLength(confirmationCount + 1);
        expect(observed.filter(e => e.event === 'spawn' && e.held)).toHaveLength(confirmationCount + (retryExit !== undefined ? 1 : 0));
        if (!laterPhases) {
          expect(observed.filter(e => e.event === 'spawn')).toHaveLength(2);
          expect(observed.filter(e => e.event === 'heartbeat').length).toBeGreaterThan(0);
        }
      } else {
        expect(result.stderr).not.toContain('confirming locally');
        if (!laterPhases && retryExit === undefined && command !== 'npm run test:unit && node raw.cjs') expect(observed.filter(e => e.event === 'spawn')).toHaveLength(1);
      }
      if (mode === 'nested-local') {
        expect(observed.filter(e => e.event === 'nested-child')).toEqual([{event:'nested-child',held:true}]);
        expect(result.stderr).toContain('heavy-admission: local (remote.enabled=false');
        expect(result.stderr).not.toContain('heavy-admission: remote');
        expect(marker.failureDetails.summary).toContain('first local failure');
        expect(marker.ranOn.phases[phase]).not.toHaveProperty('remoteRedConfirmedLocally');
      }
      if (mode === 'remote' && !confirmed) {
        expect(marker.ranOn.phases[phase].receiptId).toBe('run-123456');
        expect(observed.filter(e => e.event === 'heartbeat')).toHaveLength(0);
      }
      if (infrastructureReason) {
        expect(marker.status).toBe('infrastructure-failure');
        expect(marker.infrastructure.reason).toBe(infrastructureReason);
        if (confirmed) expect(marker.ranOn.phases[phase]).toEqual({ location: 'local', remoteRedConfirmedLocally: true });
        else expect(marker.ranOn.phases[phase]).not.toHaveProperty('remoteRedConfirmedLocally');
        if (code === 124) expect(marker.exitCode).toBe(124);
        if (watchdogKill) {
          expect(result.stderr).toContain('phase exceeded phaseTimeoutMs=2000');
          expect(marker.infrastructure).toMatchObject({ signal: 'SIGKILL', phase: 'gate', ceilingMs: 2000 });
        }
        if (signalKill) expect(marker.infrastructure.signal).toBe('SIGTERM');
      } else expect(marker.status).toBe(code === 0 ? 'green' : 'red');
      if (confirmed && code === 124) {
        expect(marker).not.toHaveProperty('infrastructure');
        expect(marker.exitCode).toBe(124);
      }
      if (code !== 0 && !infrastructureReason) {
        expect(marker.failureDetails.summary).toContain('local failure');
        expect(marker.failureDetails.summary).not.toContain('remote failure');
      }
      if (baseCompared) {
        const baseSpawn = observed.findLastIndex(e => e.event === 'spawn');
        expect(observed[baseSpawn]).toMatchObject({ held: false, executable: 'npx' });
        expect(observed[baseSpawn - 1]).toMatchObject({ event: 'acquire', kind: phaseAdmission ? 'files' : 'selected' });
        expect(observed.slice(baseSpawn + 1).filter(e => e.event !== 'heartbeat')).toEqual([{ event: 'release' }]);
      } else if (retryExit !== undefined) {
        expect(marker.isolatedRetry).toBe('flaky-outside-diff');
        expect(marker.retriedFailures).toEqual([{ file: 'local.test.mjs', kind: 'assertion' }]);
      }
    } finally { rmSync(root, { recursive:true,force:true }); }
  }
  it.each(cases)('%s phase (exit %i, %s, held=%s): %s preserves admission and terminal evidence (argv=%j, phaseAdmission=%s, remoteExit=%s, localExit=%s, retryExit=%s)', verifyRemotePhase);
  it('local confirmation holds admission and clears inherited Forge dispatch after a remote red', () => {
    verifyRemotePhase('remote', 0, 'local', false, 'npm run test:unit', undefined, undefined, 1);
  });
  it.each([false, true])('local-fallback red in an untouched file gets one admitted isolated retry (phaseAdmission=%s)', phaseAdmission => {
    verifyRemotePhase('local-fallback', 0, 'local', false, "npx vitest run 'one.test.mjs'", ['run', 'test:unit', '--', 'one.test.mjs'], phaseAdmission, 1, 0, 0);
  });
  it('a foreign directory with the wrapper suffix retains local admission in the spawned child', () => {
    verifyRemotePhase('raw', 0, 'local', true, 'node foreign/scripts/readiness/heavy-admission.mjs run -- vitest run');
  });
  it('nested local decision preserves the first local failure after remote preflight', () => {
    verifyRemotePhase('nested-local', 1, 'local', false, 'npm run test:unit', undefined, undefined, 1);
  });
  it('remote watchdog timeout remains infrastructure failure without local confirmation', () => {
    verifyRemotePhase('watchdog', 2, 'unknown', false);
  }, 15000);
  it('remote signal remains infrastructure failure without local confirmation', () => {
    verifyRemotePhase('signal', 2, 'unknown', false);
  });
  it('local confirmation exit 124 is a local red, never remote-termination-unconfirmed', () => {
    verifyRemotePhase('remote', 124, 'local', false, 'npm run test:unit', undefined, undefined, 1, 124);
  });
  it('local confirmation hitting the phase ceiling is a local verify-timeout, never remote-unconfirmed', () => {
    verifyRemotePhase('remote', 2, 'local', false, 'npm run test:unit', undefined, undefined, 1, 0, undefined, 'watchdog');
  }, 20000);
  it('local confirmation killed by a signal is a local verify-signal, never remote-unconfirmed', () => {
    verifyRemotePhase('remote', 2, 'local', false, 'npm run test:unit', undefined, undefined, 1, 0, undefined, 'signal');
  });
});
