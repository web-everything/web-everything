import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildStandDownComment } from '../stand-down.mjs';
import { standDownRow } from '../../operations/operator-queue.mjs';
import { derivePrStatusLabel } from '../pr-status-label.mjs';
import { planOrphanFixRound, CHANGES_VERDICT_PREFIX } from '../orphan-fix-round.mjs';
import { FIX_BEGIN_MARKER, FIX_END_MARKER } from '../fix-procedure.mjs';
import { standDownOf } from '../health-smells/stood-down-prs.mjs';

// Built from the path, not `new URL(rel, import.meta.url)`: under the happy-dom test environment the global `URL`
// can resolve against an http origin, and a child `node` process only loads file: URLs.
const STAND_DOWN_URL = pathToFileURL(resolve(dirname(fileURLToPath(import.meta.url)), '../stand-down.mjs')).href;
const old = 'a'.repeat(40);
const head = 'b'.repeat(40);
const c = (body, hour = 10) => ({ body, author: { login: 'web-everything' }, createdAt: `2026-10-12T${hour}:00:00Z` });
const hold = c(buildStandDownComment({ reason: 'fix-loop-exhausted', head: old }));
const pr = (headRefOid = head) => ({ number: 5155, title: 'head moved', headRefOid, labels: [], comments: [hold] });
afterEach(() => vi.unstubAllEnvs());

describe('head-aware stand-down consumers', () => {
  it('removes an old hold from the operator row and retains a current hold', () => {
    vi.stubEnv('WE_STAND_DOWN_LAPSE_ON_NEW_HEAD', 'on');
    expect(standDownRow('o/n', pr())).toBeNull();
    expect(standDownRow('o/n', pr(old))).toMatchObject({ number: 5155 });
  });
  it('removes stood-down from the status after the head moves', () => {
    vi.stubEnv('WE_STAND_DOWN_LAPSE_ON_NEW_HEAD', 'on');
    expect(derivePrStatusLabel({ pr: pr(), rows: [] })).not.toBe('stood-down');
    expect(derivePrStatusLabel({ pr: pr(old), rows: [] })).toBe('stood-down');
  });
  it('rearms an orphan round after its old hold lapses', () => {
    vi.stubEnv('WE_STAND_DOWN_LAPSE_ON_NEW_HEAD', 'on');
    const comments = [c(`${CHANGES_VERDICT_PREFIX}\nNet basis: \`${'0'.repeat(40)}..${old}\``),
      hold, c(FIX_BEGIN_MARKER, 11), c('## 🔧 conveyor fix — evidence for the `review:changes` round on this PR', 12), c(FIX_END_MARKER, 13)];
    const snapshot = { ...pr(), labels: [{ name: 'review:changes' }], comments, isDraft: false };
    const nowMs = Date.parse('2026-10-12T20:00:00Z');
    expect(planOrphanFixRound({ pr: snapshot, nowMs }).decision).toBe('rearm');
    expect(planOrphanFixRound({ pr: { ...snapshot, headRefOid: old }, nowMs }).decision).toBe('none');
  });
  it('ignores a stale stood-down label but preserves a bare label', () => {
    vi.stubEnv('WE_STAND_DOWN_LAPSE_ON_NEW_HEAD', 'on');
    const snapshot = { ...pr(), labels: [{ name: 'review-status:stood-down' }] };
    expect(standDownOf(snapshot)).toBeNull();
    expect(standDownOf({ ...snapshot, comments: [] })).not.toBeNull();
    expect(standDownOf({ ...snapshot, headRefOid: old })).not.toBeNull();
  });
  it('reads settings once for a whole comment batch', () => {
    const script = `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const real = fs.readFileSync;
      let reads = 0;
      fs.readFileSync = (...args) => {
        if (String(args[0]).endsWith('/settings/stand-down.json')) reads++;
        return real(...args);
      };
      syncBuiltinESMExports();
      const { standDownComments } = await import(${JSON.stringify(STAND_DOWN_URL)});
      reads = 0; // module load itself reads every declared settings file; count only the batch call
      delete process.env.WE_STAND_DOWN_LAPSE_ON_NEW_HEAD;
      standDownComments(${JSON.stringify([hold, hold, hold])}, { headRefOid: ${JSON.stringify(head)} });
      console.log(reads);
    `;
    expect(execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' }).trim()).toBe('1');
  });
});
