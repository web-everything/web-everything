/** @file xfwf4zc (x1bppc5 / R344): per-daemon relevance, shared per-commit verdict, Forge routing, always-run floor. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import {
  SMOKE_CHECKS, SHAREABLE_CHECK_NAMES, runLiveSmoke, checkRelevantToDaemon, checkClosureHash, relevanceDiffSafe, DISPATCH_DRY_RUN_CODE_ENTRIES,
} from '../daemon-live-smoke.mjs';
import {
  completeSmokePass, makeRelevanceProof, readSharedVerdict, writeSharedVerdict, writeClosureProofs, smokePassIdentity, smokeHarnessHash,
} from '../daemon-rebuild/smoke.mjs';
import { parseForgeSmokeOutput, runSmokeCodeChecksOnForge, FORGE_SMOKE_MARKER } from '../verify-remote-routing.mjs';

vi.mock('../resource-admission.mjs', () => ({ shadowAdmission: vi.fn(), admit: vi.fn() }));

const dirs = [];
const mk = () => { const d = mkdtempSync(join(tmpdir(), 'smoke-rel-')); dirs.push(d); return d; };
afterEach(() => { while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true }); });
const put = (root, rel, text) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text); };

/** A tree where review-daemon imports the dispatch machinery and verify-daemon does not. */
function fixture() {
  const root = mk();
  put(root, 'scripts/conveyor/reconcile-pass.mjs', 'export const r = 1;\n');
  put(root, 'scripts/operations/review-dispatch.mjs', "import '../conveyor/reconcile-pass.mjs';\n");
  put(root, 'scripts/conveyor/reconcile-fix-dispatch.mjs', 'export const f = 1;\n');
  put(root, 'scripts/operations/ci-heal-pr-dispatch.mjs', 'export const c = 1;\n');
  put(root, 'skills-src/conveyor/review-daemon.mjs', "import '../../scripts/operations/review-dispatch.mjs';\n");
  put(root, 'skills-src/conveyor/verify-daemon.mjs', "import '../../scripts/lib/util.mjs';\n");
  put(root, 'scripts/lib/util.mjs', 'export const u = 1;\n');
  return root;
}
const dryRun = (name) => SMOKE_CHECKS.find((c) => c.name === name);
const failing = async () => { throw new Error('child blocked in test'); };
const opts = (root, extra = {}) => ({ root, env: {}, repos: [], runChild: failing, clock: () => 0,
  load: () => 0, cores: () => 8, shadow: () => {}, admit: () => undefined, ...extra });

describe('check flags (Fork 4 floor)', () => {
  it('only the two dry-runs are shareable and none is cloneIndependent; the floor is neither', () => {
    expect(SMOKE_CHECKS.filter((c) => c.shareable).map((c) => c.name).sort()).toEqual(['dispatch-dry-run', 'reconcile-dry-run']);
    expect(SMOKE_CHECKS.filter((c) => c.cloneIndependent).map((c) => c.name)).toEqual([]); // both dry-runs read the live clone env
    for (const n of ['gh-api-repo', 'gh-pr-list', 'tree-stays-clean', 'daemon-entries-boot']) {
      const c = SMOKE_CHECKS.find((x) => x.name === n);
      expect(c, n).toBeTruthy();
      expect(c.shareable).not.toBe(true);
    }
    expect(SHAREABLE_CHECK_NAMES).toHaveLength(2);
  });
});

