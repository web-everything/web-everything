import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planRewaive, runPlan, runCli, classifyFindings } from '../rewaive-plan.mjs';
import { QUESTION_HASH } from '../codex-audit.mjs';

const REF = 'lane/x';
const GID = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const sh = (cwd, ...args) => execFileSync('git', args, { cwd, env: { ...process.env, ...GID }, encoding: 'utf8' }).trim();

/** Real temp repo: bare origin plus a work clone on lane/x with commits c0..c(n-1), pushed. */
function mkRepo(n = 4, { merge = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'rewaive-'));
  const origin = join(root, 'origin.git'), work = join(root, 'work');
  sh(root, 'init', '-q', '--bare', origin);
  sh(root, 'init', '-q', work);
  sh(work, 'checkout', '-q', '-b', REF);
  sh(work, 'remote', 'add', 'origin', origin);
  const shas = [];
  for (let i = 0; i < n; i++) {
    writeFileSync(join(work, `f${i}.txt`), `v${i}\n`);
    sh(work, 'add', '.');
    sh(work, 'commit', '-q', '-m', `c${i}`);
    shas.push(sh(work, 'rev-parse', 'HEAD'));
  }
  if (merge) {
    sh(work, 'checkout', '-q', '-b', 'side', shas[1]);
    writeFileSync(join(work, 'side.txt'), 's\n'); sh(work, 'add', '.'); sh(work, 'commit', '-q', '-m', 'side');
    sh(work, 'checkout', '-q', REF);
    sh(work, 'merge', '-q', '--no-ff', '-m', 'merge', 'side');
    shas.push(sh(work, 'rev-parse', 'HEAD'));
  }
  sh(work, 'push', '-q', 'origin', REF);
  return { root, work, origin, shas };
}
const rec = (head, over = {}) => ({ head, base: 'b'.repeat(40), questionHash: QUESTION_HASH, at: '2026-11-24T10:00:00Z',
  verdict: 'WEAKENED', findings: ['a.mjs:10 weak'], ...over });
const waiver = (sha, over = {}) => ({ ref: REF, sha, ruling: 'R1085', findings: ['a.mjs:10 weak'], ...over });
const plan = (r, { records, waivers, ...rest } = {}) => runPlan({ repo: r.work, ref: REF, env: { PATH: process.env.PATH, HOME: r.root },
  loadRecords: () => records, loadWaivers: () => waivers ?? [], ...rest });

