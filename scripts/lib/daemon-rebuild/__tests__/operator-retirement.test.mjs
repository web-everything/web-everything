import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as adoption from '../adopt.mjs';
import { readOverlayEventLog } from '../prepare.mjs';
import { addOverlay, appendOverlayEvent, overlayFilePath, readOverlays, removeOverlay } from '../../daemon-overlays.mjs';
import { removeRegistration } from '../../../daemon-overlay.mjs';

const ref = 'lane/overlay-fix';
const sha = 'a'.repeat(40);
const added = { kind: 'added', ref, at: '2026-11-14T10:00:00Z' };
const removed = { kind: 'removed', ref, tip: sha, by: 'operator', reason: 'retire fix', at: '2026-11-14T11:00:00Z' };

describe('operator retirement of a live overlay', () => {
  let root, env;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'overlay-retirement-'));
    env = { ...process.env, WE_DAEMON_OVERLAY_DIR: join(root, 'overlays') };
    addOverlay(root, { ref }, { env });
    appendOverlayEvent(root, added, { env });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function match(events = readOverlayEventLog(root, env), extra = {}) {
    return adoption.matchReadyCandidate({
      ready: { kind: 'candidate', prevHead: 'live', passedAt: '2026-11-15T10:00:00Z',
        tree: 'candidate-tree', adopt: { finalSha: 'candidate', applied: [] } },
      plan: { finalSha: 'newer-plan' }, prevHead: 'live', treeOf: () => 'plan-tree',
      stillWanted: () => true, verifyBuilt: () => true,
      nowMs: Date.parse('2026-11-15T10:01:00Z'), maxAgeMs: 3_600_000,
      liveApplied: [{ ref, sha }],
      retiredByOperator: (a) => adoption.overlayRetiredByOperator?.({ ...a, events,
        registered: (r) => readOverlays(root, { env }).some((o) => o.ref === r) }) ?? false,
      ...extra,
    });
  }

  function refused(result = match()) {
    expect(result).toMatchObject({ adopt: null, reason: `superseded-omits-live-overlay: ${ref}`, omitted: [ref] });
  }

  it('still discards a candidate after hand removal without a record', () => {
    removeOverlay(root, ref, { env });
    refused();
  });

  it('sanctioned removal records the exact tip and permits adoption with retired refs', () => {
    expect(removeRegistration({ root, ref, by: 'operator', reason: 'retire fix', env,
      deps: { tip: () => sha } }).removed).toBe(true);
    const events = readOverlayEventLog(root, env);
    expect(events.at(-1)).toMatchObject({ kind: 'removed', ref, tip: sha, by: 'operator', reason: 'retire fix' });
    expect(Number.isFinite(Date.parse(events.at(-1).at))).toBe(true);
    expect(match(events)).toMatchObject({ adopt: { finalSha: 'candidate' }, match: 'superseded', retired: [ref] });
  });

  it.each([
    ['wrong sha', { ...removed, tip: 'b'.repeat(40) }],
    ['missing sha', { ...removed, tip: undefined }],
    ['empty reason', { ...removed, reason: '  ' }],
    ['missing time', { ...removed, at: undefined }],
    ['invalid time', { ...removed, at: 'invalid' }],
    ['older than added', { ...removed, at: '2026-11-14T09:00:00Z' }],
    ['same time as added', { ...removed, at: added.at }],
    ['different ref', { ...removed, ref: 'lane/other' }],
  ])('refuses retirement evidence with %s', (_name, record) => {
    removeOverlay(root, ref, { env });
    refused(match([added, record]));
  });

  it('refuses a stale record after a later re-add even when removed again by hand', () => {
    removeOverlay(root, ref, { env });
    refused(match([added, removed, { ...added, at: '2026-11-14T12:00:00Z' }]));
  });

  it('refuses a still-registered ref', () => refused(match([added, removed])));

  it('refuses when an unknown lifecycle event follows the removal', () => {
    removeOverlay(root, ref, { env });
    refused(match([added, removed, { kind: 'mystery', ref, at: '2026-11-14T12:00:00Z' }]));
  });

  it('refuses unknown add chronology', () => {
    removeOverlay(root, ref, { env });
    refused(match([{ ...added, at: undefined }, removed]));
  });

  it('refuses unreadable events instead of using a valid prefix', () => {
    removeOverlay(root, ref, { env });
    appendOverlayEvent(root, removed, { env });
    const file = overlayFilePath(root, env).replace(/\.json$/, '.events.jsonl');
    writeFileSync(file, `${readFileSync(file, 'utf8')}unreadable\n`);
    refused();
    rmSync(file);
    refused();
  });

  it('removal without a non-empty reason supplies no retirement proof', () => {
    removeRegistration({ root, ref, reason: ' ', env, deps: { tip: () => sha } });
    refused();
  });

  it('an unreadable removed tip supplies no retirement proof', () => {
    removeRegistration({ root, ref, reason: 'retire fix', env, deps: { tip: () => undefined } });
    refused();
  });

  it('refuses by default when no retirement predicate is injected', () => {
    removeOverlay(root, ref, { env });
    refused(match([added, removed], { retiredByOperator: undefined }));
  });
});
