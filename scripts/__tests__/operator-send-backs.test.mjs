import { describe, expect, it } from 'vitest';
import { openOperatorSendBacks, renderOperatorSendBackBrief } from '../lib/operator-send-backs.mjs';

// Live #6732 (2026-11-14): four fix rounds pushed real fixes, then ended their turn "awaiting verify" before the
// brief's late "post the proof" step, so no `## Fix evidence` comment ever carried the marker and the PR looped.
const OLD = 'e5ed9cb74' + 'a'.repeat(31), HEAD = '245c40542' + 'b'.repeat(31);
const original = {
  id: 'IC_kwDOsend', author: { login: 'chalbert' }, createdAt: '2026-11-13T21:12:31Z',
  url: 'https://github.com/web-everything/web-everything/pull/6732#issuecomment-6865040314',
  body: `🔁 review — changes requested\n\nRecorded by chalbert via babysitter.\n\nFix exactly these:\n\n1. plan.mjs:538 keep the audit hold.`,
};
const open = () => openOperatorSendBacks({ number: 6732, state: 'OPEN', headRefOid: HEAD, comments: [original] });

describe('operator send-back fix brief: evidence is posted before the round can end', () => {
  const brief = () => renderOperatorSendBackBrief(open());

  it('names the exact post command with the PR and repo taken from the send-back URL', () => {
    expect(brief()).toContain('gh pr comment 6732 --repo web-everything/web-everything --body-file');
  });

  it('posts the evidence once verify is green and never lets the turn end on a verify wait', () => {
    const text = brief();
    expect(text).toMatch(/as soon as your verify is green/i);
    expect(text).toMatch(/do not end your turn while verify is pending/i);
    expect(text).toMatch(/never end your turn[^.]*without that comment posted/i);
  });

  it('keeps the marker, the heading and the head line the reader requires', () => {
    const text = brief();
    expect(text).toContain('## Fix evidence');
    expect(text).toContain('<!-- addresses-operator-send-back: IC_kwDOsend -->');
    expect(text).toContain('Head: `<fixed head sha>`');
  });

  it('the comment the brief asks for really resolves the send-back (acceptance rules unchanged)', () => {
    const evidence = { id: 'c2', author: { login: 'web-everything' }, createdAt: '2026-11-14T10:00:00Z',
      body: `## Fix evidence\nHead: \`${HEAD}\`\n<!-- addresses-operator-send-back: IC_kwDOsend -->\nplan.mjs:538` };
    expect(openOperatorSendBacks({ number: 6732, state: 'OPEN', headRefOid: HEAD, comments: [original, evidence] })).toEqual([]);
    const named = { ...original, body: `${original.body}\nat head ${OLD.slice(0, 9)}` };
    expect(openOperatorSendBacks({ number: 6732, state: 'OPEN', headRefOid: HEAD, comments: [named] })).toHaveLength(1);
  });

  it('falls back to a placeholder PR when the URL carries none', () => {
    const [item] = open();
    expect(renderOperatorSendBackBrief([{ ...item, url: undefined }])).toContain('gh pr comment <pr-number> --repo <owner/repo> --body-file');
  });
});
