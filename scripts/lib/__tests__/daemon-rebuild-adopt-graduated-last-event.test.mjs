import { describe, it, expect, vi } from 'vitest';
import { overlayGraduated } from '../daemon-rebuild/adopt.mjs';

const ref = 'lane/fix-daemon-pr-budgets-m1';
const sha = 'a'.repeat(40);
const build = 'b'.repeat(40);
const tree = 'c'.repeat(40);
const drop = { kind: 'auto-dropped', ref, reason: 'in-main', at: '2026-11-13T11:22:00.000Z' };
const noise = (kind) => ({ kind, ref, at: '2026-11-13T11:51:00.000Z' });

function evidence(events) {
  const responses = new Map([
    [JSON.stringify(['config', '--get-regexp', '^merge\\..*\\.driver$']), { status: 1, stdout: '' }],
    [JSON.stringify(['rev-parse', `${build}^{tree}`]), { status: 0, stdout: `${tree}\n` }],
    [JSON.stringify(['merge-tree', '--write-tree', '--no-messages', build, sha]), { status: 0, stdout: `${tree}\n` }],
  ]);
  return {
    ref, sha, build, events, registered: () => false, readyAt: '2026-11-13T12:17:00.000Z',
    git: vi.fn((args) => responses.get(JSON.stringify(args)) ?? { status: 1, stdout: '' }),
  };
}

describe('overlayGraduated uses the last registration lifecycle event', () => {
  it.each(['overlay-main-red', 'overlay-main-test-selection', 'overlay-main-merge-conflict', 'needs-you', 'quick-soak-needs-you', 'auto-rebase-needs-you', 'auto-retire-shadow'])(
    'accepts an in-main auto-drop followed by %s with unchanged content proof', (kind) => {
      const proof = evidence([{ kind: 'added', ref }, drop, noise(kind)]);
      expect(overlayGraduated(proof)).toBe(true);
      expect(proof.git).toHaveBeenCalledWith(['merge-tree', '--write-tree', '--no-messages', build, sha]);
    },
  );

  it.each([
    'added', 'removed', 'auto-dropped', 'auto-retired', 'replaced', 'retired', 'conflict-dropped',
    'drop-reverted', 'auto-retire-reverted', 'replace-reverted',
    'dropped-smoke-failed', 'dropped-dispatch-smoke-failed', 'edge-resolution-recorded', 'some-future-kind', 'overlay-future-lifecycle',
  ])('fails closed when a later %s lifecycle event supersedes the drop, even before noise', (kind) => {
    const proof = evidence([drop, { kind, ref }, noise('overlay-main-red')]);
    expect(overlayGraduated(proof)).toBe(false);
    expect(proof.git).not.toHaveBeenCalled();
  });

  it('fails closed with only noise events and no lifecycle evidence for the ref', () => {
    const proof = evidence([
      { ...drop, ref: 'lane/other' },
      ...['overlay-main-red', 'overlay-main-test-selection', 'needs-you'].map(noise),
    ]);
    expect(overlayGraduated(proof)).toBe(false);
    expect(proof.git).not.toHaveBeenCalled();
  });
});

describe('diagnostics dated after the candidate readyAt still veto graduation', () => {
  it.each(['overlay-main-red', 'overlay-main-merge-conflict', 'needs-you'])(
    'refuses an in-main drop followed by %s after readyAt', (kind) => {
      const proof = evidence([drop, { kind, ref, at: '2026-11-13T12:30:00.000Z' }]);
      expect(overlayGraduated(proof)).toBe(false);
    },
  );

  it('refuses when a diagnostic has no parseable time', () => {
    expect(overlayGraduated(evidence([drop, { kind: 'overlay-main-red', ref }]))).toBe(false);
  });
});
