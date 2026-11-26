/**
 * @file scripts/__tests__/pr-land-finish-guard.test.mjs
 * @description Real-git behavioral proof of `pr-land.mjs`'s #2833/#4296 finish-guard, extracted as
 *   `resolveFinishGuardVerdict` specifically so it can be driven directly with a real git repo instead of only
 *   through source-text regex assertions on the CLI (converge round 1, 2026-09-29 — the correctness, security
 *   and standards-conformance jurors each independently flagged that the landing path that matters most had no
 *   behavioral coverage of its own; `pr-land.test.mjs`'s existing #2833 wiring test pins the SHAPE, this pins
 *   the BEHAVIOR). Shares the exact merge fixture shape `scripts/__tests__/verify-lane.test.mjs`'s #4296
 *   describe block uses for the bare `check` CLI, applied here to the function `pr-land.mjs` actually calls —
 *   no `gh`, no push, no network: `resolveFinishGuardVerdict` never touches either.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveFinishGuardVerdict } from '../pr-land.mjs';
import * as land from '../pr-land.mjs';
import * as verifyGate from '../lib/verify-lane-gate.mjs';
import { existsSync, readFileSync } from 'node:fs';
const sharedPath = join(process.cwd(), 'scripts/lib/verify-shared-marker.mjs');
const sharedStore = existsSync(sharedPath) ? await import(sharedPath) : {};
import { readVerifyMarker } from '../lib/lane-verify.mjs';

let dir, fixtureRoot;
beforeEach(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'pr-land-finish-guard-'));
  dir = join(fixtureRoot, 'checkout'); mkdirSync(dir);
  execFileSync('git', ['init', '-q'], { maxBuffer: 2 * 1024 * 1024, cwd: dir });
});
afterEach(() => { rmSync(fixtureRoot, { recursive: true, force: true }); });

const gitDirOf = (d) => join(d, '.git');
const runGit = (args) => execFileSync('git', args, { maxBuffer: 2 * 1024 * 1024, cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const headSha = () => runGit(['rev-parse', 'HEAD']);
const laneBranch = () => runGit(['symbolic-ref', '--short', 'HEAD']);
const commit = (msg) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', msg], { maxBuffer: 2 * 1024 * 1024, cwd: dir });
const writeAndAdd = (relPath, contents) => {
  mkdirSync(join(dir, relPath.split('/').slice(0, -1).join('/') || '.'), { recursive: true });
  writeFileSync(join(dir, relPath), contents);
  execFileSync('git', ['add', relPath], { maxBuffer: 2 * 1024 * 1024, cwd: dir });
};
/** Write a marker directly (never through the real `verify-lane.mjs` writer — this suite only needs the SHAPE
 *  `resolveFinishGuardVerdict` reads, and driving the real gate here would be the exact "run everything" cost
 *  the diff-driven shrink already exists to avoid). */
function writeGreenMarker(sha) {
  const record = { sha, status: 'green', startedAt: '2026-09-29T00:00:00.000Z', finishedAt: '2026-09-29T00:01:00.000Z', suites: 'test', exitCode: 0 };
  writeFileSync(join(gitDirOf(dir), '.lane-verify'), JSON.stringify(record, null, 2) + '\n');
  return record;
}

