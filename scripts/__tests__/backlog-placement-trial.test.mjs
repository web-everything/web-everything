/**
 * @file scripts/__tests__/backlog-placement-trial.test.mjs
 * @description Rules v2: score each card on title + body text across three term lists; highest score
 * wins, unsure when the margin is under 2. Also the count invariant and the read-only check.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classifyCard, runTrial } from '../backlog-placement-trial.mjs';

const card = (title, body = '', front = 'kind: story') => `---\n${front}\n---\n# ${title}\n${body}\n`;

describe('classifyCard v2 (text scoring)', () => {
  it('explicit Placement beats scores', () => {
    const r = classifyCard(card('daemon lane drain', 'Placement: everstandards/foo (settled)'));
    expect(r).toMatchObject({ target: 'everstandards/foo', rule: 'explicit-placement' });
  });
  it('ops terms in text score plateau-app even with empty tags', () => {
    const r = classifyCard(card('Fix the conveyor drain', 'The daemon in scripts/conveyor stalls the lane.', 'tags: []'));
    expect(r.target).toBe('plateau-app');
    expect(r.rule).toMatch(/^score-plateau-app/);
  });
  it('WE-standard terms score we', () => {
    expect(classifyCard(card('New intent for a block', 'Add a plug and an adapter under src/ for the component demo.')).target).toBe('we');
  });
  it('standards terms score everstandards', () => {
    expect(classifyCard(card('Align with CDEvents and SLSA', 'everflow and everstandards ship it.')).target).toBe('everstandards/unknown');
  });
  it('a standards card that mentions "lane" still scores standards', () => {
    const r = classifyCard(card('Platform forever: everstandards ship', 'CDEvents, SLSA and everflow, run in a lane.'));
    expect(r.target).toBe('everstandards/unknown');
  });
  it('margin under 2 is unsure', () => {
    expect(classifyCard(card('A daemon that ships things', 'one intent')).target).toBe('unsure');
  });
  it('no signal is unsure, never defaulted', () => {
    expect(classifyCard(card('Rename a variable', 'tidy up')).target).toBe('unsure');
  });
  it('unreadable frontmatter is unsure', () => {
    expect(classifyCard('no frontmatter here')).toMatchObject({ target: 'unsure', rule: 'unreadable-frontmatter' });
  });
});

describe('runTrial', () => {
  it('counts sum to cards read and does not modify cards', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bpt-'));
    const files = { '1.md': card('daemon lane drain conveyor'), '2.md': card('x'), '3.md': 'bad' };
    for (const [f, t] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), t);
    const r = runTrial(dir);
    expect(r.total).toBe(3);
    expect(Object.values(r.byTarget).reduce((a, b) => a + b, 0)).toBe(3);
    expect(new Set(r.cards.map((c) => c.id)).size).toBe(3);
    for (const [f, t] of Object.entries(files)) expect(fs.readFileSync(path.join(dir, f), 'utf8')).toBe(t);
  });
});
