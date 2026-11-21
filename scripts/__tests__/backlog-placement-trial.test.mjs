/**
 * @file scripts/__tests__/backlog-placement-trial.test.mjs
 * @description Fixture cards, one per rule plus an ambiguous one; count invariant; read-only.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classifyCard, runTrial } from '../backlog-placement-trial.mjs';

const card = (front, body = 'text') => `---\n${front}\n---\n${body}\n`;

describe('classifyCard', () => {
  it('explicit Placement beats tags', () => {
    const r = classifyCard(card('tags: [daemon]', 'Placement: everstandards/foo (settled)'));
    expect(r).toMatchObject({ target: 'everstandards/foo', rule: 'explicit-placement' });
  });
  it('plateau tag', () => {
    expect(classifyCard(card('tags:\n  - conveyor')).target).toBe('plateau-app');
  });
  it('standards tag', () => {
    expect(classifyCard(card('tags: [everflow]')).target).toBe('everstandards/unknown');
  });
  it('we standards tag', () => {
    expect(classifyCard(card('tags: [intents]')).target).toBe('we');
  });
  it('ambiguous is unsure, never defaulted', () => {
    expect(classifyCard(card('tags: []')).target).toBe('unsure');
  });
  it('unreadable frontmatter is unsure', () => {
    expect(classifyCard('no frontmatter here')).toMatchObject({ target: 'unsure', rule: 'unreadable-frontmatter' });
  });
});

describe('runTrial', () => {
  it('counts sum to cards read and does not modify cards', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bpt-'));
    const files = { '1.md': card('tags: [daemon]'), '2.md': card('tags: []'), '3.md': 'bad' };
    for (const [f, t] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), t);
    const r = runTrial(dir);
    expect(r.total).toBe(3);
    expect(Object.values(r.byTarget).reduce((a, b) => a + b, 0)).toBe(3);
    expect(new Set(r.cards.map((c) => c.id)).size).toBe(3);
    for (const [f, t] of Object.entries(files)) expect(fs.readFileSync(path.join(dir, f), 'utf8')).toBe(t);
  });
});
