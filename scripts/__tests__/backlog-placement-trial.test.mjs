/**
 * @file scripts/__tests__/backlog-placement-trial.test.mjs
 * @description Rules v2: score each card on title + body text across three term lists; highest score
 * wins, unsure when the margin is under 2. Also the count invariant and the read-only check.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
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

describe('CLI read-only output', () => {
  const script = path.resolve('scripts/backlog-placement-trial.mjs');

  it.each(['direct', 'absolute', 'dot-dot', 'symlink', 'hardlink', 'directory-symlink', 'input-symlink'])(
    'rejects an output that aliases an input card (%s)',
    (alias) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bpt-cli-'));
      try {
        fs.mkdirSync(path.join(dir, 'backlog'));
        const input = path.join(dir, 'backlog', '1.md');
        const original = card('daemon lane drain');
        fs.writeFileSync(input, original);
        let out = 'backlog/1.md';
        if (alias === 'absolute') out = input;
        if (alias === 'dot-dot') out = 'backlog/../backlog/1.md';
        if (alias === 'symlink' || alias === 'hardlink') {
          out = 'report.json';
          if (alias === 'symlink') fs.symlinkSync(input, path.join(dir, out));
          else fs.linkSync(input, path.join(dir, out));
        }
        if (alias === 'directory-symlink') {
          fs.symlinkSync(path.join(dir, 'backlog'), path.join(dir, 'alias'));
          out = 'alias/1.md';
        }
        if (alias === 'input-symlink') {
          out = 'report.json';
          fs.renameSync(input, path.join(dir, out));
          fs.symlinkSync(path.join(dir, out), input);
        }
        const result = spawnSync(process.execPath, [script, '--dir=backlog', `--out=${out}`], {
          cwd: dir, encoding: 'utf8', timeout: 10_000,
        });
        expect(result.error).toBeUndefined();
        expect(fs.readFileSync(input, 'utf8')).toBe(original);
        expect(result.status).not.toBe(0);
        expect(result.stderr).toMatch(/output.*input card/i);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.each(['report.json', 'backlog/report.json', 'backlog/report.md'])(
    'writes a distinct report to %s without modifying cards',
    (out) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bpt-cli-'));
      try {
        fs.mkdirSync(path.join(dir, 'backlog'));
        const input = path.join(dir, 'backlog', '1.md');
        const original = card('daemon lane drain');
        fs.writeFileSync(input, original);
        if (out === 'report.json') fs.writeFileSync(path.join(dir, out), 'old report'.repeat(1000));
        const result = spawnSync(process.execPath, [script, '--dir=backlog', `--out=${out}`], {
          cwd: dir, encoding: 'utf8', timeout: 10_000,
        });
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(0);
        expect(JSON.parse(fs.readFileSync(path.join(dir, out), 'utf8')).total).toBe(1);
        expect(fs.readFileSync(input, 'utf8')).toBe(original);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it('refuses unknown input identities before creating a report', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bpt-cli-'));
    try {
      fs.mkdirSync(path.join(dir, 'backlog'));
      const input = path.join(dir, 'backlog', '1.md');
      const original = card('daemon lane drain');
      fs.writeFileSync(input, original);
      fs.symlinkSync(path.join(dir, 'missing'), path.join(dir, 'backlog', '2.md'));
      const result = spawnSync(process.execPath, [script, '--dir=backlog', '--out=report.json'], {
        cwd: dir, encoding: 'utf8', timeout: 10_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/ENOENT/);
      expect(fs.existsSync(path.join(dir, 'report.json'))).toBe(false);
      expect(fs.readFileSync(input, 'utf8')).toBe(original);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
