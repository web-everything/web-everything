// VERIFY-MARKER-PER-SHA: a green marker written in lane A is honoured in lane B at the same sha, tree and policy.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, statSync, chmodSync, symlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  writeSharedVerifyMarker, readSharedVerifyMarker, withdrawSharedVerifyMarker, publishSharedVerifyMarker,
  newSharedGeneration, resolveMarkerWithShared, verifyGateDecision, readVerifyMarker,
} from '../lib/lane-verify.mjs';

const SHA = 'a'.repeat(40);
const TREE = 'tree-1';
const POLICY = 'policy-1';
const repo = 'acme/widgets';
const green = { sha: SHA, status: 'green', treeHash: TREE, suites: 'gate', executedGate: 'gate', policyKey: POLICY, exitCode: 0, gateExplicit: false, local: false, finishedAt: '2026-11-25T10:00:00Z' };
const dir = () => mkdtempSync(join(tmpdir(), 'verify-shared-'));
const gate = (record) => verifyGateDecision({ record, headSha: SHA, requireVerified: true });
const read = (d, extra = {}) => readSharedVerifyMarker({ dir: d, repo, sha: SHA, treeHash: TREE, policyKey: POLICY, ...extra });
const file = (d) => join(d, 'acme__widgets', 'default', `${SHA}.json`);
/** One producer run: start (tombstone) then publish. */
function run(d, generation, record = green, lane = 'lane-2') {
  const started = withdrawSharedVerifyMarker({ dir: d, repo, sha: SHA, generation });
  return { started, published: publishSharedVerifyMarker({ dir: d, repo, sha: SHA, generation, record, lane }) };
}

