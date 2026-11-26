import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPlan, runCli } from '../rewaive-plan.mjs';
import { QUESTION_HASH } from '../codex-audit.mjs';
import { loadRuledWeakened } from '../prototype-load-io.mjs';
import { withdrawnRevocations } from '../ruled-weakened-store.mjs';

const REF = 'lane/x';
const OTHER = 'lane/other';
const GID = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const sh = (cwd, ...a) => execFileSync('git', a, { cwd, env: { ...process.env, ...GID }, encoding: 'utf8' }).trim();
const FINDINGS = ['a.mjs:10 weak'];

/** Temp repo (origin + work, 4 commits pushed) and a temp HOME holding the real-format waiver store and request log. */
function mk(requestLines) {
  const root = mkdtempSync(join(tmpdir(), 'rewaive-mal-'));
  const origin = join(root, 'origin.git'), work = join(root, 'work');
  sh(root, 'init', '-q', '--bare', origin); sh(root, 'init', '-q', work);
  sh(work, 'checkout', '-q', '-b', REF); sh(work, 'remote', 'add', 'origin', origin);
  const shas = [];
  for (let i = 0; i < 4; i++) {
    writeFileSync(join(work, `f${i}.txt`), `v${i}\n`); sh(work, 'add', '.'); sh(work, 'commit', '-q', '-m', `c${i}`);
    shas.push(sh(work, 'rev-parse', 'HEAD'));
  }
  sh(work, 'push', '-q', 'origin', REF);
  const home = join(root, 'home');
  mkdirSync(join(home, 'workspace/.operations/coordination'), { recursive: true });
  mkdirSync(join(home, 'workspace/.operations/handoff'), { recursive: true });
  mkdirSync(join(home, '.plateau'), { recursive: true });
  writeFileSync(join(home, '.plateau/platform-preferences.json'), '{}\n');
  const entry = { ref: REF, sha: shas[1], ruling: 'R1085', findings: FINDINGS, actor: 'o', quote: 'q', at: '2026-11-24T10:00:00Z' };
  writeFileSync(join(home, 'workspace/.operations/coordination/ruled-weakened.jsonl'), `${JSON.stringify(entry)}\n`);
  writeFileSync(join(home, 'workspace/.operations/handoff/waiver-requests.jsonl'), requestLines.join('\n') + '\n');
  return { work, home, shas };
}
const rec = head => ({ head, base: 'b'.repeat(40), questionHash: QUESTION_HASH, at: '2026-11-24T10:00:00Z', verdict: 'WEAKENED', findings: FINDINGS });
const run = (r) => runPlan({ repo: r.work, ref: REF, env: { PATH: process.env.PATH, HOME: r.home },
  loadRecords: () => [rec(r.shas[1])], baseOk: () => true });
const valid = JSON.stringify({ ref: OTHER, sha: 'a'.repeat(40), ruling: 'R1085', findings: ['x'] });

// Exercise the same loader as the planner, including its scope and opt-in forwarding.
function damageWarnings(line, scopeRef, relaxUnattributed) {
  const blocking = [], unrelated = [];
  const fs = { readFileSync: path => String(path).endsWith('waiver-requests.jsonl') ? `${line}\n` : '' };
  loadRuledWeakened({ fs, env: { HOME: '/fixture' }, scopeRef, relaxUnattributed,
    warn: message => blocking.push(message), warnOther: message => unrelated.push(message) });
  return { blocking, unrelated };
}

