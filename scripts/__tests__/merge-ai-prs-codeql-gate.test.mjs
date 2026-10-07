/**
 * @file The drain refuses to land a PR whose CodeQL check concluded FAILURE (drainBlocksOnCodeQL, default on).
 * Incident: PR #4236 merged at 12:10Z with CodeQL FAILURE ("1 new alert including 1 high severity") because
 * CodeQL is not a required check. The fixture is #4236's real statusCheckRollup.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyPr, isCodeQLFailed, loadDrainGateSettings } from '../merge-ai-prs.mjs';

const rollup4236 = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'pr4236-rollup.json'), 'utf8'));
const landable = (statusCheckRollup) => ({
  number: 4236, title: 't', body: 'A real description of the change.', baseRefName: 'main', mergeable: 'MERGEABLE',
  mergeStateStatus: 'UNSTABLE', labels: [{ name: 'ready-to-merge' }], statusCheckRollup, commits: [],
});
const withCodeQL = (conclusion) => rollup4236.map((c) => (c.name === 'CodeQL' ? { ...c, conclusion } : c));

describe('drain CodeQL gate (drainBlocksOnCodeQL)', () => {
  it('replays #4236: the real rollup (test green, CodeQL FAILURE) is held, not merged', () => {
    const v = classifyPr(landable(rollup4236), { defaultBranch: 'main' });
    expect(v.testGreen).toBe(true);
    expect(v.decision).toBe('skip');
    expect(v.codeqlBlocked).toBe(true);
    expect(v.reason).toMatch(/CodeQL check failed/);
  });
  it('the same PR with CodeQL SUCCESS still merges (no new false holds)', () => {
    expect(classifyPr(landable(withCodeQL('SUCCESS')), { defaultBranch: 'main' }).decision).toBe('merge');
  });
  it('a PR with no CodeQL check at all still merges', () => {
    expect(classifyPr(landable(rollup4236.filter((c) => c.name !== 'CodeQL')), { defaultBranch: 'main' }).decision).toBe('merge');
  });
  it('the knob turns it off (blockOnCodeQL=false) without touching other checks', () => {
    expect(classifyPr(landable(rollup4236), { defaultBranch: 'main', blockOnCodeQL: false }).decision).toBe('merge');
    expect(classifyPr(landable(rollup4236.map((c) => (c.name === 'test' ? { ...c, conclusion: 'FAILURE' } : c))), { blockOnCodeQL: false }).decision).toBe('skip');
  });
  it('only a FAILURE conclusion blocks', () => {
    expect(isCodeQLFailed({ statusCheckRollup: withCodeQL('FAILURE') })).toBe(true);
    expect(isCodeQLFailed({ statusCheckRollup: withCodeQL('SUCCESS') })).toBe(false);
    expect(isCodeQLFailed({ statusCheckRollup: [] })).toBe(false);
  });
  it('settings: default on, shipped file on, off only when explicitly false, malformed fails closed', () => {
    expect(loadDrainGateSettings().drainBlocksOnCodeQL).toBe(true);
    const dir = mkdtempSync(join(tmpdir(), 'dgs-'));
    writeFileSync(join(dir, 'off.json'), '{"drainBlocksOnCodeQL": false}');
    writeFileSync(join(dir, 'bad.json'), '{nope');
    expect(loadDrainGateSettings(join(dir, 'off.json')).drainBlocksOnCodeQL).toBe(false);
    expect(loadDrainGateSettings(join(dir, 'bad.json')).drainBlocksOnCodeQL).toBe(true);
    expect(loadDrainGateSettings(join(dir, 'missing.json')).drainBlocksOnCodeQL).toBe(true);
  });
});