describe('rewaive-plan: negative cases', () => {
  it('the nearest audited ancestor with an unparseable at refuses; the older waived sha is never used', () => {
    const r = mkRepo();
    const out = plan(r, { records: [rec(r.shas[0]), rec(r.shas[1], { at: 'not-a-date' })], waivers: [waiver(r.shas[0])] });
    expect(out.state).toBe('refuse');
  });
  it('the nearest audited ancestor with verdict MAYBE refuses', () => {
    const r = mkRepo();
    const out = plan(r, { records: [rec(r.shas[0]), rec(r.shas[1], { verdict: 'MAYBE' })], waivers: [waiver(r.shas[0])] });
    expect(out.state).toBe('refuse');
  });
  it('rev-list throws → refuse, no basis', () => {
    const r = mkRepo();
    const exec = (cmd, args, o) => { if (args.includes('rev-list')) throw new Error('boom'); return execFileSync(cmd, args, o); };
    const out = plan(r, { records: [rec(r.shas[1])], waivers: [waiver(r.shas[1])], exec });
    expect(out.state).toBe('refuse');
    expect(out.basis).toBeUndefined();
  });
  it('ls-remote returns two lines → refuse', () => {
    const r = mkRepo();
    const exec = (cmd, args, o) => args.includes('ls-remote')
      ? `${r.shas[3]}\trefs/heads/${REF}\n${r.shas[2]}\trefs/heads/${REF}\n` : execFileSync(cmd, args, o);
    expect(plan(r, { records: [rec(r.shas[1])], waivers: [waiver(r.shas[1])], exec }).state).toBe('refuse');
  });
  it('a merge commit in B..tip refuses', () => {
    const r = mkRepo(4, { merge: true });
    expect(plan(r, { records: [rec(r.shas[1])], waivers: [waiver(r.shas[1])] }).state).toBe('refuse');
  });
  it('a revoked root waiver refuses', () => {
    const r = mkRepo();
    const out = plan(r, { records: [rec(r.shas[1])], waivers: [waiver(r.shas[1])], revoked: () => true });
    expect(out.state).toBe('refuse');
  });
  it("waiver findings not byte-equal to B's audit refuse", () => {
    const r = mkRepo();
    const out = plan(r, { records: [rec(r.shas[1])], waivers: [waiver(r.shas[1], { findings: ['a.mjs:10 weak '] })] });
    expect(out.state).toBe('refuse');
  });
  it('no waiver for B, B not WEAKENED, or B a delta record all refuse', () => {
    const r = mkRepo();
    expect(plan(r, { records: [rec(r.shas[1])], waivers: [] }).state).toBe('refuse');
    expect(plan(r, { records: [rec(r.shas[1], { verdict: 'NOT WEAKENED', findings: [] })], waivers: [waiver(r.shas[1])] }).state).toBe('refuse');
    expect(plan(r, { records: [rec(r.shas[1], { basis: r.shas[0] })], waivers: [waiver(r.shas[1])] }).state).toBe('refuse');
  });
  it('no audited ancestor within maxWalk refuses with no-waived-ancestor', () => {
    const r = mkRepo(4);
    const out = plan(r, { records: [rec(r.shas[0])], waivers: [waiver(r.shas[0])], maxWalk: 2 });
    expect(out).toMatchObject({ state: 'refuse', reason: 'no-waived-ancestor' });
  });
  it('a malformed record anywhere refuses', () => {
    const r = mkRepo();
    expect(plan(r, { records: [rec(r.shas[1]), { head: 'zz' }], waivers: [waiver(r.shas[1])] }).state).toBe('refuse');
  });
  it('a planted replace ref does not change chain or tip, and GIT_DIR in env is ignored', () => {
    const r = mkRepo();
    const base = plan(r, { records: [rec(r.shas[1])], waivers: [waiver(r.shas[1])] });
    sh(r.work, 'replace', r.shas[2], r.shas[0]);
    const other = mkRepo(2);
    const env = { PATH: process.env.PATH, HOME: r.root, GIT_DIR: join(other.work, '.git'), GIT_WORK_TREE: other.work };
    const out = runPlan({ repo: r.work, ref: REF, env, loadRecords: () => [rec(r.shas[1])], loadWaivers: () => [waiver(r.shas[1])] });
    expect(base).toMatchObject({ state: 'audit-needed', basis: r.shas[1] });
    expect(out).toMatchObject({ state: 'audit-needed', basis: r.shas[1] });
  });
  it('spawns no gh', () => {
    const r = mkRepo(); const cmds = [];
    const exec = (cmd, args, o) => { cmds.push(cmd); return execFileSync(cmd, args, o); };
    plan(r, { records: [rec(r.shas[1])], waivers: [waiver(r.shas[1])], exec });
    expect(cmds.length).toBeGreaterThan(0);
    expect(cmds.every(c => c === 'git')).toBe(true);
  });
});

