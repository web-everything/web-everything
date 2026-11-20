import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parsePrep, prepVerdict } from '../lib/prep-block.mjs';

// Real bodies from the supplied merged50 archive; no GitHub IO during tests.
const here = dirname(fileURLToPath(import.meta.url));
const bodies = JSON.parse(readFileSync(join(here, 'fixtures/prep-bodies/real-pr-bodies.json'), 'utf8'));
const expected = {
  7163: { ok: true, present: true, waived: false },
  7147: { ok: true, present: true, waived: false },
  7137: { ok: true, present: true, waived: false },
  7136: { ok: true, present: true, waived: false },
  7133: { ok: true, present: true, waived: false },
  7129: { ok: true, present: true, waived: false },
  7122: { ok: true, present: true, waived: false },
  7069: { ok: true, present: true, waived: true },
  7081: { ok: false, present: false, waived: false },
  7074: { ok: false, present: false, waived: false },
  7072: { ok: false, present: false, waived: false },
  7141: { ok: false, present: false, waived: false },
};
const sections = ['Acceptance', 'Pre-mortem', 'Files', 'Tests'];
const populated = sections.map((name) => `${name}: concrete section content`).join('\n');
const markers = ['PREP:', 'PREP', '## PREP', '**PREP**', '**PREP:**', '- PREP', '* **prep**', '+ ## pReP'];

describe('real PR PREP corpus', () => {
  it('pins exactly the available requested PR bodies', () => {
    expect(Object.keys(bodies).sort()).toEqual(Object.keys(expected).sort());
  });
  it.each(Object.entries(expected))('classifies PR #%s', (number, verdict) => {
    expect(parsePrep(bodies[number])).toMatchObject({ present: verdict.present, waived: verdict.waived });
    expect(prepVerdict(bodies[number])).toMatchObject({ ok: verdict.ok, waived: verdict.waived });
    if (verdict.ok && !verdict.waived) {
      expect(parsePrep(bodies[number])).toMatchObject({ missing: [], empty: [] });
    }
  });
});

