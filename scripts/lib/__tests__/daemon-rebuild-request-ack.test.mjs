/** Rebuild-request acknowledgement races use real native Node bindings, not a mocked module copy. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { cloneLockDirs, writeRebuildRequest, readRebuildRequest, clearRebuildRequest } from '../daemon-clone-lock.mjs';

let scratch, root, lockRoot;
const T = 1_800_000_000_000;
beforeEach(() => {
  scratch = fs.mkdtempSync(join(tmpdir(), 'rebuild-request-ack-'));
  root = join(scratch, 'wev-review-daemon');
  lockRoot = join(scratch, 'locks');
  fs.mkdirSync(root);
});
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(scratch, { recursive: true, force: true }); });
const publish = (ref) => writeRebuildRequest(root, { lockRoot, nowMs: T, by: 'operator', reason: 'removed', ref });
const read = () => readRebuildRequest(root, { lockRoot, nowMs: T });

describe('rebuild request acknowledgement', () => {
  it('new pinned withdrawal published during rebuild acknowledgement survives for the next tick', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    // Native imports retain live bindings when instrumented. The unlink hook reproduces the old bug's
    // exact comparison/deletion gap; the rename hook targets the replacement acknowledgement protocol.
    const script = `
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import { join } from 'node:path';
      import { syncBuiltinESMExports } from 'node:module';
      const [lockUrl, syncUrl, root, lockRoot, scratch] = process.argv.slice(1);
      const lock = await import(lockUrl);
      const { withSelfSync } = await import(syncUrl);
      const nowMs = 1800000000000;
      const env = { WE_DAEMON_CLONE_LOCK_ROOT: lockRoot, WE_DAEMON_STATE_DIR: join(scratch, 'state') };
      const read = () => lock.readRebuildRequest(root, { lockRoot, nowMs });
      const first = lock.writeRebuildRequest(root, { lockRoot, nowMs, by: 'operator', reason: 'removed', ref: 'lane/first' });
      const base = lock.cloneLockDirs(root, lockRoot).base;
      const publication = join(base, 'rebuild-request.json');
      const acknowledgement = join(base, 'rebuild-request-ack.json');
      const realRm = fs.rmSync;
      const realRename = fs.renameSync;
      let second = null;
      let rebuilds = 0;
      let injected = false;
      const publishDuringAcknowledgement = () => {
        if (injected) return;
        injected = true;
        assert.equal(rebuilds, 1, 'inject only after the first rebuild concluded');
        second = lock.writeRebuildRequest(root, { lockRoot, nowMs, by: 'other-operator', reason: 'removed', ref: 'lane/second-pinned-removal' });
      };
      fs.rmSync = (path, ...args) => {
        if (String(path) === publication) publishDuringAcknowledgement();
        return realRm(path, ...args);
      };
      fs.renameSync = (from, to, ...args) => {
        if (String(to) === acknowledgement) publishDuringAcknowledgement();
        return realRename(from, to, ...args);
      };
      syncBuiltinESMExports();
      const wrapped = withSelfSync({ tickOnce: () => 'ticked' }, {
        root, env, entries: ['review-daemon.mjs'], now: () => nowMs,
        rebuild: async () => {
          rebuilds += 1;
          assert.equal(read().id, rebuilds === 1 ? first.id : second.id);
          return { moved: false, reason: 'up-to-date' };
        },
        onRestart: () => { throw new Error('unexpected restart'); },
        readHead: () => 'boot', readOriginRef: () => null, readState: () => ({}), readReady: () => null,
        versions: null, background: null, log: { error() {} },
      });
      try {
        assert.equal(await wrapped.tickOnce(), 'ticked');
        assert.equal(injected, true, 'publication must occur inside acknowledgement IO');
        assert.equal(read()?.id, second.id, 'acknowledging the first request must not delete the newer publication');
        assert.equal(await wrapped.tickOnce(), 'ticked');
        assert.equal(rebuilds, 2);
        assert.equal(read(), null, 'the second request is consumed only by the second concluded rebuild');
      } finally {
        fs.rmSync = realRm; fs.renameSync = realRename; syncBuiltinESMExports();
      }
    `;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script,
      pathToFileURL(join(here, '..', 'daemon-clone-lock.mjs')).href,
      pathToFileURL(join(here, '..', 'daemon-self-sync.mjs')).href, root, lockRoot, scratch], {
      encoding: 'utf8', timeout: 15_000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024,
      env: { ...process.env, HOME: scratch, WE_DAEMON_CLONE_LOCK_ROOT: lockRoot },
    });
    expect(r.status, r.stderr || r.stdout).toBe(0);
  });

  it('out-of-order acknowledgements cannot hide a newer publication', () => {
    const first = publish('lane/first');
    const second = publish('lane/second');
    clearRebuildRequest(root, { lockRoot, id: first.id });
    expect(read()?.id).toBe(second.id);
    clearRebuildRequest(root, { lockRoot, id: second.id });
    expect(read()).toBeNull();
    clearRebuildRequest(root, { lockRoot, id: first.id });
    expect(read()?.id).toBe(second.id); // A late old acknowledgement may replay work; it never loses work.
    const third = publish('lane/third');
    expect(read()?.id).toBe(third.id);
  });

  it.each(['{broken', '{}', 'null'])('corrupt acknowledgement %s cannot suppress a valid request', (contents) => {
    const rec = publish('lane/first');
    fs.writeFileSync(join(cloneLockDirs(root, lockRoot).base, 'rebuild-request-ack.json'), contents);
    expect(read()?.id).toBe(rec.id);
  });

  it('unreadable acknowledgement cannot suppress a valid request', () => {
    const rec = publish('lane/first');
    fs.mkdirSync(join(cloneLockDirs(root, lockRoot).base, 'rebuild-request-ack.json'));
    expect(read()?.id).toBe(rec.id);
  });

  it('failed acknowledgement publication retains the request for retry', () => {
    const rec = publish('lane/first');
    vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); });
    expect(() => clearRebuildRequest(root, { lockRoot, id: rec.id })).toThrow('denied');
    expect(read()?.id).toBe(rec.id);
  });
});
