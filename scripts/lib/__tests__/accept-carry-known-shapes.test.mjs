import { describe, expect, it } from 'vitest';
import { isKnownMachineBody, latestAcceptRecord } from '../accept-carry-forward.mjs';
import { buildExhaustedRetryRecoveredComment } from '../../conveyor/exhausted-retry.mjs';
import { buildNoteComment, INFO_NOTE_COMMENT_MARKER } from '../../conveyor/reconcile-note-comment.mjs';
import { buildRoundExtensionComment } from '../../conveyor/round-extension-mark.mjs';

// #6584: machine comments posted AFTER a human clearance must not read as a possible hold (laterVerdict),
// while a real revocation (any other text, author or channel) must still hold.
const bot = { author: { login: 'web-everything[bot]' } };
const operator = { author: { login: 'chalbert' } };
const stranger = { author: { login: 'mallory' } };
const sha = 'a'.repeat(40);

const recovered = buildExhaustedRetryRecoveredComment({ kind: 'exhaustion', headSha: sha });
const fallbackNote = (text) => buildNoteComment({ kind: 'timeout-retry-fallback-heal', prNumber: 6584,
  reason: 'timeout-evidence:evidence-read-deadline',
  text: text ?? 'PR #6584: timeout retry ineligible (timeout-evidence:evidence-read-deadline); falling back to ordinary ci-heal (0 of 3 attempts spent)' });
const note = fallbackNote();
const revocation = 'Please hold this PR; I revoke my acceptance';

describe('known machine shapes that follow a human clearance (#6584)', () => {
  it('the real exhausted-retry-recovered comment from a bot login is a machine body', () => {
    expect(isKnownMachineBody(recovered, bot)).toBe(true);
  });
  it('the recovered comment from an untrusted author, an operator, or no metadata stays a possible hold', () => {
    expect(isKnownMachineBody(recovered, stranger)).toBe(false);
    expect(isKnownMachineBody(recovered, operator)).toBe(false);
    expect(isKnownMachineBody(recovered)).toBe(false);
  });
  it('a recovered comment with extra prose after the strict shape stays a possible hold', () => {
    expect(isKnownMachineBody(`${recovered}\n${revocation}`, bot)).toBe(false);
  });
  it('the real timeout-fallback info note from a bot login is a machine body', () => {
    expect(isKnownMachineBody(note, bot)).toBe(true);
  });
  it('the info note from an untrusted author, an operator, or no metadata stays a possible hold', () => {
    expect(isKnownMachineBody(note, stranger)).toBe(false);
    expect(isKnownMachineBody(note, operator)).toBe(false);
    expect(isKnownMachineBody(note)).toBe(false);
  });
  it('audit probe: viewerDidAuthor alone never makes a note or recovered comment exempt', () => {
    expect(isKnownMachineBody(note, { ...operator, viewerDidAuthor: true })).toBe(false);
    expect(isKnownMachineBody(recovered, { viewerDidAuthor: true })).toBe(false);
  });
  it('audit probe: an info-note heading followed by hold prose, or hold prose inside the note text, is not exempt', () => {
    expect(isKnownMachineBody(`${INFO_NOTE_COMMENT_MARKER}\n\n${revocation}`, bot)).toBe(false);
    expect(isKnownMachineBody(fallbackNote(revocation), bot)).toBe(false);
    expect(isKnownMachineBody(`${note}\n\n${revocation}`, bot)).toBe(false);
    expect(isKnownMachineBody(note.replace('timeout-retry-fallback-heal', 'some-other-kind'), bot)).toBe(false);
    expect(isKnownMachineBody(buildNoteComment({ kind: 'other', prNumber: 1, text: revocation }, { informational: true }), bot)).toBe(false);
  });
  it('audit probe: an operator round-extension grant carrying a revocation reason is never exempt (grant shape left out)', () => {
    const grant = reason => buildRoundExtensionComment({ repo: 'web-everything/web-everything', pr: 6664, by: 1,
      actor: 'chalbert', channel: 'claude-code-chat', reason, at: '2026-11-12T04:16:46.410Z' });
    expect(isKnownMachineBody(grant('I revoke my acceptance. Hold this PR pending re-review.'), operator)).toBe(false);
    expect(isKnownMachineBody(grant('acting judge: progress'), operator)).toBe(false);
  });

  it('thread replay: the bot shapes after the clearance no longer set laterVerdict; an unknown comment still does', () => {
    const clear = { author: { login: 'chalbert' }, createdAt: '2026-11-11T18:44:00Z',
      body: `✅ review\n\n<!-- reviewed-sha: ${sha} -->` };
    const mk = (body, c) => ({ ...c, createdAt: '2026-11-11T19:00:00Z', body });
    expect(latestAcceptRecord([clear], [])?.sha).toBe(sha);
    const thread = [clear, mk(recovered, bot), mk(note, bot)];
    expect(latestAcceptRecord(thread, []).laterVerdict).toBe(false);
    expect(latestAcceptRecord([...thread, mk('looks wrong to me', stranger)], []).laterVerdict).toBe(true);
    expect(latestAcceptRecord([...thread, mk(`${INFO_NOTE_COMMENT_MARKER}\n\n${revocation}`, { ...operator, viewerDidAuthor: true })], []).laterVerdict).toBe(true);
  });
});
