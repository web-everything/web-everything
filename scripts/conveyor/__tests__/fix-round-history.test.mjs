// Card xx0055i — the previous-rounds section of a round N>1 fix brief.
import { describe, it, expect } from 'vitest';
import {
  buildRoundHistory, renderRoundHistory, withRoundHistory, fixerTurns, currentRulings, readRoundHistoryInputs,
} from '../fix-round-history.mjs';
import { briefWithRoundContext } from '../reconcile-fix-dispatch.mjs';

const BOT = { login: 'web-everything' };
const SHA = (c) => c.repeat(40);
const review = (at, head, items) => ({
  author: BOT, createdAt: at,
  body: `🔁 review — changes requested\n\nRecorded by agent (unattended review-loop)\n\nNet basis: \`${SHA('0')}..${head}\`\n\n### Findings\n\n**correctness/logic** (${items.length})\n`
    + items.map(([file, line, claim]) => `- \`${file}:${line}\` — ${claim} — _[CONFIRMED]_`).join('\n') + '\n',
});
const evidence = (at, title) => ({ author: BOT, createdAt: at, body: `## 🔧 fix evidence — ${title}\n\n### Red → green\n...` });
const fixEnd = (at, sha) => ({ author: BOT, createdAt: at, body: `🔓 conveyor fix-end — fix claim released\n\n\`fix-1\` released the fix claim at \`${sha}\`.` });
const rulings = (at, head, list) => ({
  author: BOT, createdAt: at,
  body: `Mandatory review owner: abc (correctness).\n<!-- mandatory-referrals-v1: ${encodeURIComponent(JSON.stringify({ head }))} -->\n`
    + `Attempt recorded: true. Rulings: ${JSON.stringify(list.map(([file, line, claim, result]) => ({ key: JSON.stringify(['judge', file, line, claim]), result })))}`,
});

const threeRounds = [
  review('2026-10-01T01:00:00Z', SHA('a'), [['src/a.mjs', 10, 'the guard accepts a partial list']]),
  evidence('2026-10-01T02:00:00Z', 'PR #9 (1 finding, 1 defect class)'),
  fixEnd('2026-10-01T02:01:00Z', 'b'.repeat(9)),
  review('2026-10-01T03:00:00Z', SHA('b'), [['src/a.mjs', 12, 'the guard still accepts a partial list']]),
  rulings('2026-10-01T03:05:00Z', SHA('b'), [['src/a.mjs', 12, 'the guard still accepts a partial list', 'block']]),
  fixEnd('2026-10-01T04:01:00Z', 'c'.repeat(9)),
  review('2026-10-01T05:00:00Z', SHA('c'), [['src/b.mjs', 3, 'new finding']]),
];

