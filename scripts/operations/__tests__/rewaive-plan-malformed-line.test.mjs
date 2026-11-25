import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPlan } from '../rewaive-plan.mjs';
import { QUESTION_HASH } from '../codex-audit.mjs';

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

describe('rewaive-plan: a malformed waiver-log line', () => {
  it('an unrelated malformed line is reported by line number, grants nothing, and does not refuse the ref', () => {
    const r = mk([valid, '{"ref":"lane/unrelated","sha":', valid]);
    const out = run(r);
    expect(out.state).toBe('audit-needed');
    expect(out.malformed).toEqual([2]);
  });
  it('a malformed line that could be a revocation refuses the ref (fail closed)', () => {
    const r = mk([valid, '{"revoked": true, "ref": "lane/x', valid]);
    const out = run(r);
    expect(out.state).toBe('refuse');
  });
  it('a line truncated inside "WITHDRAWN", or an escaped malformed withdrawal, refuses', () => {
    expect(run(mk([valid, '{"ruling":"WITH']))).toMatchObject({ state: 'refuse' });
    expect(run(mk([valid, '{"ref":"lane\\/x","ruling":"WITHDRAWN","sha":']))).toMatchObject({ state: 'refuse' });
  });
  it('a unicode-escaped malformed withdrawal refuses', () => {
    expect(run(mk([valid, '{"ref":"lane\\u002fx","ruling":"\\u0057ITHDRAWN","sha":'])).state).toBe('refuse');
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
