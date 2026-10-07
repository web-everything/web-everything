import { describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { baseRerunCandidate, measureBaseFailures, classifyPreExisting, runVitestOnBase } from '../verify-base-rerun.mjs';
import { createFailureCollector } from '../verify-failures.mjs';
import { verifyGateDecision } from '../lane-verify.mjs';
import smell from '../../conveyor/health-smells/pre-existing-red-on-main.mjs';

const t = (file, name = 'x') => ({ file, name });
const redVitest = (tests, truncated = false) => ({ phase: 'vitest', result: { exitCode: 1, signal: null, failureDetails: { tests, summary: '', truncated } } });
const cause = { redCause: 'out-of-diff-still-red', redCauseFiles: ['a.test.mjs'] };

describe('perf 42 — pre-existing on main', () => {
  it('candidate: only complete, vitest-only, out-of-diff reds', () => {
    const ok = baseRerunCandidate({ exitCode: 1, phaseResults: [redVitest([t('a.test.mjs')])], failureDetails: { tests: [t('a.test.mjs')], truncated: false }, changedFiles: ['src/b.mjs'] });
    expect(ok.files).toEqual(['a.test.mjs']);
    const base = { exitCode: 1, phaseResults: [redVitest([t('a.test.mjs')])], failureDetails: { tests: [t('a.test.mjs')], truncated: false }, changedFiles: ['src/b.mjs'] };
    expect(baseRerunCandidate({ ...base, changedFiles: ['a.test.mjs'] })).toBeNull(); // in the diff
    expect(baseRerunCandidate({ ...base, failureDetails: { tests: [t('a.test.mjs')], truncated: true } })).toBeNull();
    expect(baseRerunCandidate({ ...base, phaseResults: [{ phase: 'standards', result: { exitCode: 1 } }] })).toBeNull();
    expect(baseRerunCandidate({ ...base, changedFiles: null })).toBeNull();
  });

  it('classifies pre-existing only when EVERY failing test also fails on base', () => {
    const candidate = { tests: [t('a.test.mjs', 'one'), t('a.test.mjs', 'two')], files: ['a.test.mjs'] };
    const all = { baseSha: 'abc', tests: [t('a.test.mjs', 'one'), t('a.test.mjs', 'two')] };
    expect(classifyPreExisting({ cause, candidate, base: all })).toMatchObject({ redCause: 'pre-existing-on-main', redCauseEvidence: { baseSha: 'abc' } });
    expect(classifyPreExisting({ cause, candidate, base: { baseSha: 'abc', tests: [t('a.test.mjs', 'one')] } })).toBeNull(); // 'two' only fails on head
    expect(classifyPreExisting({ cause, candidate, base: null })).toBeNull(); // base run errored
    expect(classifyPreExisting({ cause: { redCause: 'in-diff-failure', redCauseFiles: [] }, candidate, base: all })).toBeNull();
    expect(classifyPreExisting({ cause: { ...cause, redCauseUncertain: true }, candidate, base: all })).toBeNull();
  });

  it('measures once per main sha and caches; an error is not cached and is not proof', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'base-cache-'));
    let runs = 0;
    const runBase = async () => { runs++; return { ok: true, tests: [t('a.test.mjs')] }; };
    const first = await measureBaseFailures({ baseSha: 's1', files: ['a.test.mjs'], runBase, cacheDir });
    const second = await measureBaseFailures({ baseSha: 's1', files: ['a.test.mjs'], runBase, cacheDir });
    expect([runs, first.cached, second.cached]).toEqual([1, false, true]);
    await measureBaseFailures({ baseSha: 's2', files: ['a.test.mjs'], runBase, cacheDir });
    expect(runs).toBe(2);
    expect(await measureBaseFailures({ baseSha: 's3', files: ['a.test.mjs'], runBase: async () => ({ ok: false, tests: [] }), cacheDir })).toBeNull();
    expect(await measureBaseFailures({ baseSha: 's3', files: ['a.test.mjs'], runBase: async () => { throw new Error('x'); }, cacheDir })).toBeNull();
  });

  it('gate: pre-existing red does not block; an in-diff red still does', () => {
    const rec = { sha: 'h1', status: 'red', exitCode: 1, redCause: 'pre-existing-on-main', redCauseEvidence: { baseSha: 'm1', tests: [t('a.test.mjs')] } };
    expect(verifyGateDecision({ record: rec, headSha: 'h1', requireVerified: true })).toMatchObject({ ok: true, status: 'red', reason: 'verify-red-preexisting' });
    expect(verifyGateDecision({ record: { ...rec, redCause: 'in-diff-failure' }, headSha: 'h1', requireVerified: true })).toMatchObject({ ok: false, reason: 'verify-red' });
    expect(verifyGateDecision({ record: { ...rec, redCauseEvidence: undefined }, headSha: 'h1', requireVerified: true })).toMatchObject({ ok: false, reason: 'verify-red' });
  });

  it('smell: one finding per main sha across lanes', () => {
    const m = (lane) => ({ pool: 'p', lane, sha: 'h', head: 'h', status: 'red', redCause: 'pre-existing-on-main', redCauseEvidence: { baseSha: 'abcdef1234567', tests: [t('a.test.mjs')] } });
    const out = smell.evaluate({ laneVerifyMarkers: [m(1), m(2), { ...m(3), head: 'other' }, { pool: 'p', lane: 4, sha: 'h', head: 'h', status: 'running' }] });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ subject: 'main:abcdef123', breach: true });
    expect(out[0].measure.lanes).toEqual(['p/lane-1', 'p/lane-2']);
  });

  it('replay: a real worktree run on a base commit reports the failing test', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'base-repo-'));
    const git = (args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git(['init', '-q']); git(['config', 'user.email', 't@t']); git(['config', 'user.name', 't']);
    mkdirSync(join(repo, 'x'));
    writeFileSync(join(repo, 'x', 'a.test.mjs'), "import {it,expect} from 'vitest';\nit('boom',()=>{expect(1).toBe(2)});\nit('fine',()=>{expect(1).toBe(1)});\n");
    git(['add', '.']); git(['commit', '-qm', 'base']);
    fs.symlinkSync(join(process.cwd(), 'node_modules'), join(repo, 'node_modules'), 'dir');
    const res = await runVitestOnBase({ git, repo, baseSha: git(['rev-parse', 'HEAD']), files: ['x/a.test.mjs'], tmp: tmpdir(), spawnFn: spawn, collectorFactory: createFailureCollector, fs });
    expect(res.ok).toBe(true);
    expect(res.tests).toEqual([{ file: 'x/a.test.mjs', name: 'boom' }]);
  }, 60_000);
});