describe('resolveFinishGuardVerdict (#4296) — a real merge of origin/main touching only an out-of-lane file keeps a green marker valid', () => {
  it('lands GREEN: the marker is for the pre-merge sha, the merge touched only a file the lane never edited', () => {
    writeAndAdd('scripts/verify-lane.mjs', 'base\n');
    writeAndAdd('scripts/operations/ci-heal-pr-dispatch.mjs', 'base\n');
    commit('base');
    const main = laneBranch();
    execFileSync('git', ['branch', 'origin/main'], { maxBuffer: 2 * 1024 * 1024, cwd: dir });

    writeAndAdd('scripts/verify-lane.mjs', 'lane edit\n');
    commit('lane edit');
    const laneSha = headSha();
    writeGreenMarker(laneSha);

    execFileSync('git', ['checkout', '-q', 'origin/main'], { maxBuffer: 2 * 1024 * 1024, cwd: dir });
    writeAndAdd('scripts/operations/ci-heal-pr-dispatch.mjs', 'upstream edit\n');
    commit('upstream edit');
    execFileSync('git', ['checkout', '-q', main], { maxBuffer: 2 * 1024 * 1024, cwd: dir });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'merge', '--no-edit', '-q', 'origin/main'], { maxBuffer: 2 * 1024 * 1024, cwd: dir });
    const mergeSha = headSha();
    expect(mergeSha).not.toBe(laneSha);

    const gate = resolveFinishGuardVerdict({
      gitDir: gitDirOf(dir), headSha: mergeSha, remote: 'origin', base: 'main', runGit, readMarker: readVerifyMarker,
    });

    expect(gate).toMatchObject({ ok: true, status: 'green', reason: 'verified' });
    expect(gate.detail).toMatch(/carried forward/);
  });

  it('REFUSES (unverified): a merge that DOES touch a file the lane relies on still forces a re-verify — not a blanket bypass', () => {
    writeAndAdd('scripts/verify-lane.mjs', 'base\n');
    commit('base');
    const main = laneBranch();
    execFileSync('git', ['branch', 'origin/main'], { maxBuffer: 2 * 1024 * 1024, cwd: dir });

    writeAndAdd('scripts/verify-lane.mjs', 'lane edit\n');
    commit('lane edit');
    const laneSha = headSha();
    writeGreenMarker(laneSha);

    execFileSync('git', ['checkout', '-q', 'origin/main'], { maxBuffer: 2 * 1024 * 1024, cwd: dir });
    writeAndAdd('scripts/verify-lane.mjs', 'base\nupstream addition\n');
    commit('upstream addition to the lane\'s own file');
    execFileSync('git', ['checkout', '-q', main], { maxBuffer: 2 * 1024 * 1024, cwd: dir });
    // May auto-merge cleanly or conflict, depending on git's hunk heuristics — either way the merge commit's
    // diff against the marker's sha touches scripts/verify-lane.mjs, which is exactly what this counter-case
    // needs; `resolveFinishGuardVerdict` never runs `git merge` itself, so how the conflict (if any) resolves is
    // incidental to what it is testing.
    try {
      execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'merge', '--no-edit', '-q', 'origin/main'], { maxBuffer: 2 * 1024 * 1024, cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      writeFileSync(join(dir, 'scripts/verify-lane.mjs'), 'lane edit\nupstream addition\n');
      execFileSync('git', ['add', 'scripts/verify-lane.mjs'], { maxBuffer: 2 * 1024 * 1024, cwd: dir });
      execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--no-edit', '-q'], { maxBuffer: 2 * 1024 * 1024, cwd: dir });
    }
    const mergeSha = headSha();
    expect(mergeSha).not.toBe(laneSha);

    const gate = resolveFinishGuardVerdict({
      gitDir: gitDirOf(dir), headSha: mergeSha, remote: 'origin', base: 'main', runGit, readMarker: readVerifyMarker,
    });

    expect(gate).toMatchObject({ ok: false, status: 'absent', reason: 'unverified' });
  });

  it('a RED marker recorded for a covered stale sha still REFUSES — the carry-forward preserves the STATUS, not just the shape', () => {
    writeAndAdd('scripts/verify-lane.mjs', 'base\n');
    writeAndAdd('scripts/operations/ci-heal-pr-dispatch.mjs', 'base\n');
    commit('base');
    const main = laneBranch();
    execFileSync('git', ['branch', 'origin/main'], { maxBuffer: 2 * 1024 * 1024, cwd: dir });

    writeAndAdd('scripts/verify-lane.mjs', 'lane edit\n');
    commit('lane edit');
    const laneSha = headSha();
    writeFileSync(join(gitDirOf(dir), '.lane-verify'), JSON.stringify({ sha: laneSha, status: 'red', startedAt: 't', finishedAt: 'u', suites: 'test', exitCode: 2 }, null, 2) + '\n');

    execFileSync('git', ['checkout', '-q', 'origin/main'], { maxBuffer: 2 * 1024 * 1024, cwd: dir });
    writeAndAdd('scripts/operations/ci-heal-pr-dispatch.mjs', 'upstream edit\n');
    commit('upstream edit');
    execFileSync('git', ['checkout', '-q', main], { maxBuffer: 2 * 1024 * 1024, cwd: dir });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'merge', '--no-edit', '-q', 'origin/main'], { maxBuffer: 2 * 1024 * 1024, cwd: dir });
    const mergeSha = headSha();

    const gate = resolveFinishGuardVerdict({
      gitDir: gitDirOf(dir), headSha: mergeSha, remote: 'origin', base: 'main', runGit, readMarker: readVerifyMarker,
    });

    expect(gate).toMatchObject({ ok: false, status: 'red', reason: 'verify-red' });
  });

  it('an unreachable recordSha (a torn/foreign marker) fails CLOSED, never open — the real `git diff` throws and the caller\'s runGit propagates it', () => {
    writeAndAdd('scripts/verify-lane.mjs', 'base\n');
    commit('base');
    execFileSync('git', ['branch', 'origin/main'], { maxBuffer: 2 * 1024 * 1024, cwd: dir });
    writeAndAdd('scripts/verify-lane.mjs', 'lane edit\n');
    commit('lane edit');
    // No checkout back to `main` needed here — this test never touches `origin/main` again.

    // A marker for a sha this repo has never seen (never gc'd — simply never existed here).
    writeGreenMarker('f'.repeat(40));
    const mergeSha = headSha();

    const gate = resolveFinishGuardVerdict({
      gitDir: gitDirOf(dir), headSha: mergeSha, remote: 'origin', base: 'main', runGit, readMarker: readVerifyMarker,
    });

    // real `git diff --name-only <bogus> <mergeSha>` throws (execFileSync throws on git's non-zero exit) —
    // laneRelevantChangeSince's try/catch turns that into `null`, which verifyGateDecision treats as UNKNOWN,
    // never as "no overlap" — the exact fail-closed contract laneRelevantChangeSince's own doc states.
    expect(gate).toMatchObject({ ok: false, status: 'absent', reason: 'unverified' });
  });
});

