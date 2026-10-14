import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, utimesSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireStoreLock, releaseStoreLock, LOCK_STALE_MS } from './helpers/fake-gh.mjs';

const helper = new URL('./helpers/fake-gh.mjs', import.meta.url).href;
const realNowMs = () => performance.timeOrigin + performance.now();
const cleanups = [];
afterEach(() => { while (cleanups.length) cleanups.pop()(); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'fake-gh-lock-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'store.json');
}
function backdate(path) {
  const past = new Date(realNowMs() - LOCK_STALE_MS - 5_000);
  utimesSync(path, past, past);
}
function holder(lock) { return JSON.parse(readFileSync(join(lock, 'holder.json'), 'utf8')); }

// Signal readiness before entering the synchronous acquire, so assertions never depend on child boot time.
async function waiter(store, futureClock = false) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { acquireStoreLock, releaseStoreLock } from ${JSON.stringify(helper)};
    ${futureClock ? 'Date.now = () => 9_000_000_000_000;' : ''}
    process.send('ready');
    process.on('message', () => {
      const lock = acquireStoreLock(${JSON.stringify(store)});
      process.send('acquired');
      releaseStoreLock(lock);
      process.disconnect();
    });
  `], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  cleanups.push(() => child.kill('SIGKILL'));
  let acquired = false;
  const ready = new Promise((resolve) => child.once('message', resolve));
  const done = new Promise((resolve, reject) => {
    child.on('message', (message) => { if (message === 'acquired') acquired = true; });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`lock waiter exited ${code}`)));
  });
  await ready;
  child.send('go');
  return { done, acquired: () => acquired };
}

describe('fake-gh store lock recovery', () => {
  it.each(['missing', 'empty', 'malformed'])('promptly recovers a stale %s holder', (kind) => {
    const store = fixture();
    const lock = `${store}.lock`;
    mkdirSync(lock);
    if (kind !== 'missing') writeFileSync(join(lock, 'holder.json'), kind === 'empty' ? '' : '{');
    backdate(lock);
    const started = realNowMs();
    expect(acquireStoreLock(store)).toBe(lock);
    expect(realNowMs() - started).toBeLessThan(2_000);
    expect(holder(lock).token).toBeTruthy();
    releaseStoreLock(lock);
    expect(existsSync(lock)).toBe(false);
  });

  it('waits for a fresh orphan instead of replacing the empty directory', async () => {
    const store = fixture();
    const lock = `${store}.lock`;
    mkdirSync(lock);
    const waiting = await waiter(store);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(waiting.acquired()).toBe(false);
    expect(existsSync(join(lock, 'holder.json'))).toBe(false);
    rmSync(lock, { recursive: true });
    await waiting.done;
    expect(waiting.acquired()).toBe(true);
  }, 5_000);

  it('does not release a replacement acquired by another process after stale takeover', () => {
    const store = fixture();
    const lock = acquireStoreLock(store);
    const original = holder(lock);
    writeFileSync(join(lock, 'holder.json'), JSON.stringify({ ...original, at: realNowMs() - 60_000 }));
    execFileSync(process.execPath, ['--input-type=module', '-e', `
      import { acquireStoreLock } from ${JSON.stringify(helper)};
      acquireStoreLock(${JSON.stringify(store)});
    `], { timeout: 5_000 });
    const replacement = holder(lock);
    expect(replacement.token).not.toBe(original.token);
    releaseStoreLock(lock);
    expect(holder(lock)).toEqual(replacement);
  });

  it('ignores a future simulator Date.now when waiting for a fresh live holder', async () => {
    const store = fixture();
    const lock = acquireStoreLock(store);
    const original = holder(lock);
    const waiting = await waiter(store, true);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(waiting.acquired()).toBe(false);
    expect(holder(lock)).toEqual(original);
    releaseStoreLock(lock);
    await waiting.done;
    expect(waiting.acquired()).toBe(true);
  }, 5_000);

  it('sweeps old temporary and retired siblings while preserving fresh siblings', () => {
    const store = fixture();
    for (const kind of ['tmp', 'dead']) {
      mkdirSync(`${store}.lock.${kind}-old`);
      backdate(`${store}.lock.${kind}-old`);
      mkdirSync(`${store}.lock.${kind}-fresh`);
    }
    const lock = acquireStoreLock(store);
    for (const kind of ['tmp', 'dead']) {
      expect(existsSync(`${store}.lock.${kind}-old`)).toBe(false);
      expect(existsSync(`${store}.lock.${kind}-fresh`)).toBe(true);
    }
    releaseStoreLock(lock);
  });
});
