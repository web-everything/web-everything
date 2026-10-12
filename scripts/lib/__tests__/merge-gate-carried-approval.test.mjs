// @vitest-environment node
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { proveHumanClearanceCarry, latestHumanClearance } from '../human-clearance-carry.mjs';
import { buildReviewedShaMarker, buildReviewedDiffMarker, buildClearedHumanMarker } from '../review-escalation.mjs';
import { evaluatePrGates, resolveCarryApproval, loadCarryApproval, loadMergeGateMode, STANDARD_CARRY_APPROVAL, CARRY_APPROVAL_ENV } from '../merge-gate-ci.mjs';

const dirs = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function repository({ mainFirst = true, conflict = false } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'gate-carry-')); dirs.push(cwd);
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Carry test'); git('config', 'user.email', 'carry@example.test');
  mkdirSync(join(cwd, 'src'));
  const commit = (file, text) => { writeFileSync(join(cwd, file), text); git('add', '.'); git('commit', '-qm', 'fixture'); return git('rev-parse', 'HEAD'); };
  commit('src/x.txt', 'base\n'); git('checkout', '-qb', 'lane');
  const a = commit('src/x.txt', 'PR change\n');
  git('checkout', '-q', 'main');
  const main = commit(conflict ? 'src/x.txt' : 'unrelated.txt', 'main change\n');
  git('update-ref', 'refs/remotes/origin/main', main);
  const diff = (sha) => git('diff', git('merge-base', main, sha), sha);
  const humanClearance = latestHumanClearance([{ viewerDidAuthor: true, body: [buildReviewedShaMarker(a), buildReviewedDiffMarker(diff(a)), buildClearedHumanMarker('op')].join('\n') }]);
  if (!mainFirst) git('checkout', '-q', 'lane');
  try { git('merge', '--no-ff', '--no-edit', mainFirst ? 'lane' : 'main'); }
  catch (e) { if (!conflict) throw e; commit('src/x.txt', 'resolved differently\n'); }
  const b = git('rev-parse', 'HEAD');
  const evidence = (sha = b) => ({ headSha: sha, headDiff: diff(sha), headDiffSha: sha, humanClearance });
  return { cwd, git, commit, a, b, main, evidence, prove: (e = evidence(), exec = execFileSync) => proveHumanClearanceCarry({ evidence: e, cwd, exec }) };
}

describe('shared carry proof against real git', () => {
  it.each([true, false])('carries identical content with main-first=%s', (mainFirst) => {
    const r = repository({ mainFirst });
    expect(r.git('show', '-s', '--format=%P', r.b).split(' ')).toEqual(mainFirst ? [r.main, r.a] : [r.a, r.main]);
    expect(r.prove()).toMatchObject({ carry: true, applicable: true, fromSha: r.a, toSha: r.b, actor: 'op' });
  });
  it('refuses an author commit changing the PR diff', () => {
    const r = repository(); const c = r.commit('src/x.txt', 'new author change\n');
    expect(r.prove(r.evidence(c))).toMatchObject({ carry: false, reason: expect.stringContaining('net diff changed') });
  });
  it('refuses non-merge author commits even when their final net diff is identical', () => {
    const r = repository();
    r.commit('src/x.txt', 'temporary author change\n');
    const c = r.commit('src/x.txt', 'PR change\n');
    expect(r.prove(r.evidence(c))).toMatchObject({ carry: false, reason: expect.stringContaining('not a merge') });
  });
  it('refuses conflict resolution changing the PR lines', () => {
    expect(repository({ conflict: true }).prove()).toMatchObject({ carry: false, reason: expect.stringContaining('net diff changed') });
  });
  it('fails closed on absent fingerprints, mismatched heads and unreadable git', () => {
    const r = repository(); const e = r.evidence(); const exec = vi.fn(() => { throw new Error('unreadable'); });
    expect(r.prove({ ...e, humanClearance: { ...e.humanClearance, diff: null } }, exec).carry).toBe(false);
    expect(r.prove({ ...e, headDiffSha: r.a }, exec).carry).toBe(false);
    expect(exec).not.toHaveBeenCalled();
    expect(r.prove(e, exec).carry).toBe(false);
    const broken = { get humanClearance() { throw new Error('broken evidence'); } };
    expect(r.prove(broken)).toMatchObject({ carry: false, applicable: true, reason: 'carry proof failed: broken evidence' });
    expect(r.prove({ ...e, humanClearance: null })).toMatchObject({ carry: false, applicable: false });
    expect(r.prove({ ...e, headSha: r.a.toUpperCase() })).toMatchObject({ carry: false, applicable: false });
  });
});