describe('rewaive-plan: a malformed waiver-log line', () => {
  it.each([
    '{"ref":"lane/', '{"ref":"refs/heads/lane/', '{"ref":"lane\\u002f', '{"ref":"l', '{"ref":"refs/hea',
    '{"ref":"lane\\u00', '{"ref":"lane\\', '{"ref":"lane/\r', '{"ref":"lane/\u2028',
  ])('ref-prefix-truncated evidence refuses the plan: %s', (line) => {
    const out = run(mk([valid, line, valid]));
    expect(out.state).toBe('refuse');
    expect(out.detail).toMatch(/waiver evidence warnings:.*line 2/);
  });
  it.each([
    [REF, REF], [`refs/heads/${REF}`, REF], [REF, `refs/heads/${REF}`], [`refs/heads/${REF}`, `refs/heads/${REF}`],
  ])('malformed bare-ref evidence refuses an equivalent scoped plan: scope=%s evidence=%s', (scope, evidence) => {
    const out = damageWarnings(`{"ref":"${evidence}","sha":`, scope, true);
    expect(out.blocking).toHaveLength(1);
    expect(out.unrelated).toEqual([]);
  });
  it.each([
    [REF, `refs/heads/${REF}`], [`refs/heads/${REF}`, REF],
  ])('parsed invalid evidence also refuses equivalent ref spellings: scope=%s evidence=%s', (scope, evidence) => {
    expect(damageWarnings(JSON.stringify({ ref: evidence, sha: null }), scope, true).blocking).toHaveLength(1);
  });
  it.each([REF, `refs/heads/${REF}`])('valid withdrawals revoke either ref spelling: %s', evidence => {
    const fs = { readFileSync: () => JSON.stringify({ ref: evidence, sha: 'a'.repeat(40), ruling: 'WITHDRAWN' }) };
    const revoked = withdrawnRevocations({ fs, env: { HOME: '/fixture' }, warn: message => { throw Error(message); } });
    expect(revoked({ ref: REF, sha: 'a'.repeat(40) })).toBe(true);
    expect(revoked({ ref: `refs/heads/${REF}`, sha: 'a'.repeat(40) })).toBe(true);
    expect(revoked({ ref: OTHER, sha: 'a'.repeat(40) })).toBe(false);
  });
  it.each([REF, `refs/heads/${REF}`])('an unrelated completed ref is reported under either scope spelling: %s', scope => {
    const out = damageWarnings('{"ref":"lane/unrelated","sha":', scope, true);
    expect(out.blocking).toEqual([]);
    expect(out.unrelated).toHaveLength(1);
  });
  it('callers that omit relaxation keep refusing unattributable malformed evidence', () => {
    expect(damageWarnings('broken log record', REF).blocking).toHaveLength(1);
    expect(damageWarnings('broken log record', undefined, true).blocking).toHaveLength(1);
    expect(damageWarnings('broken log record', REF, true).unrelated).toHaveLength(1);
  });
  it('unrelated malformed evidence preserves an eligible request', () => {
    const r = mk([valid, '{"ref":"lane/unrelated","sha":', valid]);
    const headFindings = ['f3.txt:1 new finding'];
    let stdout = '';
    const out = runCli({ argv: [`--ref=${REF}`, '--json'], repo: r.work, env: { PATH: process.env.PATH, HOME: r.home },
      loadRecords: () => [rec(r.shas[1]), { ...rec(r.shas[3]), findings: headFindings }], baseOk: () => true,
      stdout: text => { stdout += text; } });
    expect(out.code).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ state: 'request', basis: r.shas[1], malformed: [2],
      request: { ref: REF, sha: r.shas[3], ruling: 'R1085', findings: headFindings } });
  });
  it('an unrelated malformed line is reported by line number, grants nothing, and does not refuse the ref', () => {
    const r = mk([valid, '{"ref":"lane/unrelated","sha":', valid]);
    const out = run(r);
    expect(out.state).toBe('audit-needed');
    expect(out.malformed).toEqual([2]);
  });
  it('a malformed line that could be a revocation refuses the ref (fail closed)', () => {
    const r = mk([valid, '{"revoked":true,"sha":', valid]);
    const out = run(r);
    expect(out.state).toBe('refuse');
  });
  it('a line truncated inside "WITHDRAWN" refuses without naming the ref', () => {
    expect(run(mk([valid, '{"ruling":"WITH']))).toMatchObject({ state: 'refuse' });
  });
  it('a withdrawal hint refuses without naming the ref', () => {
    expect(run(mk([valid, '{"ruling":"WITHDRAWN","sha":'])).state).toBe('refuse');
  });
  it.each(['lane\\/x', 'lane\\u002fx', '\\u006cane/x'])('an escaped malformed ref refuses without a revocation hint: %s', ref => {
    expect(run(mk([valid, `{"ref":"${ref}","sha":`])).state).toBe('refuse');
  });
  it('a unicode-escaped withdrawal hint refuses without naming the ref', () => {
    expect(run(mk([valid, '{"ruling":"\\u0057ITHDRAWN","sha":'])).state).toBe('refuse');
  });
  it('a malformed line naming the planned ref refuses', () => {
    const r = mk([valid, `{"ref":"${REF}","sha":`]);
    expect(run(r).state).toBe('refuse');
  });
  it('an all-valid log behaves as before: no malformed key', () => {
    const r = mk([valid]);
    const out = run(r);
    expect(out.state).toBe('audit-needed');
    expect(out.malformed).toBeUndefined();
  });
});
