/**
 * Card xet6iu0 — the class-sweep check CLI, against a real temporary directory (the record it writes is the point).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { main, resolveClassSweepMode, defaultPolicySettingsPath } from '../class-sweep-check.mjs';

const dirs = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function scratch() {
  const d = mkdtempSync(join(tmpdir(), 'class-sweep-'));
  dirs.push(d);
  return d;
}
const SWEEP = { v: 1, findings: [{ finding: 'F1', class: 'truncated read', siblings: [
  { path: 'family', site: 'a.mjs#readOne', status: 'fixed', note: '' },
  { path: 'callers', site: 'b.mjs#main', status: 'checked', note: 'passes the full list' },
  { path: 'branches', site: '', status: 'n/a', note: 'no parallel branch' },
  { path: 'recovery', site: 'a.mjs#retry', status: 'checked', note: 'retry keeps the cap' },
] }] };
const evidence = (sweep) => `## fix evidence\n\n\`\`\`class-sweep\n${JSON.stringify(sweep)}\n\`\`\`\n`;

function run({ text, mode = 'warn', args = [], settings, changed = ['a.mjs', 'b.mjs'] } = {}) {
  const d = scratch();
  const file = join(d, 'evidence.md');
  if (text !== undefined) writeFileSync(file, text);
  const changedFile = join(d, 'changed.txt');
  if (changed) { writeFileSync(changedFile, `${changed.join('\n')}\n`); args = [`--changed-files=${changedFile}`, ...args]; }
  const settingsPath = join(d, 'settings.json');
  writeFileSync(settingsPath, JSON.stringify(settings ?? { classSweep: { mode, since: '2026-10-08' } }));
  const lines = [];
  const result = main([`--evidence-file=${file}`, '--kind=fix', '--repo=web-everything/web-everything', '--pr=4481', '--session=fix-4481', ...args],
    { env: {}, root: join(d, 'coord'), settingsPath, out: (s) => lines.push(s), now: () => '2026-10-08T23:00:00.000Z' });
  return { ...result, lines, root: join(d, 'coord') };
}

describe('class-sweep-check', () => {
  it('records the structured sweep for the session and exits 0', () => {
    const r = run({ text: evidence(SWEEP) });
    expect(r.exitCode).toBe(0);
    expect(r.lines[0]).toBe('class-sweep (warn): complete — every-finding-has-class-and-four-sibling-paths; 1 finding(s)');
    const record = JSON.parse(readFileSync(join(r.root, 'class-sweep', 'fix-4481.json'), 'utf8'));
    expect(record).toMatchObject({ session: 'fix-4481', pr: 4481, status: 'complete', classes: ['truncated read'], since: '2026-10-08' });
    expect(record.sweep.findings[0].siblings.map((s) => s.path)).toEqual(['family', 'callers', 'branches', 'recovery']);
    expect(readFileSync(join(r.root, 'class-sweep', 'log.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('warn reports a missing sweep and still exits 0; enforce exits 2', () => {
    const warn = run({ text: '## evidence\nVariants considered: fixed everything\n' });
    expect(warn.exitCode).toBe(0);
    expect(warn.lines[0]).toBe('class-sweep (warn): missing — no-class-sweep-block');
    expect(run({ text: '## evidence\n', mode: 'enforce' }).exitCode).toBe(2);
  });

  it('an unreadable evidence file is missing, never complete', () => {
    const r = run({ text: undefined, mode: 'enforce' });
    expect(r.verdict).toMatchObject({ status: 'missing', reason: 'no-evidence-text' });
    expect(r.exitCode).toBe(2);
  });

  it('off (built-in, today) checks and records nothing', () => {
    const r = run({ text: '', settings: {} });
    expect(r.verdict).toMatchObject({ status: 'skipped', reason: 'mode-off' });
    expect(existsSync(join(r.root, 'class-sweep'))).toBe(false);
  });

  it('an unsafe session slug writes no per-session file (log only)', () => {
    const r = run({ text: evidence(SWEEP), args: ['--session=../../etc/x'] });
    expect(existsSync(join(r.root, 'class-sweep', 'log.jsonl'))).toBe(true);
    expect(JSON.parse(readFileSync(join(r.root, 'class-sweep', 'log.jsonl'), 'utf8')).session).toBe(null);
  });

  it('card 5536: a changed file of the PR no row names is flagged in the same pass and recorded', () => {
    const r = run({ text: evidence(SWEEP), changed: ['a.mjs', 'b.mjs', 'c.mjs', 'backlog/1-card.md'] });
    expect(r.lines[0]).toBe('class-sweep (warn): incomplete — F1: pr-unswept-1; 1 finding(s); first problem F1: pr-unswept-1');
    const record = JSON.parse(readFileSync(join(r.root, 'class-sweep', 'fix-4481.json'), 'utf8'));
    expect(record).toMatchObject({ unswept: { F1: ['c.mjs'] }, prFiles: 4 });
  });

  it('card 5536: with no PR file list the PR-wide check fails closed; enforce exits 2', () => {
    expect(run({ text: evidence(SWEEP), changed: null }).verdict).toMatchObject({ status: 'incomplete', reason: 'pr-files-unknown' });
    expect(run({ text: evidence(SWEEP), changed: null, mode: 'enforce' }).exitCode).toBe(2);
  });

  it('card 5536: --checkout reads the PR files from the lane with git (base...HEAD); a bad base is unknown', () => {
    const repo = scratch();
    const g = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    g('init', '-q', '-b', 'main');
    g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'base');
    g('branch', 'base');
    for (const f of ['a.mjs', 'c.mjs']) writeFileSync(join(repo, f), 'x\n');
    g('add', 'a.mjs', 'c.mjs');
    g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'pr');
    const r = run({ text: evidence(SWEEP), changed: null, args: [`--checkout=${repo}`, '--base=base'] });
    expect(r.verdict.unswept).toEqual({ F1: ['c.mjs'] });
    expect(run({ text: evidence(SWEEP), changed: null, args: [`--checkout=${repo}`, '--base=--output=/tmp/x'] }).verdict.reason).toBe('pr-files-unknown');
  });

  it('the mode is read from the RUNNING root\'s settings; env overrides; a bad value never loosens', () => {
    expect(defaultPolicySettingsPath()).toMatch(/scripts\/lib\/review-fix-policy-settings\.json$/);
    expect(resolveClassSweepMode({ env: {} })).toMatchObject({ mode: 'warn', source: 'file', since: '2026-10-08' });
    expect(resolveClassSweepMode({ env: { WE_CLASS_SWEEP: 'enforce' } })).toMatchObject({ mode: 'enforce', source: 'env' });
    expect(resolveClassSweepMode({ env: { WE_CLASS_SWEEP: 'lenient' }, read: () => '{"classSweep":{"mode":"sometimes"}}' })).toMatchObject({ mode: 'off', source: 'default' });
    expect(resolveClassSweepMode({ env: {}, read: () => { throw new Error('ENOENT'); } })).toMatchObject({ mode: 'off' });
  });
});
