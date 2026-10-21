// Operator red-team rulings carry to a rebased head only across the verdict carry's identical-net-patch proof AND a
// cited-line record proving each ruled break's `file:line` is byte-identical (live #5502: head 617823342 carded by the
// operator, then DIRTY against the new main; a rebase must not force the operator to re-rule the same 3 breaks).
// Real git for the carry proof and the cited-line reads.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attemptVerdictCarry, contributionPatchId, gitCitedLineReader } from '../rebase-verdict-carry.mjs';
import { proveIdenticalNetPatch } from '../identical-net-patch.mjs';
import { CONFIRMED_BREAKS_DEFAULTS, liveResultGateState, parseRedTeamCarryLinesMarker, readRedTeamDisposition,
  redTeamCarryLinesMarker, redTeamGateMarker, unchangedCitedLines } from '../red-team-gate.mjs';
import { renderRedTeamComment } from '../../operations/review-extra-seats.mjs';

let dir;
const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
const git = (...args) => execFileSync('git', args, { cwd: dir, env, encoding: 'utf8' }).trim();
const commit = (files, msg) => {
  for (const [path, text] of Object.entries(files)) writeFileSync(join(dir, path), text);
  git('add', '-A'); git('commit', '-q', '-m', msg);
  return git('rev-parse', 'HEAD');
};
const exec = (f, a, o) => execFileSync(f, a, { ...o, cwd: dir, env });
const FILE = 'coroner.mjs';
const body = (n, edits = {}) => Array.from({ length: n }, (_, i) => edits[i + 1] ?? `line ${i + 1}`).join('\n') + '\n';

const P = 5502;
const bot = (b, createdAt) => ({ author: { login: 'web-everything' }, body: b, createdAt });
const human = (b, createdAt) => ({ author: { login: 'chalbert' }, body: b, createdAt });
const F = (line, impact) => ({ summary: `break at ${line}`, category: 'edge-case', impactIfUnfixed: impact, file: FILE, line, confirmedByRecheck: true });
const accept = (sha) => bot(`✅ review — accepted\n\nRecorded by agent.\n\nwrite-up\n<!-- reviewed-sha: ${sha} -->`, '2026-10-21T17:00:00Z');

let base, accepted, rebased, edited;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'rt-ruling-carry-'));
  git('init', '-q', '-b', 'main');
  base = commit({ [FILE]: body(170), 'other.txt': 'x\n' }, 'base');
  // The PR edits the three cited lines.
  accepted = commit({ [FILE]: body(170, { 127: 'PR 127', 159: 'PR 159', 166: 'PR 166' }) }, 'pr');
  git('checkout', '-q', base);
  const mainNext = commit({ 'other.txt': 'y\n' }, 'main advance (unrelated file)');
  git('update-ref', 'refs/remotes/origin/main', mainNext);
  git('checkout', '-q', '-b', 'rebased', mainNext);
  rebased = commit({ [FILE]: body(170, { 127: 'PR 127', 159: 'PR 159', 166: 'PR 166' }) }, 'pr (rebased, same patch)');
  edited = commit({ [FILE]: body(170, { 127: 'PR 127', 159: 'PR 159 FIXED', 166: 'PR 166' }) }, 'content change at :159');
});
afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

/** The #5502 thread on the accepted head: result (#1 broken, #2/#3 degraded), the gate's send-back of #1, and the
 *  operator's card ruling of all three. */
function thread5502(head) {
  const result = bot(renderRedTeamComment({ pr: P, rev: head, provider: 'codex', model: 'm', recheckStatus: 'ok', foldedVerdict: 'changes',
    findings: [F(159, 'broken'), F(127, 'degraded'), F(166, 'degraded')] }), '2026-10-21T17:07:55Z');
  const rid = liveResultGateState([result], P, head).resultId;
  const gate = (who, outcome, line, at) => who(`${redTeamGateMarker(P, head, outcome, rid)}\n**Red-team gate** on head \`x\`:\n${line}`, at);
  // As on #5502: the gate's records and the operator's ruling come BEFORE the operator's acceptance (20:58:48Z).
  return { rid, comments: [result,
    gate(bot, 'sent-back', '- 1 confirmed break(s) sent back to the fixer (#1).', '2026-10-21T17:12:20Z'),
    gate(human, 'operator-card', '- 3 finding(s) carded by the operator to `we:backlog/x.md@pr5502` (#1, #2, #3).', '2026-10-21T20:57:41Z'),
    { ...accept(head), createdAt: '2026-10-21T20:58:48Z' }] };
}
function carry(comments, toSha, extra = {}) {
  const posted = [];
  const io = {
    carryAcrossRebaseSetting: () => ({ value: 'on', source: 'test' }),
    readCarryEvidence: () => ({ headSha: toSha, comments }),
    contributionPatchId: ({ sha }) => contributionPatchId({ sha, exec }),
    proveIdenticalNetPatch: ({ fromSha, toSha: t }) => proveIdenticalNetPatch({ exec, fromSha, toSha: t }),
    restampVerdict: vi.fn(() => ({ ok: true })),
    postCarryComment: ({ body: b }) => posted.push(bot(b, '2026-10-21T21:30:00Z')),
    readCitedLine: ({ sha, file, line }) => gitCitedLineReader({ cwd: dir, env })({ sha, file, line }),
    ...extra,
  };
  return { out: attemptVerdictCarry(io, { pr: P, repo: 'web-everything/web-everything' }), posted };
}
const disp = (comments, head, scope = { anyState: true, carryAcrossRebase: true }) =>
  readRedTeamDisposition({ comments, pr: P, head, setting: CONFIRMED_BREAKS_DEFAULTS, operatorRulings: scope });