describe('Fork 1: per-daemon relevance by import closure', () => {
  it('a daemon importing the dispatch machinery is relevant; one that does not is not', () => {
    const root = fixture();
    const check = dryRun('dispatch-dry-run');
    expect(checkRelevantToDaemon({ check, root, daemonEntries: ['skills-src/conveyor/review-daemon.mjs'] })).toBe(true);
    expect(checkRelevantToDaemon({ check, root, daemonEntries: ['skills-src/conveyor/verify-daemon.mjs'] })).toBe(false);
    expect(checkRelevantToDaemon({ check: dryRun('reconcile-dry-run'), root, daemonEntries: ['skills-src/conveyor/review-daemon.mjs'] })).toBe(true);
  });
  it('unknown daemon, unknown/incomplete closure, throwing scan, or a non-shareable check all mean RUN (mutation guard)', () => {
    const root = fixture();
    const check = dryRun('dispatch-dry-run');
    expect(checkRelevantToDaemon({ check, root, daemonEntries: null })).toBe(true);
    expect(checkRelevantToDaemon({ check, root, daemonEntries: [] })).toBe(true);
    expect(checkRelevantToDaemon({ check, root, daemonEntries: ['x.mjs'], closureOf: () => null })).toBe(true);
    expect(checkRelevantToDaemon({ check, root, daemonEntries: ['x.mjs'], closureOf: () => ({ files: new Set(), complete: false }) })).toBe(true);
    expect(checkRelevantToDaemon({ check, root, daemonEntries: ['x.mjs'], closureOf: () => { throw new Error('boom'); } })).toBe(true);
    expect(checkRelevantToDaemon({ check: SMOKE_CHECKS.find((c) => c.name === 'gh-pr-list'), root, daemonEntries: ['skills-src/conveyor/verify-daemon.mjs'] })).toBe(true);
  });
  it('runLiveSmoke skips an irrelevant dry-run only with a recorded identical-closure live pass', async () => {
    const root = fixture();
    const daemonEntries = ['skills-src/conveyor/verify-daemon.mjs'];
    const hash = checkClosureHash({ check: dryRun('dispatch-dry-run'), root });
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    const without = await runLiveSmoke(opts(root, { daemonEntries, relevanceProof: () => false }));
    expect(without.results.find((r) => r.name === 'dispatch-dry-run').skipReason).toBeUndefined();
    const proof = vi.fn((name, h) => (name === 'dispatch-dry-run' || name === 'reconcile-dry-run') && /^[0-9a-f]{64}$/.test(h));
    const withProof = await runLiveSmoke(opts(root, { daemonEntries, changedFiles: ['scripts/lib/util.mjs'], relevanceProof: proof }));
    const row = withProof.results.find((r) => r.name === 'dispatch-dry-run');
    expect(row).toMatchObject({ ok: true, skipped: true, skipReason: 'relevance' });
    expect(row.closureHash).toBe(hash);
    // relevant daemon: never relevance-skipped
    const relevant = await runLiveSmoke(opts(root, { daemonEntries: ['skills-src/conveyor/review-daemon.mjs'], changedFiles: ['scripts/lib/util.mjs'], relevanceProof: proof }));
    expect(relevant.results.find((r) => r.name === 'dispatch-dry-run').skipReason).toBeUndefined();
  });
  it('the floor rows are still present and run when everything shareable is skipped', async () => {
    const root = fixture();
    const out = await runLiveSmoke(opts(root, { daemonEntries: ['skills-src/conveyor/verify-daemon.mjs'], changedFiles: ['scripts/lib/util.mjs'], relevanceProof: () => true }));
    for (const n of ['gh-api-repo', 'gh-pr-list', 'daemon-entries-boot', 'tree-stays-clean']) {
      const r = out.results.find((x) => x.name === n);
      expect(r, n).toBeTruthy();
      expect(r.skipReason).toBeUndefined();
    }
  });
  it('reuse (a proven tree) covers only the shareable dry-runs, never the floor', async () => {
    const root = fixture();
    const out = await runLiveSmoke(opts(root, { reuseCode: true }));
    expect(out.results.filter((r) => r.skipped).map((r) => r.name).sort()).toEqual(['dispatch-dry-run', 'reconcile-dry-run']);
  });
});