describe('PREP Markdown forms and boundaries', () => {
  it.each(markers)('accepts whole-line marker %s', (marker) => {
    expect(prepVerdict(`${marker}\n${populated}`)).toEqual({ ok: true, reason: '', waived: false });
  });
  it.each(markers)('refuses placeholders under marker %s', (marker) => {
    for (const value of ['<observable criteria>', 'TBD', 'TODO', 'n/a', 'none', 'short']) {
      const body = `${marker}\n${sections.map((name) => `${name}: ${value}`).join('\n')}`;
      expect(parsePrep(body)).toMatchObject({ present: true, missing: [], empty: sections });
      expect(prepVerdict(body).ok).toBe(false);
    }
  });
  it.each([
    (name) => `${name}: concrete section content`,
    (name) => `**${name}**\n- concrete section content`,
    (name) => `**${name}:**\nconcrete section content`,
    (name) => `## ${name}\n- concrete section content`,
    (name) => `### ${name}\nconcrete section content`,
    (name) => `- ${name}: concrete section content`,
  ])('accepts section heading form %#', (format) => {
    expect(prepVerdict(`## PREP\n${sections.map(format).join('\n')}`).ok).toBe(true);
  });
  it.each(['Touch-set', 'Touch set'])('maps %s to Files and Test plan to Tests', (files) => {
    expect(parsePrep(`PREP\n${populated.replace('Files:', `${files}:`).replace('Tests:', 'Test plan:')}`))
      .toMatchObject({ present: true, missing: [], empty: [] });
  });
  it.each(['Threat model:', '**Threat model**', '## Threat model'])('isolates optional %s content from an empty required section', (heading) => {
    const body = `PREP\n${populated.replace('Tests: concrete section content', `Tests:\n${heading}\nconcrete threat details`)}`;
    expect(parsePrep(body)).toMatchObject({ missing: [], empty: ['Tests'] });
    expect(prepVerdict(body).ok).toBe(false);
    expect(prepVerdict(`PREP\n${populated}\n${heading}\nTODO`).ok).toBe(true);
  });
  it('does not borrow summary prose for an empty section', () => {
    expect(parsePrep('## PREP\nTests:\n## Summary\nconcrete summary content'))
      .toMatchObject({ present: true, missing: ['Acceptance', 'Pre-mortem', 'Files'], empty: ['Tests'] });
  });
  it.each(['Re-prepare #4456 against main', '- `prepare.mjs` changes', 'the PREP block is missing',
    'PREP implementation plan', '## PREP implementation plan', '**PREP** implementation plan'])('does not count prose %s as a marker', (line) => {
    expect(parsePrep(`${line}\n${populated}`)).toMatchObject({ present: false, missing: sections, empty: [] });
  });
  it('ignores headings before PREP', () => {
    expect(parsePrep(`## Acceptance\nconcrete acceptance criteria\n${populated}`)).toMatchObject({ present: false, missing: sections });
    expect(parsePrep(`## Acceptance\nconcrete acceptance criteria\nPREP\nTests: focused unit tests`))
      .toMatchObject({ present: true, missing: ['Acceptance', 'Pre-mortem', 'Files'], empty: [] });
  });
  it.each(['PREP', '## PREP', '**PREP**'])('resets sections at another %s marker', (marker) => {
    expect(parsePrep(`PREP\nTests:\n${marker}\nlong unrelated prose`))
      .toMatchObject({ present: true, missing: sections, empty: [] });
  });
  const footer = '🤖 Generated with [Claude Code](https://claude.ai/code)\nhttps://claude.ai/code\nCo-Authored-By: Claude <claude@example.com>\nClaude-Session: concrete-session-id';
  it.each(['PREP:', '## PREP'])('refuses Tests: TODO followed by a PR footer under %s', (marker) => {
    const body = `${marker}\n${populated.replace('Tests: concrete section content', 'Tests: TODO')}\n${footer}`;
    expect(parsePrep(body)).toMatchObject({ present: true, missing: [], empty: ['Tests'] });
    expect(prepVerdict(body).ok).toBe(false);
  });
  it.each(['---', '***', '___', '🤖 Generated with Claude Code', 'Generated with Claude Code',
    'Co-Authored-By: Claude <claude@example.com>', 'Claude-Session: concrete-session-id',
    'https://claude.ai/code', 'http://example.com/session'])('ends continuation at %s without borrowing later prose', (boundary) => {
    const body = `PREP:\n${populated.replace('Tests: concrete section content', 'Tests: TODO')}\n${boundary}\nUnrelated footer prose`;
    expect(parsePrep(body)).toMatchObject({ missing: [], empty: ['Tests'] });
    expect(prepVerdict(body).ok).toBe(false);
  });
  it('refuses two incomplete PREP blocks that jointly cover all required headings', () => {
    const body = 'PREP:\nAcceptance: concrete acceptance criteria\nPre-mortem: concrete failure risks\n## PREP\nFiles: scripts/example.mjs\nTests: focused unit tests';
    expect(parsePrep(body)).toMatchObject({ present: true, missing: ['Acceptance', 'Pre-mortem'], empty: [] });
    expect(prepVerdict(body).ok).toBe(false);
  });
  it('accepts a complete PREP block followed by a PR footer', () => {
    expect(prepVerdict(`PREP:\n${populated}\n${footer}`)).toEqual({ ok: true, reason: '', waived: false });
  });
  it.each(['PREP:', '## PREP'])('refuses a complete block followed by a second incomplete %s block', (marker) => {
    const body = `PREP:\n${populated}\n${marker}\nTests: focused unit tests`;
    expect(parsePrep(body)).toMatchObject({ present: true, missing: ['Acceptance', 'Pre-mortem', 'Files'], empty: [] });
    expect(prepVerdict(body).ok).toBe(false);
  });
});