describe('shared verify marker', () => {
  it('a green marker written in lane A is honoured in lane B at the same sha and tree', () => {
    const d = dir();
    expect(run(d, newSharedGeneration(1000)).published).toBe(true);
    const local = readVerifyMarker(mkdtempSync(join(tmpdir(), 'laneb-')));
    expect(local).toBeNull();
    const rec = resolveMarkerWithShared({ local, headSha: SHA, readShared: () => read(d) });
    expect(rec.sharedFrom.lane).toBe('lane-2');
    expect(gate(rec).ok).toBe(true);
    expect(statSync(file(d)).mode & 0o777).toBe(0o600);
    expect(statSync(join(d, 'acme__widgets')).mode & 0o777).toBe(0o700);
  });

  it('refuses a sha that was never verified', () => {
    const rec = resolveMarkerWithShared({ local: null, headSha: SHA, readShared: () => read(dir()) });
    expect(gate(rec).ok).toBe(false);
  });

  it('refuses when the tree hash differs at the same sha', () => {
    const d = dir();
    run(d, newSharedGeneration(1000));
    expect(gate(read(d, { treeHash: 'dirty' })).ok).toBe(false);
    expect(gate(read(d, { treeHash: null })).ok).toBe(false);
  });

  it('refuses a marker for another repo or gate', () => {
    const d = dir();
    run(d, newSharedGeneration(1000));
    expect(read(d, { repo: 'acme/other' })).toBeNull();
    expect(read(d, { gate: 'custom' })).toBeNull();
  });

  it('refuses a running, unreadable or foreign-owned shared marker', () => {
    const d = dir();
    withdrawSharedVerifyMarker({ dir: d, repo, sha: SHA, generation: newSharedGeneration(1000) });
    expect(gate(read(d)).ok).toBe(false);
    const d2 = dir();
    run(d2, newSharedGeneration(1000));
    writeFileSync(file(d2), '{torn', { mode: 0o600 });
    expect(read(d2)).toEqual({ corrupt: true });
    const d3 = dir();
    run(d3, newSharedGeneration(1000));
    expect(read(d3, { uid: 999999 })).toEqual({ corrupt: true });
  });

  it('refuses a policy mismatch, and a record that does not store its executed gate', () => {
    const d = dir();
    run(d, newSharedGeneration(1000));
    expect(read(d, { policyKey: 'weaker-policy' })).toEqual({ corrupt: true });
    expect(read(d, { policyKey: undefined })).toEqual({ corrupt: true });
    const d2 = dir();
    writeSharedVerifyMarker({ dir: d2, repo, record: { ...green, suites: undefined, generation: 'g' } });
    expect(read(d2)).toEqual({ corrupt: true });
  });

  it('never publishes explicit, local, skipped or nonzero runs, and refuses them if found', () => {
    for (const bad of [{ exitCode: 1 }, { skipped: 'card-only' }, { gateExplicit: true }, { local: true }]) {
      const d = dir();
      expect(run(d, newSharedGeneration(1000), { ...green, ...bad }).published).toBe(false);
      writeSharedVerifyMarker({ dir: d, repo, record: { ...green, generation: 'g', ...bad } });
      expect(gate(read(d)).ok).toBe(false);
    }
  });

  it('an older run can never overwrite a newer run, and only the owner of the tombstone publishes', () => {
    const d = dir();
    const older = newSharedGeneration(1000), newer = newSharedGeneration(2000);
    expect(withdrawSharedVerifyMarker({ dir: d, repo, sha: SHA, generation: older })).toBe('written');
    expect(withdrawSharedVerifyMarker({ dir: d, repo, sha: SHA, generation: newer })).toBe('written');
    // the older finisher cannot publish, and cannot take the tombstone back
    expect(publishSharedVerifyMarker({ dir: d, repo, sha: SHA, generation: older, record: green })).toBe(false);
    expect(withdrawSharedVerifyMarker({ dir: d, repo, sha: SHA, generation: older })).toBe('superseded');
    expect(gate(read(d)).ok).toBe(false); // newer run still unfinished: running refuses
    expect(publishSharedVerifyMarker({ dir: d, repo, sha: SHA, generation: newer, record: green })).toBe(true);
    expect(gate(read(d)).ok).toBe(true);
    // a publish without any tombstone is refused
    expect(publishSharedVerifyMarker({ dir: dir(), repo, sha: SHA, generation: newer, record: green })).toBe(false);
  });

  it('a later running/red start withdraws the shared green', () => {
    const d = dir();
    run(d, newSharedGeneration(1000));
    expect(gate(read(d)).ok).toBe(true);
    expect(withdrawSharedVerifyMarker({ dir: d, repo, sha: SHA, generation: newSharedGeneration(3000), reason: 'red' })).toBe('written');
    expect(gate(read(d)).ok).toBe(false);
  });

  it('a local running or red marker for another sha is never replaced by a shared green', () => {
    const d = dir();
    run(d, newSharedGeneration(1000));
    for (const status of ['running', 'red']) {
      const local = { sha: 'b'.repeat(40), status, treeHash: TREE };
      expect(resolveMarkerWithShared({ local, headSha: SHA, readShared: () => read(d) })).toBe(local);
    }
  });

  it('treats any stat error other than ENOENT as corrupt, and refuses symlinked or open parents', () => {
    const d = dir();
    run(d, newSharedGeneration(1000));
    chmodSync(file(d), 0o666);
    expect(read(d)).toEqual({ corrupt: true });
    chmodSync(file(d), 0o600);
    chmodSync(join(d, 'acme__widgets', 'default'), 0o755);
    expect(read(d)).toEqual({ corrupt: true });
    chmodSync(join(d, 'acme__widgets', 'default'), 0o700);
    expect(gate(read(d)).ok).toBe(true);
    // parent is a regular file => ENOTDIR, not "absent"
    const d2 = dir();
    writeFileSync(join(d2, 'acme__widgets'), 'x');
    expect(read(d2)).toEqual({ corrupt: true });
    // a symlinked parent directory is refused
    const d3 = dir(), real = dir();
    run(real, newSharedGeneration(1000));
    symlinkSync(join(real, 'acme__widgets'), join(d3, 'acme__widgets'));
    expect(read(d3)).toEqual({ corrupt: true });
    // a dangling symlink leaf is not "absent"
    const d4 = dir();
    run(d4, newSharedGeneration(1000));
    const leaf = file(d4);
    writeFileSync(`${leaf}.x`, '');
    symlinkSync('/nonexistent-target', join(d4, 'acme__widgets', 'default', `${'b'.repeat(40)}.json`));
    expect(readSharedVerifyMarker({ dir: d4, repo, sha: 'b'.repeat(40), treeHash: TREE, policyKey: POLICY })).toEqual({ corrupt: true });
  });

  it('refuses a malformed sha key', () => {
    expect(writeSharedVerifyMarker({ dir: dir(), repo, record: { ...green, sha: '../x' } })).toBe(false);
  });
});

describe('production wiring (the entry points really use the shared store)', () => {
  const root = process.cwd();
  const verifyLane = readFileSync(join(root, 'scripts/verify-lane.mjs'), 'utf8');
  const prLand = readFileSync(join(root, 'scripts/pr-land.mjs'), 'utf8');
  it('verify-lane withdraws on every non-green write, publishes only default non-local runs, and carries the policy key', () => {
    expect(verifyLane).toMatch(/record\?\.status !== 'green'[\s\S]{0,400}withdrawSharedVerifyMarker/);
    expect(verifyLane).toMatch(/if \(!gateExplicit && !FORCE_LOCAL\)[\s\S]{0,600}publishSharedVerifyMarker/);
    expect(verifyLane).toMatch(/policyKey: verifyPolicyKey\(process\.env\)/);
    expect(verifyLane).toMatch(/\{ publish: false \}/); // withdrawal is not limited to pool lanes
  });
  it('pr-land reads the shared marker through the hardened git env with the consumer policy key, failing closed', () => {
    expect(prLand).toMatch(/hardenLaneGitArgs\(args\)[\s\S]{0,200}laneGitHardeningEnv\(process\.env\)/);
    expect(prLand).toMatch(/runGit: hardened/);
    expect(prLand).toMatch(/policyKey: verifyPolicyKey\(process\.env\)/);
    expect(prLand).toMatch(/catch \{ return \{ corrupt: true \}; \}/);
  });
});