describe('completeSmokePass accepts a relevance skip only with its proof', () => {
  const rows = (skipRow) => SMOKE_CHECKS.map((c) => (c.name === 'dispatch-dry-run' ? skipRow : { name: c.name, ok: true }));
  const result = (skipRow) => ({ verdict: 'pass', smoke: { results: rows(skipRow) } });
  const skip = { name: 'dispatch-dry-run', ok: true, skipped: true, skipReason: 'relevance', closureHash: 'a'.repeat(64) };
  it('rejects without proof or with a failing proof; accepts with one', () => {
    expect(completeSmokePass(result(skip))).toBe(false);
    expect(completeSmokePass(result(skip), { relevanceProof: () => false })).toBe(false);
    expect(completeSmokePass(result(skip), { relevanceProof: () => true })).toBe(true);
  });
  it('still rejects any other skip', () => {
    expect(completeSmokePass(result({ name: 'dispatch-dry-run', ok: true, skipped: true }), { relevanceProof: () => true })).toBe(false);
    expect(completeSmokePass(result({ name: 'dispatch-dry-run', ok: true, skipped: true, skipReason: 'relevance' }), { relevanceProof: () => false })).toBe(false);
  });
});

describe('Fork 2: the shared host store', () => {
  const identity = { tree: 'a'.repeat(40), sharedKey: 'k'.repeat(64), relevanceKey: 'e'.repeat(64) };
  let env;
  beforeEach(() => { env = { WE_DAEMON_STATE_DIR: mk() }; });
  const file = () => join(env.WE_DAEMON_STATE_DIR, 'smoke-verdicts', `verdict-${identity.sharedKey}.json`);
  it('hit, then miss on a different key part, expiry, truncation, and malformed content', () => {
    expect(readSharedVerdict(identity, { env })).toBeNull();
    expect(writeSharedVerdict(identity, { env })).toBe(true);
    expect(readSharedVerdict(identity, { env })).toMatchObject({ key: identity.sharedKey, tree: identity.tree });
    expect(readSharedVerdict({ ...identity, sharedKey: 'z'.repeat(64) }, { env })).toBeNull();
    expect(readSharedVerdict({ ...identity, tree: 'u'.repeat(40) }, { env })).toBeNull();
    expect(readSharedVerdict(identity, { env, now: () => Date.now() + 13 * 3_600_000 })).toBeNull();
    const text = readFileSync(file(), 'utf8');
    writeFileSync(file(), text.slice(0, text.length - 7));
    expect(readSharedVerdict(identity, { env })).toBeNull();
    writeFileSync(file(), '[]');
    expect(readSharedVerdict(identity, { env })).toBeNull();
    writeFileSync(file(), JSON.stringify({ kind: 'smoke-verdict', key: identity.sharedKey, tree: identity.tree, passedAt: new Date().toISOString(), checks: ['dispatch-dry-run'] }));
    expect(readSharedVerdict(identity, { env })).toBeNull(); // does not name every shareable check
    writeFileSync(file(), 'x'.repeat(70_000));
    expect(readSharedVerdict(identity, { env })).toBeNull(); // oversize
  });
  it('concurrent writers leave one whole, parseable record and no temp debris is trusted', async () => {
    await Promise.all(Array.from({ length: 12 }, () => Promise.resolve().then(() => writeSharedVerdict(identity, { env }))));
    expect(readSharedVerdict(identity, { env })).not.toBeNull();
    expect(readdirSync(join(env.WE_DAEMON_STATE_DIR, 'smoke-verdicts')).filter((f) => f.endsWith('.json'))).toEqual([`verdict-${identity.sharedKey}.json`]);
  });
  it('closure proofs: written only for live passing shareable rows, valid inside the window', () => {
    const h = 'b'.repeat(64);
    writeClosureProofs([
      { name: 'dispatch-dry-run', ok: true, closureHash: h },
      { name: 'reconcile-dry-run', ok: true, skipped: true, skipReason: 'relevance', closureHash: h },
      { name: 'gh-pr-list', ok: true, closureHash: h },
      { name: 'dispatch-dry-run', ok: false, closureHash: 'c'.repeat(64) },
    ], { identity, env });
    const sameTree = () => ({ status: 0, stdout: '' });
    const proof = makeRelevanceProof({ identity, git: sameTree, env });
    expect(proof('dispatch-dry-run', h)).toBe(true);
    expect(proof('reconcile-dry-run', h)).toBe(false);
    expect(proof('gh-pr-list', h)).toBe(false);
    expect(proof('dispatch-dry-run', 'c'.repeat(64))).toBe(false);
    expect(makeRelevanceProof({ identity, git: () => ({ status: 0, stdout: '' }), env, now: () => Date.now() + 13 * 3_600_000 })('dispatch-dry-run', h)).toBe(false);
  });
  it('rejects missing identity, legacy records, and mismatched stored execution identity', () => {
    const h = 'b'.repeat(64);
    const rows = [{ name: 'dispatch-dry-run', ok: true, closureHash: h }];
    writeClosureProofs(rows, { env });
    expect(makeRelevanceProof({ identity, env })('dispatch-dry-run', h)).toBe(false);
    writeClosureProofs(rows, { identity, env });
    expect(makeRelevanceProof({ env })('dispatch-dry-run', h)).toBe(false);
    const path = join(env.WE_DAEMON_STATE_DIR, 'smoke-verdicts', `closure-dispatch-dry-run-${h}-${identity.relevanceKey}.json`);
    const record = JSON.parse(readFileSync(path, 'utf8'));
    writeFileSync(path, JSON.stringify({ ...record, v: 1, relevanceKey: undefined }));
    expect(makeRelevanceProof({ identity, env })('dispatch-dry-run', h)).toBe(false);
    writeFileSync(path, JSON.stringify({ ...record, relevanceKey: 'f'.repeat(64) }));
    expect(makeRelevanceProof({ identity, env })('dispatch-dry-run', h)).toBe(false);
  });
});

