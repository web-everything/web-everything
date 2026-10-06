/** @file /state rendering and argument handling: no printed field carries a terminal escape, unknown probes read as unknown. */
import { describe, it, expect, vi } from 'vitest';
import { main, renderPrState, renderCard } from '../state.mjs';

// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f]/;
describe('renderPrState', () => {
  it('sanitizes the headline, next step and every evidence line', () => {
    const out = renderPrState({ phase: 'FIXING', headline: 'live\x1b]52;c;ZXZpbA==\x07 fix\rSTUCK', next: 'x\x1b[2Ky',
      evidence: ['a\rb', 'c\x1b]0;t\x07d'] }, 'PR #1');
    expect(out.split('\n').every(l => !CONTROL.test(l))).toBe(true);
    expect(out).not.toContain('ZXZpbA');
    expect(out.split('\n')).toHaveLength(4);
  });
});
describe('renderCard', () => {
  const card = { id: 'x', status: 'active', found: true, claim: { held: false, owner: '' }, prs: [], evidence: ['join bounded'] };
  it('reports active sessions as unknown when the agents probe failed', () => {
    expect(renderCard({ ...card, activeSessions: [], activeSessionsKnown: false })).toContain('active sessions: unknown (claude agents unavailable)');
  });
  it('reports none observed only when the probe worked', () => {
    expect(renderCard({ ...card, activeSessions: [], activeSessionsKnown: true })).toContain('active sessions: none observed');
  });
});
describe('main', () => {
  it('rejects a flag-like or missing subject without probing', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(main(['--help'])).toBe(2);
    expect(main([])).toBe(2);
    err.mockRestore();
  });
});