const A = 'a'.repeat(40), B = 'b'.repeat(40);
const facts = () => ({
  repo: 'o/r', pr: { number: 7, body: 'Real body', baseRefName: 'main', headRefOid: B, labels: ['ready-to-merge', 'review:accepted'], commits: [] },
  defaultBranch: 'main', pinnedHead: { sha: B }, gatePaths: { files: ['.github/workflows/test.yml'] },
  manifest: { live: null }, netSignals: { scored: true, changedFiles: ['docs/a.md'], diffLines: 2, humanBasisFiles: ['docs/a.md'], cumulativeDiffLines: 2, netDiffText: { text: "diff --git a/x.test.mjs b/x.test.mjs\ndeleted file mode 100644\n--- a/x.test.mjs\n+++ /dev/null\n@@ -1 +0,0 @@\n-it('a', () => {})\n" } },
  acceptance: { headSha: B, acceptedSha: B, humanClearedSha: A, humanClearance: { sha: A, diff: 'fingerprint', actor: 'op' } },
});
const carried = { carry: true, applicable: true, fromSha: A, toSha: B };
const options = (extra = {}) => ({ carrySetting: { value: 'on', source: 'repo' }, proveCarry: () => carried, write: () => {}, ...extra });
const gate = (result, id = 'review-acceptance') => result.results.find((g) => g.id === id);
describe('gate carry integration', () => {
  it('clears both workflow and test-gaming holds using effective acceptance, without mutating facts', () => {
    const write = vi.fn(); const proveCarry = vi.fn(() => carried);
    const f = facts(); const before = evaluatePrGates(f, options({ write, proveCarry, carrySetting: { value: 'off', source: 'env' } }));
    expect(proveCarry).not.toHaveBeenCalled();
    for (const id of ['review-acceptance', 'test-gaming']) expect(gate(before, id).status).toBe('hold');
    expect(gate(before).reason).toContain('mergeGate.carryApproval=off, source: env');
    const after = evaluatePrGates(f, options({ write, proveCarry }));
    expect(proveCarry).toHaveBeenCalledWith({ evidence: f.acceptance, pinnedSha: B });
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith('merge-gate · mergeGate.carryApproval=off (source: env)\n');
    for (const id of ['review-acceptance', 'test-gaming']) expect(gate(after, id).status).toBe('pass');
    expect(gate(after).reason).toContain(`human clearance carried ${A.slice(0, 9)}→${B.slice(0, 9)} (mergeGate.carryApproval=on, source: repo)`);
    expect(after.clearanceCarry).toMatchObject(carried);
    expect(f.acceptance.humanClearedSha).toBe(A);
  });
  it.each([
    () => ({ carry: false, applicable: true, reason: 'changed diff' }),
    () => ({ ...carried, toSha: A }),
    () => { throw new Error('git unavailable'); },
  ])('refuses unproven or wrongly bound carries', (proveCarry) => {
    const result = evaluatePrGates(facts(), options({ proveCarry }));
    expect(gate(result).status).toBe('hold'); expect(gate(result, 'test-gaming').status).toBe('hold');
    expect(gate(result).reason).toContain('clearance not carried:');
  });
  it('uses supplied facts without invoking proof and checks both head bindings', () => {
    const proveCarry = vi.fn(); const f = { ...facts(), clearanceCarry: { ...carried, toSha: B.toUpperCase() } };
    expect(gate(evaluatePrGates(f, options({ proveCarry }))).status).toBe('pass');
    f.acceptance.headSha = A;
    expect(gate(evaluatePrGates(f, options({ proveCarry }))).status).toBe('hold');
    expect(proveCarry).not.toHaveBeenCalled();
  });
  it('refuses supplied valid carry when the setting is off', () => {
    const proveCarry = vi.fn();
    const result = evaluatePrGates({ ...facts(), clearanceCarry: carried }, options({ proveCarry, carrySetting: { value: 'off', source: 'env' } }));
    for (const id of ['review-acceptance', 'test-gaming']) expect(gate(result, id).status).toBe('hold');
    expect(gate(result).reason).toContain('mergeGate.carryApproval=off, source: env');
    expect(gate(result).reason).toContain('carry approval disabled');
    expect(proveCarry).not.toHaveBeenCalled();
  });
  it('does not evaluate carry without eligible acceptance and a pinned head', () => {
    for (const over of [{ acceptance: null }, { acceptance: { error: 'read error' } }, { pinnedHead: null }, { acceptance: { humanClearance: { sha: B } } }]) {
      const proveCarry = vi.fn(); evaluatePrGates({ ...facts(), ...over }, options({ proveCarry })); expect(proveCarry).not.toHaveBeenCalled();
    }
  });
});

