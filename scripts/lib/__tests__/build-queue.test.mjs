import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, statSync, utimesSync, existsSync } from 'node:fs';
import { buildQueueCacheFile } from '../build-queue-cache.mjs';
import { SETTINGS_DIR, readSettings } from '../settings-files.mjs';
import { DELIVERY_PRIORITY_SETTINGS_PATH } from '../../conveyor/delivery-priority-shadow.mjs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { orderQueueDetailed, DEFAULT_CONFIG, buildQueuePriorityFacts, resolveBuildQueuePrioritySettings, classOrder, formatBuildQueuePriorityShadowLine } from '../build-queue.mjs';

const item = (num, over = {}) => ({ num: String(num), id: `${num}-x`, status: 'open', dateOpened: '2026-07-16', ...over });
const NOW = Date.parse('2026-07-16T12:00:00Z');
const ON = { mode: 'enforce', agingHours: 8, maxLiveP0: 2, unblockWeightMinutes: 60 };
const queuedAgo = (hours) => new Date(NOW - hours * 3600e3).toISOString();
const enforce = (items) => orderQueueDetailed(items, DEFAULT_CONFIG, NOW, { priority: ON });

describe('build queue priority settings cascade', () => {
  it('layers mode ownership while preserving other platform preferences', () => {
    // agingHours is deliberately NOT the default (8): losing the platform preference must turn this test red.
    const platform = { mode: 'shadow', agingHours: 12 };
    const tool = { mode: 'enforce' };
    expect(resolveBuildQueuePrioritySettings()).toMatchObject({ mode: 'off', source: 'default' });
    expect(resolveBuildQueuePrioritySettings({ platform })).toMatchObject({ mode: 'shadow', source: 'platform', agingHours: 12 });
    expect(resolveBuildQueuePrioritySettings({ platform, tool })).toMatchObject({
      mode: 'enforce', source: 'tool', agingHours: 12,
    });
    expect(resolveBuildQueuePrioritySettings({ platform, tool, env: { WE_BUILD_QUEUE_PRIORITY_MODE: 'off' } }))
      .toMatchObject({ mode: 'off', source: 'env', agingHours: 12 });
    expect(resolveBuildQueuePrioritySettings({ platform, tool, env: { WE_BUILD_QUEUE_PRIORITY_MODE: 'invalid' } }))
      .toMatchObject({ mode: 'enforce', source: 'tool', agingHours: 12 });
    expect(resolveBuildQueuePrioritySettings({ platform, tool: { maxLiveP0: 3 } }))
      .toMatchObject({ mode: 'shadow', source: 'platform', maxLiveP0: 3, agingHours: 12 });
  });

  it('lets an invalid mode in a layer fall through to the lower layer, like an invalid env mode', () => {
    const platform = { mode: 'shadow', agingHours: 12 };
    // typo'd tool mode: the valid platform mode (and its source) survives, not a silent revert to `off`
    expect(resolveBuildQueuePrioritySettings({ platform, tool: { mode: 'enforc' } }))
      .toMatchObject({ mode: 'shadow', source: 'platform', agingHours: 12 });
    // typo'd platform mode with a valid tool mode: the tool still owns the mode
    expect(resolveBuildQueuePrioritySettings({ platform: { mode: 'shaddow', agingHours: 12 }, tool: { mode: 'enforce' } }))
      .toMatchObject({ mode: 'enforce', source: 'tool', agingHours: 12 });
    // both layers invalid: the standard default, reported as such
    expect(resolveBuildQueuePrioritySettings({ platform: { mode: 'x' }, tool: { mode: 7 } }))
      .toMatchObject({ mode: 'off', source: 'default' });
    // the sibling keys follow the same rule: an invalid tool value never overrides a valid platform one
    expect(resolveBuildQueuePrioritySettings({ platform, tool: { mode: 'enforce', agingHours: -1, maxLiveP0: 'many' } }))
      .toMatchObject({ mode: 'enforce', source: 'tool', agingHours: 12, maxLiveP0: 2 });
  });

  it.each([null, false, 'enforce', 4, []])('ignores non-object layers: %j', (layer) => {
    expect(resolveBuildQueuePrioritySettings({ platform: layer, tool: layer, env: layer }))
      .toMatchObject({ mode: 'off', source: 'default' });
  });
});

