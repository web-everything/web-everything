// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { runInNewContext } from 'node:vm';
import { SHARD_RUN_SCRIPT, localPhaseReason, localPhaseBypassDetail, phaseAdmissionPlan, phaseRunLocation, shouldConfirmRemoteRed, remoteInfrastructureFailure } from '../lib/verify-remote-routing.mjs';
import { shellQuote, isShardWrapperCommand } from '../lib/verify-lane-gate.mjs';
import { SCAN_FILES_ENV, SCAN_ROOT_ENV } from '../lib/repo-scan-tests.mjs';
import { runLaneGate } from '../conveyor/verify-dispatch.mjs';
import localPolicy from '../conveyor/soak/breaks/verify-request-local-policy.mjs';
import { SHARD_LOCAL_ENV } from '../lib/verify-shard-run.mjs';

const source = readFileSync(new URL('../verify-lane.mjs', import.meta.url), 'utf8');
const admissionStart = source.indexOf('async function acquireAdmission(');
const admissionEnd = source.indexOf('const admission = await acquireAdmission(', admissionStart);
const selectedTests = "npx vitest run 'a test.mjs' b.test.mjs --testTimeout=15000 --hookTimeout=30000";
const shardCommand = `node ${shellQuote(SHARD_RUN_SCRIPT)} --shards=2 --parallel=2 --budget-ms=1000 -- ${selectedTests}`;
const unsupportedShardCommand = `node ${shellQuote(SHARD_RUN_SCRIPT)} --shards=2 --parallel=2 --budget-ms=1000 -- echo unexpected`;
const shardPathVariants = [
  'scripts/lib/verify-shard-run.mjs',
  './scripts/lib/verify-shard-run.mjs',
  "'scripts/lib/verify-shard-run.mjs'",
  '"./scripts/lib/verify-shard-run.mjs"',
  SHARD_RUN_SCRIPT,
  `"${SHARD_RUN_SCRIPT}"`,
  "scripts/'lib'/verify-shard-run.mjs",
  'scripts/lib/verify-shard-\\run.mjs',
  'scripts/../scripts/lib/verify-shard-run.mjs',
];
const relativeShard = `node scripts/lib/verify-shard-run.mjs --shards=2 --parallel=2 --budget-ms=60000 -- ${selectedTests}`;
// --local keeps a validated wrapper whole and scopes forced-local routing to that one command.
const kept = command => `WE_VERIFY_SHARD_LOCAL=1 ${command}`;
const findingScenario = 'node scripts/lib/verify-shard-run.mjs --shards=2 --parallel=2 --budget-ms=60000 -- npx vitest run scripts/lib/__tests__/verify-selection-log.test.mjs scripts/__tests__/stdout-flush.test.mjs --passWithNoTests';
const commandShapes = [
  ['npm', 'npm run test:unit -- a.test.mjs'],
  ['vitest', selectedTests],
  ['related', 'npx vitest related scripts/a.mjs --run --passWithNoTests'],
  ['chain', 'npx vitest run a.test.mjs && npx vitest run b.test.mjs'],
  ['standards', 'npm run check:standards -- --files=scripts/a.mjs'],
  ...shardPathVariants.map(path => [
    `standards shard path is input data: ${path}`, `npm run check:standards -- --local --files=${path}`,
  ]),
  ['standards separate file argument is data', "npm run check:standards -- --local --files 'scripts/lib/verify-shard-run.mjs'"],
  ['standards file list is data', "npm run check:standards -- --local --files='scripts/a.mjs,scripts/lib/verify-shard-run.mjs'"],
  ['standards input before shard execution', `npm run check:standards -- --local --files='scripts/lib/verify-shard-run.mjs' && ${relativeShard}`, `npm run check:standards -- --local --files='scripts/lib/verify-shard-run.mjs' && ${kept(relativeShard)}`],
  ['assigned standards input is data', "CI=1 npm run check:standards -- --local --files='scripts/lib/verify-shard-run.mjs'"],
  ['vitest related shard input is data', "npx vitest related 'scripts/lib/verify-shard-run.mjs' --run"],
  ['npm test shard input is data', "npm run test:unit -- 'scripts/lib/verify-shard-run.mjs.test.mjs'"],
  ['npm test alias shard input is data', "npm test -- 'scripts/lib/verify-shard-run.mjs.test.mjs'"],
  ['vitest run shard input is data', "npx vitest run 'scripts/lib/verify-shard-run.mjs.test.mjs'"],
  ['standards input does not exempt a later launcher', `npm run check:standards -- --files='scripts/lib/verify-shard-run.mjs' && env ${relativeShard}`, null],
  ['npm exec still refuses shard execution', `npm exec -- ${relativeShard}`, null],
  ['npx still refuses shard execution', `npx ${relativeShard}`, null],
  ['npm options cannot impersonate script arguments', "npm run check:standards --script-shell=scripts/lib/verify-shard-run.mjs", null],
  ['admission wrapper', 'node scripts/readiness/heavy-admission.mjs run -- npx vitest run a.test.mjs'],
  ...[
    'scripts/readiness/heavy-admission.mjs',
    './scripts/readiness/heavy-admission.mjs',
    "'scripts/readiness/heavy-admission.mjs'",
    'scripts/readiness/../readiness/heavy-admission.mjs',
    "scripts/'readiness'/heavy-admission.mjs",
    'scripts/readiness/heavy-admis\\sion.mjs',
    shellQuote(resolve('scripts/readiness/heavy-admission.mjs')),
  ].map(path => [
    `nested admission shard refuses local execution: ${path}`,
    `node ${path} run -- ${relativeShard}`, null,
  ]),
  ['nested admission with local still refuses shard execution', `node scripts/readiness/heavy-admission.mjs run --local -- ${relativeShard}`, null],
  ['doubly nested admission refuses shard execution', `node scripts/readiness/heavy-admission.mjs run -- node scripts/readiness/heavy-admission.mjs run -- ${relativeShard}`, null],
  ['oversized admission nesting refuses with an unwrapped-gate fallback', `${'node scripts/readiness/heavy-admission.mjs run -- '.repeat(33)}${relativeShard}`, null],
  ['nested node option terminators refuse shard execution', `node -- scripts/readiness/heavy-admission.mjs run -- ${relativeShard.replace('node ', 'node -- ')}`, null],
  ['nested prefixed shard refuses execution', `node scripts/readiness/heavy-admission.mjs run -- env ${relativeShard}`, null],
  ...shardPathVariants.map(path => [
    `nested shard path refuses execution: ${path}`,
    `node scripts/readiness/heavy-admission.mjs run -- node ${path} --shards=2 --parallel=2 --budget-ms=1000 -- ${selectedTests}`, null,
  ]),
  ['nested admission shard input is data', "node scripts/readiness/heavy-admission.mjs run -- npx vitest related scripts/lib/verify-shard-run.mjs --run"],
  ['nested admission standards input is data', "node scripts/readiness/heavy-admission.mjs run -- npm run check:standards -- --files='scripts/lib/verify-shard-run.mjs'"],
  // A validated wrapper is kept whole (its inventory completeness check still applies) and runs locally.
  ['shard wrapper', shardCommand, kept(shardCommand)],
  ...shardPathVariants.map(path => [
    `shard path ${path}`, `node ${path} --shards=2 --parallel=2 --budget-ms=1000 -- ${selectedTests}`,
    kept(`node ${path} --shards=2 --parallel=2 --budget-ms=1000 -- ${selectedTests}`),
  ]),
  ['relative shard after standards', `npm run check:standards && ${relativeShard}`, `npm run check:standards && ${kept(relativeShard)}`],
  ['two shard wrappers', `${relativeShard} && ${shardCommand}`, `${kept(relativeShard)} && ${kept(shardCommand)}`],
  ['reordered shard options and tabs', `node\t./scripts/lib/verify-shard-run.mjs\t--budget-ms=1000 --parallel=2 --shards=2 -- ${selectedTests}`,
    kept(`node\t./scripts/lib/verify-shard-run.mjs\t--budget-ms=1000 --parallel=2 --shards=2 -- ${selectedTests}`)],
  ['node option terminator', relativeShard.replace('node ', 'node -- '), kept(relativeShard.replace('node ', 'node -- '))],
  ['leading assignment keeps the scoped local route', `CI=1 ${relativeShard}`, `CI=1 ${kept(relativeShard)}`],
  ['caller-set shard env is overridden by the scoped route', `WE_VERIFY_SHARD_LOCAL=0 ${relativeShard}`, `WE_VERIFY_SHARD_LOCAL=0 ${kept(relativeShard)}`],
  ...[
    'env', 'command', '/usr/bin/env', 'env --', 'env -i',
    'env WE_HEAVY_ADMISSION_HELD=0', 'command -p', 'command env',
    'env command', 'exec', 'nice -n 5', 'timeout 60',
  ].map(prefix => [`shell prefix ${prefix} refuses local execution`, `${prefix} ${relativeShard}`, null]),
  ['quoted prefix and wrapper path refuse local execution', `"env" node './scripts/lib/verify-shard-run.mjs' --shards=2 --parallel=2 --budget-ms=60000 -- ${selectedTests}`, null],
  ['prefixed shard after standards refuses local execution', `npm run check:standards && env ${relativeShard}`, null],
  ['shell payload refuses local execution', `sh -c ${shellQuote(relativeShard)}`, null],
  ...shardPathVariants.map(path => [
    `prefixed shard path ${path} refuses local execution`, `env node ${path} --shards=2 --parallel=2 --budget-ms=1000 -- ${selectedTests}`, null,
  ]),
  ['node eval payload refuses local execution', `node -e ${shellQuote(`import('./scripts/lib/verify-shard-run.mjs')`)}`, null],
  ['unsupported node options refuse local execution', relativeShard.replace('node ', 'node --no-warnings '), null],
  ['relative shard unsupported selection', relativeShard.replace(selectedTests, 'echo unexpected'), null],
  ['relative shard malformed options', relativeShard.replace('--parallel=2', '--parallel=bad'), null],
  ['dynamic shard path refuses local execution', `node "$PWD/scripts/lib/verify-shard-run.mjs" --shards=2 --parallel=2 --budget-ms=1000 -- ${selectedTests}`, null],
  ...[
    'scripts/lib/verify-shard-ru?.mjs',
    'scripts/lib/verify-shard-ru*.mjs',
    'scripts/lib/verify-shard-ru[n].mjs',
    'scripts/l?b/verify-shard-run.mjs',
    "'scripts/lib/'verify-shard-ru?.mjs",
    'scripts/lib/verify-shard-ru""?.mjs',
    'scripts/lib/../lib/verify-shard-ru?.mjs',
  ].flatMap(path => [
    ['direct', `node ${path}`],
    ['node terminator', `node -- ${path}`],
    ['prefixed', `env node ${path}`],
    ['nested', `node scripts/readiness/heavy-admission.mjs run -- node ${path}`],
    ['after standards', `npm run check:standards && node ${path}`],
    ['shell payload', `sh -c ${shellQuote(`node ${path} --shards=1 --parallel=1 --budget-ms=60000 -- npx vitest run scripts/__tests__/stdout-flush.test.mjs`)}`],
  ].map(([shape, prefix]) => [
    `globbed shard path refuses local execution (${shape}): ${path}`,
    shape === 'shell payload' ? prefix : `${prefix} --shards=1 --parallel=1 --budget-ms=60000 -- npx vitest run scripts/__tests__/stdout-flush.test.mjs`, null,
  ])),
  ...[
    "'scripts/lib/verify-shard-ru?.mjs'",
    '"scripts/lib/verify-shard-ru*.mjs"',
    'scripts/lib/verify-shard-ru\\?.mjs',
    "scripts/lib/verify-shard-ru'[n]'.mjs",
  ].map(path => [`literal glob characters do not expand: ${path}`, `node ${path}`]),
  ['quoted glob suite input remains data', "npx vitest run 'scripts/__tests__/*.test.mjs'"],
  ['quoted glob standards input remains data', "npm run check:standards -- --files='scripts/lib/verify-shard-ru?.mjs'"],
  ['unquoted glob suite input remains data', 'npx vitest run scripts/__tests__/*.test.mjs'],
  ['unquoted glob standards input remains data', 'npm run check:standards -- --files=scripts/lib/verify-shard-ru?.mjs'],
  ['nested glob suite input remains data', 'node scripts/readiness/heavy-admission.mjs run -- npx vitest run scripts/__tests__/*.test.mjs'],
  ['glob echo argument remains data', 'echo scripts/lib/verify-shard-ru?.mjs'],
  ['globbed executable refuses local execution', `./node_module?/.bin/node scripts/lib/verify-shard-run.mjs --shards=1 --parallel=1 --budget-ms=60000 -- ${selectedTests}`, null],
  ['node options cannot hide a globbed script', `node --no-warnings scripts/lib/verify-shard-ru?.mjs --shards=1 --parallel=1 --budget-ms=60000 -- ${selectedTests}`, null],
  ['globbed outer admission refuses local execution', `node scripts/readiness/heavy-admissio?.mjs run -- ${relativeShard}`, null],
  ...[
    '"$RUNNER"', '$RUNNER', '"${RUNNER}"', 'scripts/lib/"$RUNNER"',
    '"${DIR}/${FILE}"', '"$(printf %s "$RUNNER")"', '`printf %s "$RUNNER"`',
  ].map(path => [
    `opaque shard path refuses local execution: ${path}`,
    `node ${path} --shards=1 --parallel=1 --budget-ms=60000 -- npx vitest run scripts/__tests__/stdout-flush.test.mjs`, null,
  ]),
  ['expanded executable refuses local execution', '"$NODE" "$RUNNER" -- -- npx vitest run a.test.mjs', null],
  ['expanded shard after standards refuses local execution', 'npm run check:standards && node "$RUNNER" -- npx vitest run a.test.mjs', null],
  ['nested expanded shard refuses local execution', 'node scripts/readiness/heavy-admission.mjs run -- node "$RUNNER" -- npx vitest run a.test.mjs', null],
  ...['\n', '\r\n', ';', '|', '||'].map(separator => [
    `unsupported shell separator refuses local execution: ${JSON.stringify(separator)}`,
    `npm run check:standards${separator}node "$RUNNER" -- npx vitest run a.test.mjs`, null,
  ]),
  ['quoted wrapper text stays an argument', `echo '${relativeShard.replaceAll("'", '')}'`],
  ['whole gate with shard wrapper', `${shardCommand} && npm run check:standards`, `${kept(shardCommand)} && npm run check:standards`],
  ['shard wrapper from quoted requester checkout', `node ${shellQuote("/tmp/requester's -- npx vitest run checkout/scripts/lib/verify-shard-run.mjs")} --shards=2 --parallel=2 --budget-ms=1000 -- ${selectedTests}`,
    kept(`node ${shellQuote("/tmp/requester's -- npx vitest run checkout/scripts/lib/verify-shard-run.mjs")} --shards=2 --parallel=2 --budget-ms=1000 -- ${selectedTests}`)],
  ['finding scenario: partial execution keeps the wrapper', findingScenario, kept(findingScenario)],
  ['scan', "VERIFY_SCAN_FILES='scripts/a.mjs' npx vitest run scripts/scan.test.mjs"],
  ['empty selection', "echo 'verify-lane: no remaining changed file'"],
  ['unsupported shard command refuses local execution', unsupportedShardCommand],
];

