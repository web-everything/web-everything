import { beforeEach, afterEach, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, statSync, realpathSync, symlinkSync, rmSync, readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadVerifySettingsFile, resolveVerifySettings } from '../lib/verify-settings.mjs';
import { createHash } from 'node:crypto';
import { resolveBuildPolicy } from '../lib/build-policy.mjs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname, basename, relative, sep } from 'node:path';
import { runInNewContext } from 'node:vm';
import * as gate from '../lib/verify-lane-gate.mjs';
import * as land from '../pr-land.mjs';
import { shouldRecordGreen, repoSlugFromRemote } from '../lib/lane-verify.mjs';
import { laneGitHardeningEnv, hardenLaneGitArgs } from '../lib/lane-git-hardening.mjs';
import { isAllowlistedLitterPath } from '../lib/lane-litter.mjs';

// Unknown WE_* names enter the digest automatically; only exact exceptions need review.
const producerEnv = () => Object.fromEntries(Object.entries(process.env).filter(([name]) =>
  !name.startsWith('GIT_CONFIG') && !['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_COMMON_DIR'].includes(name)));

// Simulate an unconfigured verifier env without re-enabling the runner's system/global
// filters at the real Git IO boundary. Keep all production hardening pins and local config.
const producerGit = (command, argv, options) => execFileSync(command, argv, { ...options,
  env: { ...options.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });

const source = readFileSync(join(process.cwd(), 'scripts/verify-lane.mjs'), 'utf8');
const sharedPath = join(process.cwd(), 'scripts/lib/verify-shared-marker.mjs');
// On the red run, each guarantee fails explicitly at its missing API, rather than failing test collection.
const store = existsSync(sharedPath) ? await import(sharedPath) : {};
let root, coordRoot, laneA, sha, mergeBase;
const repo = 'example/project';
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024,
  env: laneGitHardeningEnv(process.env), stdio: ['ignore', 'pipe', 'pipe'] }).trim();
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'verify-shared-v2-'));
  coordRoot = join(root, 'coord');
  laneA = join(root, 'lane-A');
  mkdirSync(laneA);
  git(laneA, ['init', '-q', '-b', 'main']);
  git(laneA, ['remote', 'add', 'origin', 'https://github.com/example/project.git']);
  writeFileSync(join(laneA, 'code.txt'), 'committed\n', { mode: 0o644 });
  git(laneA, ['add', '.']);
  git(laneA, ['-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'fixture']);
  sha = git(laneA, ['rev-parse', 'HEAD']);
  mergeBase = sha;
  git(laneA, ['update-ref', 'refs/remotes/origin/main', sha]);
  const sibling = join(root, 'frontierui');
  git(root, ['clone', '-q', laneA, sibling]);
  mkdirSync(join(sibling, 'plugs')); mkdirSync(join(sibling, 'webtheme'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const key = (env, options) => gate.verifyPolicyKey(env ?? {}, { root: laneA, ...options });
const args = (extra = {}) => ({ coordRoot, repo, sha, mergeBase, policyKey: key(), ...extra });
const record = (extra = {}) => ({ v: 1, writer: 'verify-lane', repo, sha, mergeBase, revertRed: null, policyKey: key(), status: 'green', exitCode: 0,
  executedGate: 'npm run test:unit', selectionMode: 'pr', deltaBase: null, finishedAt: new Date().toISOString(), lane: 'lane-A', ...extra });
function publish(extra = {}) { return store.publishGreen({ ...args(), record: record(), ...extra }); }
function rawRecord(value) {
  const file = store.sharedMarkerPath(args());
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 });
  return file;
}
// Exercise the production publish-site function, isolated from verify-lane's top-level CLI/daemon/admission.
function producer(overrides = {}) {
  const start = source.indexOf('function maybePublishSharedGreen(');
  expect(start, 'verify-lane must own the publish site').toBeGreaterThan(-1);
  const end = source.indexOf('// The default gate\'s selected test half', start);
  expect(end).toBeGreaterThan(start);
  const notes = [];
  const resolved = { command: 'npm run test:unit', decision: { mode: 'full', selectionMode: { mode: 'pr' } } };
  const context = { ...store, shouldRecordGreen, repoSlugFromRemote, laneGitHardeningEnv, hardenLaneGitArgs,
    isAllowlistedLitterPath, gateCommandsEqual: gate.gateCommandsEqual, verifyPolicyKey: key,
    VERIFIER_AT_START: { sha, scriptsClean: true }, sharedFullPhaseComplete: true,
    execFileSync: producerGit, basename, join, REPO: laneA, headSha: sha, GATE: resolved.command, resolvedGate: resolved,
    resolveBuildDefaultGate: () => resolved, flags: {}, FORCE_LOCAL: false, admissionFallback: false, revertRed: null,
    sharedTestCounts: [1], phaseResults: [{ phase: 'standards', result: { exitCode: 0 } }],
    resolveCoordinationRoot: () => coordRoot, process: { env: producerEnv(), stderr: { write: s => notes.push(s) } },
    ...overrides };
  runInNewContext(`${source.slice(start, end)}\nmaybePublishSharedGreen({status:'green', treeHash:'stable', revertRed});`, context);
  return notes.join('');
}

it('a green published in lane A opens the PR from lane B at the same sha and policy key', () => {
  const publishNotes = [];
  producer({ process: { env: {}, stderr: { write: s => publishNotes.push(s) } } });
  expect(publishNotes).toEqual([]);
  const laneB = join(root, 'lane-B');
  git(root, ['clone', '-q', laneA, laneB]);
  git(laneB, ['remote', 'set-url', 'origin', 'https://github.com/example/project.git']);
  const logs = [];
  const readMarker = gitDir => land.readFinishGuardMarker({ gitDir, headSha: sha, remote: 'origin', base: 'main',
    runGit: a => git(laneB, a), coordRoot, env: { WE_VERIFY_SHARED_GREEN_REUSE: '1' }, log: s => logs.push(s) });
  const result = land.resolveFinishGuardVerdict({ gitDir: join(laneB, '.git'), headSha: sha, remote: 'origin', base: 'main',
    runGit: a => git(laneB, a), readMarker });
  expect(result).toMatchObject({ ok: true, status: 'green', reason: 'verified' });
  expect(logs.join('\n')).toMatch(/sharedFrom.*lane-A.*\d{4}-/);
});

it.each(['system', 'global'])('producer fixture isolates %s filters while production still refuses them', scope => {
  const config = join(root, 'host.gitconfig');
  writeFileSync(config, '[filter "lfs"]\n\tclean = git-lfs clean -- %f\n');
  const hostOptions = options => ({ ...options, env: { ...options.env, GIT_CONFIG_NOSYSTEM: '0',
    GIT_CONFIG_SYSTEM: scope === 'system' ? config : '/dev/null',
    GIT_CONFIG_GLOBAL: scope === 'global' ? config : '/dev/null' } });
  expect(producer({ execFileSync: (command, argv, options) => execFileSync(command, argv, hostOptions(options)) }))
    .toMatch(/shared.*skip.*git filter configuration/);
  expect(store.readSharedGreen(args({ policyKey: key(producerEnv()) }))).toBeNull();
  expect(producer({ execFileSync: (command, argv, options) => producerGit(command, argv, hostOptions(options)) })).toBe('');
  expect(store.readSharedGreen(args({ policyKey: key(producerEnv()) }))).toMatchObject({ status: 'green' });
});

const policyVariations = {
  WE_BUILD_FINAL_GATE: ['full', 'related'], WE_BUILD_FINAL_GATE_STANDARDS: ['always', 'selected'], WE_DIFF_TEST_SELECTION: ['0', '1'],
  WE_VERIFY_SHARD_MIN_TESTS: ['0', '12'], WE_VERIFY_SHARD_SIZE: ['12', '6'], WE_VERIFY_SHARD_PARALLEL: ['3', '2'],
  WE_VERIFY_RELATED: ['all', 'import-only'], WE_VERIFY_TEST_TIMEOUT_FACTOR: ['1', '3'], WE_VERIFY_STANDARDS: ['always', 'auto'],
  WE_VERIFY_PHASE_ADMISSION: ['0', '1'], WE_VERIFY_FAST_TARGETS: ['5', '6'], WE_VERIFY_MATCH_REQUEST_VARIANTS: ['0', '1'],
  WE_VERIFY_SUPERSEDE: ['newer', 'never'], WE_VERIFY_RESTART_IN_FLIGHT: ['adopt', 'kill'], WE_VERIFY_RUN_ALL_PHASES: ['0', '1'],
  WE_VERIFY_ISOLATED_RETRY: ['untouched', 'off'], WE_VERIFY_RETRY_FAILED: ['0', '1'], WE_VERIFY_RELATED_MAX_TESTS: ['0', '100'],
  WE_VERIFY_RELATED_DEPTH: ['1', '2'], WE_VERIFY_ALWAYS_RUN_TESTS: ['', 'scripts/a.test.mjs'],
  WE_VERIFY_SKIP_LOCAL_FOR_CARD_ONLY: ['0', '1'], WE_VERIFY_REVERT_RED: ['off', 'warn'],
  WE_VERIFY_REVERT_RED_SINCE: ['2026-11-24', '2026-11-25'], WE_VERIFY_REVERT_RED_MAX_FILES: ['40', '41'],
  WE_VERIFY_SELECTION: ['pr', 'since-last-green'], WE_VERIFY_PHASE_TIMEOUT_MS: ['1000', '2000'], WE_VERIFY_SLOT_HEARTBEAT_MS: ['1000', '2000'],
};
it.each(Object.entries(policyVariations))('policy variation %s cannot reuse another policy green', (name, [a, b]) => {
  const first = key({ [name]: a }), second = key({ [name]: b });
  expect(first).not.toBe(second);
  publish({ policyKey: first, record: record({ policyKey: first }) });
  expect(store.readSharedGreen(args({ policyKey: second }))).toBeNull();
});
it('policy key ratchet covers every new WE_* read automatically and exceptions have reasons', () => {
  for (const file of ['verify-lane.mjs', 'lib/verify-lane-gate.mjs', 'lib/verify-settings.mjs', 'lib/build-policy.mjs']) {
    const names = new Set(readFileSync(join(process.cwd(), 'scripts', file), 'utf8').match(/\bWE_[A-Z0-9_]+\b/g) ?? []);
    names.add('WE_NEW_UNREVIEWED_KNOB');
    for (const name of names) {
      if (Object.hasOwn(gate.NON_POLICY_ENV, name)) expect(gate.NON_POLICY_ENV[name].length).toBeGreaterThan(10);
      else expect(gate.policyEnvironmentDigest({ [name]: 'a' }), name).not.toBe(gate.policyEnvironmentDigest({ [name]: 'b' }));
    }
  }
  for (const [name, reason] of Object.entries(gate.NON_POLICY_ENV)) {
    expect(reason.length).toBeGreaterThan(10);
    expect(name).not.toMatch(/[*^$]/);
    expect(gate.policyEnvironmentDigest({ [name]: 'a' })).toBe(gate.policyEnvironmentDigest({ [name]: 'b' }));
  }
});
it('policy environment digest sorts insertion order and distinguishes raw values and absence', () => {
  expect(key({ WE_DIFF_TEST_SELECTION: '0', WE_VERIFY_RETRY_FAILED: '1' }))
    .toBe(key({ WE_VERIFY_RETRY_FAILED: '1', WE_DIFF_TEST_SELECTION: '0' }));
  expect(key({})).not.toBe(key({ WE_DIFF_TEST_SELECTION: '1' }));
  expect(key({ WE_DIFF_TEST_SELECTION: ' 0 ' })).not.toBe(key({ WE_DIFF_TEST_SELECTION: '1' }));
});
it.each(['variant-matched', 'requester-stamped', 'explicit', 'local'])('executed-plan %s run does not publish', kind => {
  const notes = producer({ ...(kind === 'explicit' ? { flags: { gate: 'npm run test:unit' } } : {}),
    ...(kind === 'local' ? { FORCE_LOCAL: true } : {}),
    ...(['variant-matched', 'requester-stamped'].includes(kind) ? { resolveBuildDefaultGate: () => ({ command: 'different env plan' }) } : {}) });
  expect(store.readSharedGreen(args({ policyKey: key(producerEnv()) }))).toBeNull();
  expect(notes).toMatch(/shared.*skip/i);
});
it.each(['dirty tree', 'assume-unchanged', 'skip-worktree', 'chmod with core.fileMode=false'])('commit check refuses %s', kind => {
  if (kind === 'dirty tree') writeFileSync(join(laneA, 'code.txt'), 'dirty\n');
  if (kind === 'assume-unchanged') git(laneA, ['update-index', '--assume-unchanged', 'code.txt']);
  if (kind === 'skip-worktree') git(laneA, ['update-index', '--skip-worktree', 'code.txt']);
  if (kind.startsWith('chmod')) { git(laneA, ['config', 'core.fileMode', 'false']); chmodSync(join(laneA, 'code.txt'), 0o755); }
  expect(producer()).toMatch(/shared.*skip/i);
  expect(store.readSharedGreen(args({ policyKey: key(producerEnv()) }))).toBeNull();
});
it('commit check permits only untracked allowlisted lane litter and uses hardened bounded git', () => {
  writeFileSync(join(laneA, '.pr-body.md'), 'litter');
  const calls = [];
  expect(producer({ execFileSync: (command, argv, options) => { calls.push({ argv, options }); return producerGit(command, argv, options); } })).toBe('');
  expect(store.readSharedGreen(args({ policyKey: key(producerEnv()) }))).toMatchObject({ status: 'green' });
  for (const { options } of calls) {
    expect(options.maxBuffer).toBeGreaterThan(0);
    expect(options.env.GIT_CONFIG_COUNT).toBe(laneGitHardeningEnv(producerEnv()).GIT_CONFIG_COUNT);
  }
  expect(calls.some(c => c.argv.includes('core.fileMode=true'))).toBe(true);
  expect(calls.some(c => c.argv.includes('ls-files'))).toBe(true);
});
it('oversized git evidence skips publication and names re-verification as the fallback', () => {
  const notes = producer({ execFileSync: (_command, _argv, options) => execFileSync(process.execPath,
    ['-e', `process.stdout.write('x'.repeat(${options.maxBuffer + 1}))`], options) });
  expect(notes).toMatch(/shared.*skip.*checks failed.*re-verify/);
  expect(store.readSharedGreen(args({ policyKey: key(producerEnv()) }))).toBeNull();
});
it('since-last-green never publishes even with a full gate and valid shared delta base', () => {
  publish({ policyKey: key(producerEnv()), record: record({ policyKey: key(producerEnv()) }) });
  const deltaBase = sha;
  git(laneA, ['-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-qm', 'delta']);
  sha = git(laneA, ['rev-parse', 'HEAD']);
  const resolved = { command: 'npm run test:unit', decision: { mode: 'full', selectionMode: { mode: 'since-last-green', base: deltaBase } } };
  expect(producer({ resolvedGate: resolved, resolveBuildDefaultGate: () => resolved })).toMatch(/shared.*skip/);
  expect(store.readSharedGreen(args({ policyKey: key(producerEnv()) }))).toBeNull();
});
it('write-once EEXIST leaves the original bytes identical', () => {
  expect(publish()).toBe(true);
  const file = store.sharedMarkerPath(args()), bytes = readFileSync(file);
  expect(publish({ record: record({ lane: 'lane-B', finishedAt: new Date(Date.now() - 1000).toISOString() }) })).toBe(true);
  expect(readFileSync(file)).toEqual(bytes);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(readdirSync(dirname(file))).toEqual([basename(file)]);
});
it('a killed writer temp is ignored and cannot open the guard', () => {
  const file = store.sharedMarkerPath(args());
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  expect(() => execFileSync(process.execPath, ['-e', "require('node:fs').writeFileSync(process.argv[1], '{torn', {mode:0o600}); process.kill(process.pid, 'SIGKILL')", `${file}.killed.tmp`],
    { maxBuffer: 1024, stdio: 'ignore' })).toThrow();
  expect(existsSync(`${file}.killed.tmp`)).toBe(true);
  expect(store.readSharedGreen(args())).toBeNull();
  expect(land.resolveFinishGuardVerdict({ gitDir: join(laneA, '.git'), headSha: sha, remote: 'origin', base: 'main',
    runGit: a => git(laneA, a), readMarker: () => store.readSharedGreen(args()) }).ok).toBe(false);
});

const schemaMutations = [
  ...['v', 'writer', 'repo', 'sha', 'mergeBase', 'revertRed', 'policyKey', 'status', 'exitCode', 'executedGate', 'selectionMode', 'deltaBase', 'finishedAt', 'lane']
    .map(field => [`missing ${field}`, r => { delete r[field]; }]),
  ...Object.entries({ v: 2, writer: 'other', repo: 'other/repo', sha: 'f'.repeat(40), mergeBase: 'f'.repeat(40), revertRed: { mode: 'warn', status: 'flagged' }, policyKey: 'f'.repeat(64), status: 'red',
    exitCode: 1, executedGate: '', selectionMode: 'unknown', deltaBase: 'f'.repeat(40), finishedAt: 'invalid', lane: null })
    .map(([field, value]) => [`invalid ${field}`, r => { r[field] = value; }]),
  ['future finishedAt', r => { r.finishedAt = new Date(Date.now() + 301_000).toISOString(); }],
  ['non-string finishedAt', r => { r.finishedAt = 1234; }],
  ['whitespace executedGate', r => { r.executedGate = '  '; }],
  ['delta without base', r => { r.selectionMode = 'since-last-green'; }],
  ['delta with malformed base', r => { r.selectionMode = 'since-last-green'; r.deltaBase = 'bad'; }],
  ['malformed mergeBase', r => { r.mergeBase = 'bad'; }],
  ['revertRed extra field', r => { r.revertRed = { mode: 'warn', status: 'clean', extra: true }; }],
  ['revertRed missing mode', r => { r.revertRed = { status: 'clean' }; }],
  ['revertRed invalid mode', r => { r.revertRed = { mode: 'unknown', status: 'clean' }; }],
  ['revertRed non-object', r => { r.revertRed = []; }],
  ['extra key', r => { r.extra = true; }],
];
it.each(schemaMutations)('strict schema refuses %s', (_, mutate) => {
  const value = record(); mutate(value); rawRecord(value);
  expect(store.readSharedGreen(args())).toEqual({ corrupt: true });
});
it.each(['symlinked leaf', 'symlinked directory', 'group-readable file', 'group-readable directory', 'foreign uid', 'bad JSON'])
  ('store integrity refuses %s and the gate refuses', kind => {
    const file = rawRecord(record());
    let readArgs = args();
    if (kind === 'symlinked leaf') { const other = join(root, 'other.json'); writeFileSync(other, readFileSync(file), { mode: 0o600 }); rmSync(file); symlinkSync(other, file); }
    if (kind === 'symlinked directory') { const target = join(root, 'outside'); mkdirSync(target, { mode: 0o700 }); rmSync(dirname(file), { recursive: true }); symlinkSync(target, dirname(file)); }
    if (kind === 'group-readable file') chmodSync(file, 0o640);
    if (kind === 'group-readable directory') chmodSync(dirname(file), 0o750);
    if (kind === 'foreign uid') readArgs = args({ uid: process.getuid() + 1 });
    if (kind === 'bad JSON') writeFileSync(file, '{bad');
    const marker = store.readSharedGreen(readArgs);
    expect(marker).toEqual({ corrupt: true });
    expect(land.resolveFinishGuardVerdict({ gitDir: join(laneA, '.git'), headSha: sha, remote: 'origin', base: 'main',
      runGit: a => git(laneA, a), readMarker: () => store.resolveMarkerWithShared({ local: null, shared: marker, headSha: sha }) }).ok).toBe(false);
  });
it.each(['red', 'running', 'green'])('precedence preserves local %s at head over shared green', status => {
  const local = { sha, status }, shared = { sha, status: 'green', sharedFrom: { lane: 'other' } };
  expect(store.resolveMarkerWithShared({ local, shared, headSha: sha })).toBe(local);
});
it('precedence lets exact shared head beat stale local green', () => {
  const status = 'green';
  const local = { sha: 'f'.repeat(40), status }, shared = { sha, status: 'green' };
  expect(store.resolveMarkerWithShared({ local, shared, headSha: sha })).toBe(shared);
});
it('precedence refuses corrupt local and shared evidence; accepts exact shared over stale local; never carries shared forward', () => {
  const shared = { sha, status: 'green' }, corrupt = { corrupt: true }, stale = { sha: 'f'.repeat(40), status: 'green' };
  expect(store.resolveMarkerWithShared({ local: corrupt, shared, headSha: sha })).toBe(corrupt);
  expect(store.resolveMarkerWithShared({ local: null, shared: corrupt, headSha: sha })).toEqual(corrupt);
  expect(store.resolveMarkerWithShared({ local: stale, shared, headSha: sha })).toBe(shared);
  expect(store.resolveMarkerWithShared({ local: null, shared: stale, headSha: sha })).toBeNull();
  expect(store.resolveMarkerWithShared({ local: stale, shared: null, headSha: sha })).toBe(stale);
});
it('ciOnly remains unchanged and never substitutes for a shared green', () => {
  publish();
  const ciOnly = { ok: true, status: 'ci-only' };
  const result = land.resolveFinishGuardVerdict({ gitDir: join(laneA, '.git'), headSha: sha, remote: 'origin', base: 'main',
    runGit: a => git(laneA, a), readMarker: () => store.readSharedGreen(args()), ciOnly });
  expect(result).toMatchObject({ ok: true, status: 'green' });
  expect(result).not.toBe(ciOnly);
});


it.each(['finalGate', 'finalGateStandards'])('policy provenance refuses reuse for the same %s value from env', field => {
  const envKey = field === 'finalGate' ? 'WE_BUILD_FINAL_GATE' : 'WE_BUILD_FINAL_GATE_STANDARDS';
  const defaults = resolveBuildPolicy({ env: {} });
  const env = { [envKey]: defaults[field] };
  expect(gate.verifyPolicyInputs({}).sources?.[field]).toBe(defaults.sources[field]);
  expect(gate.verifyPolicyInputs(env).sources?.[field]).toBe('env');
  expect(key(env)).not.toBe(key({}));
  publish();
  expect(store.readSharedGreen(args({ policyKey: key(env) }))).toBeNull();
});
// Exercise the actual policy functions in fresh process-like contexts, with only filesystem IO injected.
// This also checks that verifier paths derive from the module URL, independently of the target checkout.
const policySource = readFileSync(join(process.cwd(), 'scripts/lib/verify-lane-gate.mjs'), 'utf8');
const policyStart = policySource.indexOf('const TOOLING_ROOT');
const policyEnd = policySource.indexOf('/**\n * PR 7008', policyStart);
function policyProcess({ runGit = (args, cwd) => git(cwd, args), buildPolicy = resolveBuildPolicy, initialize = true } = {}) {
  expect(policyStart).toBeGreaterThan(-1);
  expect(policyEnd).toBeGreaterThan(policyStart);
  const functions = policySource.slice(policyStart, policyEnd).replace(/\bexport /g, '').replaceAll('import.meta.url', 'moduleUrl');
  return runInNewContext(`${functions}\n${initialize ? 'initializeVerifierIdentity();' : ''}\n({verifyPolicyInputs, verifyPolicyKey, initializeVerifierIdentity});`, {
    moduleUrl: pathToFileURL(join(process.cwd(), 'scripts/lib/verify-lane-gate.mjs')).href,
    fileURLToPath, dirname, join, relative, sep, createHash, laneGitHardeningEnv, hardenLaneGitArgs, resolveBuildPolicy: buildPolicy,
    SIBLING_PATHS: { plugs: '../frontierui/plugs', webtheme: '../frontierui/webtheme' },
    execFileSync: (_command, args, options) => runGit(args, options.cwd),
    defaultFileConfig: loadVerifySettingsFile(), resolveVerifySettings, SELECTION_FLAG: 'WE_DIFF_TEST_SELECTION',
    process: { env: {} },
  });
}
it('standard-sourced full cannot reuse env-sourced full even with identical effective gate values', () => {
  const isolated = policyProcess({ buildPolicy: ({ env }) => resolveBuildPolicy({ env, tool: {}, platform: {} }) });
  const env = { WE_BUILD_FINAL_GATE: 'full', WE_BUILD_FINAL_GATE_STANDARDS: 'always' };
  expect(isolated.verifyPolicyInputs({})).toMatchObject({ finalGate: 'full', finalGateStandards: 'always',
    sources: { finalGate: 'standard', finalGateStandards: 'standard' } });
  expect(isolated.verifyPolicyInputs(env)).toMatchObject({ finalGate: 'full', finalGateStandards: 'always',
    sources: { finalGate: 'env', finalGateStandards: 'env' } });
  expect(isolated.verifyPolicyKey({})).not.toBe(isolated.verifyPolicyKey(env));
});
it('policy helper initialization defers Git until explicitly requested, then freezes identity', () => {
  let calls = 0;
  const isolated = policyProcess({ initialize: false, runGit: args => {
    calls += 1;
    return args.includes('rev-parse') ? 'a'.repeat(40) : '';
  } });
  expect(calls).toBe(0);
  const identity = isolated.initializeVerifierIdentity();
  expect(identity).toEqual({ sha: 'a'.repeat(40), scriptsClean: true });
  const capturedCalls = calls;
  expect(capturedCalls).toBeGreaterThan(0);
  expect(isolated.initializeVerifierIdentity()).toBe(identity);
  expect(calls).toBe(capturedCalls);
  expect(Object.isFrozen(identity)).toBe(true);
});
it('entry points freeze verifier identity before repository work and after pr-land validation', () => {
  const producerCapture = source.indexOf('const VERIFIER_AT_START = initializeVerifierIdentity();');
  expect(producerCapture).toBeGreaterThan(-1);
  expect(producerCapture).toBeGreaterThan(source.indexOf('  process.exit(0);'));
  expect(producerCapture).toBeLessThan(source.indexOf('for (const a of process.argv.slice(2))'));
  const landSource = readFileSync(join(process.cwd(), 'scripts/pr-land.mjs'), 'utf8');
  const capture = landSource.indexOf('  initializeVerifierIdentity();');
  expect(capture).toBeGreaterThan(landSource.indexOf("reason: 'bad-delegation'"));
  expect(capture).toBeLessThan(landSource.indexOf("const refSha = tryGit(['rev-parse', SRC])"));
});
it('F7 tooling identity is startup HEAD plus scripts cleanliness, independent of later changes', () => {
  let dirty = false, toolingHead = 'a'.repeat(40);
  const runGit = args => args.includes('rev-parse') ? toolingHead : args.includes('status') && dirty ? ' M scripts/other.mjs' : '';
  const first = policyProcess({ runGit });
  const firstKey = first.verifyPolicyKey({}, { aliasInputs: [] });
  expect(first.verifyPolicyInputs({}).verifier).toEqual({ sha: toolingHead, scriptsClean: true });
  dirty = true; toolingHead = 'b'.repeat(40);
  expect(first.verifyPolicyKey({}, { aliasInputs: [] })).toBe(firstKey);
  const second = policyProcess({ runGit });
  expect(second.verifyPolicyInputs({}).verifier).toEqual({ sha: toolingHead, scriptsClean: false });
  expect(second.verifyPolicyKey({}, { aliasInputs: [] })).not.toBe(firstKey);
  dirty = false;
  expect(second.verifyPolicyInputs({}).verifier.scriptsClean).toBe(false);
});
it('F7 unreadable startup tooling cannot produce a reusable key', () => {
  const isolated = policyProcess({ runGit: () => { throw new Error('unreadable'); } });
  expect(isolated.verifyPolicyKey({}, { aliasInputs: [] })).toBeNull();
});
it('base binding refuses reuse for another merge base and validates caller input', () => {
  expect(publish()).toBe(true);
  expect(store.sharedMarkerPath(args())).toBe(join(coordRoot, 'verify-shared', 'example__project', sha, mergeBase, `${key()}.json`));
  expect(store.readSharedGreen(args({ mergeBase: 'e'.repeat(40) }))).toBeNull();
  expect(store.readSharedGreen(args({ mergeBase: 'bad' }))).toEqual({ corrupt: true });
  expect(store.sharedMarkerPath(args({ mergeBase: 'bad' }))).toBeNull();
  for (let dir = dirname(store.sharedMarkerPath(args())); dir !== coordRoot; dir = dirname(dir)) {
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  }
});
it('producer refuses publication when merge-base cannot be computed', () => {
  git(laneA, ['update-ref', '-d', 'refs/remotes/origin/main']);
  expect(producer()).toMatch(/shared.*skip.*re-verify/);
  expect(store.readSharedGreen(args({ policyKey: key(producerEnv()) }))).toBeNull();
});
it.each(['red', 'running', 'unknown', undefined])('precedence refuses stale local non-green %s despite exact shared green', status => {
  const local = { sha: 'e'.repeat(40), status }, shared = { sha, status: 'green' };
  expect(store.resolveMarkerWithShared({ local, shared, headSha: sha })).toBe(local);
});
it.each(['warn', 'enforce'].flatMap(mode => ['skipped', 'unproven', 'flagged'].map(status => [mode, status])))
  ('revert-red %s/%s refuses shared publication', (mode, status) => {
    expect(producer({ revertRed: { mode, status } })).toMatch(/shared.*skip.*re-verify/);
    expect(store.readSharedGreen(args({ policyKey: key(producerEnv()) }))).toBeNull();
  });
it.each([null, { mode: 'off', status: 'skipped' }, { mode: 'warn', status: 'clean' }, { mode: 'enforce', status: 'clean' }])
  ('producer records only clean or absent revert-red evidence %j', revertRed => {
    expect(producer({ revertRed })).toBe('');
    const file = store.sharedMarkerPath(args({ policyKey: key(producerEnv()) }));
    expect(JSON.parse(readFileSync(file, 'utf8')).revertRed).toEqual(revertRed?.mode === 'off' ? null : revertRed);
    expect(store.readSharedGreen(args({ policyKey: key(producerEnv()) }))).toMatchObject({ status: 'green' });
  });
it.each([
  ['card-only echo', 'echo card-only skip'],
  ['no-suite echo with standards', 'echo no tests && npm run check:standards'],
  ['empty selection', 'npx vitest run --passWithNoTests'],
  ['empty selection with standards', 'npx vitest related --run --passWithNoTests && npm run check:standards'],
  ['no test invocation', 'node scripts/other-check.mjs'],
  ['test name without invocation', 'node scripts/vitest-report.mjs'],
])('zero tests refuses publication for %s', (_kind, command) => {
  const resolved = { command, decision: { selectionMode: { mode: 'pr' }, selection: { tests: [] } } };
  expect(producer({ GATE: command, resolvedGate: resolved, resolveBuildDefaultGate: () => resolved })).toMatch(/shared.*skip.*re-verify/);
  expect(store.readSharedGreen(args({ policyKey: key(producerEnv()) }))).toBeNull();
});
it('a filename with passWithNoTests never proves executed tests', () => {
  const command = 'npx vitest run scripts/example.test.mjs --passWithNoTests';
  const resolved = { command, decision: { selectionMode: { mode: 'pr' }, selection: { tests: ['scripts/example.test.mjs'] } } };
  expect(producer({ GATE: command, resolvedGate: resolved, resolveBuildDefaultGate: () => resolved })).toMatch(/shared.*skip.*re-verify/);
  expect(store.readSharedGreen(args({ policyKey: key(producerEnv()) }))).toBeNull();
});

it('HEAD moved by a commit after capture refuses publication even with a clean tree', () => {
  git(laneA, ['-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-qm', 'moved after capture']);
  expect(git(laneA, ['status', '--porcelain'])).toBe('');
  expect(producer()).toMatch(/shared.*skip.*HEAD.*re-verify/);
  expect(store.readSharedGreen(args({ policyKey: key(producerEnv()) }))).toBeNull();
});
it.each(['NODE_OPTIONS', 'NODE_ENV', 'WE_TEST_SANDBOX'])('runtime policy %s cannot reuse a different value or unset green', name => {
  expect(key({ [name]: 'a' })).not.toBe(key({ [name]: 'b' }));
  expect(key({ [name]: '' })).not.toBe(key({}));
  expect(gate.verifyPolicyInputs({}).environmentDigest).not.toBe(gate.verifyPolicyInputs({ [name]: 'a' }).environmentDigest);
});
it.each([
  ['zero executed', [0]], ['unknown runner count', [null]], ['one unreported phase', [1, null]],
  ['no runner reports', []], ['negative runner count', [-1]],
])('%s refuses publication despite a test command', (_name, sharedTestCounts) => {
  expect(producer({ sharedTestCounts })).toMatch(/shared.*skip.*runner.*re-verify/);
  expect(store.readSharedGreen(args({ policyKey: key(producerEnv()) }))).toBeNull();
});
it('standards-only gate never publishes', () => {
  const resolved = { command: 'npm run check:standards', decision: { mode: 'full', selectionMode: { mode: 'pr' } } };
  expect(producer({ GATE: resolved.command, resolvedGate: resolved, resolveBuildDefaultGate: () => resolved, sharedTestCounts: [] })).toMatch(/shared.*skip/);
  expect(store.readSharedGreen(args({ policyKey: key(producerEnv()) }))).toBeNull();
});
it.each([[[]], [[{ phase: 'standards', result: { exitCode: 1 } }]]])('tests without a passed standards phase never publish %j', phaseResults => {
  expect(producer({ phaseResults })).toMatch(/shared.*skip.*standards.*re-verify/);
  expect(store.readSharedGreen(args({ policyKey: key(producerEnv()) }))).toBeNull();
});
const completeSelection = { status: 'complete', tests: ['scripts/a.test.mjs'], selectedTestCount: 1, fullTestCount: 1, droppedCount: 0 };
it.each([
  ['capped-fallback', { ...completeSelection, status: 'capped-fallback' }],
  ['graph-error fallback', { ...completeSelection, status: 'graph-error' }],
  ['truncated selection', { ...completeSelection, status: 'selection-truncated' }],
  ['null coverage', { ...completeSelection, fullTestCount: null }],
  ['unknown coverage', { ...completeSelection, fullTestCount: undefined }],
  ['missing selection', null], ['forced fallback', { ...completeSelection, forceFallback: true }],
])('incomplete selection %s never publishes', (_name, selection) => {
  const resolved = { command: 'npx vitest run scripts/a.test.mjs', decision: { mode: 'shrink', selectionMode: { mode: 'pr' }, selection } };
  expect(producer({ GATE: resolved.command, resolvedGate: resolved, resolveBuildDefaultGate: () => resolved })).toMatch(/shared.*skip.*selection.*re-verify/);
  expect(store.readSharedGreen(args({ policyKey: key(producerEnv()) }))).toBeNull();
});
it('decision forceFallback never publishes even with a complete selection', () => {
  const resolved = { command: 'npx vitest run scripts/a.test.mjs', decision: { mode: 'shrink', forceFallback: true, selectionMode: { mode: 'pr' }, selection: completeSelection } };
  expect(producer({ GATE: resolved.command, resolvedGate: resolved, resolveBuildDefaultGate: () => resolved })).toMatch(/shared.*skip.*selection.*re-verify/);
  expect(store.readSharedGreen(args({ policyKey: key(producerEnv()) }))).toBeNull();
});
it('complete related selection with runner counts and standards still refuses publication', () => {
  const resolved = { command: 'npx vitest run scripts/a.test.mjs', decision: { mode: 'shrink', selectionMode: { mode: 'pr' }, selection: completeSelection } };
  producer({ GATE: resolved.command, resolvedGate: resolved, resolveBuildDefaultGate: () => resolved, sharedTestCounts: [0, 2, 3] });
  expect(store.readSharedGreen(args({ policyKey: key(producerEnv()) }))).toBeNull();
});
const runnerReport = extra => JSON.stringify({ numTotalTests: 6, numPendingTests: 2, numTodoTests: 1, numPassedTests: 2, numFailedTests: 1, ...extra });
it('runner count excludes skipped and todo and includes passed plus failed', () => {
  expect(typeof store.executedTestCount).toBe('function');
  expect(store.executedTestCount(runnerReport())).toBe(3);
});
it.each([null, '{bad', '{}', runnerReport({ numTotalTests: 0 }), runnerReport({ numTotalTests: '6' }), runnerReport({ numPendingTests: -1 }), runnerReport({ numFailedTests: 0 })])
  ('unreadable or inconsistent runner report fails closed %j', reportText => {
    expect(typeof store.executedTestCount).toBe('function');
    expect(store.executedTestCount(reportText)).toBeNull();
  });
it('skipped-only runner report proves zero execution', () => {
  expect(typeof store.executedTestCount).toBe('function');
  expect(store.executedTestCount(runnerReport({ numTotalTests: 3, numPassedTests: 0, numFailedTests: 0 }))).toBe(0);
});

it('skipped assertions cannot borrow the older Vitest inflated passed counter', () => {
  expect(typeof store.executedTestCount).toBe('function');
  const report = { numTotalTests: 2, numPendingTests: 0, numTodoTests: 1, numPassedTests: 2, numFailedTests: 0,
    testResults: [{ assertionResults: [{ status: 'skipped' }, { status: 'todo' }] }] };
  expect(store.executedTestCount(JSON.stringify(report))).toBe(0);
});
function countedRunner(run, { maxBytes = 1024 * 1024, listing, listingError = false } = {}) {
  const start = source.indexOf('async function runCountedTestGate(');
  expect(start, 'test phases must collect their own runner reports').toBeGreaterThan(-1);
  const end = source.indexOf('// Retry commands use direct test-file filters', start);
  expect(end).toBeGreaterThan(start);
  const sharedTestCounts = [];
  const runner = runInNewContext(`${source.slice(start, end).replaceAll('import.meta.url', 'moduleUrl')}\n({runCountedTestGate, complete: () => sharedFullPhaseComplete});`, {
    sharedTestCounts, sharedFullPhaseComplete: false, REPO: laneA, checkoutHasRetryableTestUnit: () => true,
    moduleUrl: pathToFileURL(join(process.cwd(), 'scripts/verify-lane.mjs')).href, fileURLToPath, URL, realpathSync, fullPhaseInventory: store.fullPhaseInventory,
    execFileSync: (_command, argv, options) => {
      expect(JSON.parse(argv[1])).toEqual({ options: {}, filters: [] });
      expect(options.timeout).toBe(60_000); expect(options.maxBuffer).toBe(maxBytes);
      if (listingError) throw new Error('enumeration failed');
      return JSON.stringify(listing ?? [join(realpathSync(laneA), 'a.test.mjs'), join(realpathSync(laneA), 'b.test.mjs')]);
    },
    process: { env: {} }, timedRunGate: run, mkdtempSync, join, tmpdir, rmSync, readFileSync,
    nodeFs: { statSync }, MAX_TIMEOUT_LOG_BYTES: maxBytes, shellQuote: gate.shellQuote, executedTestCount: store.executedTestCount,
  });
  return { runCounted: runner.runCountedTestGate, sharedTestCounts, fullComplete: runner.complete };
}
it('selected shell, scan and retry phases preserve their commands for admission', async () => {
  const calls = [];
  const runner = countedRunner(async (_phase, command, argv) => {
    calls.push({ command, argv });
    return { exitCode: 0 };
  });
  const selected = 'npx vitest run scripts/a.test.mjs --testTimeout=15000';
  const scan = "VERIFY_SCAN_FILES='[\"source.mjs\"]' npx vitest run scripts/scan.test.mjs";
  const retry = ['vitest', 'run', '--maxWorkers=1', './scripts/a.test.mjs'];
  await runner.runCounted('vitestMs', selected);
  await runner.runCounted('scanMs', scan);
  await runner.runCounted('vitestMs', 'npx', retry);
  expect(calls).toEqual([{ command: selected, argv: undefined }, { command: scan, argv: undefined }, { command: 'npx', argv: retry }]);
  expect(runner.sharedTestCounts).toEqual([null, null, null]);
  expect(runner.fullComplete()).toBe(false);
});
it('counted full runner reads JSON from direct shell and argv test phases and sums execution', async () => {
  let index = 0;
  const runner = countedRunner(async (_phase, command, argv) => {
    const file = argv ? argv.find(a => a.startsWith('--outputFile.json=')).slice('--outputFile.json='.length)
      : command.match(/--outputFile.json='([^']+)'/)[1];
    writeFileSync(file, index++ ? runnerReport({ numTotalTests: 3, numPassedTests: 0, numFailedTests: 0 }) : runnerReport());
    return { exitCode: 0 };
  });
  await runner.runCounted('vitestMs', 'npx vitest run scripts/a.test.mjs', undefined, { fullPhase: true });
  await runner.runCounted('vitestMs', 'npx', ['vitest', 'run', 'scripts/b.test.mjs'], { fullPhase: true });
  expect(runner.sharedTestCounts).toEqual([3, 0]);
});
it.each(['missing', 'oversized', 'sharded', 'opaque npm'])('counted runner fails closed for %s execution evidence', async kind => {
  const runner = countedRunner(async (_phase, command) => {
    if (kind === 'oversized') writeFileSync(command.match(/--outputFile.json='([^']+)'/)[1], 'x'.repeat(513));
    return { exitCode: 0 };
  }, { maxBytes: 512 });
  await runner.runCounted('vitestMs', kind === 'sharded' ? 'node scripts/lib/verify-shard-run.mjs -- npx vitest run'
    : kind === 'opaque npm' ? 'npm run test:unit' : 'npx vitest run', undefined, { fullPhase: kind !== 'opaque npm' });
  expect(runner.sharedTestCounts).toEqual([null]);
});
it('counted runner reuses the always-run guard report without replacing its output path', async () => {
  const reportFile = join(root, 'guards.json');
  const runner = countedRunner(async (_phase, command) => {
    expect(command).toBe('npx vitest run scripts/guard.test.mjs --reporter=json');
    writeFileSync(reportFile, runnerReport());
    return { exitCode: 0 };
  });
  await runner.runCounted('scanMs', 'npx vitest run scripts/guard.test.mjs --reporter=json', undefined, { reportFile });
  expect(runner.sharedTestCounts).toEqual([3]);
});
it('every test phase uses counted execution while standards use their own outcome', () => {
  const calls = [...source.matchAll(/await timedRunGate\(([^\n]+)/g)].map(m => m[1]);
  expect(calls).toHaveLength(2); // the counted wrapper itself, and the standards half
  expect(calls.some(c => c.includes("'standardsMs'"))).toBe(true);
});

// Final-round ruling: each closed path must fail independently of command text.
it.each(['WE_NEW_UNREVIEWED_KNOB', 'GIT_UNKNOWN', 'NODE_EXTRA_CA_CERTS', 'VITEST_POOL_ID', 'npm_config_ignore_scripts'])
  ('F1 unknown policy environment %s is covered automatically', name => {
    expect(key({ [name]: 'a' })).not.toBe(key({ [name]: 'b' }));
    expect(key({ [name]: '' })).not.toBe(key({}));
  });
it.each(['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_COMMON_DIR', 'GIT_CONFIG', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_NEW'])
  ('F2 inherited %s refuses publication even when empty', name => {
    const logs = [];
    producer({ process: { env: { [name]: '' }, stderr: { write: text => logs.push(text) } } });
    expect(logs.join('')).toMatch(/shared.*skip.*inherited git/);
    expect(store.readSharedGreen(args({ policyKey: key({ [name]: '' }) }))).toBeNull();
  });
it.each(['configured filter', 'attribute filter'])('F3 %s refuses a clean committed tree', kind => {
  if (kind === 'configured filter') git(laneA, ['config', 'filter.evil.clean', 'cat']);
  else {
    writeFileSync(join(laneA, '.gitattributes'), '*.txt filter=unknown\n');
    git(laneA, ['add', '.gitattributes']);
    git(laneA, ['-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'attributes']);
    sha = git(laneA, ['rev-parse', 'HEAD']);
  }
  producer();
  expect(store.readSharedGreen(args({ policyKey: key(producerEnv()) }))).toBeNull();
});
it('F4 unreadable or dirty alias input makes the key unavailable', () => {
  expect(typeof gate.aliasPolicyInputs).toBe('function');
  const options = { root: laneA, aliasPaths: ['../missing'], runGit: (argv, cwd) => git(cwd, argv) };
  expect(gate.aliasPolicyInputs(options)).toBeNull();
  options.aliasPaths = ['../frontierui/plugs'];
  expect(gate.aliasPolicyInputs(options)).toEqual([{ path: '../frontierui/plugs', sha }]);
  writeFileSync(join(root, 'frontierui', 'code.txt'), 'dirty');
  expect(gate.aliasPolicyInputs(options)).toBeNull();
  expect(key({}, { aliasInputs: null })).toBeNull();
});
it.each(['related', 'selected', 'pr', 'since-last-green', 'capped-fallback', 'shrink'])
  ('F5 complete %s selection cannot publish', mode => {
    const resolved = { command: 'npm run test:unit', decision: { mode, selection: completeSelection, selectionMode: { mode: 'pr' } } };
    producer({ resolvedGate: resolved, resolveBuildDefaultGate: () => resolved });
    expect(store.readSharedGreen(args({ policyKey: key(producerEnv()) }))).toBeNull();
  });
it.each(['missing full report', 'guards only', 'missing file', 'zero executed file'])
  ('F6 %s cannot borrow phase counts for publication', kind => {
    producer({ sharedFullPhaseComplete: false, sharedTestCounts: [10] });
    expect(store.readSharedGreen(args({ policyKey: key(producerEnv()) }))).toBeNull();
  });
it('F7 dirty scripts at process start cannot publish even if later clean', () => {
  producer({ VERIFIER_AT_START: { sha: 'a'.repeat(40), scriptsClean: false } });
  expect(store.readSharedGreen(args({ policyKey: key(producerEnv()) }))).toBeNull();
});

it.each(['missing file', 'skipped-only file', 'todo-only file', 'missing inventory', 'malformed report'])
  ('F6 full-phase inventory refuses %s despite executed guards', kind => {
    const files = [join(laneA, 'a.test.mjs'), join(laneA, 'b.test.mjs')];
    const report = { numTotalTests: 2, numPendingTests: 0, numTodoTests: 0, numPassedTests: 2, numFailedTests: 0,
      testResults: files.map(name => ({ name, assertionResults: [{ status: 'passed' }] })) };
    if (kind === 'missing file') { report.testResults.pop(); report.numTotalTests = report.numPassedTests = 1; }
    if (kind === 'skipped-only file') report.testResults[1].assertionResults[0].status = 'skipped';
    if (kind === 'todo-only file') { report.testResults[1].assertionResults[0].status = 'todo'; report.numTodoTests = 1; }
    expect(store.fullPhaseInventory({ reportText: kind === 'malformed report' ? '{bad' : JSON.stringify(report),
      files: kind === 'missing inventory' ? null : files, cwd: laneA })).toBe(false);
  });
it('F6 full-phase inventory counts failed assertions as executed and refuses summary-only reports', () => {
  const files = [join(laneA, 'a.test.mjs'), join(laneA, 'b.test.mjs')];
  const report = { numTotalTests: 2, numPendingTests: 0, numTodoTests: 0, numPassedTests: 1, numFailedTests: 1,
    testResults: files.map((name, i) => ({ name, assertionResults: [{ status: i ? 'failed' : 'passed' }] })) };
  expect(store.fullPhaseInventory({ reportText: JSON.stringify(report), files, cwd: laneA })).toBe(true);
  delete report.testResults;
  expect(store.fullPhaseInventory({ reportText: JSON.stringify(report), files, cwd: laneA })).toBe(false);
});
it('F4 alias roots and sibling HEAD both bind the key and a dirty sibling refuses producer publication', () => {
  const first = key({});
  git(join(root, 'frontierui'), ['-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-qm', 'sibling moved']);
  expect(key({})).not.toBe(first);
  expect(key({}, { aliasInputs: [{ path: '../elsewhere', sha }] })).not.toBe(key({}, { aliasInputs: [{ path: '../frontierui', sha }] }));
  writeFileSync(join(root, 'frontierui', 'code.txt'), 'dirty');
  expect(key({})).toBeNull();
  expect(producer()).toMatch(/shared.*skip.*alias.*re-verify/);
});

it.each(['missing file', 'skipped file', 'absent full report', 'unreadable enumeration', 'oversized enumeration', 'empty enumeration'])
  ('F6 counted full phase refuses %s and later guard reports cannot repair its proof', async kind => {
    const files = [join(realpathSync(laneA), 'a.test.mjs'), join(realpathSync(laneA), 'b.test.mjs')];
    const report = { numTotalTests: 2, numPendingTests: 0, numTodoTests: 0, numPassedTests: 2, numFailedTests: 0,
      testResults: files.map(name => ({ name, assertionResults: [{ status: 'passed' }] })) };
    const runner = countedRunner(async (phase, command) => {
      const path = command.match(/--outputFile.json='([^']+)'/)[1];
      if (phase === 'vitestMs' && kind === 'absent full report') return { exitCode: 0 };
      const own = structuredClone(report);
      if (phase === 'vitestMs' && kind === 'missing file') { own.testResults.pop(); own.numTotalTests = own.numPassedTests = 1; }
      if (phase === 'vitestMs' && kind === 'skipped file') own.testResults[1].assertionResults[0].status = 'skipped';
      writeFileSync(path, JSON.stringify(own));
      return { exitCode: 0 };
    }, { listingError: kind === 'unreadable enumeration', listing: kind === 'empty enumeration' ? []
      : kind === 'oversized enumeration' ? [files[0] + 'x'.repeat(1024 * 1024)] : files });
    await runner.runCounted('vitestMs', 'npx vitest run', undefined, { fullPhase: true });
    expect(runner.fullComplete()).toBe(false);
    const guardReport = join(root, 'guard-report.json');
    await runner.runCounted('scanMs', `npx vitest run --reporter=json --outputFile.json=${gate.shellQuote(guardReport)}`, undefined, { reportFile: guardReport });
    expect(runner.sharedTestCounts.at(-1)).toBe(2);
    expect(runner.fullComplete()).toBe(false);
  });
it('F6 full npm phase appends its own reporter flags and proves all enumerated files', async () => {
  const files = [join(realpathSync(laneA), 'a.test.mjs'), join(realpathSync(laneA), 'b.test.mjs')];
  const runner = countedRunner(async (_phase, command) => {
    expect(command).toMatch(/^npm run test:unit -- --reporter=default --reporter=json/);
    writeFileSync(command.match(/--outputFile.json='([^']+)'/)[1], JSON.stringify({
      numTotalTests: 2, numPendingTests: 0, numTodoTests: 0, numPassedTests: 2, numFailedTests: 0,
      testResults: files.map(name => ({ name, assertionResults: [{ status: 'passed' }] })),
    }));
    return { exitCode: 0 };
  }, { listing: files });
  await runner.runCounted('vitestMs', 'npm run test:unit', undefined, { fullPhase: true });
  expect(runner.fullComplete()).toBe(true);
});
it('F3 unreadable filter config fails closed and names re-verification', () => {
  const logs = producer({ execFileSync: (command, argv, options) => {
    if (argv.includes('--get-regexp')) throw Object.assign(new Error('unreadable config'), { status: 2 });
    return producerGit(command, argv, options);
  } });
  expect(logs).toMatch(/checks failed.*re-verify/);
  expect(store.readSharedGreen(args({ policyKey: key(producerEnv()) }))).toBeNull();
});

it('F4 hidden sibling edits outside alias subdirectories refuse the key', () => {
  const sibling = join(root, 'frontierui');
  git(sibling, ['update-index', '--assume-unchanged', 'code.txt']);
  writeFileSync(join(sibling, 'code.txt'), 'hidden sibling edit');
  expect(gate.aliasPolicyInputs({ root: laneA })).toBeNull();
  expect(key({})).toBeNull();
});