describe('build queue shadow observations', () => {
  it('retains legacy order with real priority metadata and previews enforce order without mutation', () => {
    const items = [
      item(1, { value: 5 }),
      item(2, { value: 1, priority: 'high', queuedAt: queuedAgo(1) }),
      item(3, { value: 4 }),
      item(4, { value: 2, queuedAt: queuedAgo(2) }),
    ];
    const rows = (mode) => orderQueueDetailed(items, DEFAULT_CONFIG, NOW, { priority: { ...ON, mode } });
    const nums = (rs) => rs.map((r) => r.item.num);
    const off = rows('off');
    const shadow = rows('shadow');
    const enforced = rows('enforce');
    expect(nums(off)).toEqual(['1', '3', '4', '2']);
    expect(off.every((r) => r.priorityClass === 'P3' && r.priorityScore === 0)).toBe(true);
    expect(nums(shadow)).toEqual(nums(off));
    expect(shadow.find((r) => r.item.num === '2')).toMatchObject({
      priorityClass: 'P2', priorityScore: 60, priorityReasons: ['card priority: high'],
    });
    expect(nums(enforced)).toEqual(['2', '4', '1', '3']);
    expect(classOrder(shadow)).toEqual(enforced);
    expect(nums(shadow)).toEqual(nums(off));
    expect(formatBuildQueuePriorityShadowLine(shadow, 'shadow')).toBe(
      'build-queue: priority-shadow mode=shadow 4 item(s) — class order #2 P2 score 60 | #4 P3 score 120 | #1 P3 score 0 | #3 P3 score 0 (order unchanged)',
    );
  });

  it('caps the shadow line at 25 entries', () => {
    const rows = enforce(Array.from({ length: 27 }, (_, i) => item(i + 1)));
    const line = formatBuildQueuePriorityShadowLine(rows, 'shadow');
    expect(line).toContain('27 item(s)');
    expect(line).toContain('#25 P3 score 0 | … +2 more (order unchanged)');
    expect(line).not.toContain('#26');
    expect(formatBuildQueuePriorityShadowLine([], 'shadow')).toContain('0 item(s)');
  });
});

describe('#4355 build-queue orders by delivery class (rulings Q1/Q2)', () => {
  it('keeps the legacy order and reports P3 when priority is omitted or off', () => {
    const items = [item(1, { value: 1 }), item(2, { value: 5, priority: 'high' }), item(3, { value: 3, priority: 'low' })];
    const baseline = orderQueueDetailed(items, DEFAULT_CONFIG, NOW);
    const off = orderQueueDetailed(items, DEFAULT_CONFIG, NOW, { priority: { mode: 'off' } });
    expect(baseline.map((r) => r.item.num)).toEqual(['2', '3', '1']);
    expect(off.map((r) => r.item.num)).toEqual(baseline.map((r) => r.item.num));
    for (const row of [...baseline, ...off]) {
      expect(row.priorityClass).toBe('P3');
      expect(row.priorityScore).toEqual(expect.any(Number));
      expect(Array.isArray(row.priorityReasons)).toBe(true);
      expect(row.priorityReasons.every((reason) => typeof reason === 'string')).toBe(true);
      expect(row.aged).toBe(false);
    }
  });

  it('puts a high-priority P2 card ahead of an older, higher-value normal card', () => {
    const rows = enforce([item(1, { value: 5, dateOpened: '2026-01-01' }), item(2, { value: 1, priority: 'high' })]);
    expect(rows.map((r) => r.item.num)).toEqual(['2', '1']);
    expect(rows[0].priorityClass).toBe('P2');
    expect(rows[0].priorityReasons).toContain('card priority: high');
  });

  it('puts a low-priority P4 card last even when it has the highest value', () => {
    const rows = enforce([item(1, { value: 5, priority: 'low' }), item(2, { value: 1 })]);
    expect(rows.map((r) => r.item.num)).toEqual(['2', '1']);
    expect(rows[1].priorityClass).toBe('P4');
    expect(rows[1].priorityReasons).toContain('card priority: low');
  });

  it('promotes a card unblocking two pending cards to P1 and excludes the blocked cards', () => {
    const rows = enforce([item(1), item(2, { priority: 'high' }), item(10, { blockedBy: ['1'] }), item(11, { blockedBy: ['1'] })]);
    expect(rows.map((r) => r.item.num)).toEqual(['1', '2']);
    expect(rows[0].priorityClass).toBe('P1');
    expect(rows[1].priorityClass).toBe('P2');
  });

  it('sorts class before tier under enforce and preserves tier ordering when off', () => {
    const items = [item(1, { tier: 'pinned' }), item(2, { priority: 'high' })];
    expect(enforce(items).map((r) => r.item.num)).toEqual(['2', '1']);
    const off = orderQueueDetailed(items, DEFAULT_CONFIG, NOW, { priority: { mode: 'off' } });
    expect(off.map((r) => r.item.num)).toEqual(['1', '2']);
  });

  it('ages from queuedAt by one class without ever promoting a card into P0', () => {
    const rows = enforce([
      item(1, { queuedAt: queuedAgo(9) }),
      item(2, { queuedAt: queuedAgo(1) }),
      item(3, { priority: 'high', queuedAt: queuedAgo(9) }),
      item(4, { queuedAt: queuedAgo(100) }),
      item(10, { blockedBy: ['4'] }),
      item(11, { blockedBy: ['4'] }),
    ]);
    expect(rows).toHaveLength(4);
    expect(rows.find((r) => r.item.num === '1')).toMatchObject({ aged: true, priorityClass: 'P2' });
    expect(rows.find((r) => r.item.num === '2')).toMatchObject({ aged: false, priorityClass: 'P3' });
    expect(rows.find((r) => r.item.num === '3')).toMatchObject({ aged: true, priorityClass: 'P1' });
    expect(rows.find((r) => r.item.num === '4')).toMatchObject({ aged: false, priorityClass: 'P1' });
    expect(rows.some((r) => r.priorityClass === 'P0')).toBe(false);
  });

  it('uses the fix-queue score within a class so longer wait beats WSJF value', () => {
    const rows = enforce([item(1, { value: 5, queuedAt: queuedAgo(2) }), item(2, { value: 1, queuedAt: queuedAgo(5) })]);
    expect(rows.map((r) => r.item.num)).toEqual(['2', '1']);
    expect(rows.map((r) => r.priorityClass)).toEqual(['P3', 'P3']);
    expect(rows[0].priorityScore).toBe(300);
  });

  it('maps card priority, queue timestamp and unblock count into delivery facts', () => {
    const high = buildQueuePriorityFacts(item(1, { priority: 'high', queuedAt: '2026-07-16T00:00:00Z' }), { unblocks: 3 });
    expect(high).toMatchObject({ blockedItems: 3, operatorRequested: true, waitingSince: '2026-07-16T00:00:00Z' });
    const low = buildQueuePriorityFacts(item(2, { priority: 'low' }), { unblocks: 0 });
    expect(low.override).toEqual({ value: 'low', byOperator: true });
    const medium = buildQueuePriorityFacts(item(3, { priority: 'medium' }), { unblocks: 0 });
    expect(medium).not.toHaveProperty('operatorRequested');
    expect(medium).not.toHaveProperty('override');
  });
});

