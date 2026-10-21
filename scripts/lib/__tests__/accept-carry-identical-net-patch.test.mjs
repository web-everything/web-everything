// Accept carry across an identical net change (operator brief 2026-10-21; card #2884's "auto-re-stamp on a provably
// identical rebase" option). Real git for every proof: patch ids and the identical-net-patch proof run on real objects.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attemptVerdictCarry, contributionPatchId, carryCandidateShas, findCarriableVerdict, isAcceptedRearmBody,
  parseVerdictCarriedMarker } from '../rebase-verdict-carry.mjs';
import { proveIdenticalNetPatch } from '../identical-net-patch.mjs';
import { buildRearmComment, countRearmComments } from '../../conveyor/rearm-review.mjs';
import { isKnownMachineBody } from '../accept-carry-forward.mjs';

let dir;
const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
const git = (...args) => execFileSync('git', args, { cwd: dir, env, encoding: 'utf8' }).trim();
const commit = (files, msg, { mode } = {}) => {
  for (const [path, text] of Object.entries(files)) {
    writeFileSync(join(dir, path), text);
    if (mode) chmodSync(join(dir, path), mode);
  }
  git('add', '-A'); git('commit', '-q', '-m', msg);
  return git('rev-parse', 'HEAD');
};
const exec = (f, a, o) => execFileSync(f, a, { ...o, cwd: dir, env });
const trusted = body => ({ author: { login: 'chalbert' }, body, createdAt: '2026-10-21T00:00:00Z' });
const accept = sha => trusted(`✅ review — accepted\n\nRecorded by agent.\n<!-- reviewed-sha: ${sha} -->`);
const restamp = sha => trusted(`📌 review — acceptance re-stamped after a rebase (no new review)\n\nRecorded by drain via drain-rebase.\n<!-- reviewed-sha: ${sha} -->`);
const redTeam = sha => trusted(`<!-- we:red-team-advisory pr=7 rev=${sha} -->\nNo confirmed breaks.`);
const acceptedRearm = () => trusted(buildRearmComment({ actor: 'conveyor fix agent', decision: { rearmFrom: 'review:accepted', keepsHuman: false } }));
const bounceRearm = () => trusted(buildRearmComment({ actor: 'conveyor fix agent', decision: { rearmFrom: 'review:changes', keepsHuman: false } }));
const paused = sha => trusted(`<!-- approval-prevention-filed:${sha} -->\nRecorded the prevention filing owed by web-everything/web-everything#7's independent review, mechanically, on approval (operator rule, 2026-09-27) — recorded, owed; filing paused and will resume automatically.`);

let base, accepted, mainNext, rebased, oneByte, modeOnly, jit, restored;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'accept-carry-'));
  git('init', '-q', '-b', 'main');
  base = commit({ 'a.txt': 'one\ntwo\nthree\n', 'other.txt': 'x\n' }, 'base');
  // The PR: one edit.
  accepted = commit({ 'a.txt': 'one\nTWO\nthree\n', 'card.md': 'card xabc\n' }, 'pr change');
  // main advances on an unrelated file; the drain's rebase replays the same change onto it.
  git('checkout', '-q', base); mainNext = commit({ 'other.txt': 'y\n' }, 'main advance');
  git('update-ref', 'refs/remotes/origin/main', mainNext);
  git('checkout', '-q', '-b', 'rebased', mainNext);
  rebased = commit({ 'a.txt': 'one\nTWO\nthree\n', 'card.md': 'card xabc\n' }, 'pr change (rebased)');
  // One byte more than what was reviewed.
  oneByte = commit({ 'card.md': 'card xabc!\n' }, 'one byte');
  git('checkout', '-q', rebased);
  modeOnly = commit({ 'card.md': 'card xabc\n' }, 'mode only', { mode: 0o755 });
  // The live #5779 shape on the SAME base: the drain JIT-numbers the card (content moves, accept re-stamped onto it),
  // CI fails, and the repair restores exactly the reviewed content.
  git('checkout', '-q', rebased);
  jit = commit({ 'card.md': 'card #6674\n' }, 'drain: JIT-number');
  restored = commit({ 'card.md': 'card xabc\n' }, 'fix(backlog): restore provisional identity');
});
afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

function io(comments, headSha, extra = {}) {
  return {
    carryAcrossRebaseSetting: () => ({ value: 'on', source: 'test' }),
    readCarryEvidence: () => ({ headSha, comments }),
    contributionPatchId: ({ sha }) => contributionPatchId({ sha, exec }),
    proveIdenticalNetPatch: ({ fromSha, toSha }) => proveIdenticalNetPatch({ exec, fromSha, toSha }),
    restampVerdict: vi.fn(() => ({ ok: true })),
    postCarryComment: vi.fn(),
    ...extra,
  };
}

