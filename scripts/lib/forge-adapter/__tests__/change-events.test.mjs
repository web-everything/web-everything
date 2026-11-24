/**
 * @file forge.change-events port: the GitHub adapter maps app-webhook deliveries to core change events, detects
 * gaps by seq (never timestamps), and core feed code reads events only through the port.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readChangeEvents, detectSeqGap } from '../change-events.mjs';
import { mapDelivery } from '../github/change-events.mjs';
import { isRelevantEvent } from '../../pr-events.mjs';

const REPO = { full_name: 'web-everything/web-everything' };
const SHA = 'a'.repeat(40);
const fetchOf = (body) => async () => ({ ok: true, status: 200, json: async () => body });

describe('forge.change-events', () => {
  it('github adapter maps an app-webhook merge_group and pull_request delivery to core change events with a gap flag on a skipped seq', async () => {
    const mg = mapDelivery('merge_group', { action: 'checks_requested', repository: REPO, merge_group: { head_sha: SHA, head_ref: 'refs/heads/gh-readonly-queue/main/pr-7-abc' } }, { deliveryId: 'd1', receivedAt: 1 });
    expect(mg).toMatchObject({ id: 'd1', type: 'merge_group', action: 'checks_requested', repo: REPO.full_name, sha: SHA, prs: [7] });
    const pr = mapDelivery('pull_request', { action: 'synchronize', number: 9, repository: REPO, pull_request: { head: { sha: SHA } } }, { deliveryId: 'd2', receivedAt: 2 });
    expect(pr).toMatchObject({ type: 'pull_request', prs: [9], sha: SHA });
    const body = { cursor: 5, events: [{ seq: 3, id: 'x' }, { seq: 5, id: 'y' }], more: false };
    const r = await readChangeEvents(2, { url: 'http://x', token: 't', fetchImpl: fetchOf(body) });
    expect(r.ok).toBe(true);
    expect(r.gap).toBe(true);
  });

  it('seq order only: contiguous seqs are no gap, a missing first seq is a gap, equal timestamps are irrelevant', () => {
    expect(detectSeqGap(2, [{ seq: 3, at: 'T' }, { seq: 4, at: 'T' }])).toBe(false);
    expect(detectSeqGap(2, [{ seq: 4 }])).toBe(true);
    expect(detectSeqGap(null, [{ seq: 9 }])).toBe(false);
  });

  it('unprovable feeds are gaps: invalid seq, and a cursor that moved past an empty page', async () => {
    expect(detectSeqGap(2, [{ id: 'no-seq' }])).toBe(true);
    expect(detectSeqGap(2, [{ seq: 3 }], 3)).toBe(false);
    const r = await readChangeEvents(2, { url: 'http://x', token: 't', fetchImpl: fetchOf({ cursor: 5, events: [] }) });
    expect(r).toMatchObject({ ok: true, gap: true });
  });

  it('an adapter declaring change-events unsupported routes to a person and is never read', async () => {
    let read = 0;
    const adapter = { capabilities: () => ({ 'change-events': { support: 'unsupported' } }), read: async () => { read += 1; return { ok: true, events: [] }; } };
    const r = await readChangeEvents(1, { adapter });
    expect(r).toMatchObject({ ok: false, route: 'person' });
    expect(read).toBe(0);
  });

  it('merge_group events wake the review and drain roles', () => {
    const e = { type: 'merge_group', action: 'checks_requested', repo: REPO.full_name, prs: [7], sha: SHA };
    expect(isRelevantEvent(e, 'review')).toBe(true);
    expect(isRelevantEvent(e, 'drain')).toBe(true);
  });

  it('an unknown event type is dropped from the wake set, never treated as all clear', () => {
    expect(mapDelivery('star', { action: 'created', repository: REPO })).toBeNull();
  });

  it('feed unreachable is an error (base interval), not an empty all-clear', async () => {
    const r = await readChangeEvents(1, { url: 'http://x', token: 't', fetchImpl: async () => { throw new Error('down'); } });
    expect(r.ok).toBe(false);
  });

  it('core modules import no GitHub event shape', () => {
    const feed = readFileSync(join(process.cwd(), 'scripts/lib/pr-event-feed.mjs'), 'utf8');
    expect(feed).not.toMatch(/pollEvents/);
    expect(feed).toMatch(/forge-adapter\/change-events\.mjs/);
    const core = readFileSync(join(process.cwd(), 'scripts/conveyor/pr-events-worker/core.mjs'), 'utf8');
    expect(core).not.toMatch(/child_process/);
  });
});