const BACKLOG_CLI = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'backlog.mjs');
const card = (dir, file, fm) => writeFileSync(join(dir, file),
  `---\n${Object.entries(fm).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n')}\n---\n\n# ${file}\n`, 'utf8');

describe('#4355 build-queue --json reads the cleared set through the queue-store state-home resolver', () => {
  it('counts the sidecar-cleared cards (not committed buildQueued frontmatter) and orders class first', () => {
    const root = mkdtempSync(join(tmpdir(), 'bq-4355-'));
    try {
      const dir = join(root, 'backlog');
      mkdirSync(dir);
      const base = { kind: 'story', size: 2, status: 'open', dateOpened: '2026-01-01', tags: [] };
      card(dir, '9101-old-normal.md', { ...base, value: 5 });
      card(dir, '9102-new-high.md', { ...base, priority: 'high', dateOpened: '2026-09-01' });
      card(dir, '9103-frontmatter-only.md', { ...base, buildQueued: true });
      const stateDir = join(root, 'state');
      mkdirSync(join(stateDir, '.conveyor'), { recursive: true });
      const queueFile = join(stateDir, '.conveyor', 'queue.json');
      const at = new Date().toISOString();
      writeFileSync(queueFile, JSON.stringify([{ num: '9101', addedAt: at }, { num: '9102', addedAt: at }, { num: '9999', addedAt: at }]));
      // No CONVEYOR_QUEUE_FILE: the read must go through the state-home default (CONVEYOR_STATE_ROOT pins it).
      const env = { ...process.env, CONVEYOR_STATE_ROOT: stateDir, WE_BUILD_QUEUE_CACHE: '0' };
      delete env.CONVEYOR_QUEUE_FILE;
      delete env.WE_BUILD_QUEUE_PRIORITY_MODE;
      const out = JSON.parse(execFileSync('node', [BACKLOG_CLI, 'build-queue', '--json', `--backlog-dir=${dir}`], { encoding: 'utf8', env }));
      expect(out).toMatchObject({ priorityMode: 'enforce', prioritySource: 'tool' });
      expect(out.cleared).toBe(2);
      expect(out.sidecar).toMatchObject({ path: queueFile, entries: 3 });
      const cleared = out.queue.filter((r) => r.buildQueued).map((r) => String(r.num));
      expect(cleared).toEqual(['9102', '9101']);
      expect(out.queue.find((r) => String(r.num) === '9102').priorityClass).toBe('P2');
      expect(out.queue.find((r) => String(r.num) === '9103').buildQueued).toBe(false);
      const run = (mode, next = false) => {
        const result = spawnSync('node', [
          BACKLOG_CLI, 'build-queue', '--json', `--backlog-dir=${dir}`, ...(next ? ['--next'] : []),
        ], { encoding: 'utf8', env: { ...env, WE_BUILD_QUEUE_PRIORITY_MODE: mode } });
        expect(result.status, result.stderr).toBe(0);
        return { payload: JSON.parse(result.stdout), stderr: result.stderr };
      };
      const modes = Object.fromEntries(['off', 'shadow', 'enforce'].map((mode) => [mode, run(mode)]));
      const clearedOrder = (payload) => payload.queue.filter((r) => r.buildQueued).map((r) => String(r.num));
      expect(clearedOrder(modes.off.payload)).toEqual(['9101', '9102']);
      expect(modes.off.payload.queue.every((r) => r.priorityClass === 'P3' && r.priorityScore === 0)).toBe(true);
      expect(clearedOrder(modes.shadow.payload)).toEqual(clearedOrder(modes.off.payload));
      expect(clearedOrder(modes.enforce.payload)).toEqual(['9102', '9101']);
      expect(String(modes.shadow.payload.shadowClassOrder[0])).toBe('9102');
      expect(modes.shadow.stderr).toContain('priority-shadow mode=shadow');
      for (const [mode, result] of Object.entries(modes)) {
        expect(result.payload).toMatchObject({ priorityMode: mode, prioritySource: 'env' });
        const next = run(mode, true);
        expect(next.payload).toMatchObject({ priorityMode: mode, prioritySource: 'env' });
        expect(String(next.payload.next.num)).toBe(clearedOrder(result.payload)[0]);
        if (mode === 'shadow') {
          expect(next.payload.shadowClassOrder).toEqual(result.payload.shadowClassOrder);
          expect(next.stderr).toContain('priority-shadow mode=shadow');
        } else {
          expect(result.payload).not.toHaveProperty('shadowClassOrder');
          expect(next.payload).not.toHaveProperty('shadowClassOrder');
          expect(result.stderr).not.toContain('priority-shadow');
        }
      }

    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('#4355 build-queue --json clearance through a JIT-number rename (bornAs)', () => {
  it('keeps the clearance and addedAt of a numbered card the sidecar still holds under its pre-number hash', () => {
    const root = mkdtempSync(join(tmpdir(), 'bq-4355-bornas-'));
    try {
      const dir = join(root, 'backlog');
      mkdirSync(dir);
      const base = { kind: 'story', size: 2, status: 'open', dateOpened: '2026-01-01', tags: [] };
      card(dir, '9201-renumbered.md', { ...base, bornAs: 'x34h6a2' });
      card(dir, '9202-never-cleared.md', { ...base, priority: 'high' });
      const stateDir = join(root, 'state');
      mkdirSync(join(stateDir, '.conveyor'), { recursive: true });
      const addedAt = new Date(Date.now() - 2 * 3600e3).toISOString();
      // The sidecar was written BEFORE the drain numbered the card: it holds the hash, never the number 9201.
      writeFileSync(join(stateDir, '.conveyor', 'queue.json'), JSON.stringify([{ num: 'x34h6a2', addedAt }]));
      const env = { ...process.env, CONVEYOR_STATE_ROOT: stateDir, WE_BUILD_QUEUE_CACHE: '0' };
      delete env.CONVEYOR_QUEUE_FILE;
      delete env.WE_BUILD_QUEUE_PRIORITY_MODE;
      const run = (...extra) => JSON.parse(execFileSync('node', [BACKLOG_CLI, 'build-queue', '--json', `--backlog-dir=${dir}`, ...extra], { encoding: 'utf8', env }));
      const out = run();
      expect(out.cleared).toBe(1);
      expect(out.sidecar).toMatchObject({ entries: 1 });
      const row = out.queue.find((r) => String(r.num) === '9201');
      expect(row).toMatchObject({ buildQueued: true, queuedAt: addedAt });
      expect(out.queue.find((r) => String(r.num) === '9202').buildQueued).toBe(false);
      // the cleared card is the builder's pick even though the uncleared one has a higher delivery class
      expect(String(run('--next').next.num)).toBe('9201');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('#4355 build-queue --json cache is invalidated by every input the cleared order reads', () => {
  it('re-reads after a sidecar edit and after a priority-settings edit (cache enabled)', () => {
    const root = mkdtempSync(join(tmpdir(), 'bq-4355-cache-'));
    const backlogDir = join(root, 'backlog');
    const cacheFile = buildQueueCacheFile(backlogDir);
    const stateDir = join(root, 'state');
    const queueFile = join(stateDir, '.conveyor', 'queue.json');
    const touched = [];
    // utimes on a settings file changes only its mtime (the cache-key input), never its content; restored in finally.
    const bump = (path, secondsAhead) => {
      const before = statSync(path);
      touched.push([path, before.atime, before.mtime]);
      utimesSync(path, before.atime, new Date(before.mtimeMs + secondsAhead * 1000));
    };
    try {
      mkdirSync(join(stateDir, '.conveyor'), { recursive: true });
      mkdirSync(backlogDir);
      const base = { kind: 'story', size: 2, status: 'open', dateOpened: '2026-01-01', tags: [] };
      card(backlogDir, '9301-first.md', { ...base, value: 5 });
      card(backlogDir, '9302-second.md', { ...base, value: 1 });
      const at = new Date().toISOString();
      writeFileSync(queueFile, '[]');
      // WE_BUILD_QUEUE_CACHE=1 opts a --backlog-dir fixture run INTO the cache (it is off by default there).
      const env = { ...process.env, CONVEYOR_STATE_ROOT: stateDir, WE_BUILD_QUEUE_CACHE: '1' };
      delete env.CONVEYOR_QUEUE_FILE;
      delete env.WE_BUILD_QUEUE_PRIORITY_MODE;
      const run = () => JSON.parse(execFileSync('node', [BACKLOG_CLI, 'build-queue', '--json', `--backlog-dir=${backlogDir}`], { encoding: 'utf8', env }));
      const cacheKey = () => JSON.parse(readFileSync(cacheFile, 'utf8')).key;

      const first = run();
      expect(first.cleared).toBe(0);
      expect(first.queue).toHaveLength(2);
      const head = String(first.queue[0].num);
      const firstKey = cacheKey(); // proves the cache path really ran

      // sidecar edit: a cached read would still say cleared 0
      writeFileSync(queueFile, JSON.stringify([{ num: head, addedAt: at }]));
      bump(queueFile, 5);
      const second = run();
      expect(second.cleared).toBe(1);
      expect(second.queue.find((r) => String(r.num) === head)).toMatchObject({ buildQueued: true, queuedAt: at });
      const secondKey = cacheKey();
      expect(secondKey).not.toBe(firstKey);

      // the tool layer is the merge of several settings files: the key carries the merged value, not one file's mtime
      expect(secondKey).toContain(JSON.stringify(JSON.stringify(readSettings().buildQueuePriority ?? null)).slice(1, -1));

      // the mode env var is a key input too: flipping it inside the cache window must change the served mode
      const withMode = (mode) => JSON.parse(execFileSync('node', [BACKLOG_CLI, 'build-queue', '--json', `--backlog-dir=${backlogDir}`], {
        encoding: 'utf8', env: { ...env, WE_BUILD_QUEUE_PRIORITY_MODE: mode } }));
      expect(withMode('off')).toMatchObject({ priorityMode: 'off', prioritySource: 'env' });
      expect(withMode('enforce')).toMatchObject({ priorityMode: 'enforce', prioritySource: 'env' });
      run(); // re-prime the cache entry under the unset-mode key for the settings checks below
      expect(cacheKey()).toBe(secondKey);

      // settings edits: each settings file's mtime must be part of the key, so a bump rewrites the cached entry
      let previousKey = secondKey;
      for (const [index, path] of [DELIVERY_PRIORITY_SETTINGS_PATH, join(SETTINGS_DIR, 'build-queue-priority.json')].entries()) {
        if (!existsSync(path)) continue; // an absent file contributes 'none' to the key; nothing to bump
        bump(path, 10 * (index + 1));
        expect(run().cleared).toBe(1);
        const nextKey = cacheKey();
        expect(nextKey, `bumping ${path} must change the cache key`).not.toBe(previousKey);
        previousKey = nextKey;
      }
    } finally {
      for (const [path, atime, mtime] of touched.reverse()) { try { utimesSync(path, atime, mtime); } catch { /* best effort */ } }
      rmSync(cacheFile, { force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });
});