describe('carry setting cascade shares mode layer handling', () => {
  it('defaults on and walks platform, repo, env in order', () => {
    expect(STANDARD_CARRY_APPROVAL).toBe('on'); expect(CARRY_APPROVAL_ENV).toBe('MERGE_GATE_CARRY_APPROVAL');
    for (const [layers, value, source] of [[{}, 'on', 'standard'], [{ platform: 'off' }, 'off', 'platform'], [{ platform: 'off', repo: 'on' }, 'on', 'repo'], [{ repo: 'on', env: 'off' }, 'off', 'env']]) {
      expect(resolveCarryApproval(layers)).toMatchObject({ value, source });
    }
    for (const layers of [{ env: 'ON' }, { platform: false, env: 'on' }, { repo: 'bad' }, { readErrors: ['unreadable'] }]) {
      expect(resolveCarryApproval(layers)).toMatchObject({ value: 'off', source: expect.stringContaining('fail-closed') });
    }
  });
  it('loads both keys together and fails closed on unreadable or malformed layers', () => {
    const opts = { env: {}, readFile: () => JSON.stringify({ mergeGate: { mode: 'enforce', carryApproval: 'off' } }), readDeclared: () => ({ settings: { mergeGate: { mode: 'shadow', carryApproval: 'on' } } }) };
    expect(loadCarryApproval(opts)).toMatchObject({ value: 'on', source: 'repo' });
    expect(loadMergeGateMode(opts)).toMatchObject({ mode: 'shadow', source: 'repo' });
    expect(loadCarryApproval({ ...opts, env: { MERGE_GATE_CARRY_APPROVAL: 'off' } })).toMatchObject({ value: 'off', source: 'env' });
    const missingPlatform = { ...opts, readFile: () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); } };
    expect(loadCarryApproval(missingPlatform)).toMatchObject({ value: 'on', source: 'repo' });
    expect(loadCarryApproval({ ...missingPlatform, readDeclared: () => ({ settings: { mergeGate: { mode: 'shadow' } } }) })).toMatchObject({ value: 'on', source: 'standard' });
    for (const over of [{ readFile: () => { throw new Error('EACCES'); } }, { readFile: () => '{' }, { readFile: () => '{"mergeGate":[]}' }, { readDeclared: () => ({ settings: { mergeGate: null } }) }, { readDeclared: () => { throw new Error('unreadable'); } }]) {
      expect(loadCarryApproval({ ...opts, ...over })).toMatchObject({ value: 'off', source: expect.stringContaining('fail-closed') });
      expect(loadMergeGateMode({ ...opts, ...over })).toMatchObject({ mode: 'enforce', source: expect.stringContaining('fail-closed') });
    }
  });
});