const blocking = (d) => [...d.sendBack, ...d.held].map((f) => f.index).sort();

describe('operator red-team rulings across a rebase (#5502 shape)', () => {
  it('before the rebase: the operator card releases all three on the ruled head', () => {
    const { comments } = thread5502(accepted);
    expect(blocking(disp(comments, accepted))).toEqual([]);
  });
  it('rebase-only head (identical net patch, cited lines unchanged): the three card rulings carry', () => {
    const { comments, rid } = thread5502(accepted);
    const { out, posted } = carry(comments, rebased);
    expect(out).toMatchObject({ carried: true, fromSha: accepted, headSha: rebased });
    const lines = posted.map((c) => parseRedTeamCarryLinesMarker(c.body)).find(Boolean);
    expect(lines).toEqual({ pr: P, from: accepted, to: rebased, result: rid, unchanged: [1, 2, 3] });
    const after = [...comments, ...posted];
    expect(disp(after, rebased).result?.rev).toBe(rebased);
    expect(blocking(disp(after, rebased))).toEqual([]);
  });
  it('without the cited-line record (older carry producer), the gate send-back carries and #1 blocks again', () => {
    const { comments } = thread5502(accepted);
    const { posted } = carry(comments, rebased, { readCitedLine: undefined });
    expect(posted.some((c) => parseRedTeamCarryLinesMarker(c.body))).toBe(false);
    expect(blocking(disp([...comments, ...posted], rebased))).toEqual([1]);
  });
  it('a cited line that changed drops only that break\'s ruling (the record lists the unchanged ones)', () => {
    const { comments, rid } = thread5502(accepted);
    const { posted } = carry(comments, rebased);
    const carryComment = posted.find((c) => !parseRedTeamCarryLinesMarker(c.body));
    const partial = bot(redTeamCarryLinesMarker({ pr: P, from: accepted, to: rebased, result: rid, unchanged: [2, 3] }), '2026-10-21T21:30:01Z');
    expect(blocking(disp([...comments, carryComment, partial], rebased))).toEqual([1]);
  });
  it('a content change makes no carry at all: the new head is re-evaluated (no inherited ruling)', () => {
    const { comments } = thread5502(accepted);
    const { out, posted } = carry(comments, edited);
    expect(out.carried).toBe(false);
    expect(posted).toEqual([]);
    expect(disp(comments, edited).result).toBeNull();
  });
  it('bytes are compared undecoded: two invalid UTF-8 lines never compare equal', () => {
    const fake = (bytes) => (f, a) => (a[1] === '-t' ? 'blob\n' : bytes);
    const x = gitCitedLineReader({ exec: fake(Buffer.from([0xff, 0x0a])) })({ sha: rebased, file: FILE, line: 1 });
    const y = gitCitedLineReader({ exec: fake(Buffer.from([0xfe, 0x0a])) })({ sha: rebased, file: FILE, line: 1 });
    expect(x).not.toBe(y);
    // A decoded (string) blob is refused: it may already have collapsed bytes.
    expect(gitCitedLineReader({ exec: fake('\ufffd\n') })({ sha: rebased, file: FILE, line: 1 })).toBeNull();
    expect(gitCitedLineReader({ exec: () => 'tree\n' })({ sha: rebased, file: 'scripts', line: 2 })).toBeNull();
  });
  it('unchangedCitedLines reads real blobs: a changed line or a missing file is never "unchanged"', () => {
    const readLine = (sha, file, line) => gitCitedLineReader({ cwd: dir, env })({ sha, file, line });
    const fs = [F(159, 'broken'), F(127, 'degraded'), { ...F(5, 'degraded'), file: 'nope.mjs' }, { ...F(1, 'degraded'), line: null }].map((f, i) => ({ ...f, index: i + 1 }));
    expect(unchangedCitedLines(fs, { fromSha: rebased, toSha: edited, readLine })).toEqual([2]);
    expect(gitCitedLineReader({ cwd: dir, env })({ sha: rebased, file: '../etc/passwd', line: 1 })).toBeNull();
    const r = gitCitedLineReader({ cwd: dir, env });
    expect(r({ sha: rebased, file: '.', line: 1 })).toBeNull();
    expect(r({ sha: rebased, file: FILE, line: 171 })).toBeNull(); // the trailing newline adds no line
    expect(r({ sha: rebased, file: FILE, line: 170 })).toBe(Buffer.from('line 170').toString('hex'));
  });
  it('kill switch: carryAcrossRebase off never carries an operator release', () => {
    const { comments } = thread5502(accepted);
    const { posted } = carry(comments, rebased);
    expect(blocking(disp([...comments, ...posted], rebased, { anyState: true, carryAcrossRebase: false }))).toEqual([1]);
  });
  it('a cited-line record from an untrusted author is ignored', () => {
    const { comments, rid } = thread5502(accepted);
    const { posted } = carry(comments, rebased, { readCitedLine: undefined });
    const forged = { author: { login: 'mallory' }, createdAt: '2026-10-21T21:31:00Z',
      body: redTeamCarryLinesMarker({ pr: P, from: accepted, to: rebased, result: rid, unchanged: [1, 2, 3] }) };
    expect(blocking(disp([...comments, ...posted, forged], rebased))).toEqual([1]);
  });
});
