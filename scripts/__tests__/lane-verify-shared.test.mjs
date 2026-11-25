import { beforeEach, afterEach, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, statSync, symlinkSync, rmSync, readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadVerifySettingsFile, resolveVerifySettings } from '../lib/verify-settings.mjs';
import { createHash } from 'node:crypto';
import { resolveBuildPolicy } from '../lib/build-policy.mjs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { runInNewContext } from 'node:vm';
import * as gate from '../lib/verify-lane-gate.mjs';
import * as land from '../pr-land.mjs';
import { shouldRecordGreen, repoSlugFromRemote } from '../lib/lane-verify.mjs';
import { laneGitHardeningEnv, hardenLaneGitArgs } from '../lib/lane-git-hardening.mjs';
import { isAllowlistedLitterPath } from '../lib/lane-litter.mjs';

// The inventory is deliberately independent of implementation: every new WE_* token needs a reason here.
export const POLICY_ENV_KEYS = Object.fromEntries([
  'WE_BUILD_FINAL_GATE', 'WE_BUILD_FINAL_GATE_STANDARDS', 'WE_DIFF_TEST_SELECTION',
  'WE_VERIFY_SHARD_MIN_TESTS', 'WE_VERIFY_SHARD_SIZE', 'WE_VERIFY_SHARD_PARALLEL',
  'WE_VERIFY_RELATED', 'WE_VERIFY_TEST_TIMEOUT_FACTOR', 'WE_VERIFY_STANDARDS', 'WE_VERIFY_PHASE_ADMISSION',
  'WE_VERIFY_FAST_TARGETS', 'WE_VERIFY_MATCH_REQUEST_VARIANTS', 'WE_VERIFY_SUPERSEDE', 'WE_VERIFY_RESTART_IN_FLIGHT',
  'WE_VERIFY_RUN_ALL_PHASES', 'WE_VERIFY_ISOLATED_RETRY', 'WE_VERIFY_RETRY_FAILED', 'WE_VERIFY_RELATED_MAX_TESTS',
  'WE_VERIFY_RELATED_DEPTH', 'WE_VERIFY_ALWAYS_RUN_TESTS', 'WE_VERIFY_SKIP_LOCAL_FOR_CARD_ONLY', 'WE_VERIFY_REVERT_RED',
  'WE_VERIFY_REVERT_RED_SINCE', 'WE_VERIFY_REVERT_RED_MAX_FILES', 'WE_VERIFY_SELECTION', 'WE_VERIFY_PHASE_TIMEOUT_MS',
  'WE_VERIFY_SLOT_HEARTBEAT_MS',
].map(name => [name, 'Resolved verify/build value or normalized selection is included in the policy key.']));
export const NON_POLICY_ENV = {
  WE_REQUIRE_VERIFIED: 'Consumer admission option; does not select or execute tests.',
  WE_LAND_UNVERIFIED: 'Consumer break-glass option; does not change verification.',
  WE_VERIFY_GREEN_LEDGER_DIR: 'Storage location; delta publication independently validates the shared base.',
  WE_HEAVY_SESSION: 'Admission log identity only.',
  WE_VERIFY_GATE_PHASE_: 'Dynamic child phase identity only.',
  WE_VERIFY_REMOTE_REPORT: 'Child execution receipt path only.',
  WE_FORGE_GATE_DISPATCH: 'Child routing identity; gate content stays the same.',
  WE_BUILD_SELF_REVIEW_ENABLED: 'Review workflow, outside the verification plan.',
  WE_BUILD_SELF_REVIEW_MAX_ROUNDS: 'Review workflow, outside the verification plan.',
  WE_BUILD_REVIEWER_EXPECTATIONS_ENABLED: 'Brief formatting, outside the verification plan.',
  WE_SCRIPTS: 'Local JS constant, not an environment variable.',
  WE_VERIFY_: 'Documentation wildcard, not an environment variable.',
};
const unlisted = text => [...new Set(text.match(/\bWE_[A-Z0-9_]+\b/g) ?? [])]
  .filter(name => !POLICY_ENV_KEYS[name] && !NON_POLICY_ENV[name]);

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
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const key = env => gate.verifyPolicyKey(env ?? {});
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
  const resolved = { command: 'npm run test:unit', decision: { selectionMode: { mode: 'pr' } } };
  const context = { ...store, shouldRecordGreen, repoSlugFromRemote, laneGitHardeningEnv, hardenLaneGitArgs,
    isAllowlistedLitterPath, gateCommandsEqual: gate.gateCommandsEqual, verifyPolicyKey: gate.verifyPolicyKey,
    execFileSync, basename, join, REPO: laneA, headSha: sha, GATE: resolved.command, resolvedGate: resolved,
    resolveBuildDefaultGate: () => resolved, flags: {}, FORCE_LOCAL: false, admissionFallback: false, revertRed: null,
    resolveCoordinationRoot: () => coordRoot, process: { env: process.env, stderr: { write: s => notes.push(s) } },
    ...overrides };
  runInNewContext(`${source.slice(start, end)}\nmaybePublishSharedGreen({status:'green', treeHash:'stable', revertRed});`, context);
  return notes.join('');
}