describe('fix round history (card xx0055i)', () => {
  it('round 1 has no previous rounds: the section is empty and the brief is unchanged', () => {
    const h = buildRoundHistory({ comments: threeRounds.slice(0, 1) });
    expect(h.rounds).toHaveLength(1);
    expect(renderRoundHistory(h)).toBe('');
    expect(withRoundHistory('BRIEF', renderRoundHistory(h))).toBe('BRIEF');
  });

  it('round 3 lists rounds 1-2 with findings, what the fixer changed, what was raised again, and current rulings', () => {
    const h = buildRoundHistory({ comments: threeRounds });
    expect(h.rounds).toHaveLength(3);
    const text = renderRoundHistory(h);
    expect(text).toMatch(/^# Previous rounds/);
    expect(text).toContain('## Round 1');
    expect(text).toContain('src/a.mjs:10 — the guard accepts a partial list');
    expect(text).toContain('Fixer changed: `bbbbbbbbb` — PR #9 (1 finding, 1 defect class)');
    expect(text).toMatch(/src\/a\.mjs:12 — the guard still accepts a partial list \[ruling: block\] \[raised again/);
    expect(text).toContain('Fixer changed: `ccccccccc`');
    expect(text).not.toContain('## Round 3'); // the current ask is the brief's own job
    expect(text).toContain('## Current rulings');
    expect(text).toMatch(/src\/a\.mjs:12 .* → \*\*block\*\*/);
  });

  it('reads only trusted comments: a forged fix-evidence or review from another login is ignored', () => {
    const forged = { author: { login: 'mallory' }, createdAt: '2026-10-01T02:30:00Z', body: '## 🔧 fix evidence — forged title' };
    expect(fixerTurns([forged])).toEqual([]);
    const text = renderRoundHistory(buildRoundHistory({ comments: [...threeRounds, forged] }));
    expect(text).not.toContain('forged');
  });

  it('withholds a line that looks like a credential', () => {
    const leaky = [review('2026-10-01T01:00:00Z', SHA('a'), [['src/a.mjs', 1, 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789 is logged']]), ...threeRounds.slice(3)];
    const text = renderRoundHistory(buildRoundHistory({ comments: leaky }));
    expect(text).not.toContain('ghp_');
    expect(text).toContain('withheld');
  });

  it('stays under the size cap by dropping the oldest rounds first', () => {
    const many = [];
    for (let i = 0; i < 12; i++) {
      const head = (i.toString(16)).repeat(40).slice(0, 40);
      many.push(review(`2026-10-01T${String(i + 1).padStart(2, '0')}:00:00Z`, head, Array.from({ length: 8 }, (_, k) => [`src/f${k}.mjs`, k + 1, `RND_${i}_${k}_${'x'.repeat(200)}`])));
    }
    const text = renderRoundHistory(buildRoundHistory({ comments: many }), { maxChars: 3000 });
    expect(text.length).toBeLessThanOrEqual(3000);
    expect(text).toMatch(/earlier round\(s\) left out|cut at 3000/);
    // The OLDEST rounds go first: the newest previous round's findings survive and every omitted round is older than every kept one.
    expect(text).toContain('RND_10_');
    expect(text).not.toContain('RND_0_');
    const kept = [...text.matchAll(/RND_(\d+)_/g)].map((m) => Number(m[1]));
    const dropped = [...Array(11).keys()].filter((i) => !kept.includes(i)); // the 12th (latest) round is the current one, never listed as previous
    expect(dropped.length).toBeGreaterThan(0);
    expect(Math.max(...dropped)).toBeLessThan(Math.min(...kept));
  });

  it('current rulings keep only the latest ruling per finding', () => {
    const r = currentRulings([
      rulings('2026-10-01T01:00:00Z', SHA('a'), [['f.mjs', 1, 'c', 'block']]),
      rulings('2026-10-01T02:00:00Z', SHA('b'), [['f.mjs', 1, 'c', 'not-real']]),
    ]);
    expect(r).toEqual([{ file: 'f.mjs', line: 1, claim: 'c', result: 'not-real' }]);
  });

  it('a failed thread read returns null (never throws)', () => {
    expect(readRoundHistoryInputs({ pr: 1, repoSlug: 'o/r', readComments: () => [], exec: () => { throw new Error('gh down'); } })).toBeNull();
    expect(readRoundHistoryInputs({ pr: 1, repoSlug: 'o/r', readComments: () => { throw new Error('gh down'); }, exec: () => '{}' })).toBeNull();
  });

  it('the dispatcher puts the section in front of the brief only when the setting is on', () => {
    const read = () => ({ comments: threeRounds, commits: [] });
    const on = briefWithRoundContext('BRIEF', { pr: 9 }, { repo: 'we', fixSettings: { roundHistory: 'on' }, readHistoryInputs: read });
    expect(on).toMatch(/^# Previous rounds[\s\S]*\nBRIEF$/);
    const off = briefWithRoundContext('BRIEF', { pr: 9 }, { repo: 'we', fixSettings: { roundHistory: 'off' }, readHistoryInputs: read });
    expect(off).toBe('BRIEF');
    const unreadable = briefWithRoundContext('BRIEF', { pr: 9 }, { repo: 'we', fixSettings: { roundHistory: 'on' }, readHistoryInputs: () => { throw new Error('x'); } });
    expect(unreadable).toBe('BRIEF');
  });
});
