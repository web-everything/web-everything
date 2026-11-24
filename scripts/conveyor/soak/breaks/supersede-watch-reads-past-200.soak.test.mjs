import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import b, { probe } from './supersede-watch-reads-past-200.mjs';
import { defineBreakTest } from '../define-break-test.mjs';

defineBreakTest(b);

function withCheckout(source, check) {
  const dir = mkdtempSync(join(tmpdir(), 'supersede-watch-replay-'));
  try {
    mkdirSync(join(dir, 'scripts/conveyor'), { recursive: true });
    if (source !== null) writeFileSync(join(dir, 'scripts/conveyor/supersede-watch.mjs'), source);
    check(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Independent stand-in readers exercise each wire shape without importing the live implementation.
function readers(shape, capped = '') {
  return `
    function read(exec, state) {
      ${shape === 'rest' ? `
        const rows = [];
        for (let page = 1; page <= 4; page++) {
          const batch = JSON.parse(exec('gh', ['api',
            'repos/soak/repo/pulls?state=' + state + '&per_page=100&page=' + page]));
          rows.push(...batch);
          if (batch.length < 100) break;
        }
        return rows;
      ` : `
        return JSON.parse(exec('gh', ['pr', 'list', '--state', state, '--limit', '1000',
          '--json', 'number,body,mergedAt,author']));
      `}
    }
    export function defaultReadMergedPrs({ exec }) {
      return read(exec, 'closed')${capped === 'merged' ? '.slice(0, 200)' : ''};
    }
    export function defaultReadOpenNumbers({ exec }) {
      return read(exec, 'open')${capped === 'open' ? '.slice(0, 200)' : ''}.map(row => row.number);
    }
  `;
}

describe('supersede-watch past-200 behavioral replay', () => {
  it('keeps both readers in the current checkout past row 200', () => {
    expect(b.judge(b.run({}))).toEqual([]);
  });

  describe.each(['rest', 'legacy'])('%s gh wire shape', shape => {
    it('accepts readers returning the older row from a list larger than 200', () => {
      withCheckout(readers(shape), dir => expect(b.fixPresent(dir)).toBe(true));
    });

    it.each(['merged', 'open'])('rejects truncation in the %s reader alone', capped => {
      withCheckout(readers(shape, capped), dir => {
        expect(b.fixPresent(dir)).toBe(false);
        expect(b.judge(probe(dir)).join('\n')).toContain(`${capped} reader omitted old row #251`);
      });
    });
  });

  it('rejects the legacy single-call --limit 200 regression', () => {
    withCheckout(readers('legacy').replace("'1000'", "'200'"), dir => {
      expect(b.fixPresent(dir)).toBe(false);
    });
  });

  it.each([
    ['missing checkout module', null],
    ['missing reader exports', 'export const marker = "pagination fixed";'],
    ['unreadable results', 'export const defaultReadMergedPrs = () => null; export const defaultReadOpenNumbers = () => null;'],
    ['unexpected IO', `export function defaultReadMergedPrs({ exec }) { return exec('gh', ['unexpected']); }
      export const defaultReadOpenNumbers = () => [];`],
  ])('fails closed on %s', (_name, source) => {
    withCheckout(source, dir => expect(b.fixPresent(dir)).toBe(false));
  });
});