it('a green published in lane A opens the PR from lane B at the same sha and policy key', () => {
  producer({ process: { env: {}, stderr: { write() {} } } });
  const laneB = join(root, 'lane-B');
  git(root, ['clone', '-q', laneA, laneB]);
  git(laneB, ['remote', 'set-url', 'origin', 'https://github.com/example/project.git']);
  const logs = [];
  const readMarker = gitDir => land.readFinishGuardMarker({ gitDir, headSha: sha, remote: 'origin', base: 'main',
    runGit: a => git(laneB, a), coordRoot, env: {}, log: s => logs.push(s) });
  const result = land.resolveFinishGuardVerdict({ gitDir: join(laneB, '.git'), headSha: sha, remote: 'origin', base: 'main',
    runGit: a => git(laneB, a), readMarker });
  expect(result).toMatchObject({ ok: true, status: 'green', reason: 'verified' });
  expect(logs.join('\n')).toMatch(/sharedFrom.*lane-A.*\d{4}-/);
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
it('policy key ratchet rejects an unlisted WE_* read and requires reasons in both inventories', () => {
  for (const file of ['verify-lane.mjs', 'lib/verify-lane-gate.mjs', 'lib/verify-settings.mjs', 'lib/build-policy.mjs']) {
    expect(unlisted(readFileSync(join(process.cwd(), 'scripts', file), 'utf8')), file).toEqual([]);
  }
  expect(unlisted('process.env.WE_NEW_UNREVIEWED_KNOB')).toEqual(['WE_NEW_UNREVIEWED_KNOB']);
  for (const reason of Object.values({ ...POLICY_ENV_KEYS, ...NON_POLICY_ENV })) expect(reason.length).toBeGreaterThan(10);
  expect(typeof gate.verifyPolicyKey).toBe('function');
});
it('policy keys normalize selection and ignore environment insertion order', () => {
  expect(key({ WE_DIFF_TEST_SELECTION: '0', WE_VERIFY_RETRY_FAILED: '1' }))
    .toBe(key({ WE_VERIFY_RETRY_FAILED: '1', WE_DIFF_TEST_SELECTION: '0' }));
  expect(key({})).toBe(key({ WE_DIFF_TEST_SELECTION: '1' }));
  // The executing resolver opts out only for exact '0'; all other spellings keep selection enabled.
  expect(key({ WE_DIFF_TEST_SELECTION: ' 0 ' })).toBe(key({ WE_DIFF_TEST_SELECTION: '1' }));
});
it.each(['variant-matched', 'requester-stamped', 'explicit', 'local'])('executed-plan %s run does not publish', kind => {
  const notes = producer({ ...(kind === 'explicit' ? { flags: { gate: 'npm run test:unit' } } : {}),
    ...(kind === 'local' ? { FORCE_LOCAL: true } : {}),
    ...(['variant-matched', 'requester-stamped'].includes(kind) ? { resolveBuildDefaultGate: () => ({ command: 'different env plan' }) } : {}) });
  expect(store.readSharedGreen(args({ policyKey: key(process.env) }))).toBeNull();
  expect(notes).toMatch(/shared.*skip/i);
});
it.each(['dirty tree', 'assume-unchanged', 'skip-worktree', 'chmod with core.fileMode=false'])('commit check refuses %s', kind => {
  if (kind === 'dirty tree') writeFileSync(join(laneA, 'code.txt'), 'dirty\n');
  if (kind === 'assume-unchanged') git(laneA, ['update-index', '--assume-unchanged', 'code.txt']);
  if (kind === 'skip-worktree') git(laneA, ['update-index', '--skip-worktree', 'code.txt']);
  if (kind.startsWith('chmod')) { git(laneA, ['config', 'core.fileMode', 'false']); chmodSync(join(laneA, 'code.txt'), 0o755); }
  expect(producer()).toMatch(/shared.*skip/i);
  expect(store.readSharedGreen(args({ policyKey: key(process.env) }))).toBeNull();
});
it('commit check permits only untracked allowlisted lane litter and uses hardened bounded git', () => {
  writeFileSync(join(laneA, '.pr-body.md'), 'litter');
  const calls = [];
  producer({ execFileSync: (command, argv, options) => { calls.push({ argv, options }); return execFileSync(command, argv, options); } });
  expect(store.readSharedGreen(args({ policyKey: key(process.env) }))).toMatchObject({ status: 'green' });
  for (const { options } of calls) {
    expect(options.maxBuffer).toBeGreaterThan(0);
    expect(options.env.GIT_CONFIG_COUNT).toBe(laneGitHardeningEnv(process.env).GIT_CONFIG_COUNT);
  }
  expect(calls.some(c => c.argv.includes('core.fileMode=true'))).toBe(true);
  expect(calls.some(c => c.argv.includes('ls-files'))).toBe(true);
});
it('oversized git evidence skips publication and names re-verification as the fallback', () => {
  const notes = producer({ execFileSync: (_command, _argv, options) => execFileSync(process.execPath,
    ['-e', `process.stdout.write('x'.repeat(${options.maxBuffer + 1}))`], options) });
  expect(notes).toMatch(/shared.*skip.*checks failed.*re-verify/);
  expect(store.readSharedGreen(args({ policyKey: key(process.env) }))).toBeNull();
});
it('delta chain refuses an absent or different-policy base and publishes only with a valid same-policy base', () => {
  const deltaBase = sha;
  git(laneA, ['-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-qm', 'delta']);
  sha = git(laneA, ['rev-parse', 'HEAD']);
  const resolved = { command: 'npm run test:unit', decision: { selectionMode: { mode: 'since-last-green', base: deltaBase } } };
  const options = { resolvedGate: resolved, resolveBuildDefaultGate: () => resolved };
  expect(producer(options)).toMatch(/shared.*skip/i);
  publish({ sha: deltaBase, policyKey: key({ WE_VERIFY_RETRY_FAILED: '10' }),
    record: record({ sha: deltaBase, policyKey: key({ WE_VERIFY_RETRY_FAILED: '10' }) }) });
  expect(producer(options)).toMatch(/shared.*skip/i);
  publish({ sha: deltaBase, policyKey: key(process.env), record: record({ sha: deltaBase, policyKey: key(process.env) }) });
  producer(options);
  expect(store.readSharedGreen(args({ policyKey: key(process.env) }))).toMatchObject({ sha, status: 'green' });
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
const policyStart = policySource.indexOf('let verifier;');
const policyEnd = policySource.indexOf('/**\n * PR 7008', policyStart);
function policyProcess({ readFile = readFileSync, buildPolicy = resolveBuildPolicy } = {}) {
  expect(policyStart).toBeGreaterThan(-1);
  expect(policyEnd).toBeGreaterThan(policyStart);
  const functions = policySource.slice(policyStart, policyEnd).replace(/\bexport /g, '').replaceAll('import.meta.url', 'moduleUrl');
  return runInNewContext(`${functions}\n({verifyPolicyInputs, verifyPolicyKey});`, {
    moduleUrl: pathToFileURL(join(process.cwd(), 'scripts/lib/verify-lane-gate.mjs')).href,
    fileURLToPath, dirname, join, createHash, readFileSync: readFile, resolveBuildPolicy: buildPolicy,
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
const verifierFiles = ['scripts/verify-lane.mjs', 'scripts/lib/verify-lane-gate.mjs',
  'scripts/lib/verify-shared-marker.mjs', 'scripts/lib/verify-settings.mjs', 'scripts/lib/build-policy.mjs'];
it.each(verifierFiles)('verifier identity refuses reuse after different running-checkout bytes in %s', changed => {
  let changedBytes = false;
  const reads = [];
  const readFile = (file, ...rest) => {
    reads.push(file);
    const bytes = readFileSync(file, ...rest);
    return changedBytes && file === join(process.cwd(), changed)
      ? Buffer.concat([bytes, Buffer.from('\n// changed verifier\n')]) : bytes;
  };
  const first = policyProcess({ readFile });
  const firstKey = first.verifyPolicyKey({});
  expect(firstKey).toBe(key({})); // the extracted functions match the imported production module
  const expected = createHash('sha256');
  for (const file of verifierFiles) expected.update(readFileSync(join(process.cwd(), file)));
  expect(first.verifyPolicyInputs({}).verifier).toBe(expected.digest('hex'));
  changedBytes = true;
  expect(first.verifyPolicyKey({})).toBe(firstKey); // cached for this loaded verifier
  expect(reads).toEqual(verifierFiles.map(f => join(process.cwd(), f)));
  const secondKey = policyProcess({ readFile }).verifyPolicyKey({});
  expect(secondKey).not.toBe(firstKey);
  publish({ policyKey: firstKey, record: record({ policyKey: firstKey }) });
  expect(store.readSharedGreen(args({ policyKey: secondKey }))).toBeNull();
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
  expect(store.readSharedGreen(args({ policyKey: key(process.env) }))).toBeNull();
});
it.each(['red', 'running', 'unknown', undefined])('precedence refuses stale local non-green %s despite exact shared green', status => {
  const local = { sha: 'e'.repeat(40), status }, shared = { sha, status: 'green' };
  expect(store.resolveMarkerWithShared({ local, shared, headSha: sha })).toBe(local);
});
it.each(['warn', 'enforce'].flatMap(mode => ['skipped', 'unproven', 'flagged'].map(status => [mode, status])))
  ('revert-red %s/%s refuses shared publication', (mode, status) => {
    expect(producer({ revertRed: { mode, status } })).toMatch(/shared.*skip.*re-verify/);
    expect(store.readSharedGreen(args({ policyKey: key(process.env) }))).toBeNull();
  });
it.each([null, { mode: 'off', status: 'skipped' }, { mode: 'warn', status: 'clean' }, { mode: 'enforce', status: 'clean' }])
  ('producer records only clean or absent revert-red evidence %j', revertRed => {
    producer({ revertRed });
    const file = store.sharedMarkerPath(args({ policyKey: key(process.env) }));
    expect(JSON.parse(readFileSync(file, 'utf8')).revertRed).toEqual(revertRed?.mode === 'off' ? null : revertRed);
    expect(store.readSharedGreen(args({ policyKey: key(process.env) }))).toMatchObject({ status: 'green' });
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
  expect(store.readSharedGreen(args({ policyKey: key(process.env) }))).toBeNull();
});
it('nonempty selected test invocation remains eligible for publication', () => {
  const command = 'npx vitest run scripts/example.test.mjs --passWithNoTests';
  const resolved = { command, decision: { selectionMode: { mode: 'pr' }, selection: { tests: ['scripts/example.test.mjs'] } } };
  producer({ GATE: command, resolvedGate: resolved, resolveBuildDefaultGate: () => resolved });
  expect(store.readSharedGreen(args({ policyKey: key(process.env) }))).toMatchObject({ status: 'green' });
});
