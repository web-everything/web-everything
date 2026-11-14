/**
 * Live #6732: the green-verify resume prompt must tell the resumed fixer exactly what a send-back evidence comment
 * is, and the orphan guard must stop blind re-dispatch after two rounds that ended without it (NEEDS-YOU instead).
 */
import { describe, expect, it } from 'vitest';
import { buildAwaitVerifyResumePrompt } from '../await-verify-pass.mjs';
import { planOrphanFixRound } from '../orphan-fix-round.mjs';
import { FIX_BEGIN_MARKER, FIX_END_MARKER } from '../fix-procedure.mjs';
import { CHANGES_VERDICT_PREFIX } from '../../review-set-label.mjs';

const SHA = '1efa95327d6186a88fe46dca3c2a604cdfa50401';
const rec = (over = {}) => ({ repo: 'web-everything/web-everything', pr: 6732, sha: SHA, ref: 'lane/x', who: 'fix-6732', kind: 'fix', attempt: 1, ...over });

describe('the green resume prompt for a fix round', () => {
  const prompt = buildAwaitVerifyResumePrompt({ kind: 'green', record: rec() });
  it('spells out the send-back evidence comment', () => {
    expect(prompt).toContain('## Fix evidence');
    expect(prompt).toContain(`Head: ${SHA}`);
    expect(prompt).toContain('<!-- addresses-operator-send-back: <id> -->');
    expect(prompt).toMatch(/file:line/);
    expect(prompt).toMatch(/open operator send-back/);
  });
  it('keeps the existing hand-back instruction and leaves ci-heal alone', () => {
    expect(prompt).toMatch(/before\/after evidence/);
    expect(buildAwaitVerifyResumePrompt({ kind: 'green', record: rec({ kind: 'ci-heal' }) })).not.toContain('## Fix evidence');
  });
});

describe('orphan guard backstop: two evidence-less rounds on the same send-back', () => {
  const BOT = { login: 'web-everything' };
  const c = (createdAt, body, author = BOT, extra = {}) => ({ createdAt, includesCreatedEdit: false, body, author, ...extra });
  const NOW = Date.parse('2026-11-14T12:00:00Z');
  const OLD = '8dbb6ad552c1e3e81a83697cf0cc4d5c5360005c';
  const VERDICT = c('2026-11-13T19:57:43Z', `${CHANGES_VERDICT_PREFIX}\n\nRecorded by agent.\n\nNet basis: \`0c6c1fb5caf43602aeff444ed5731b4c39e1c1ec..${OLD}\``);
  const SEND_BACK = c('2026-11-13T21:12:31Z', '🔁 review — changes requested\n\nRecorded by chalbert via babysitter.\n\n1. plan.mjs:538 keep the hold.',
    { login: 'chalbert' }, { id: 'IC_sb', url: 'https://github.com/web-everything/web-everything/pull/6732#issuecomment-1' });
  const round = (n, day = '14') => [c(`2026-11-${day}T0${n}:00:00Z`, `${FIX_BEGIN_MARKER}\n\n**Who:** \`fix-6732\``),
    c(`2026-11-${day}T0${n}:50:00Z`, `${FIX_END_MARKER}\n\n\`fix-6732\` released the fix claim at \`4d88cc44f\`.`)];
  const pr = (comments) => ({ number: 6732, labels: [{ name: 'review:changes' }], headRefOid: SHA, isDraft: false, comments });

  it('escalates with a NEEDS-YOU line instead of re-dispatching a third blind fixer', () => {
    const plan = planOrphanFixRound({ pr: pr([VERDICT, SEND_BACK, ...round(1), ...round(3)]), nowMs: NOW });
    expect(plan.decision).toBe('escalate');
    expect(plan.reason).toMatch(/^NEEDS-YOU:/);
    expect(plan.reason).toMatch(/send-back IC_sb/);
  });
  it('still re-dispatches after a single evidence-less round', () => {
    expect(planOrphanFixRound({ pr: pr([VERDICT, SEND_BACK, ...round(3)]), nowMs: NOW }).decision).toBe('redispatch');
  });
  it('does not count rounds that ended before the send-back was posted', () => {
    const plan = planOrphanFixRound({ pr: pr([VERDICT, ...round(1, '13'), ...round(2, '13'), SEND_BACK, ...round(3)]), nowMs: NOW });
    expect(plan.decision).toBe('redispatch');
  });
});
