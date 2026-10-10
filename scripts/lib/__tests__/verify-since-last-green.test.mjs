/**
 * @file scripts/lib/__tests__/verify-since-last-green.test.mjs
 * @description #xgqwuq5 — `verify.selection: since-last-green`. A fix round on a PR whose earlier commit has a
 *   clean-tree default-gate green in the green ledger selects tests (and scopes check:standards) from
 *   `<green>..HEAD` only; a merge of main, a rebase, a missing or red ledger record, or a config change in the delta
 *   falls back to the whole-PR selection. The lane marker stays keyed to the exact HEAD it verified. Real git in a
 *   temp repo (the eligibility checks are git ancestry questions; a fake runner would only restate the code).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { resolveDefaultGate, matchRequestedDefaultGate, describeGate } from '../verify-lane-gate.mjs';
import { decideSinceLastGreen, findLastGreenAncestor } from '../../readiness/test-selection.mjs';
import { recordGreenLedger, hasGreenLedger, shouldRecordGreen, greenLedgerDir, greenLedgerWritable, verifyGateDecision, VERIFY_GREEN_LEDGER_ENV } from '../lane-verify.mjs';
import { validateVerifySettings, resolveVerifySettings } from '../verify-settings.mjs';

const fileConfig = validateVerifySettings({ relatedMode: 'import-only', standards: 'always', skipLocalForCardOnly: false, relatedMaxTests: 0 });

let repo;
let ledger;
const git = (args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const write = (path, text) => { mkdirSync(join(repo, path, '..'), { recursive: true }); writeFileSync(join(repo, path), text); };
const commit = (msg, files) => { for (const [p, t] of Object.entries(files)) write(p, t); git(['add', '-A']); git(['commit', '-q', '-m', msg]); return git(['rev-parse', 'HEAD']); };
const markGreen = (sha) => recordGreenLedger({ dir: ledger, sha, record: { status: 'green' } });
const hasGreen = (sha) => hasGreenLedger({ dir: ledger, sha });
const resolve = (env = {}) => resolveDefaultGate({ runGit: git, env: { WE_VERIFY_SELECTION: 'since-last-green', ...env }, fileConfig, hasGreen });

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'since-green-'));
  ledger = mkdtempSync(join(tmpdir(), 'since-green-ledger-'));
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 't@t']); git(['config', 'user.name', 't']); git(['config', 'commit.gpgsign', 'false']);
  commit('base', { 'scripts/lib/a.mjs': 'export const a = 1;\n', 'scripts/lib/b.mjs': 'export const b = 1;\n', 'README.md': '# r\n' });
  git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  git(['checkout', '-q', '-b', 'pr']);
});
afterEach(() => { rmSync(repo, { recursive: true, force: true }); rmSync(ledger, { recursive: true, force: true }); });

describe('since-last-green selection (#xgqwuq5)', () => {
  it('a fixer-only commit after a green selects only the delta', () => {
    const green = commit('author', { 'scripts/lib/a.mjs': 'export const a = 2;\n' });
    markGreen(green);
    commit('fixer', { 'scripts/lib/b.mjs': 'export const b = 2;\n' });
    const gate = resolve();
    expect(gate.decision.selectionMode).toMatchObject({ mode: 'since-last-green', base: green });
    expect(gate.decision.changedFiles).toEqual(['scripts/lib/b.mjs']);
    expect(gate.command).toContain('scripts/lib/b.mjs');
    expect(gate.command).not.toContain('scripts/lib/a.mjs');
    expect(describeGate(gate).split('\n')[1]).toMatch(/selection mode: since-last-green — delta [0-9a-f]{8}\.\.HEAD only/);
    // The whole-PR setting still sees both commits.
    const pr = resolve({ WE_VERIFY_SELECTION: 'pr' });
    expect(pr.decision.selectionMode.mode).toBe('pr');
    expect(pr.decision.changedFiles).toEqual(['scripts/lib/a.mjs', 'scripts/lib/b.mjs']);
  });

  it('uncommitted fixer edits on top of the delta are part of the selection', () => {
    markGreen(commit('author', { 'scripts/lib/a.mjs': 'export const a = 2;\n' }));
    commit('fixer', { 'scripts/lib/b.mjs': 'export const b = 2;\n' });
    write('scripts/lib/c.mjs', 'export const c = 1;\n');
    expect(resolve().decision.changedFiles).toEqual(['scripts/lib/b.mjs', 'scripts/lib/c.mjs']);
  });

  it('picks the NEWEST green ancestor', () => {
    markGreen(commit('one', { 'scripts/lib/a.mjs': 'export const a = 2;\n' }));
    const second = commit('two', { 'scripts/lib/a.mjs': 'export const a = 3;\n' });
    markGreen(second);
    commit('three', { 'scripts/lib/b.mjs': 'export const b = 2;\n' });
    expect(findLastGreenAncestor({ runGit: git, hasGreen })).toBe(second);
  });

  it('falls back to the whole PR after a merge of main', () => {
    const green = commit('author', { 'scripts/lib/a.mjs': 'export const a = 2;\n' });
    markGreen(green);
    git(['checkout', '-q', 'main']);
    commit('main moved', { 'README.md': '# r2\n' });
    git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    git(['checkout', '-q', 'pr']);
    git(['merge', '-q', '--no-edit', 'main']);
    commit('fixer', { 'scripts/lib/b.mjs': 'export const b = 2;\n' });
    const gate = resolve();
    expect(gate.decision.selectionMode.mode).toBe('pr');
    expect(gate.decision.selectionMode.reason).toMatch(/merge commit/);
    expect(gate.decision.changedFiles).toEqual(['scripts/lib/a.mjs', 'scripts/lib/b.mjs']);
    expect(describeGate(gate).split('\n')[1]).toMatch(/selection mode: pr — whole PR diff vs origin\/main \(fallback — /);
  });

  it('falls back after a rebase onto a newer main (the green is no longer an ancestor)', () => {
    markGreen(commit('author', { 'scripts/lib/a.mjs': 'export const a = 2;\n' }));
    git(['checkout', '-q', 'main']);
    commit('main moved', { 'README.md': '# r2\n' });
    git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    git(['checkout', '-q', 'pr']);
    git(['rebase', '-q', 'main']);
    commit('fixer', { 'scripts/lib/b.mjs': 'export const b = 2;\n' });
    const gate = resolve();
    expect(gate.decision.selectionMode.mode).toBe('pr');
    expect(gate.decision.changedFiles).toEqual(['scripts/lib/a.mjs', 'scripts/lib/b.mjs']);
  });

  it('a green that is not an ancestor or whose merge-base moved is refused by the eligibility check itself', () => {
    const green = commit('author', { 'scripts/lib/a.mjs': 'export const a = 2;\n' });
    git(['checkout', '-q', 'main']);
    const other = commit('elsewhere', { 'README.md': '# r3\n' });
    git(['checkout', '-q', 'pr']);
    commit('fixer', { 'scripts/lib/b.mjs': 'export const b = 2;\n' });
    expect(decideSinceLastGreen({ runGit: git, greenSha: other })).toMatchObject({ eligible: false, reason: expect.stringMatching(/not an ancestor/) });
    expect(decideSinceLastGreen({ runGit: git, greenSha: green })).toMatchObject({ eligible: true });
    expect(decideSinceLastGreen({ runGit: git, greenSha: git(['rev-parse', 'HEAD']) })).toMatchObject({ eligible: false });
    expect(decideSinceLastGreen({ runGit: git, greenSha: null })).toMatchObject({ eligible: false });
  });

  it('falls back when there is no green record, or only a red one', () => {
    const author = commit('author', { 'scripts/lib/a.mjs': 'export const a = 2;\n' });
    commit('fixer', { 'scripts/lib/b.mjs': 'export const b = 2;\n' });
    expect(resolve().decision.selectionMode).toMatchObject({ mode: 'pr', reason: expect.stringMatching(/no green verify/) });
    writeFileSync(join(ledger, `${author}.json`), JSON.stringify({ sha: author, status: 'red' }));
    expect(resolve().decision.selectionMode.mode).toBe('pr');
    writeFileSync(join(ledger, `${author}.json`), '{torn');
    expect(resolve().decision.selectionMode.mode).toBe('pr');
  });

  it('a config/deps change in the delta falls back to the whole-PR rules (no silent narrowing)', () => {
    markGreen(commit('author', { 'scripts/lib/a.mjs': 'export const a = 2;\n' }));
    commit('fixer', { 'package.json': '{"name":"x"}\n' });
    const gate = resolve();
    expect(gate.decision.selectionMode.mode).toBe('pr');
    expect(gate.decision.selectionMode.reason).toMatch(/delta since [0-9a-f]{8} cannot use a selected run/);
    expect(gate.decision.changedFiles).toEqual(['package.json', 'scripts/lib/a.mjs']);
  });

  it('the dispatched child still recognizes an older requester\'s whole-PR stamp', () => {
    markGreen(commit('author', { 'scripts/lib/a.mjs': 'export const a = 2;\n' }));
    commit('fixer', { 'scripts/lib/b.mjs': 'export const b = 2;\n' });
    const ours = resolve();
    const requested = resolve({ WE_VERIFY_SELECTION: 'pr' });
    expect(ours.command).not.toBe(requested.command);
    const plan = matchRequestedDefaultGate({ gate: requested.command, env: { WE_VERIFY_SELECTION: 'since-last-green' }, resolved: ours,
      resolveUnder: (env) => resolveDefaultGate({ runGit: git, env, fileConfig, hasGreen }) });
    expect(plan?.command).toBe(requested.command);
    expect(plan.decision.selectionMode.mode).toBe('pr');
  });

  it('the marker binding is unchanged: a green for the earlier head never satisfies the gate for HEAD', () => {
    const green = commit('author', { 'scripts/lib/a.mjs': 'export const a = 2;\n' });
    const head = commit('fixer', { 'scripts/lib/b.mjs': 'export const b = 2;\n' });
    const record = { sha: green, status: 'green', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), exitCode: 0, suites: 'x' };
    expect(verifyGateDecision({ record, headSha: head, requireVerified: true }).ok).toBe(false);
    expect(verifyGateDecision({ record: { ...record, sha: head }, headSha: head, requireVerified: true }).ok).toBe(true);
  });
});

describe('green ledger (#xgqwuq5)', () => {
  const sha = 'a'.repeat(40);
  it('round-trips a record and refuses non-sha keys', () => {
    expect(hasGreenLedger({ dir: ledger, sha })).toBe(false);
    expect(recordGreenLedger({ dir: ledger, sha, record: { status: 'green' } })).toBe(true);
    expect(hasGreenLedger({ dir: ledger, sha })).toBe(true);
    expect(JSON.parse(readFileSync(join(ledger, `${sha}.json`), 'utf8')).sha).toBe(sha);
    expect(recordGreenLedger({ dir: ledger, sha: '../evil', record: { status: 'green' } })).toBe(false);
    expect(hasGreenLedger({ dir: ledger, sha: '../evil' })).toBe(false);
  });
  it('records only a clean-tree default-gate green', () => {
    const ok = { status: 'green', defaultGate: true, admissionFallback: null, treeHash: 'h', cleanTree: true };
    expect(shouldRecordGreen(ok)).toBe(true);
    expect(shouldRecordGreen({ ...ok, status: 'red' })).toBe(false);
    expect(shouldRecordGreen({ ...ok, defaultGate: false })).toBe(false);
    expect(shouldRecordGreen({ ...ok, admissionFallback: 'whole-gate' })).toBe(false);
    expect(shouldRecordGreen({ ...ok, treeHash: null })).toBe(false);
    expect(shouldRecordGreen({ ...ok, cleanTree: false })).toBe(false);
  });
  it('lives in the coordination root and is written only from pool lanes or an explicit override', () => {
    expect(greenLedgerDir({ env: {}, coordinationRoot: '/c' })).toBe(join('/c', 'verify-green'));
    expect(greenLedgerDir({ env: { [VERIFY_GREEN_LEDGER_ENV]: '/x' }, coordinationRoot: '/c' })).toBe('/x');
    expect(greenLedgerWritable({ repo: `${sep}w${sep}.lanes${sep}web-everything${sep}lane-3`, env: {} })).toBe(true);
    expect(greenLedgerWritable({ repo: `${sep}tmp${sep}fixture`, env: {} })).toBe(false);
    expect(greenLedgerWritable({ repo: `${sep}tmp${sep}fixture`, env: { [VERIFY_GREEN_LEDGER_ENV]: '/x' } })).toBe(true);
  });
});

describe('verify.selection setting (#xgqwuq5)', () => {
  it('defaults to since-last-green, accepts pr, ignores junk', () => {
    expect(resolveVerifySettings({ fileConfig: validateVerifySettings(null), env: {} }).values.selection).toBe('since-last-green');
    expect(resolveVerifySettings({ fileConfig: validateVerifySettings({ selection: 'pr' }), env: {} }).values.selection).toBe('pr');
    expect(resolveVerifySettings({ fileConfig: validateVerifySettings(null), env: { WE_VERIFY_SELECTION: 'pr' } }).values.selection).toBe('pr');
    expect(resolveVerifySettings({ fileConfig: validateVerifySettings({ selection: 'bogus' }), env: {} }).values.selection).toBe('since-last-green');
  });
});