describe('identity and harness hash', () => {
  const git = (tree, lock = 'L') => (args) => {
    if (args[0] === 'rev-parse') return { status: 0, stdout: `${tree}\n` };
    if (args[0] === 'show') return { status: 0, stdout: lock };
    return { status: 1, stdout: '' };
  };
  it.each(['harness', 'Node', 'lockfile'])('rejects relevance proofs after %s changes and executes the check', async (component) => {
    const root = fixture();
    const env = { WE_DAEMON_STATE_DIR: mk() };
    const check = dryRun('dispatch-dry-run');
    const closureHash = checkClosureHash({ check, root });
    const baseline = smokePassIdentity(git('a'.repeat(40)), 'sha', 'drain', { harnessHash: 'h1', nodeVersion: 'v1' });
    writeClosureProofs([{ name: check.name, ok: true, closureHash }], { identity: baseline, env });
    const options = { daemonEntries: ['skills-src/conveyor/verify-daemon.mjs'], changedFiles: ['scripts/conveyor/reconcile-fix-dispatch.mjs'] };
    const before = await runLiveSmoke(opts(root, { ...options, relevanceProof: makeRelevanceProof({ identity: baseline, git: git('a'.repeat(40)), env }) }));
    expect(before.results.find((r) => r.name === check.name)).toMatchObject({ skipped: true, skipReason: 'relevance' });
    const changed = smokePassIdentity(git('a'.repeat(40), component === 'lockfile' ? 'L2' : 'L'), 'sha', 'drain', {
      harnessHash: component === 'harness' ? 'h2' : 'h1', nodeVersion: component === 'Node' ? 'v2' : 'v1',
    });
    const proof = makeRelevanceProof({ identity: changed, git: git('a'.repeat(40)), env });
    expect(proof(check.name, closureHash)).toBe(false);
    const child = vi.fn(failing);
    const after = await runLiveSmoke(opts(root, { ...options, relevanceProof: proof, runChild: child }));
    expect(after.results.find((r) => r.name === check.name)).toMatchObject({ ok: false });
    expect(after.results.find((r) => r.name === check.name).skipped).toBeUndefined();
    expect(child.mock.calls.some(([cmd, argv]) => cmd === 'node' && argv.includes('--input-type=module'))).toBe(true);
  });
  it('key parts: tree, lockfile, harness change the key; cloneKind changes both `key` and `sharedKey` while no check is cloneIndependent', () => {
    const base = smokePassIdentity(git('a'.repeat(40)), 'sha', 'drain', { harnessHash: 'h1' });
    expect(base.sharedKey).not.toBe(smokePassIdentity(git('a'.repeat(40)), 'sha', 'review', { harnessHash: 'h1' }).sharedKey);
    expect(base.key).not.toBe(smokePassIdentity(git('a'.repeat(40)), 'sha', 'review', { harnessHash: 'h1' }).key);
    expect(base.sharedKey).not.toBe(smokePassIdentity(git('b'.repeat(40)), 'sha', 'drain', { harnessHash: 'h1' }).sharedKey);
    expect(base.sharedKey).not.toBe(smokePassIdentity(git('a'.repeat(40), 'L2'), 'sha', 'drain', { harnessHash: 'h1' }).sharedKey);
    expect(base.sharedKey).not.toBe(smokePassIdentity(git('a'.repeat(40)), 'sha', 'drain', { harnessHash: 'h2' }).sharedKey);
  });
  it('no harness hash means no identity (nothing is reused)', () => {
    expect(smokePassIdentity(git('a'.repeat(40)), 'sha', 'drain', { harnessHash: null })).toBeNull();
  });
  it('changing an imported harness dependency changes the computed harness hash', () => {
    const root = mk();
    put(root, 'scripts/lib/daemon-live-smoke.mjs', "import './harness-dependency.mjs';\n");
    put(root, 'scripts/lib/daemon-rebuild/smoke.mjs', 'export const smoke = true;\n');
    put(root, 'scripts/lib/harness-dependency.mjs', 'export const value = 1;\n');
    const before = smokeHarnessHash({ root });
    expect(before).toMatch(/^[0-9a-f]{64}$/);
    put(root, 'scripts/lib/harness-dependency.mjs', 'export const value = 2;\n');
    const after = smokeHarnessHash({ root });
    expect(after).toMatch(/^[0-9a-f]{64}$/);
    expect(after).not.toBe(before);
    put(root, 'scripts/lib/harness-dependency.mjs', 'export const value = 1;\n');
    expect(smokeHarnessHash({ root })).toBe(before);
  });
  it('an unreadable or incomplete harness closure returns null', () => {
    const root = mk();
    expect(smokeHarnessHash({ root })).toBeNull();
    put(root, 'scripts/lib/daemon-live-smoke.mjs', "import './harness-dependency.mjs';\n");
    put(root, 'scripts/lib/daemon-rebuild/smoke.mjs', 'export const smoke = true;\n');
    put(root, 'scripts/lib/harness-dependency.mjs', 'export const value = 1;\n');
    expect(smokeHarnessHash({ root, readFile: (path) => {
      if (path.endsWith('harness-dependency.mjs')) throw new Error('unreadable dependency');
      return readFileSync(path);
    } })).toBeNull();
    put(root, 'scripts/lib/harness-dependency.mjs', 'export const load = (path) => import(path);\n');
    expect(smokeHarnessHash({ root })).toBeNull();
    for (const closure of [null, { complete: false, files: new Set(['x.mjs']) },
      { files: new Set(['x.mjs']) }, { complete: true, files: new Set() }]) {
      expect(smokeHarnessHash({ root, closureOf: () => closure })).toBeNull();
    }
  });
});