describe('resolveFinishGuardVerdict — a green marker carries over docs-only commits (delivery-blocker R826)', () => {
  const setup = () => {
    writeAndAdd('scripts/a.mjs', 'base\n');
    commit('base');
    execFileSync('git', ['branch', 'origin/main'], { maxBuffer: 2 * 1024 * 1024, cwd: dir });
    writeAndAdd('scripts/a.mjs', 'lane edit\n');
    commit('fix');
    const sha = headSha();
    writeGreenMarker(sha);
    return sha;
  };
  const verdict = () => resolveFinishGuardVerdict({ gitDir: gitDirOf(dir), headSha: headSha(), remote: 'origin', base: 'main', runGit, readMarker: readVerifyMarker });

  it('accepts a backlog card committed after the marker', () => {
    setup();
    writeAndAdd('backlog/9999-x.md', 'card\n');
    commit('card');
    expect(verdict()).toMatchObject({ ok: true, reason: 'verified' });
    expect(verdict().detail).toMatch(/verify-marker carried from/);
  });
  it('REFUSES a code commit after the marker', () => {
    setup();
    writeAndAdd('scripts/a.mjs', 'more code\n');
    commit('code');
    expect(verdict().ok).toBe(false);
  });
  it('REFUSES a script under docs/ (only .md counts)', () => {
    setup();
    writeAndAdd('docs/tool.mjs', 'x\n');
    commit('docs script');
    expect(verdict().ok).toBe(false);
  });
  it('REFUSES a root README.md (only backlog/ or docs/ .md counts)', () => {
    setup();
    writeAndAdd('README.md', 'x\n');
    commit('root md');
    expect(verdict().ok).toBe(false);
  });
  it('REFUSES code renamed to a docs .md name', () => {
    setup();
    writeAndAdd('docs/a.md', 'lane edit\n'); // identical content: git sees a rename
    execFileSync('git', ['rm', '-q', 'scripts/a.mjs'], { maxBuffer: 2 * 1024 * 1024, cwd: dir });
    commit('rename code to md');
    expect(verdict().ok).toBe(false);
  });
  it('REFUSES a marker on a non-ancestor commit', () => {
    setup();
    execFileSync('git', ['checkout', '-q', '--orphan', 'other'], { maxBuffer: 2 * 1024 * 1024, cwd: dir });
    writeAndAdd('backlog/1-y.md', 'c\n');
    commit('orphan card');
    expect(verdict().ok).toBe(false);
  });
});