describe('rewaive-plan: positive flow and request shape', () => {
  it('a linear 2-commit push after a waived WEAKENED head gives audit-needed, then a request superseding B', () => {
    const r = mkRepo();
    const [, B, , H] = r.shas;
    const first = plan(r, { records: [rec(B)], waivers: [waiver(B)] });
    expect(first).toMatchObject({ state: 'audit-needed', basis: B });
    expect(first.command).toBe(`node scripts/operations/run.mjs codex-audit --base=origin/main --head=${H}`);
    const second = plan(r, { records: [rec(B), rec(H, { findings: ['f3.txt:1 new'] })], waivers: [waiver(B)] });
    expect(second.state).toBe('request');
    expect(second.request).toEqual({ ref: REF, sha: H, ruling: 'R1085', findings: ['f3.txt:1 new'], reason: `ci-heal re-waiver; supersedes ${B}` });
    expect(second.table[0]).toMatchObject({ file: 'f3.txt', class: 'new-file', sameTextAsWaived: null });
  });
  it("request.findings equals H's own audit findings even when one is textually identical to a waived finding", () => {
    const r = mkRepo();
    const [, B, , H] = r.shas;
    const own = ['a.mjs:10 weak', 'b.mjs:2 other'];
    const out = plan(r, { records: [rec(B), rec(H, { findings: own })], waivers: [waiver(B)] });
    expect(out.request.findings).toEqual(own);
    expect(out.table[0]).toMatchObject({ class: 'unchanged-file', sameTextAsWaived: 0 });
  });
  it('a latest NOT WEAKENED head is not-needed; a delta WEAKENED head refuses; an unaudited tip with an own record is judged on its latest', () => {
    const r = mkRepo();
    const [, B, , H] = r.shas;
    expect(plan(r, { records: [rec(B), rec(H, { verdict: 'NOT WEAKENED', findings: [] })], waivers: [waiver(B)] }).state).toBe('not-needed');
    expect(plan(r, { records: [rec(B), rec(H, { basis: B })], waivers: [waiver(B)] }).state).toBe('refuse');
  });
  it('classifies findings: unparsed, new-file, edited-file', () => {
    const t = classifyFindings(['nothing here', 'x.mjs:3 y', 'y.mjs:4 z'], { changed: ['y.mjs'], tracked: ['x.mjs', 'y.mjs'] }, []);
    expect(t.map(x => x.class)).toEqual(['unparsed', 'unchanged-file', 'edited-file']);
  });
});

describe('rewaive-plan: pure planner', () => {
  const B = 'b'.repeat(40), H = 'c'.repeat(40);
  it('refuses a chain whose head is not the tip', () => {
    expect(planRewaive({ ref: REF, tip: H, chain: [B, H], merges: [], records: [], waivers: [], wellFormed: () => true }).state).toBe('refuse');
  });
});

describe('rewaive-plan: --file-request', () => {
  it('with the op missing exits 3 and writes nothing', () => {
    const r = mkRepo();
    const [, B, , H] = r.shas;
    const out = runCli({ argv: [`--ref=${REF}`, '--file-request'], repo: r.work, env: { PATH: process.env.PATH, HOME: r.root },
      loadRecords: () => [rec(B), rec(H)], loadWaivers: () => [waiver(B)], stdout: () => {} });
    expect(out.code).toBe(3);
    expect(existsSync(join(r.root, 'workspace/.operations/handoff/waiver-requests.jsonl'))).toBe(false);
  });
  it('with the op present appends exactly one request line, and refuses to file when not a request', () => {
    const r = mkRepo();
    const [, B, , H] = r.shas;
    const dir = join(r.root, 'workspace/.operations/handoff');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'waiver-requests.jsonl');
    // Stand-in for the worker-safe op: appends the stdin JSON as one line (the real op validates and appends the same way).
    writeFileSync(join(dir, 'waive-request.mjs'),
      `import { appendFileSync, readFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(file)}, JSON.stringify(JSON.parse(readFileSync(0, 'utf8'))) + '\\n');\n`);
    const env = { PATH: process.env.PATH, HOME: r.root };
    const noop = runCli({ argv: [`--ref=${REF}`, '--file-request'], repo: r.work, env, loadRecords: () => [rec(B)], loadWaivers: () => [waiver(B)], stdout: () => {} });
    expect(noop.code).toBe(1);
    expect(existsSync(file)).toBe(false);
    const ok = runCli({ argv: [`--ref=${REF}`, '--file-request'], repo: r.work, env, loadRecords: () => [rec(B), rec(H)], loadWaivers: () => [waiver(B)], stdout: () => {} });
    expect(ok.code).toBe(0);
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ ref: REF, sha: H, findings: ['a.mjs:10 weak'] });
  });
});

describe('rewaive-plan: pins', () => {
  it('codex-audit.json delta.maxFiles is 0 and has no waivedCarry', () => {
    const p = resolve(dirname(fileURLToPath(import.meta.url)), '../../settings/codex-audit.json');
    const cfg = JSON.parse(readFileSync(p, 'utf8'));
    expect(cfg.audit?.delta?.maxFiles).toBe(0);
    expect(JSON.stringify(cfg)).not.toContain('waivedCarry');
  });
});
