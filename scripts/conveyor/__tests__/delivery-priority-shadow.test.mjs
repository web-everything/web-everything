/**
 * Card xjddimd — the fix daemon's delivery-priority SHADOW adapter: facts from a planned fix entry, one log line per
 * pass, never a change to the pass, off value logs nothing, any failure is swallowed.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  actualScopeWaiters, fixEntryPriorityFacts, formatPriorityShadowLine, logFixPassPriorityShadow, readDeliveryPrioritySettings,
  readMainRedOwner, shadowFixPassPriority,
} from '../delivery-priority-shadow.mjs';
import { filterFixesByInFlightScope } from '../reconcile-fix-dispatch.mjs';
import { resolvePrioritySettings } from '../../lib/delivery-priority.mjs';

const NOW = Date.parse('2026-10-08T23:45:00Z');
const PASS_0304 = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fix-pass-2026-10-09.json'), 'utf8'));

describe('actualScopeWaiters — only PRs actually waiting behind this one', () => {
  const planned = [
    { pr: 1, overlapScope: ['we:a.mjs'] }, { pr: 2, overlapScope: ['we:a.mjs'] },
    { pr: 3, overlapScope: ['we:a.mjs', 'we:b.mjs'] }, { pr: 4, overlapScope: ['we:c.mjs'] },
  ];
  const ranks = [{ pr: 1, rank: 1 }, { pr: 2, rank: 2 }, { pr: 3, rank: 3 }, { pr: 4, rank: 4 }];
  const refusals = [{ pr: 2, kind: 'scope-overlap' }, { pr: 3, kind: 'scope-overlap' }];

  it('the admitted head of a wait chain counts its waiters; a waiting PR counts none; no shared path = none', () => {
    expect([...actualScopeWaiters({ planned, ranks, refusals })]).toEqual([[1, 2], [2, 0], [3, 0], [4, 0]]);
  });

  it('a shared file in the other direction (the waiter ranks ahead) is not a waiter', () => {
    expect(actualScopeWaiters({ planned, ranks: [{ pr: 1, rank: 3 }, { pr: 2, rank: 1 }, { pr: 3, rank: 2 }, { pr: 4, rank: 4 }], refusals }).get(1)).toBe(0);
  });

  it('no scope refusals this pass = nobody waits on anybody', () => {
    expect([...actualScopeWaiters({ planned, ranks, refusals: [] }).values()]).toEqual([0, 0, 0, 0]);
  });
});

describe('replay: the live 12-PR fix pass of 2026-10-09 03:04Z', () => {
  it('spreads the classes: only the admitted head that others wait on is P1, the rest P3 (was 12 x P1)', () => {
    const now = Date.parse(PASS_0304.now);
    const scope = filterFixesByInFlightScope(PASS_0304.planned, [], [], { now, maxWaitMinutes: 60 });
    const { ranked } = shadowFixPassPriority({
      planned: PASS_0304.planned, ranks: scope.ranks, refusals: scope.refusals,
      settings: resolvePrioritySettings({ mode: 'shadow', agingHours: 8, maxLiveP0: 2, unblockWeightMinutes: 60 }), now,
    });
    expect(ranked).toHaveLength(12);
    expect(ranked.filter((r) => r.class === 'P1').map((r) => r.id)).toEqual([4461]);
    expect(ranked.filter((r) => r.class === 'P3')).toHaveLength(11);
    expect(ranked[0].reasons[0]).toMatch(/^10 change\(s\) wait on its scope$/);
  });
});
const SHADOW = resolvePrioritySettings({ mode: 'shadow', agingHours: 8, maxLiveP0: 2, unblockWeightMinutes: 60 });

describe('fixEntryPriorityFacts', () => {
  it('owner record naming this PR in this repo = incident owner', () => {
    const facts = fixEntryPriorityFacts({ pr: 4522, waitingSince: '2026-10-08T22:43:39Z' }, { owner: { repo: 'we', pr: 4522 }, repoKey: 'we' });
    expect(facts.incident).toEqual({ open: true, owner: true });
    expect(fixEntryPriorityFacts({ pr: 4522 }, { owner: { repo: 'plateau-app', pr: 4522 }, repoKey: 'we' }).incident.owner).toBe(false);
    expect(fixEntryPriorityFacts({ pr: 4511 }, { owner: { repo: 'we', pr: 4522 } }).incident).toEqual({ open: true, owner: false });
    expect(fixEntryPriorityFacts({ pr: 4511 }, {}).incident).toEqual({ open: false });
  });

  it('reads scope waiters, operator answers, code-free diffs and override labels (unverified)', () => {
    const facts = fixEntryPriorityFacts(
      { pr: 1, operatorAnswer: { body: 'go' }, overlapScope: ['we:backlog/x.md', 'we:docs/a.md'] },
      { waiters: 2, labels: ['priority:urgent', 'review:human'] },
    );
    expect(facts).toMatchObject({ scopeWaiters: 2, operatorRequested: true, changesCode: false, override: { value: 'urgent', byOperator: false } });
    expect(fixEntryPriorityFacts({ pr: 2, overlapScope: ['we:scripts/a.mjs'] }).changesCode).toBe(true);
    expect('changesCode' in fixEntryPriorityFacts({ pr: 3 })).toBe(false);
  });
});

describe('shadowFixPassPriority + log line', () => {
  const planned = [
    { pr: 4511, waitingSince: '2026-10-08T21:14:41Z', overlapScope: ['we:scripts/a.mjs'] },
    { pr: 4522, waitingSince: '2026-10-08T22:43:39Z', overlapScope: ['we:scripts/b.mjs'] },
    { pr: 4478, waitingSince: '2026-10-08T16:50:22Z', overlapScope: ['we:backlog/c.md'] },
  ];

  it('the incident pass: the owner is P0 and first; the others keep their classes', () => {
    const { ranked } = shadowFixPassPriority({ planned, ranks: [], dispatchEntries: [], settings: SHADOW, owner: { repo: 'we', pr: 4522 }, now: NOW });
    expect(ranked.map((r) => [r.id, r.class])).toEqual([[4522, 'P0'], [4511, 'P3'], [4478, 'P4']]);
    const line = formatPriorityShadowLine('we', { mode: 'shadow', ranked });
    expect(line).toMatch(/^reconcile-fix-dispatch: priority-shadow we mode=shadow 3 PR\(s\) — #4522 P0 /);
    expect(line).toContain('owns the fix for the open main-red episode');
  });

  it('an unverified override label is named in the log, never applied', () => {
    const { ranked } = shadowFixPassPriority({
      planned: [{ pr: 9, overlapScope: ['we:scripts/a.mjs'] }], dispatchEntries: [{ prNumber: 9, labels: ['priority:urgent'] }], settings: SHADOW, now: NOW,
    });
    expect(ranked[0].class).toBe('P3');
    expect(ranked[0].reasons).toContain('override urgent ignored: not verified as operator-set');
  });
});

describe('logFixPassPriorityShadow (IO shell)', () => {
  it('logs exactly one line per pass and returns the ranking', () => {
    const log = vi.fn();
    const result = logFixPassPriorityShadow({
      planned: [{ pr: 1 }], ranks: [], dispatchEntries: [], now: NOW, log, readSettings: () => SHADOW, readOwner: () => null,
    });
    expect(log).toHaveBeenCalledTimes(1);
    expect(result.ranked[0]).toMatchObject({ id: 1, class: 'P3' });
  });

  it('mode off logs nothing', () => {
    const log = vi.fn();
    expect(logFixPassPriorityShadow({ planned: [{ pr: 1 }], log, readSettings: () => resolvePrioritySettings({ mode: 'off' }), readOwner: () => null })).toBeNull();
    expect(log).not.toHaveBeenCalled();
  });

  it('a pass with nothing owed logs nothing and adds nothing to the result', () => {
    const log = vi.fn();
    expect(logFixPassPriorityShadow({ planned: [], log, readSettings: () => SHADOW, readOwner: () => null })).toBeNull();
    expect(log).not.toHaveBeenCalled();
  });

  it('never throws: a failing read is logged as skipped', () => {
    const log = vi.fn();
    expect(logFixPassPriorityShadow({ planned: [{ pr: 1 }], log, readSettings: () => { throw new Error('boom'); } })).toBeNull();
    expect(log.mock.calls[0][0]).toMatch(/priority-shadow skipped: boom/);
  });
});

describe('readers fail closed', () => {
  it('settings: unreadable file = off; the shipped file = shadow', () => {
    expect(readDeliveryPrioritySettings({ read: () => { throw new Error('ENOENT'); } }).mode).toBe('off');
    expect(readDeliveryPrioritySettings({ read: () => '{not json' }).mode).toBe('off');
    expect(readDeliveryPrioritySettings().mode).toBe('shadow');
  });

  it('owner record: absent, malformed or expired = null', () => {
    const read = (body) => () => JSON.stringify(body);
    expect(readMainRedOwner({ path: '/x', now: NOW, read: () => { throw new Error('ENOENT'); } })).toBeNull();
    expect(readMainRedOwner({ path: '/x', now: NOW, read: read({ pr: '4522', expiresAt: NOW + 1 }) })).toBeNull();
    expect(readMainRedOwner({ path: '/x', now: NOW, read: read({ repo: 'we', pr: 4522, expiresAt: NOW - 1 }) })).toBeNull();
    expect(readMainRedOwner({ path: '/x', now: NOW, read: read({ repo: 'we', pr: 4522, expiresAt: NOW + 1 }) })).toEqual({ repo: 'we', pr: 4522 });
  });
});
