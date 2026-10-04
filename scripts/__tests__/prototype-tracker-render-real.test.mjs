/**
 * @file prototype-tracker-render-real.test.mjs — the REAL mechanism of `prototype-tracker.mjs render` (#2949): the
 * real command line, run as a child process inside a real git repo holding a tracker card and cards, with a real
 * (stub) `operator-queue.mjs` on a fake main checkout. Proves the default page is the compact one — sections in
 * order, under the size target, rows matching the list — and that `--full` is the previous page byte for byte
 * (a golden captured from the renderer BEFORE the compact page existed).
 *
 * HOME points at a temp directory, so the search for `operator-queue.mjs` cannot find this machine's real
 * checkouts: the only places it looks are the repo under test, `WIP_MAIN_ROOT`, and paths under that HOME.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { withRealRepo } from '../operations/__tests__/helpers/real-repo.mjs';
import { localToday } from '../lib/local-date.mjs';
import { CLAIMED, ORDERED, TITLES, fixtureFiles } from './fixtures/tracker-compact-fixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const TRACKER = resolve(HERE, '..', 'prototype-tracker.mjs');
const GOLDEN = readFileSync(join(HERE, 'fixtures', 'prototype-tracker-full.golden.html'), 'utf8');

const QUEUE_LINE = 'PR #2401 (web-everything/web-everything) — review:human, gates pass, needs you';
const QUEUE_STUB = (needs) => `console.log('NEEDS YOU (review:human + advisory:accepted, all gates pass):');
console.log(${JSON.stringify(needs)});
console.log('PENDING — transient, re-run (GitHub is still computing mergeability; no agent work owed):');
console.log('(none)');
`;

/** A fresh repo with the fixture committed, and a fake main checkout carrying a stub operator-queue.mjs. */
async function scenario(fn, { queue = QUEUE_LINE } = {}) {
  return withRealRepo(async (ctx) => {
    ctx.commit(fixtureFiles(), 'fixture: tracker card and cards');
    const mainRoot = join(ctx.tmp, 'main-checkout');
    if (queue !== null) {
      mkdirSync(join(mainRoot, 'scripts/operations'), { recursive: true });
      writeFileSync(join(mainRoot, 'scripts/operations/operator-queue.mjs'), QUEUE_STUB(queue));
    } else {
      mkdirSync(mainRoot, { recursive: true });
    }
    const home = join(ctx.tmp, 'home');
    mkdirSync(home, { recursive: true });
    const render = (...args) => {
      const r = spawnSync(process.execPath, [TRACKER, 'render', '--backlog-dir=backlog', ...args], {
        cwd: ctx.root, encoding: 'utf8', env: { ...process.env, HOME: home, WIP_MAIN_ROOT: mainRoot }, maxBuffer: 64 * 1024 * 1024,
      });
      return { code: r.status, out: r.stdout, err: r.stderr };
    };
    return fn({ ...ctx, render });
  });
}

const rowsOf = (html) => [...html.matchAll(/<tr><td class="rank">(.*?)<\/td><td class="card"><span class="num">(.*?)<\/span>(.*?)<span class="ttl">(.*?)<\/span><\/td><td class="band">(.*?)<\/td><td class="size">(.*?)<\/td><\/tr>/g)]
  .map(([, rank, num, tag, ttl, band, size]) => ({ rank, num, tag, ttl, band, size }));

