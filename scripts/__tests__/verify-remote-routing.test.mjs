// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { appendVerifyRemoteReport, heartbeatOwnedSlot } from '../readiness/heavy-admission.mjs';
import { keepAliveScript } from '../lib/test-keepalive.mjs';
import { phaseAdmissionPlan, shouldConfirmRemoteRed, readRemoteReport, remoteInfrastructureFailure, phaseRunLocation, overallRunLocation, decidePhaseRemote } from '../lib/verify-remote-routing.mjs';

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
  it.each(['npm run test:unit --prefix=other', 'node other/heavy-admission.mjs run -- vitest run'])(
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
    ['--passWithNoTests --testTimeout=15000 --hookTimeout=30000', ''],
    ['--testTimeout=15000 --hookTimeout=30000 --passWithNoTests', ''],
    ['--passWithNoTests', ''],
    ['--testTimeout=15000', ''],
    ['--hookTimeout=30000', ''],
    ['--testTimeout=5000 --hookTimeout=10000', ''],
    ['--reporter=dot --passWithNoTests --testTimeout=15000 --hookTimeout=30000', ' --reporter=dot'],
  ])('remote selected Vitest run strips only trailing local gate flags: %s', (flags, retained) => {
    const files = "'scripts/path with spaces.test.mjs' 'scripts/two.test.mjs'";
    expect(phaseAdmissionPlan({ command: `npx vitest run ${files} ${flags}`, decision: { remote: true } })).toEqual({
      command: `npm run test:unit -- ${files}${retained}`, takeLocalSlot: false, setHeld: false,
    });
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
      expect(readRemoteReport(file)).toEqual([JSON.parse(report)]);
      symlinkSync(file, join(root, 'link.jsonl'));
      expect(readRemoteReport(join(root, 'link.jsonl'))).toEqual([]);
      execFileSync('mkfifo', [join(root, 'fifo.jsonl')]);
      expect(readRemoteReport(join(root, 'fifo.jsonl'))).toEqual([]);
      mkdirSync(join(root, 'dir.jsonl'));
      expect(readRemoteReport(join(root, 'dir.jsonl'))).toEqual([]);
      writeFileSync(join(root, 'big.jsonl'), report + '\n' + ' '.repeat(65536));
      expect(readRemoteReport(join(root, 'big.jsonl'))).toEqual([]);
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
    ['remote', 0, 'remote', false, "npx vitest run 'one.test.mjs' 'path with spaces.test.mjs' --reporter=dot --passWithNoTests --testTimeout=15000 --hookTimeout=30000",
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
      "npx vitest run 'one.test.mjs' --passWithNoTests --testTimeout=15000 --hookTimeout=30000",
      ['run', 'test:unit', '--', 'one.test.mjs'], phaseAdmission]),
    ['remote', 0, 'local', false, 'npm run check:standards', undefined, undefined, 75],
    ['remote', 0, 'local', false, 'npm run test:unit', undefined, undefined, 1],
    ['local', 1, 'local', true, 'npm run test:unit', undefined, undefined, 0, 1],
    ...[false, true].flatMap(phaseAdmission => [0, 1].map(localExit => ['remote', localExit, 'local', false,
      "npx vitest run 'one.test.mjs' --passWithNoTests --testTimeout=15000 --hookTimeout=30000",
      ['run', 'test:unit', '--', 'one.test.mjs'], phaseAdmission, 1, localExit])),
    ['remote', 1, 'local', false, "npx vitest run 'one.test.mjs'", ['run', 'test:unit', '--', 'one.test.mjs'], true, 1, 1, 0],
  ];
  function verifyRemotePhase(mode, code, location, held, gateCommand, expectedArgs, phaseAdmission, remoteExit = 0, localExit = 0, retryExit, localBehavior = '') {
    const root = mkdtempSync(join(tmpdir(), 'verify-routing-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: root });
      execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-qm', 'fixture'], { cwd: root });
      const events = join(root, 'events.jsonl');
      const heavy = pathToFileURL(resolve(repo, 'scripts/readiness/heavy-admission.mjs')).href;
      const routing = pathToFileURL(resolve(repo, 'scripts/lib/verify-remote-routing.mjs')).href;
      const gate = pathToFileURL(resolve(repo, 'scripts/lib/verify-lane-gate.mjs')).href;
      const laterPhases = phaseAdmission !== undefined;
      const confirmed = mode === 'remote' && remoteExit !== 0 && remoteExit !== 124;
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
        if (url === ${JSON.stringify(gate)} && process.env.ROUTING_PHASES === '1') return {format:'module',shortCircuit:true,source:
          'export * from ' + JSON.stringify(url+'?actual') + ';' +
          'export function resolveDefaultGate() { return ' + ${JSON.stringify(JSON.stringify(phasePlan))} + '; }'};
        if (url === ${JSON.stringify(heavy)}) return {format:'module',shortCircuit:true,source:
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
const exitCode=held ? (retry ? Number(process.env.ROUTING_RETRY_EXIT) : Number(process.env.ROUTING_LOCAL_EXIT)) : Number(process.env.ROUTING_REMOTE_EXIT);
fs.appendFileSync(process.env.ROUTING_EVENTS,JSON.stringify({event:'spawn',held, env:{WE_HEAVY_ADMISSION_HELD:process.env.WE_HEAVY_ADMISSION_HELD,WE_FORGE_GATE_DISPATCH:process.env.WE_FORGE_GATE_DISPATCH}, report:!!process.env.WE_VERIFY_REMOTE_REPORT, executable:require('node:path').basename(process.argv[1]), args:process.argv.slice(2)})+'\\n');
if(mode==='local-fallback') {
  if(held) throw Error('double local admission');
  fs.appendFileSync(process.env.ROUTING_EVENTS,JSON.stringify({event:'nested-acquire'})+'\\n');
}
if(['remote','local-fallback'].includes(mode) && !held)fs.appendFileSync(process.env.WE_VERIFY_REMOTE_REPORT,JSON.stringify({location:mode,receiptId:'run-123456',exitCode})+'\\n');
if(mode==='unreadable')fs.writeFileSync(process.env.WE_VERIFY_REMOTE_REPORT,'{');
if(exitCode) {
  const file=held ? (process.env.ROUTING_RETRY_EXIT ? 'local.test.mjs' : 'one.test.mjs') : 'remote.test.mjs';
  fs.writeSync(2,' FAIL  '+file+' > '+(held?'local':'remote')+' failure\\nAssertionError: fixture failure\\n');
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
      const confirmationCount = confirmed ? (laterPhases ? 2 : 1) : 0;
      expect(observed.filter(e => e.event === 'acquire')).toHaveLength((held ? 1 : confirmationCount) + (retryExit !== undefined ? 1 : 0));
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
            ...(confirmed ? [{ executable: 'npm', args: ['run', 'check:standards'] }] : []),
          ]);
        expect(marker.ranOn.phases.standards).toEqual(confirmed
          ? { location: 'local', remoteRedConfirmedLocally: true }
          : { location: 'remote', receiptId: 'run-123456' });
        if (confirmed) expect(observed.filter(e => e.event === 'acquire').map(e => e.kind)).toEqual(
          phaseAdmission ? (retryExit !== undefined ? ['files', 'files', 'other'] : ['files', 'other']) : ['selected', 'selected']);
      }
      expect(observed.filter(e => e.event === 'nested-acquire')).toHaveLength(mode === 'local-fallback' ? 1 : 0);
      const phase = laterPhases || command.startsWith('npm run test:unit') ? 'vitest' : command.startsWith('npm run check:standards') ? 'standards' : 'gate';
      expect(marker.ranOn).toMatchObject({ location, phases: { [phase]: { location } } });
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
        if (!laterPhases && command !== 'npm run test:unit && node raw.cjs') expect(observed.filter(e => e.event === 'spawn')).toHaveLength(1);
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
      if (retryExit !== undefined) {
        expect(marker.isolatedRetry).toBe('flaky-outside-diff');
        expect(marker.retriedFailures).toEqual([{ file: 'local.test.mjs', kind: 'assertion' }]);
      }
    } finally { rmSync(root, { recursive:true,force:true }); }
  }
  it.each(cases)('%s phase (exit %i, %s, held=%s): %s preserves admission and terminal evidence (argv=%j, phaseAdmission=%s, remoteExit=%s, localExit=%s, retryExit=%s)', verifyRemotePhase);
  it('local confirmation holds admission and clears inherited Forge dispatch after a remote red', () => {
    verifyRemotePhase('remote', 0, 'local', false, 'npm run test:unit', undefined, undefined, 1);
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
