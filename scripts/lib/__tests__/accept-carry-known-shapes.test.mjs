import { describe, expect, it } from 'vitest';
import { isKnownMachineBody, latestAcceptRecord } from '../accept-carry-forward.mjs';
import { buildExhaustedRetryRecoveredComment } from '../../conveyor/exhausted-retry.mjs';
import { INFO_NOTE_COMMENT_MARKER } from '../../conveyor/reconcile-note-comment.mjs';
import { buildRoundExtensionComment } from '../../conveyor/round-extension-mark.mjs';

// #6584 / #6664: machine comments posted AFTER a human clearance must not read as a possible hold (laterVerdict).
const bot = { author: { login: 'web-everything[bot]' } };
const operator = { author: { login: 'chalbert' } };
const stranger = { author: { login: 'mallory' } };
const sha = 'a'.repeat(40);

const recovered = buildExhaustedRetryRecoveredComment({ kind: 'exhaustion', headSha: sha });
const note = `${INFO_NOTE_COMMENT_MARKER}\n\nnote: timeout-retry-fallback-heal\n\nPR #6584: falling back to ordinary ci-heal\n\n<!-- conveyor-note-key: timeout-retry-fallback-heal:6584:x -->`;
const grant = (overrides = {}) => buildRoundExtensionComment({ repo: 'web-everything/web-everything', pr: 6664, by: 1,
  actor: 'chalbert', channel: 'claude-code-chat', reason: 'acting judge: progress', at: '2026-11-12T04:16:46.410Z', ...overrides });

describe('known machine shapes that follow a human clearance (#6584/#6664)', () => {
  it('the real exhausted-retry-recovered comment from a trusted author is a machine body', () => {
    expect(isKnownMachineBody(recovered, bot)).toBe(true);
  });
  it('the recovered comment from an untrusted author, or without metadata, stays a possible hold', () => {
    expect(isKnownMachineBody(recovered, stranger)).toBe(false);
    expect(isKnownMachineBody(recovered)).toBe(false);
  });
  it('a recovered comment with extra prose after the strict shape stays a possible hold', () => {
    expect(isKnownMachineBody(`${recovered}\nplease also hold this PR`, bot)).toBe(false);
  });
  it('the informational conveyor note from a trusted author is a machine body; untrusted is not', () => {
    expect(isKnownMachineBody(note, bot)).toBe(true);
    expect(isKnownMachineBody(note, stranger)).toBe(false);
    expect(isKnownMachineBody(note)).toBe(false);
  });
  it('an info-note heading followed by operator hold prose is not a machine note (audit round 1)', () => {
    expect(isKnownMachineBody(`${INFO_NOTE_COMMENT_MARKER}\n\nPlease hold this PR; I revoke my acceptance`, operator)).toBe(false);
    expect(isKnownMachineBody(note, operator)).toBe(false);
  });
  it('a round-extension grant with extra prose or a revocation is not a machine note (audit round 1)', () => {
    expect(isKnownMachineBody(`${grant()}\n\nI revoke my acceptance`, operator)).toBe(false);
    expect(isKnownMachineBody(grant().replace('\n\nOperator', '\n\nI revoke my acceptance. Operator'), operator)).toBe(false);
  });
  it('the operator-written round-extension grant with its strict marker is a machine body', () => {
    expect(isKnownMachineBody(grant(), operator)).toBe(true);
  });
  it('a round-extension grant is refused for a non-operator author, a bot, or a forged/duplicate marker', () => {
    expect(isKnownMachineBody(grant(), stranger)).toBe(false);
    expect(isKnownMachineBody(grant(), bot)).toBe(false);
    expect(isKnownMachineBody(grant(), undefined)).toBe(false);
    expect(isKnownMachineBody(grant().replace(/<!-- round-extension: .* -->/, '<!-- round-extension: {nope} -->'), operator)).toBe(false);
    const doubled = `${grant()}\n${grant().split('\n').at(-1)}`;
    expect(isKnownMachineBody(doubled, operator)).toBe(false);
  });
  it('a grant whose actor is not an operator login is refused', () => {
    expect(isKnownMachineBody(grant({ actor: 'mallory' }), operator)).toBe(false);
  });

  it('thread replay: these shapes after the clearance no longer set laterVerdict; an unknown comment still does', () => {
    const clear = { author: { login: 'chalbert' }, createdAt: '2026-11-11T18:44:00Z',
      body: `✅ review\n\n<!-- reviewed-sha: ${sha} -->` };
    const mk = (body, c) => ({ ...c, createdAt: '2026-11-11T19:00:00Z', body });
    const base = latestAcceptRecord([clear], []);
    expect(base?.sha).toBe(sha);
    const thread = [clear, mk(recovered, bot), mk(note, bot), mk(grant(), operator)];
    expect(latestAcceptRecord(thread, []).laterVerdict).toBe(false);
    expect(latestAcceptRecord([...thread, mk('looks wrong to me', stranger)], []).laterVerdict).toBe(true);
  });
});
