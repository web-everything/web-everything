import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { easternIso, hotPatchRoot, main } from '../hot-patch.mjs';
import { hotPatchLedgerPath } from '../lib/hot-patch.mjs';
import { overlayFilePath } from '../lib/daemon-overlays.mjs';
import { cloneKeyOf } from '../lib/daemon-last-good.mjs';

const dirs = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'hot-patch-cli-')); dirs.push(dir);
  const env = { WE_DAEMON_STATE_DIR: dir, WE_DAEMON_OVERLAY_DIR: dir };
  let out = '', err = '';
  return { dir, env, io: { env, stdout: s => { out += s; }, stderr: s => { err += s; } },
    output: () => out, error: () => err };
}

test('unknown daemon is refused without a stack or admission call', async () => {
  const f = fixture();
  expect(await main(['request', '--daemon=unknown', '--pr=7'], { ...f.io,
    request: () => { throw Error('admission must not run'); } })).toBe(1);
  expect(f.error()).toMatch(/^unknown daemon;/);
  expect(f.error()).not.toMatch(/\n\s+at /);
  expect(f.output()).toBe('');
});

test('CLI process exits 1 on refusal without a stack', () => {
  const result = spawnSync(process.execPath, ['--no-deprecation', resolve('scripts/hot-patch.mjs'),
    'request', '--daemon=unknown', '--pr=7'], { encoding: 'utf8', timeout: 15000, maxBuffer: 65536 });
  expect(result.status).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toMatch(/^unknown daemon;[^\n]*\n$/);
});

test.each(['verify-result', 'pr'])('removed command %s is refused', async command => {
  const f = fixture();
  expect(await main([command], f.io)).toBe(1);
  expect(f.error()).toBe('expected request or status\n');
});

test('status without a global ledger prints no hot-patch open', async () => {
  const f = fixture();
  expect(await main(['status'], f.io)).toBe(0);
  expect(f.output()).toBe('no hot-patch open\n');
});

test('easternIso uses the winter and summer DST offsets', () => {
  expect(easternIso('2026-01-15T12:00:00Z')).toBe('2026-01-15T07:00:00-05:00');
  expect(easternIso('2026-07-15T12:00:00Z')).toBe('2026-07-15T08:00:00-04:00');
});

test('request passes the resolved clone and numeric PR to admission', async () => {
  const f = fixture(); let received;
  expect(await main(['request', '--daemon=./clone', '--pr=7'], { ...f.io, cwd: f.dir,
    request: async options => { received = options; return { ok: true }; } })).toBe(0);
  expect(received).toEqual({ root: join(f.dir, 'clone'), pr: 7, env: f.env });
  expect(hotPatchRoot('com.we.review-daemon', f.dir)).toMatch(/wev-review-daemon$/);
});

test.each(['0', '-1', '1e2', '9007199254740992'])('invalid PR %s is refused', async pr => {
  const f = fixture();
  expect(await main(['request', '--daemon=./clone', `--pr=${pr}`], f.io)).toBe(1);
  expect(f.error()).toMatch(/--pr requires/);
});

test('status refuses an unreadable global ledger', async () => {
  const f = fixture(); writeFileSync(hotPatchLedgerPath(f.env), '{}');
  expect(await main(['status'], f.io)).toBe(1);
  expect(f.error()).toMatch(/state unreadable; repair ledger/);
  expect(f.output()).toBe('');
});

test('status prints ET ledger, overlay and watch, and refuses corrupt watch or overlay evidence', async () => {
  const f = fixture(), at = '2026-07-15T12:00:00.000Z';
  const overlay = { ref: 'lane/patch', pr: 7, pinned: true, reason: 'R1100 hot-patch', addedAt: at, addedBy: null };
  const ledger = { sha: 'a'.repeat(40), pr: 7, branch: overlay.ref, root: f.dir,
    requestPid: 1, requestStart: Date.parse(at), loadedAt: at, wokeAt: at, overlay,
    preGood: { head: 'b'.repeat(40), inputsKey: 'c'.repeat(40), mainSha: 'd'.repeat(40), applied: [] } };
  writeFileSync(hotPatchLedgerPath(f.env), JSON.stringify(ledger));
  writeFileSync(overlayFilePath(f.dir, f.env), JSON.stringify({ clone: f.dir, overlays: [overlay] }));
  writeFileSync(join(f.dir, `${cloneKeyOf(f.dir)}.force-watch.json`), JSON.stringify({ ticksLeft: 2, startedAt: at }));
  expect(await main(['status'], f.io)).toBe(0);
  const result = JSON.parse(f.output());
  expect(result.ledger.loadedAt).toBe('2026-07-15T08:00:00-04:00');
  expect(result.ledger.requestStart).toBe(result.ledger.loadedAt);
  expect(result.ledger.wokeAt).toBe(result.ledger.loadedAt);
  expect(result.overlay.addedAt).toBe(result.ledger.loadedAt);
  expect(result.watch).toEqual({ ticksLeft: 2, startedAt: result.ledger.loadedAt });
  writeFileSync(join(f.dir, `${cloneKeyOf(f.dir)}.force-watch.json`), '{');
  expect(await main(['status'], f.io)).toBe(1);
  expect(f.error()).toMatch(/force-watch state unreadable; repair evidence/);
  writeFileSync(overlayFilePath(f.dir, f.env), '{');
  expect(await main(['status'], f.io)).toBe(1);
  expect(f.error()).toMatch(/overlay state unreadable; repair evidence/);
});