describe('accept carry across an identical net change', () => {
  it('same-patch rebase → accept carried through the existing restamp + carried marker; no re-arm, so no round', () => {
    const comments = [accept(accepted), paused(accepted), redTeam(accepted), acceptedRearm()];
    const fake = io(comments, rebased);
    const out = attemptVerdictCarry(fake, { pr: 7, repo: 'o/r' });
    expect(out).toMatchObject({ carried: true, fromSha: accepted, headSha: rebased });
    expect(fake.restampVerdict).toHaveBeenCalledWith(expect.objectContaining({ newHead: rebased }));
    const body = fake.postCarryComment.mock.calls[0][0].body;
    expect(parseVerdictCarriedMarker(body)).toMatchObject({ fromSha: accepted, toSha: rebased });
    // The red-team result is re-keyed to the new head, never left implicit.
    expect(body).toContain(`<!-- we:red-team-advisory pr=7 rev=${rebased} -->`);
    // The round counter reads re-arm comments; the carry wrote none.
    expect(countRearmComments([...comments, trusted(body)])).toBe(1);
  });
  it('one-byte change → re-review (no restamp, no comment)', () => {
    const fake = io([accept(accepted), redTeam(accepted)], oneByte);
    expect(attemptVerdictCarry(fake, { pr: 7, repo: 'o/r' }).carried).toBe(false);
    expect(fake.restampVerdict).not.toHaveBeenCalled(); expect(fake.postCarryComment).not.toHaveBeenCalled();
  });
  it('mode-only change → re-review', () => {
    const fake = io([accept(rebased), redTeam(rebased)], modeOnly);
    const out = attemptVerdictCarry(fake, { pr: 7, repo: 'o/r' });
    expect(out.carried).toBe(false);
    expect(fake.restampVerdict).not.toHaveBeenCalled();
  });
  it('live #5779 shape: accept re-stamped onto a JIT head, repair restores the reviewed tree → carried from the REVIEWED head', () => {
    const comments = [accept(rebased), redTeam(rebased), restamp(jit), acceptedRearm()];
    expect(carryCandidateShas(comments)).toEqual([jit, rebased]);
    const fake = io(comments, restored);
    expect(attemptVerdictCarry(fake, { pr: 7, repo: 'o/r' })).toMatchObject({ carried: true, fromSha: rebased, headSha: restored });
  });
  it('never carries over a bounce re-arm, a changes verdict, an unknown comment, or without a red-team record', () => {
    for (const later of [bounceRearm(), trusted('🔁 review — changes requested\n\nRecorded by x.'), trusted('please hold'),
      { author: { login: 'stranger' }, body: 'please hold' }]) {
      const fake = io([accept(accepted), redTeam(accepted), later], rebased);
      expect(attemptVerdictCarry(fake, { pr: 7, repo: 'o/r' }).carried, later.body).toBe(false);
    }
    expect(attemptVerdictCarry(io([accept(accepted)], rebased), { pr: 7, repo: 'o/r' }).carried).toBe(false);
    // An older candidate never skips a hold posted after it, even when a later re-stamp sits in between.
    const held = [accept(rebased), redTeam(rebased), trusted('please hold'), restamp(jit)];
    expect(findCarriableVerdict({ comments: held, headSha: restored, pr: 7, sha: rebased })).toBeNull();
    // A hold or a red-team break that quotes a reviewed-sha marker is never set aside as a "later record" (audit finding 1).
    for (const quoting of [trusted(`please hold <!-- reviewed-sha: ${jit} -->`),
      trusted(`🔁 review — changes requested\n\nRecorded by x.\n<!-- reviewed-sha: ${jit} -->`),
      trusted(`✅ review — accepted\n🔁 review — changes requested\n<!-- reviewed-sha: ${jit} -->`),
      trusted(`<!-- we:red-team-advisory pr=7 rev=${rebased} -->\n1. [**confirmed**] (correctness, broken) — Breaks it\n<!-- reviewed-sha: ${jit} -->`)]) {
      const thread = [accept(rebased), redTeam(rebased), quoting, restamp(jit), acceptedRearm()];
      expect(findCarriableVerdict({ comments: thread, headSha: restored, pr: 7, sha: rebased }), quoting.body).toBeNull();
      expect(attemptVerdictCarry(io(thread, restored), { pr: 7 }).carried, quoting.body).toBe(false);
    }
  });
  it('fails closed: no proof reader, setting off, a pushed head GitHub does not show yet, a refused restamp', () => {
    const comments = [accept(accepted), redTeam(accepted)];
    expect(attemptVerdictCarry(io(comments, rebased, { proveIdenticalNetPatch: undefined }), { pr: 7 }).carried).toBe(false);
    expect(attemptVerdictCarry(io(comments, rebased, { carryAcrossRebaseSetting: () => ({ value: 'off' }) }), { pr: 7 }).carried).toBe(false);
    expect(attemptVerdictCarry(io(comments, rebased), { pr: 7, expectHead: oneByte }).carried).toBe(false);
    const refused = io(comments, rebased, { restampVerdict: () => ({ ok: false, reason: 'review:human' }) });
    expect(attemptVerdictCarry(refused, { pr: 7 })).toMatchObject({ carried: false });
    expect(refused.postCarryComment).not.toHaveBeenCalled();
  });
  it('the neutral shapes are exact: appended prose or a human-hold re-arm is not neutral', () => {
    expect(isAcceptedRearmBody(acceptedRearm().body)).toBe(true);
    expect(isAcceptedRearmBody(`${acceptedRearm().body}\nalso: hold`)).toBe(false);
    expect(isAcceptedRearmBody(bounceRearm().body)).toBe(false);
    expect(isAcceptedRearmBody(buildRearmComment({ actor: 'x', decision: { rearmFrom: 'review:accepted', keepsHuman: true } }))).toBe(false);
    expect(isKnownMachineBody(paused(accepted).body, paused(accepted))).toBe(true);
    expect(isKnownMachineBody(`${paused(accepted).body}\nhold`, paused(accepted))).toBe(false);
  });
});
