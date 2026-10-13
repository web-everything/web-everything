import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rollUp } from '../readiness/velocity-metrics.mjs';
import { computeSelection, computeReadiness } from '../readiness/engine.mjs';
import { isReady } from '../lib/build-queue.mjs';
import nunjucks from 'nunjucks';

const require = createRequire(import.meta.url);

describe('closed fixture backlog — scope removed, never delivered', () => {
  it('loads closed metadata, excludes scope and delivered/calibration points, and keeps blockers gated', () => {
    const dir = mkdtempSync(join(tmpdir(), 'we-closed-'));
    const loaderPath = require.resolve('../../src/_data/backlog.js');
    const burndownPath = require.resolve('../../src/_data/burndown.js');
    const priorEnv = process.env.WE_BACKLOG_DIR;
    const priorLoader = require.cache[loaderPath];
    const priorBurndown = require.cache[burndownPath];
    const card = (fields, title) => `---\nkind: story\nsize: 3\ndateOpened: "2026-10-01"\n${fields}\n---\n# ${title}\n\nFixture work.\n`;
    try {
      writeFileSync(join(dir, '001-delivered.md'), card('status: resolved\ndateResolved: "2026-10-02"', 'Delivered'));
      writeFileSync(join(dir, '002-closed.md'), card('status: closed\nsize: 8\nclosedReason: duplicate\nclosedInto: "xabc123"\ndateClosed: "2026-10-03"\nparent: "004"', 'Closed').replace('size: 3\n', ''));
      writeFileSync(join(dir, '003-live.md'), card('status: open\nbornAs: xabc123\nblockedBy: ["002"]\nparent: "004"', 'Survivor'));
      writeFileSync(join(dir, '004-parent.md'), '---\nkind: epic\nstatus: open\ndateOpened: "2026-10-01"\n---\n# Parent\n\nFixture parent.\n');
      process.env.WE_BACKLOG_DIR = dir;
      delete require.cache[loaderPath];
      delete require.cache[burndownPath];
      const items = require(loaderPath)();
      const closed = items.find((i) => i.num === '002');
      const live = items.find((i) => i.num === '003');
      expect(closed).toMatchObject({ closedReason: 'duplicate', closedInto: 'xabc123', dateClosed: '2026-10-03', batchCost: 0, buildState: { state: 'closed' }, closedIntoTarget: { num: '003', title: 'Survivor', url: '/backlog/003-live/' } });
      expect(items.find((i) => i.num === '004').openChildCount).toBe(1);
      const bd = require(burndownPath)();
      expect(bd.points).toEqual({ total: 6, done: 3, remaining: 3 });
      expect(bd.series.daily.at(-1)).toMatchObject({ scope: 6, done: 3, remaining: 3 });
      const velocity = rollUp(items, { asOf: '2026-10-04', windowDays: 7 });
      expect(velocity.counts.resolved).toBe(1);
      expect(velocity.throughput).toMatchObject({ points: 3, count: 1 });
      // The --points calibration basis is the resolved-only sum of loader batchCost.
      expect(items.filter((i) => i.status === 'resolved').reduce((sum, i) => sum + (i.batchCost || 0), 0)).toBe(3);
      expect(closed.batchable).toBe(false);
      expect(isReady(closed, new Map())).toBe(false);
      expect(isReady(live, new Map(items.map((i) => [i.num, i])))).toBe(false);
      expect(JSON.stringify(computeSelection(items))).not.toContain('002-closed');
      expect(computeReadiness(items).cascade.stillBlocked.find((i) => i.num === '003').openBlockers).toContainEqual({ num: '002', status: 'closed' });
      const env = new nunjucks.Environment(new nunjucks.FileSystemLoader('src/_includes'), { autoescape: true });
      const html = env.renderString('{% import "backlog-badges.njk" as bk %}{{ bk.closedBadge(item) }}', { item: closed });
      expect(html).toContain('<we-badge tone="neutral">Closed — duplicate of');
      expect(html).toContain('href="/backlog/003-live/"');
      expect(html).not.toContain('<we-tag');
    } finally {
      if (priorEnv === undefined) delete process.env.WE_BACKLOG_DIR;
      else process.env.WE_BACKLOG_DIR = priorEnv;
      delete require.cache[loaderPath];
      delete require.cache[burndownPath];
      if (priorLoader) require.cache[loaderPath] = priorLoader;
      if (priorBurndown) require.cache[burndownPath] = priorBurndown;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