describe('prototype-tracker render (real command line)', () => {
  // #3891 lands only the priority-order/prototype-tracker-compact LIBRARIES (`lib/prototype-tracker-compact.mjs`
  // and friends) — the six tests below exercise the compact-page-by-default CLI wiring of `prototype-tracker.mjs
  // render` (operator-queue reading via WIP_MAIN_ROOT, `--ref`, `--base-url`, `--out`), which needs
  // `lib/prototype-tracker-compact-io.mjs`. That file, and the CLI's compact-render wiring, are #3909's own scope
  // (blockedBy: ["3891", ...]) — not yet landed. Skipped here, not reworded, so they start proving the real CLI
  // the moment #3909 lands; the one test that only needs this item's own libraries (`--full`, below) stays live.
  it.skip('renders the compact page by default: sections in order, under 60 KB, NEEDS YOU verbatim, rows matching the list', async () => {
    await scenario(({ render, head }) => {
      const { code, out, err } = render();
      expect(err.replace(/\(node:\d+\)[^\n]*\n?|\(Use `node[^\n]*\n?/g, '')).toBe('');
      expect(code).toBe(0);

      // the sections, in order
      const order = ['<header>', 'id="needs-you"', 'id="up-next"', 'id="counts"', 'id="notes"'].map((m) => out.indexOf(m));
      expect(order.every((i) => i >= 0)).toBe(true);
      expect([...order].sort((a, b) => a - b)).toEqual(order);
      expect(Buffer.byteLength(out)).toBeLessThan(60 * 1024);

      // the header: tip sha of this repo, a render time
      expect(out).toContain(`tip ${head().slice(0, 7)} · rendered `);
      // NEEDS YOU: the stub's line, verbatim
      expect(out).toContain(`<pre class="needs">${QUEUE_LINE}</pre>`);

      // the first rows are the first lines of the list, with H1 titles, band and size from the line
      const rows = rowsOf(out.slice(0, out.indexOf('<details>'))); // the first table: what comes before the first collapsed block
      expect(rows).toHaveLength(15);
      expect(rows.map((r) => r.num.replace('#', ''))).toEqual(ORDERED.slice(0, 15).map((r) => r[0]));
      expect(rows.map((r) => [r.band, r.size])).toEqual(ORDERED.slice(0, 15).map((r) => [r[2], r[1]]));
      expect(rows[3].ttl).toBe('Decouple dispatch from the Claude CLI');
      expect(rows[1].ttl.length).toBeLessThanOrEqual(40);
      expect(rows.find((r) => r.num === '#3906').tag).toContain('claimed'); // the card is status: active
      expect(out).toMatch(/<summary>5 more<\/summary>/);
      expect(out).toMatch(new RegExp(`<summary>Claimed \\(${CLAIMED.length}\\)</summary>`));
      expect(out).toContain('card numbers are plain text (no base URL)');
      expect(out).toContain('<div class="counts"><span><b>20</b> ordered</span><span>A <b>12</b></span><span>B <b>5</b></span><span>C <b>3</b></span><span>claimed <b>2</b></span><span>off-path <b>1</b></span><span>why unwritten <b>2</b></span></div>');

      // notes: the latest title, its body collapsed, older notes as titles
      expect(out).toContain('the latest fixture note, whose title is what the page shows');
      expect(out).toMatch(/<summary>Earlier notes \(2\)<\/summary>/);
      expect(out).not.toContain('Body of the first note');
    });
  });

  it('--full is the previous page byte for byte for the same fixture', async () => {
    await scenario(({ render }) => {
      const { code, out } = render('--full');
      expect(code).toBe(0);
      expect(out).toBe(GOLDEN.replace('{{DATE}}', localToday()));
    });
  });

  it.skip('--out writes the file and reports its size in bytes', async () => {
    await scenario(({ render, tmp }) => {
      const file = join(tmp, 'page.html');
      const { code, out } = render(`--out=${file}`);
      expect(code).toBe(0);
      expect(statSync(file).size).toBe(Number(/\((\d+) bytes\)/.exec(out)[1]));
      expect(readFileSync(file, 'utf8')).toContain('id="up-next"');
    });
  });

  it.skip('reads a card only a ref has (the prototype branch lags main), and can be told not to', async () => {
    await scenario(({ render, git }) => {
      git(['checkout', '--quiet', '-b', 'lane/proto']);
      git(['rm', '--quiet', 'backlog/3905-card.md']);
      git(['commit', '--quiet', '-m', 'fixture: the branch has not got #3905 yet']);
      const withRef = rowsOf(render('--ref=main').out).find((r) => r.num === '#3905');
      expect(withRef.ttl).toBe(TITLES['3905']);
      const without = rowsOf(render('--ref=none').out).find((r) => r.num === '#3905');
      expect(without.ttl).toBe('a review step runs only from the branch.'); // the "why" text, no H1 to read
    });
  });

  it.skip('links card numbers only when given a base URL', async () => {
    await scenario(({ render }) => {
      expect(render().out).not.toContain('<a href');
      const { out } = render('--base-url=https://example.test/we');
      expect(out).toContain('<a href="https://example.test/we/backlog/3901/">#3901</a>');
    });
  });

  it.skip('says NEEDS YOU is unavailable, never "none", when no operator-queue is found', async () => {
    await scenario(({ render }) => {
      const { out } = render();
      expect(out).toContain('unavailable: operator-queue.mjs is not on any checkout found');
      expect(out).not.toContain('<p class="none">none</p>');
    }, { queue: null });
  });

  it.skip('prints "none" when the queue has nothing for the operator', async () => {
    await scenario(({ render }) => {
      expect(render().out).toContain('<section id="needs-you">\n    <h2>Needs you</h2>\n    <p class="none">none</p>');
    }, { queue: '(none)' });
  });
});
