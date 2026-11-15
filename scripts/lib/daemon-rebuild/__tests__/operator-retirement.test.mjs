import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import nodeFs, { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as adoption from '../adopt.mjs';
import { readOverlayEventLog } from '../prepare.mjs';
import { addOverlay, appendOverlayEvent, overlayFilePath, readOverlays, removeOverlay } from '../../daemon-overlays.mjs';
import { removeRegistration, retireRegistration } from '../../../daemon-overlay.mjs';
import { createPrototypeLoader } from '../../../operations/prototype-load-io.mjs';
import { OPERATOR_LOGINS } from '../../marker-authorship.mjs';

const ref = 'lane/overlay-fix';
const sha = 'a'.repeat(40);
const added = { kind: 'added', ref, at: '2026-11-14T10:00:00Z' };
const actor = OPERATOR_LOGINS[0];
const removed = { kind: 'removed', ref, tip: sha, by: 'operator', actor, reason: 'retire fix', at: '2026-11-14T11:00:00Z' };

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

  function loader(identity = () => ({ login: actor.toUpperCase(), type: 'User' })) {
    return createPrototypeLoader({ fs: nodeFs, env: { ...env, HOME: root }, now: () => 0,
      sleep: () => { throw new Error('unexpected sleep'); }, resolveOperatorIdentity: identity,
      settings: { workspaceRoot: root, daemons: { control: { clone: root } }, loaderCli: 'scripts/daemon-overlay.mjs', recordPath: join(root, 'records.jsonl') },
      exec: (command, args) => {
        if (command === 'node' && args[1] === 'list') return JSON.stringify({ list: readOverlays(root, { env }) });
        if (command === 'git' && args[0] === 'fetch') return '';
        if (command === 'git' && args[0] === 'rev-parse') return sha;
        if (command === 'git' && args[0] === 'ls-remote') return `${sha}\trefs/heads/${ref}`;
        throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
      } });
  }

  it('real prototype-load --remove verifies the actor and produces adoptable auto-retired evidence', async () => {
    expect(await loader()({ daemon: 'control', remove: ref, actor: actor.toUpperCase(), reason: 'withdraw live fix' }))
      .toMatchObject({ ok: true, removed: [ref] });
    expect(readOverlayEventLog(root, env).at(-1)).toMatchObject({ kind: 'auto-retired', ref, actor,
      operatorReason: true, by: env.USER || 'prototype-load', reason: 'withdraw live fix', tip: sha });
    expect(match()).toMatchObject({ adopt: { finalSha: 'candidate' }, retired: [ref] });
  });

  it.each([
    ['non-operator', 'outsider', () => ({ login: 'outsider', type: 'User' })],
    ['mismatched actor', 'outsider', () => ({ login: actor, type: 'User' })],
    ['bot identity', actor, () => ({ login: actor, type: 'Bot' })],
    ['unreadable identity', actor, () => { throw new Error('identity unavailable'); }],
  ])('prototype-load refuses %s --actor without removing anything', async (_name, declared, identity) => {
    const before = readOverlays(root, { env });
    expect(await loader(identity)({ daemon: 'control', remove: ref, actor: declared, reason: 'withdraw' }))
      .toMatchObject({ ok: false, stopReason: 'operator-identity-refused', removed: [] });
    expect(readOverlays(root, { env })).toEqual(before);
    expect(readOverlayEventLog(root, env)).toEqual([added]);
  });

  it('automatic retireRegistration supplies no operator proof', async () => {
    expect(await retireRegistration({ root, ref, expectedTip: sha, env, by: 'prototype-load', deps: {
      prove: () => ({ action: 'retire', tip: sha, reason: 'in-main' }), tip: () => sha,
    } })).toMatchObject({ retired: true });
    const event = readOverlayEventLog(root, env).at(-1);
    expect(event).toMatchObject({ kind: 'auto-retired', reason: 'in-main', tip: sha });
    expect(event).not.toHaveProperty('actor');
    expect(event).not.toHaveProperty('operatorReason');
    refused();
  });

  it('prototype-load without an actor removes but cannot authorize omission of a live overlay', async () => {
    expect(await loader(() => { throw new Error('must not resolve absent actor'); })({ daemon: 'control', remove: ref, reason: 'withdraw' }))
      .toMatchObject({ ok: true, removed: [ref] });
    expect(readOverlayEventLog(root, env).at(-1)).not.toHaveProperty('actor');
    refused();
  });

  it.each(['removed', 'auto-retired'])('%s requires operator evidence and accepts it case-insensitively', (kind) => {
    removeOverlay(root, ref, { env });
    expect(match([added, { ...removed, kind, actor: actor.toUpperCase() }])).toMatchObject({
      adopt: { finalSha: 'candidate' }, retired: [ref],
    });
    for (const invalid of [{ actor: undefined }, { actor: 'outsider' }, { reason: ' ' }, { tip: 'b'.repeat(40) }]) {
      refused(match([added, { ...removed, kind, ...invalid }]));
    }
    refused(match([added, removed, { ...removed, kind: 'auto-retired', actor: undefined }]));
  });

  it('still discards a candidate after hand removal without a record', () => {
    removeOverlay(root, ref, { env });
    refused();
  });

  it('sanctioned removal records the exact tip and permits adoption with retired refs', () => {
    expect(removeRegistration({ root, ref, by: 'operator', actor, reason: 'retire fix', env,
      deps: { tip: () => sha } }).removed).toBe(true);
    const events = readOverlayEventLog(root, env);
    expect(events.at(-1)).toMatchObject({ kind: 'removed', ref, tip: sha, by: 'operator', actor, reason: 'retire fix' });
    expect(Number.isFinite(Date.parse(events.at(-1).at))).toBe(true);
    expect(match(events)).toMatchObject({ adopt: { finalSha: 'candidate' }, match: 'superseded', retired: [ref] });
  });

  it.each([
    ['no actor (legacy record)', { ...removed, actor: undefined }],
    ['non-operator actor', { ...removed, actor: 'unregistered[bot]' }],
    ['non-string actor', { ...removed, actor: [actor] }],
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

  it('accepts a registered operator actor case-insensitively with a reason', () => {
    removeOverlay(root, ref, { env });
    expect(match([added, { ...removed, actor: actor.toUpperCase() }])).toMatchObject({
      adopt: { finalSha: 'candidate' }, retired: [ref],
    });
  });

  it('removal without an actor still removes but supplies no retirement proof', () => {
    expect(removeRegistration({ root, ref, reason: 'retire fix', env,
      deps: { tip: () => sha } }).removed).toBe(true);
    expect(readOverlayEventLog(root, env).at(-1)).not.toHaveProperty('actor');
    refused();
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
    removeRegistration({ root, ref, actor, reason: ' ', env, deps: { tip: () => sha } });
    refused();
  });

  it('an unreadable removed tip supplies no retirement proof', () => {
    removeRegistration({ root, ref, actor, reason: 'retire fix', env, deps: { tip: () => undefined } });
    refused();
  });

  it('refuses by default when no retirement predicate is injected', () => {
    removeOverlay(root, ref, { env });
    refused(match([added, removed], { retiredByOperator: undefined }));
  });
});