function parseCli(context, local, childArgs) {
  const start = source.indexOf('const flags = {}');
  const end = source.indexOf('// #2833 finding 5', start);
  expect(end).toBeGreaterThan(start);
  context.process.argv = ['node', ...(childArgs ?? ['verify-lane.mjs', ...(local ? ['--local'] : [])])];
  context.process.cwd = () => process.cwd();
  Object.assign(context, { resolve, join, homedir });
  runInNewContext(`${source.slice(start, end)}; Object.assign(globalThis, { FORCE_LOCAL, flags, REPO });`, context);
}

describe('verify-lane --local', () => {
  it('the reported glob resolves to the real shard runner in the production shell', () => {
    const expanded = execFileSync('/bin/sh', ['-c', 'printf "%s" scripts/lib/verify-shard-ru?.mjs'], {
      cwd: new URL('../../', import.meta.url), encoding: 'utf8', timeout: 1000, maxBuffer: 4096,
    });
    expect(expanded).toBe('scripts/lib/verify-shard-run.mjs');
  });

  it('supersedes in-flight requests when local policy changes and retains identical retries (daemon soak)', async () => {
    expect(localPolicy.judge(await localPolicy.run())).toEqual([]);
  });

  it.each([false, true])('preserves a replacement policy if the old dispatched run finishes before supersession (local=%s)', local => {
    const start = source.indexOf('const onDisk = readMarker();');
    const end = source.indexOf('// Reuse the on-disk start body', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const emit = vi.fn(() => { throw new Error('superseded exit'); });
    const context = {
      DISPATCHED_RUN: true, FORCE_LOCAL: local, headSha: 'head', exitCode: 0, redCauseFields: {}, emit,
      readMarker: () => ({ status: 'running', sha: 'head', ...(!local ? { local: true } : {}) }),
    };
    expect(() => runInNewContext(source.slice(start, end), context)).toThrow('superseded exit');
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ status: 'superseded' }), 3);
    emit.mockClear();
    for (const policy of local ? [true] : [false, undefined]) {
      runInNewContext(source.slice(start, end), { ...context,
        readMarker: () => ({ status: 'running', sha: 'head', local: policy }),
      });
    }
    expect(emit).not.toHaveBeenCalled();
  });

  it.each([false, true])('request marker preserves parsed --local through daemon dispatch to the executing CLI (local=%s)', async local => {
    const startLine = source.split('\n').find(line => line.startsWith("if (MODE !== 'run') writeMarker("));
    const context = {
      MODE: 'request', process: { env: {} }, verifyStartBody: value => value,
      headSha: 'head', GATE: selectedTests, currentTreeHash: 'tree', writeMarker: vi.fn(), gateAudit: {},
    };
    parseCli(context, local);
    runInNewContext(startLine, context);
    const marker = context.writeMarker.mock.calls[0][0];
    const spawnGate = vi.fn(async () => ({ pid: 123 }));
    await runLaneGate({
      pool: 'fixture', lane: 1, dir: process.cwd(), headSha: 'head', marker,
      runId: 'request-local-policy', spawnGate, log: () => {}, logPath: 'unused',
      gateCeiling: { ms: 1000, mode: 'fixture', source: 'fixture', factor: 1 },
    });
    expect(spawnGate).toHaveBeenCalledTimes(1);
    const [args] = spawnGate.mock.calls[0];
    expect(args).toContain(`--gate=${selectedTests}`);
    expect(args).toContain('--run-id=request-local-policy');
    const child = { process: { env: {} } };
    parseCli(child, false, args);
    expect(child.FORCE_LOCAL).toBe(local);
    expect(child.flags.gate).toBe(selectedTests);
  });

  it.each([false, true])('takes local slots for every phase and bypasses remote policy (phaseAdmission=%s)', async phaseAdmission => {
    expect(admissionStart).toBeGreaterThan(-1);
    expect(admissionEnd).toBeGreaterThan(admissionStart);
    const context = {
      FORCE_LOCAL: true, phaseAdmission, fullFallbackGate: false, localPhaseReason, phaseAdmissionPlan,
      decidePhaseRemote: vi.fn(async () => ({ remote: true })),
      acquireSlotBlocking: vi.fn(async () => ({ ok: true, slot: 0, waitedMs: 0 })),
      phaseAdmissionKind: () => ({ kind: 'files' }), classifyCommandKind: () => 'selected',
      recordLocalSlotFallback: vi.fn(), admissionPhases: {}, laneMatch: null,
      GATE: 'npm run test:unit', resolvedGate: { decision: {} },
      ADMISSION_LOCK_ROOT: '', ADMISSION_CAP: 1, ADMISSION_TIMEOUT_MS: 1000,
      REPO: process.cwd(), process: { env: {}, stderr: { write: vi.fn() } },
    };
    const acquireAdmission = runInNewContext(`${source.slice(admissionStart, admissionEnd)}; acquireAdmission`, context);
    const commands = [
      ['vitest', 'npm run test:unit'],
      ['scan', 'npx vitest run scripts/scan.test.mjs'],
      ['scan', 'npx vitest run scripts/guard.test.mjs'],
      ['standards', 'npm run check:standards'],
      ['vitest', `node ${shellQuote(SHARD_RUN_SCRIPT)} --shards=2 --parallel=2 --budget-ms=1000 -- npx vitest run a.test.mjs b.test.mjs`],
      ['vitest', 'npx vitest related scripts/a.mjs --run --passWithNoTests'],
      ['vitest', 'npx vitest run a.test.mjs && npx vitest run b.test.mjs'],
      ['vitest', 'node scripts/readiness/heavy-admission.mjs run -- npx vitest run a.test.mjs'],
    ];
    for (const [phase, command] of commands) {
      const admission = await acquireAdmission(phase, command);
      expect(admission).toMatchObject({ ok: true });
      expect(admission.remote).not.toBe(true);
    }
    expect(context.decidePhaseRemote).not.toHaveBeenCalled();
    expect(context.acquireSlotBlocking).toHaveBeenCalledTimes(commands.length);
    expect(context.recordLocalSlotFallback).toHaveBeenCalledTimes(commands.length);
    expect(context.recordLocalSlotFallback.mock.calls.every(([entry]) => entry.reason === 'local-flag')).toBe(true);
    expect(context.process.stderr.write.mock.calls.every(([line]) => line.includes('local admission (local-flag)'))).toBe(true);
  });

  it.each([false, true])('records local metadata only with the parsed CLI flag in start and terminal markers (local=%s)', local => {
    const startLine = source.split('\n').find(line => line.startsWith("if (MODE !== 'run') writeMarker("));
    const finishLine = source.split('\n').find(line => line.startsWith('writeMarker({ ...finished,'));
    expect(startLine).toBeTypeOf('string');
    expect(finishLine).toBeTypeOf('string');
    const writeMarker = vi.fn();
    const context = {
      MODE: 'verify', writeMarker, process: { env: {} },
      verifyStartBody: value => value, headSha: 'head', GATE: 'gate', currentTreeHash: 'tree', flags: {}, gateAudit: {},
      finished: { status: 'green' }, overallRunLocation: () => ({ location: 'local' }), ranOnPhases: {},
      resolvedGate: null, redCauseFields: {}, phases: {}, revertRed: null,
    };
    parseCli(context, local);
    runInNewContext(startLine, context);
    runInNewContext(finishLine, context);
    expect(writeMarker).toHaveBeenCalledTimes(2);
    for (const [marker] of writeMarker.mock.calls) {
      if (local) expect(marker.local).toBe(true);
      else expect(marker).not.toHaveProperty('local');
    }
    writeMarker.mockClear();
    context.MODE = 'run';
    runInNewContext(startLine, context);
    expect(writeMarker).not.toHaveBeenCalled();
  });

  it.each(commandShapes)('CLI --local preserves suites and bypasses Forge while default routing remains unchanged: %s', async (_shape, command, localCommand = command) => {
    // slotOk=false: admission timed out and verify-lane proceeds unslotted.
    for (const [local, slotOk] of [[false, true], [true, true], [true, false]]) {
      const spawn = vi.fn(() => {
        const child = new EventEmitter();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        queueMicrotask(() => child.emit('close', 0, null));
        return child;
      });
      const context = {
        process: { env: { WE_FORGE_GATE_DISPATCH: '1', [SHARD_LOCAL_ENV]: '1',
          [SCAN_FILES_ENV]: '["polluted.mjs"]', [SCAN_ROOT_ENV]: '/tmp/polluted-scan-root' }, stderr: { write: vi.fn() }, pid: 123 },
        SHARD_LOCAL_ENV, SCAN_FILES_ENV, SCAN_ROOT_ENV,
        phaseAdmission: true, fullFallbackGate: false, localPhaseReason, localPhaseBypassDetail, phaseAdmissionPlan, phaseRunLocation,
        isShardWrapperCommand,
        shouldConfirmRemoteRed, remoteInfrastructureFailure,
        decidePhaseRemote: vi.fn(async () => ({ remote: true, reason: 'test-remote-policy' })),
        acquireSlotBlocking: vi.fn(async () => (slotOk ? { ok: true, slot: 0, waitedMs: 0 } : { ok: false, timedOut: true, waitedMs: 1000 })),
        recordLocalSlotFallback: vi.fn(), phaseAdmissionKind: () => ({ kind: 'files' }),
        classifyCommandKind: () => 'selected', admissionPhases: {}, laneMatch: null,
        GATE: command, resolvedGate: { decision: {} }, ADMISSION_TIMEOUT_MS: 1000,
        ADMISSION_LOCK_ROOT: '', ADMISSION_CAP: 1, ADMISSION_HELD_ENV: 'WE_HEAVY_ADMISSION_HELD',
        mkdtempSync, rmSync, join, tmpdir, spawn,
        createFailureCollector: () => ({ push() {}, finish: () => null }),
        createOutputTail: () => ({ push() {}, finish: () => [] }),
        randomBytes: () => Buffer.from('fixture'), Buffer, MAX_TIMEOUT_LOG_BYTES: 1000,
        GATE_PHASE_MARKER_ENV: 'WE_VERIFY_GATE_PHASE_123',
        readRemoteReport: () => [], recordOutcome: vi.fn(), buildPhaseOutcome: value => value,
        ranOnPhases: {}, phaseMs: {}, remoteUnconfirmed: false, phaseTimeout: null,
        slotHeartbeat: null, setInterval: vi.fn(() => ({ unref() {} })), clearInterval: vi.fn(),
        clearTimeout, heartbeatOwnedSlot: vi.fn(), releaseOwnedSlot: vi.fn(),
        SLOT_HEARTBEAT_MS: 1000, PHASE_TIMEOUT_MS: 10000, MARKER_NONCE_SUFFIX: '', performance,
      };
      parseCli(context, local);
      const acquireAdmission = runInNewContext(`${source.slice(admissionStart, admissionEnd)}; acquireAdmission`, context);
      context.admission = await acquireAdmission('vitest', command);
      context.firstPhaseAdmission = context.admission;
      context.acquireAdmission = acquireAdmission;
      const runStart = source.indexOf('async function runGate(');
      const runEnd = source.indexOf('// #5141', runStart);
      const timedStart = source.indexOf('async function timedRunGate(');
      const timedEnd = source.indexOf('// runVitestOnBase', timedStart);
      expect(runEnd).toBeGreaterThan(runStart);
      expect(timedEnd).toBeGreaterThan(timedStart);
      context.runGate = vi.fn(runInNewContext(`${source.slice(runStart, runEnd)}; runGate`, context));
      const timedRunGate = runInNewContext(`${source.slice(timedStart, timedEnd)}; timedRunGate`, context);
      if (local && (command === unsupportedShardCommand || localCommand === null)) {
        await expect(timedRunGate('vitestMs', command)).rejects.toThrow('--local requires a selected Vitest command');
        expect(spawn).not.toHaveBeenCalled();
        if (slotOk) expect(context.releaseOwnedSlot).toHaveBeenCalledTimes(1);
        continue;
      }
      if (local && !slotOk && localCommand.includes(kept(''))) {
        // Without a held slot the scoped local route would be a false claim; the wrapper would route alone.
        await expect(timedRunGate('vitestMs', command)).rejects.toThrow('--local shard wrapper needs a held admission slot');
        expect(spawn).not.toHaveBeenCalled();
        continue;
      }
      const result = await timedRunGate('vitestMs', command);
      expect(result.exitCode).toBe(0);
      expect(spawn).toHaveBeenCalledTimes(1);
      const [executed, args, options] = spawn.mock.calls[0];
      expect(options.env).not.toHaveProperty(SCAN_FILES_ENV);
      expect(options.env).not.toHaveProperty(SCAN_ROOT_ENV);
      expect(context.process.env[SCAN_FILES_ENV]).toBe('["polluted.mjs"]');
      expect(context.process.env[SCAN_ROOT_ENV]).toBe('/tmp/polluted-scan-root');
      if (local) {
        expect(context.admission.ok).toBe(slotOk);
        expect(context.admission.remote).not.toBe(true);
        expect(context.acquireSlotBlocking).toHaveBeenCalledTimes(1);
        expect(context.decidePhaseRemote).not.toHaveBeenCalled();
        expect(executed).toBe(localCommand);
        expect(context.runGate).toHaveBeenNthCalledWith(1, localCommand, undefined, { forgeDispatch: false });
        expect(args).toEqual([]);
        expect(options.env).not.toHaveProperty('WE_FORGE_GATE_DISPATCH');
        expect(options.env.WE_HEAVY_ADMISSION_HELD).toBe('1');
        // Forced-local shard routing is scoped to each kept wrapper, never inherited by other commands.
        expect(options.env).not.toHaveProperty(SHARD_LOCAL_ENV);
        expect(result.remoteAttempt).toBe(false);
        expect(result.ranOn.location).toBe('local');
        // Also defend the execution boundary against a stale remote admission or confirmation request.
        await context.runGate('node', ['fixture.mjs'], { forgeDispatch: true });
        expect(spawn.mock.calls[1][2].env).not.toHaveProperty('WE_FORGE_GATE_DISPATCH');
      } else {
        const plan = phaseAdmissionPlan({ command, decision: { remote: true }, cwd: process.cwd() });
        expect(executed).toBe(plan.command);
        expect(result.remoteAttempt).toBe(!plan.takeLocalSlot);
        expect(context.acquireSlotBlocking).toHaveBeenCalledTimes(plan.takeLocalSlot ? 1 : 0);
        expect(context.decidePhaseRemote).toHaveBeenCalledTimes(plan.takeLocalSlot ? 0 : 1);
        // A leaked forced-local env from the caller never changes default routing.
        expect(options.env).not.toHaveProperty(SHARD_LOCAL_ENV);
        if (plan.takeLocalSlot) expect(options.env).not.toHaveProperty('WE_FORGE_GATE_DISPATCH');
        else expect(options.env.WE_FORGE_GATE_DISPATCH).toBe('1');
      }
    }
  });
});