describe('Fork 3: Forge routing with Mac fallback', () => {
  const tree = 'a'.repeat(40);
  const line = (body) => `noise\n${FORGE_SMOKE_MARKER}${JSON.stringify(body)}\n`;
  const rows = [{ name: 'dispatch-dry-run', ok: true, ms: 5, detail: 'ok', closureHash: 'd'.repeat(64) }];
  const allowedChecks = SHAREABLE_CHECK_NAMES;
  it('accepts a passing row for the exact tree', () => {
    const r = parseForgeSmokeOutput(line({ tree, rows }), { expectedTree: tree, allowedChecks });
    expect(r.ran).toBe(true);
    expect(Object.keys(r.rows)).toEqual(['dispatch-dry-run']);
  });
  it('rejects a tree mismatch, missing/duplicate markers, oversize, non-JSON, failing and unexpected rows', () => {
    expect(parseForgeSmokeOutput(line({ tree: 'b'.repeat(40), rows }), { expectedTree: tree, allowedChecks })).toEqual({ ran: false, reason: 'tree-mismatch' });
    expect(parseForgeSmokeOutput('nothing', { expectedTree: tree, allowedChecks }).ran).toBe(false);
    expect(parseForgeSmokeOutput(line({ tree, rows }) + line({ tree, rows }), { expectedTree: tree, allowedChecks }).ran).toBe(false);
    expect(parseForgeSmokeOutput('x'.repeat(70_000), { expectedTree: tree, allowedChecks }).ran).toBe(false);
    expect(parseForgeSmokeOutput(`${FORGE_SMOKE_MARKER}{nope`, { expectedTree: tree, allowedChecks }).ran).toBe(false);
    const bad = parseForgeSmokeOutput(line({ tree, rows: [{ name: 'dispatch-dry-run', ok: false }, { name: 'gh-pr-list', ok: true }, { name: '../x', ok: true }] }), { expectedTree: tree, allowedChecks });
    expect(bad.ran).toBe(false);
  });
  it('falls back (ran:false) when Forge is not ready, unconfigured, errors, or returns a wrong tree', async () => {
    const decide = (remote, reason) => async () => ({ remote, reason });
    expect((await runSmokeCodeChecksOnForge({ cwd: '.', expectedTree: tree, allowedChecks, exec: async () => '', decide: decide(false, 'forge-busy') }))).toEqual({ ran: false, reason: 'forge-busy' });
    expect((await runSmokeCodeChecksOnForge({ cwd: '.', expectedTree: tree, allowedChecks, decide: decide(true) }))).toEqual({ ran: false, reason: 'forge-smoke-executor-unconfigured' });
    expect((await runSmokeCodeChecksOnForge({ cwd: '.', expectedTree: tree, allowedChecks, exec: async () => { throw new Error('transport'); }, decide: decide(true) })).ran).toBe(false);
    expect((await runSmokeCodeChecksOnForge({ cwd: '.', expectedTree: tree, allowedChecks, exec: async () => line({ tree: 'c'.repeat(40), rows }), decide: decide(true) })).reason).toBe('tree-mismatch');
    const ok = await runSmokeCodeChecksOnForge({ cwd: '.', expectedTree: tree, allowedChecks, exec: async () => line({ tree, rows }), decide: decide(true) });
    expect(ok.ran).toBe(true);
  });
  it('runLiveSmoke takes a verified passing Forge row instead of running the check, and never takes a failing one', async () => {
    const root = fixture();
    const forgeRows = { 'dispatch-dry-run': { name: 'dispatch-dry-run', ok: true, ms: 7, detail: 'ok' } };
    const out = await runLiveSmoke(opts(root, { forgeRows }));
    expect(out.results.find((r) => r.name === 'dispatch-dry-run')).toMatchObject({ ok: true, ranOn: 'forge' });
    const failed = await runLiveSmoke(opts(root, { forgeRows: { 'dispatch-dry-run': { name: 'dispatch-dry-run', ok: false } } }));
    expect(failed.results.find((r) => r.name === 'dispatch-dry-run').ranOn).toBeUndefined();
  });
});