describe('finish-guard shared readMarker wiring', () => {
  const setup = () => {
    writeAndAdd('code.txt', 'base\n'); commit('base');
    runGit(['remote', 'add', 'origin', 'https://github.com/example/project.git']);
    const sha = headSha();
    runGit(['update-ref', 'refs/remotes/origin/main', sha]);
    const mergeBase = sha, coordRoot = join(dir, 'coord');
    const sibling = join(fixtureRoot, 'frontierui');
    execFileSync('git', ['clone', '-q', dir, sibling], { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });
    mkdirSync(join(sibling, 'plugs')); mkdirSync(join(sibling, 'webtheme'));
    const policyKey = verifyGate.verifyPolicyKey({}, { root: dir });
    const record = { v: 1, writer: 'verify-lane', repo: 'example/project', sha, mergeBase, revertRed: null, policyKey, status: 'green', exitCode: 0,
      executedGate: 'npm run test:unit', selectionMode: 'pr', deltaBase: null, finishedAt: new Date().toISOString(), lane: 'lane-A' };
    expect(sharedStore.publishGreen({ coordRoot, repo: record.repo, sha, mergeBase, policyKey, record })).toBe(true);
    const logs = [];
    const read = (env = {}, head = sha, base = 'main', runner = runGit) => land.readFinishGuardMarker({ gitDir: gitDirOf(dir), headSha: head,
      remote: 'origin', base, runGit: runner, coordRoot, env: { WE_VERIFY_SHARED_GREEN_REUSE: '1', ...env }, log: text => logs.push(text) });
    return { sha, read, logs, coordRoot, policyKey, record };
  };
  it('F8 default-off shared reuse preserves the exact local read and records shadow acceptance', () => {
    const { read, logs, coordRoot } = setup();
    expect(read({ WE_VERIFY_SHARED_GREEN_REUSE: '0' })).toEqual(readVerifyMarker(gitDirOf(dir)));
    expect(logs.join('\n')).toMatch(/shared-reuse shadow: would-accept \(sharedFrom /);
    expect(JSON.parse(readFileSync(join(coordRoot, 'verify-shared-shadow.log'), 'utf8').trim())).toMatchObject({ verdict: 'would-accept' });
  });
  it.each(['red', 'running', 'corrupt', 'stale-green', 'exact-green'])
    ('F8 default-off returns the unchanged local %s evidence and logs refusal or acceptance', kind => {
      const { sha, read, logs, coordRoot } = setup();
      writeFileSync(join(gitDirOf(dir), '.lane-verify'), kind === 'corrupt' ? '{bad' : JSON.stringify({
        sha: kind === 'stale-green' ? 'e'.repeat(40) : sha, status: kind.endsWith('green') ? 'green' : kind, suites: 'local',
      }));
      const local = readVerifyMarker(gitDirOf(dir));
      expect(read({ WE_VERIFY_SHARED_GREEN_REUSE: '0' })).toEqual(local);
      expect(logs.join('\n')).toMatch(kind === 'stale-green' ? /shared-reuse shadow: would-accept/ : /shared-reuse shadow: would-refuse/);
      const line = JSON.parse(readFileSync(join(coordRoot, 'verify-shared-shadow.log'), 'utf8').trim());
      expect(line.verdict).toBe(kind === 'stale-green' ? 'would-accept' : 'would-refuse');
    });
  it('F8 shadow append failures preserve main local behavior and never throw', () => {
    const { read, coordRoot, logs } = setup();
    mkdirSync(join(coordRoot, 'verify-shared-shadow.log'));
    expect(read({ WE_VERIFY_SHARED_GREEN_REUSE: '0' })).toBeNull();
    expect(logs.join('\n')).toMatch(/shared-reuse shadow: would-accept/);
  });
  it('F8 absent shared evidence logs a one-line shadow refusal', () => {
    const { read, logs } = setup();
    expect(read({ WE_VERIFY_SHARED_GREEN_REUSE: '0', WE_NEW_POLICY_KNOB: 'different' })).toBeNull();
    expect(logs.filter(line => line.includes('shared-reuse shadow:'))).toEqual([
      'pr-land: shared-reuse shadow: would-refuse (local precedence or shared evidence unavailable)',
    ]);
  });
  it('reads the exact consumer SHA and computed policy, logs sharedFrom on acceptance and key inputs on refusal', () => {
    const { sha, read, logs } = setup();
    expect(read()).toMatchObject({ sha, status: 'green', suites: 'npm run test:unit', sharedFrom: { lane: 'lane-A' } });
    expect(logs.join('\n')).toMatch(/sharedFrom.*lane-A.*\d{4}-/);
    expect(read({ WE_BUILD_FINAL_GATE: 'none' })).toBeNull();
    expect(logs.join('\n')).toMatch(/policyKey.*finalGate.*none.*finalGateStandards.*diffTestSelection/);
    expect(read({}, 'f'.repeat(40))).toBeNull();
  });
  it.each(['red', 'running', 'green', 'corrupt'])('local %s at head decides before shared green', status => {
    const { sha, read, logs } = setup();
    writeFileSync(join(gitDirOf(dir), '.lane-verify'), status === 'corrupt' ? '{bad' : JSON.stringify({ sha, status, suites: 'local' }));
    expect(read()).toMatchObject(status === 'corrupt' ? { corrupt: true } : { sha, status, suites: 'local' });
    expect(read().sharedFrom).toBeUndefined();
    if (status !== 'green') expect(logs.join('\n')).toMatch(/policyKey=.*finalGate.*finalGateStandards.*diffTestSelection/);
  });
  it('stale local yields to shared head but remains available for existing carry-forward when shared is absent', () => {
    const { sha, read } = setup();
    const stale = { sha: 'e'.repeat(40), status: 'green', suites: 'old' };
    writeFileSync(join(gitDirOf(dir), '.lane-verify'), JSON.stringify(stale));
    expect(read()).toMatchObject({ sha, sharedFrom: { lane: 'lane-A' } });
    expect(read({ WE_BUILD_FINAL_GATE: 'none' })).toMatchObject(stale);
  });
  it.each(['red', 'running', 'unknown'])('stale local %s refuses despite exact shared head', status => {
    const { read } = setup();
    const stale = { sha: 'e'.repeat(40), status, suites: 'old' };
    writeFileSync(join(gitDirOf(dir), '.lane-verify'), JSON.stringify(stale));
    expect(read()).toMatchObject(stale);
    expect(resolveFinishGuardVerdict({ gitDir: gitDirOf(dir), headSha: headSha(), remote: 'origin', base: 'main',
      runGit, readMarker: () => read() }).ok).toBe(false);
  });
  it('another consumer merge base cannot reuse shared green and the CLI base selects the ref', () => {
    const { sha, read, coordRoot, policyKey, record } = setup();
    runGit(['update-ref', 'refs/remotes/origin/release', sha]);
    writeAndAdd('code.txt', 'next\n'); commit('next');
    const head = headSha();
    expect(sharedStore.publishGreen({ coordRoot, repo: record.repo, sha: head, mergeBase: sha, policyKey,
      record: { ...record, sha: head } })).toBe(true);
    expect(read({}, head)).toMatchObject({ sha: head, sharedFrom: { lane: 'lane-A' } });
    runGit(['update-ref', 'refs/remotes/origin/main', head]);
    expect(read({}, head)).toBeNull(); // same head, newly advanced base: the old record is absent
    const calls = [];
    expect(read({}, head, 'release', argv => { calls.push(argv); return runGit(argv); })).toMatchObject({ sharedFrom: { lane: 'lane-A' } });
    expect(calls).toContainEqual(['merge-base', head, 'origin/release']);
  });
  it('failed merge-base computation treats shared as absent and preserves local carry-forward evidence', () => {
    const { read } = setup();
    const failed = argv => { if (argv[0] === 'merge-base') throw new Error('unavailable base'); return runGit(argv); };
    expect(read({}, headSha(), 'main', failed)).toBeNull();
    const stale = { sha: 'e'.repeat(40), status: 'green', suites: 'old' };
    writeFileSync(join(gitDirOf(dir), '.lane-verify'), JSON.stringify(stale));
    expect(read({}, headSha(), 'main', failed)).toMatchObject(stale);
  });
  it('CLI finish guard actually supplies the shared reader with refSha and its git runner', () => {
    const source = readFileSync(join(process.cwd(), 'scripts/pr-land.mjs'), 'utf8');
    const finishArgs = source.slice(source.indexOf('const finishArgs ='), source.indexOf('const gate = resolveFinishGuardVerdict', source.indexOf('const finishArgs =')));
    expect(finishArgs).toMatch(/readMarker:.*readFinishGuardMarker/s);
    expect(finishArgs).toMatch(/headSha: refSha/);
    expect(finishArgs).toMatch(/runGit: gitC/);
    expect(finishArgs).toMatch(/headSha: refSha, remote: REMOTE, base: BASE/);
  });
});

// S1 landing authority is distinct from the historical WIP/carry-forward fixtures above.
describe('S1 atomic local landing', () => {
  const sha = 'a'.repeat(40), policyKey = 'b'.repeat(64), treeHash = 'c'.repeat(64);
  const gatePlan = { command: 'gate', mode: 'selected', selectionMode: 'pr', deltaBase: null };
  const record = () => ({ v: 2, writer: 'verify-lane', runId: 'A', sha, status: 'green', exitCode: 0,
    policyKey, policyInputs: null, gatePlan, treeHash });
  const landing = { policyKey, gatePlan, treeHash, cleanTree: true };
  const decide = (rec = record(), extra = {}) => resolveFinishGuardVerdict({ headSha: sha,
    readMarker: () => rec, landingContext: landing, ...extra });
  it('atomic-v1-no-shadow-bypass: complete non-null v2 passes and null-key refuses', () => {
    expect(decide()).toMatchObject({ ok: true, reason: 'verified' });
    expect(decide({ ...record(), policyKey: null })).toMatchObject({ ok: false, reason: 'stale:producer-key-null' });
  });
  it.each([{ requireVerified: false }, { ciOnly: { ok: true } }, { ciCheckRuns: [] }])('invalid-never-substitutes %j', extra => {
    expect(decide({ ...record(), exitCode: 1 }, extra)).toMatchObject({ ok: false, reason: 'invalid:exit-status' });
  });
  it('break-glass is the first explicit override', () => {
    expect(decide({ corrupt: true }, { breakGlass: true }).reason).toBe('break-glass');
  });
  it('L-head pins key/plan before varying head; explicit mismatch follows key checks', () => {
    expect(decide({ ...record(), sha: 'd'.repeat(40) }).reason).toBe('stale:other-head');
    expect(decide(record(), { landingContext: { ...landing, cleanTree: false } }).reason).toBe('stale:tree-mismatch');
    const rec = { ...record(), gateExplicit: true, gatePlan: { ...gatePlan, command: 'other' } };
    expect(decide(rec).reason).toBe('stale:gate-explicit');
    expect(decide({ ...rec, policyKey: null }).reason).toBe('stale:producer-key-null');
  });
  it('L-input-failure: thrown identity reads are unavailable proof', () => {
    expect(decide(record(), { landingContext: () => { throw new Error('unreadable'); } })).toMatchObject({ ok: false, reason: 'stale:consumer-key-unavailable' });
  });
});
