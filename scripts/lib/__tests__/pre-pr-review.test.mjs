/**
 * @file pre-pr-review.test.mjs — the pre-PR review gate (perf sweep card 2): risk rule, knob, receipt, and the
 * open-pr runner refusing a risky head without a receipt. Real git sandboxes; no gh, no network.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifyPrRisk, decidePrePrReview, resolvePrePrSettings, loadPrePrSettings, checkPrePrReview, isPreparedCard,
  buildReceipt, gitDirOf, treeOf, RECEIPT_FILE, BUILT_IN_PRE_PR_SETTINGS,
} from '../pre-pr-review.mjs';
import { createPrLandRunner } from "../../operations/open-pr-io.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CLI = join(ROOT, 'scripts', 'converge-cli.mjs');
const S = BUILT_IN_PRE_PR_SETTINGS;
const f = (path, n = 10) => ({ path, additions: n, deletions: 0 });

describe('risk rule', () => {
  it('card-only PRs are never gated, whatever the builder', () => {
    const r = classifyPrRisk({ files: [f('backlog/1.md', 900), f('backlog/2.md')], hasPreparedCard: false, operatorAgent: true });
    expect(r).toMatchObject({ gated: false, cardOnly: true });
  });
  it('a small prepared conveyor code PR is low risk', () => {
    const r = classifyPrRisk({ files: [f('scripts/a.mjs'), f('scripts/__tests__/a.test.mjs')], hasPreparedCard: true, operatorAgent: false });
    expect(r.gated).toBe(false);
  });
  it.each([
    ['lines > 264', { files: [f('scripts/a.mjs', 265)], hasPreparedCard: true, operatorAgent: false }, /265 lines/],
    ['subsystems > 2', { files: [f('scripts/a/x.mjs'), f('docs/b/y.md'), f('skills-src/c/z.md')], hasPreparedCard: true, operatorAgent: false }, /3 subsystems/],
    ['files > 5', { files: ['a', 'b', 'c', 'd', 'e', 'f'].map((n) => f(`scripts/${n}.mjs`)), hasPreparedCard: true, operatorAgent: false }, /6 files/],
    ['no prepared card', { files: [f('scripts/a.mjs')], hasPreparedCard: false, operatorAgent: false }, /no prepared card/],
    ['operator agent', { files: [f('scripts/a.mjs')], hasPreparedCard: true, operatorAgent: true }, /operator agent/],
  ])('gates on %s', (_n, input, re) => {
    const r = classifyPrRisk(input);
    expect(r.gated).toBe(true);
    expect(r.reasons.join(' ')).toMatch(re);
  });
  it('264 lines exactly is NOT over the line threshold', () => {
    expect(classifyPrRisk({ files: [f('scripts/a.mjs', 264)], hasPreparedCard: true, operatorAgent: false }).gated).toBe(false);
  });
  it('isPreparedCard reads preparedDate', () => {
    expect(isPreparedCard('---\npreparedDate: "2026-06-12"\n---')).toBe(true);
    expect(isPreparedCard('---\nstatus: open\n---')).toBe(false);
  });
});

describe('knob and decision', () => {
  const risky = { gated: true, cardOnly: false, reasons: ['300 lines changed (> 264)'] };
  it('product default is advise; this repo ships enforce; bad values are ignored', () => {
    expect(BUILT_IN_PRE_PR_SETTINGS.mode).toBe('advise');
    expect(loadPrePrSettings().settings.mode).toBe('enforce');
    expect(loadPrePrSettings({ path: '/nonexistent' }).settings.mode).toBe('advise');
    const r = resolvePrePrSettings({ mode: 'sometimes', maxLines: -1 });
    expect(r.settings.mode).toBe('advise');
    expect(r.ignored).toEqual(['mode', 'maxLines']);
  });
  it('enforce refuses a risky head with no receipt, with a clear message', () => {
    const d = decidePrePrReview({ settings: { ...S, mode: 'enforce' }, risk: risky, receipt: null, headTree: 't1' });
    expect(d.action).toBe('refuse');
    expect(d.message).toMatch(/pre-PR review required.*converge-cli\.mjs receipt.*--skip-pre-pr-review/s);
  });
  it('a receipt for another tree is stale and refused', () => {
    const d = decidePrePrReview({ settings: { ...S, mode: 'enforce' }, risk: risky, receipt: { tree: 't0', verdict: 'land' }, headTree: 't1' });
    expect(d).toMatchObject({ action: 'refuse', why: 'receipt-stale' });
  });
  it('a receipt for the head tree admits; advise warns; off ignores; bypass needs a reason', () => {
    const e = { ...S, mode: 'enforce' };
    expect(decidePrePrReview({ settings: e, risk: risky, receipt: { tree: 't1', verdict: 'land' }, headTree: 't1' }).action).toBe('pass');
    expect(decidePrePrReview({ settings: { ...S, mode: 'advise' }, risk: risky, receipt: null, headTree: 't1' }).action).toBe('advise');
    expect(decidePrePrReview({ settings: { ...S, mode: 'off' }, risk: risky, receipt: null, headTree: 't1' }).action).toBe('pass');
    expect(decidePrePrReview({ settings: e, risk: risky, receipt: null, headTree: 't1', skip: '   ' }).action).toBe('refuse');
    expect(decidePrePrReview({ settings: e, risk: risky, receipt: null, headTree: 't1', skip: 'hotfix' }).why).toBe('bypass');
  });
  it('card-only and low-risk pass untouched', () => {
    const e = { ...S, mode: 'enforce' };
    expect(decidePrePrReview({ settings: e, risk: { gated: false, cardOnly: true }, headTree: 't' }).why).toBe('card-only');
    expect(decidePrePrReview({ settings: e, risk: { gated: false, cardOnly: false }, headTree: 't' }).why).toBe('low-risk');
  });
});

describe('lane sandbox: checkPrePrReview + open-pr runner', () => {
  let dir;
  const git = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
  const commit = (files) => {
    for (const [p, c] of Object.entries(files)) { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), c); }
    git('add', '-A'); git('-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-qm', 'x');
  };
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'pre-pr-')));
    git('init', '-q', '-b', 'main'); commit({ 'README.md': 'x\n' });
    git('checkout', '-q', '-b', 'lane/x');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const enforce = { ...S, mode: 'enforce' };
  const OPERATOR = { PATH: process.env.PATH }; // no WE_CONVEYOR_WORKER => operator agent

  it('a risky code PR is refused without a receipt and admitted with one for the head tree', () => {
    commit({ 'scripts/big.mjs': 'x\n'.repeat(400) });
    const no = checkPrePrReview({ cwd: dir, env: OPERATOR, settings: enforce });
    expect(no.action).toBe('refuse');
    writeFileSync(join(gitDirOf(dir), RECEIPT_FILE), JSON.stringify(buildReceipt({ tree: treeOf(dir), head: 'h', envelope: {} })));
    expect(checkPrePrReview({ cwd: dir, env: OPERATOR, settings: enforce })).toMatchObject({ action: 'pass', why: 'receipt' });
    commit({ 'scripts/more.mjs': 'y\n' }); // a new head tree invalidates the receipt
    expect(checkPrePrReview({ cwd: dir, env: OPERATOR, settings: enforce }).why).toBe('receipt-stale');
  });
  it('a card-only PR passes untouched, no receipt', () => {
    commit({ 'backlog/9.md': '---\nstatus: open\n---\n'.repeat(50) });
    expect(checkPrePrReview({ cwd: dir, env: OPERATOR, settings: enforce })).toMatchObject({ action: 'pass', why: 'card-only' });
  });
  it('a small prepared conveyor-worker PR is unaffected', () => {
    commit({ 'backlog/9.md': '---\npreparedDate: "2026-10-01"\n---\n', 'scripts/a.mjs': 'x\n' });
    const r = checkPrePrReview({ cwd: dir, env: { WE_CONVEYOR_WORKER: '1' }, settings: enforce });
    expect(r).toMatchObject({ action: 'pass', why: 'low-risk' });
  });
  it('the open-pr runner refuses before spawning pr-land, and a recorded bypass admits', () => {
    commit({ 'scripts/big.mjs': 'x\n'.repeat(400) });
    const spawned = [];
    const spawn = (...a) => { spawned.push(a); return { status: 0, stdout: '{"pr":1,"url":"u"}\n', stderr: '' }; };
    const run = createPrLandRunner({ spawn, cwd: dir, env: OPERATOR });
    const argv = ['--ref=lane/x', '--base=main', '--body-file=/tmp/b.md', '--label-on-green'];
    const out = run({ argv });
    expect(out).toMatchObject({ outcome: 'refused', reason: 'pre-pr-review-missing' });
    expect(spawned).toHaveLength(0);
    const ok = run({ argv, skipPrePrReview: 'emergency hotfix' });
    expect(ok.outcome).toBe('opened');
    expect(spawned).toHaveLength(1);
    expect(spawned[0][1].join(' ')).not.toMatch(/skip-pre-pr/);
    expect(readFileSync(join(gitDirOf(dir), 'pre-pr-review-bypass.log'), 'utf8')).toMatch(/emergency hotfix/);
  });
});

describe('converge-cli receipt', () => {
  let dir; let state;
  const git = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'pre-pr-cli-')));
    git('init', '-q', '-b', 'main'); writeFileSync(join(dir, 'a'), 'x');
    git('add', '-A'); git('-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-qm', 'x');
    state = join(dir, '..', `state-${Date.now()}.json`);
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); rmSync(state, { force: true }); });
  const cli = (...a) => spawnSync(process.execPath, [CLI, ...a], { encoding: 'utf8' });

  it('refuses a run that did not land, and stamps the head tree for one that did', () => {
    const st = { round: 2, careLevel: 'elevated', activeLenses: ['correctness'], dismissed: [] };
    writeFileSync(state, JSON.stringify({ ctx: { laneRoot: dir }, state: st, final: 'escalate' }));
    const bad = cli('receipt', `--state=${state}`, `--lane=${dir}`);
    expect(bad.status).not.toBe(0);
    expect(bad.stderr).toMatch(/did not end in `land`/);
    writeFileSync(state, JSON.stringify({ ctx: { laneRoot: dir }, state: st, final: 'land' }));
    const ok = cli('receipt', `--state=${state}`, `--lane=${dir}`);
    expect(ok.status).toBe(0);
    const rec = JSON.parse(readFileSync(join(dir, '.git', RECEIPT_FILE), 'utf8'));
    expect(rec).toMatchObject({ tree: treeOf(dir), verdict: 'land', rounds: 2 });
  });
  it('refuses when tracked files are dirty', () => {
    writeFileSync(state, JSON.stringify({ ctx: { laneRoot: dir }, state: {}, final: 'land' }));
    writeFileSync(join(dir, 'a'), 'changed');
    expect(cli('receipt', `--state=${state}`, `--lane=${dir}`).stderr).toMatch(/uncommitted/);
    expect(existsSync(join(dir, '.git', RECEIPT_FILE))).toBe(false);
  });
});