describe('audit findings (xfwf4zc)', () => {
  it('closure hash covers runtime JSON the closure reads by name', () => {
    const root = fixture();
    put(root, 'scripts/conveyor/reconcile-pass.mjs', "export const r = 'dispatch-settings.json';\n");
    put(root, 'scripts/settings/dispatch-settings.json', '{"a":1}');
    const check = dryRun('reconcile-dry-run');
    const a = checkClosureHash({ check, root });
    put(root, 'scripts/settings/dispatch-settings.json', '{"a":2}');
    expect(checkClosureHash({ check, root })).not.toBe(a);
    expect(checkClosureHash({ check, root, listDir: () => { throw new Error('unreadable'); } })).toBeNull();
  });
  it('Forge output with any failing, skipped, duplicate or unexpected row is void as a whole', () => {
    const tree = 'a'.repeat(40);
    const good = { name: 'dispatch-dry-run', ok: true, ms: 1, detail: 'ok' };
    const parse = (rows) => parseForgeSmokeOutput(`${FORGE_SMOKE_MARKER}${JSON.stringify({ tree, rows })}`, { expectedTree: tree, allowedChecks: SHAREABLE_CHECK_NAMES });
    expect(parse([good]).ran).toBe(true);
    for (const extra of [{ name: 'reconcile-dry-run', ok: false }, { ...good, skipped: true }, good, { name: 'gh-pr-list', ok: true }]) {
      expect(parse([good, extra]).ran, JSON.stringify(extra)).toBe(false);
    }
    expect(parse([{ ...good, skipped: true }]).ran).toBe(false);
  });
  it('a relevance skip needs a known, plain-code diff: markdown briefs, config, skills, unknown diff all run the check', async () => {
    expect(relevanceDiffSafe(['scripts/a.mjs', 'docs/x.md'])).toBe(true);
    for (const bad of [null, undefined, ['scripts/briefs/review.md'], ['skills-src/x/brief.md'], ['package.json'], ['scripts/x.sh'], ['scripts/settings/a.json'], ['.claude/s.md']]) {
      expect(relevanceDiffSafe(bad), JSON.stringify(bad)).toBe(false);
    }
    const root = fixture();
    const base = { daemonEntries: ['skills-src/conveyor/verify-daemon.mjs'], relevanceProof: () => true };
    for (const changedFiles of [null, ['scripts/briefs/review.md']]) {
      const out = await runLiveSmoke(opts(root, { ...base, changedFiles }));
      expect(out.results.find((r) => r.name === 'dispatch-dry-run').skipReason, JSON.stringify(changedFiles)).toBeUndefined();
    }
  });
  it('a proof from another tree counts only when the trees differ in plain code/docs (markdown briefs void it)', () => {
    const env = { WE_DAEMON_STATE_DIR: mk() };
    const proofIdentity = { tree: 'a'.repeat(40), relevanceKey: 'e'.repeat(64) };
    const h = 'f'.repeat(64);
    writeClosureProofs([{ name: 'dispatch-dry-run', ok: true, closureHash: h }], { identity: proofIdentity, env });
    const later = { tree: 'b'.repeat(40), relevanceKey: 'e'.repeat(64) };
    const diff = (out, status = 0) => () => ({ status, stdout: out });
    const proof = (git) => makeRelevanceProof({ identity: later, git, env })('dispatch-dry-run', h);
    expect(proof(diff('scripts/lib/util.mjs\ndocs/a.md\n'))).toBe(true);
    expect(proof(diff('scripts/briefs/review.md\n'))).toBe(false);
    expect(proof(diff('skills-src/x.mjs\n'))).toBe(false);
    expect(proof(diff('', 1))).toBe(false);
    expect(proof(() => { throw new Error('git gone'); })).toBe(false);
    expect(proof(null)).toBe(false);
  });
});

