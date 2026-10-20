// Keep-alive leak fix (2026-10-20): every keep-alive from test-keepalive.mjs must end on its own once its
// anchor is gone or its lifetime is up, and the check:standards scan must flag a bare one anywhere else.
import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  KEEPALIVE_ANCHOR_ENV, KEEPALIVE_MARKER, keepAliveAnchorPid, keepAliveScript, killKeepAlives, spawnKeepAlive,
} from '../test-keepalive.mjs';
import { findUnmanagedKeepAlives, EMPTY_TIMER_RE } from '../../check-standards-rules.mjs';

const HELPER = pathToFileURL(resolve(dirname(fileURLToPath(import.meta.url)), '..', 'test-keepalive.mjs')).href;
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
async function waitGone(pid, ms = 3_000) {
  for (const end = Date.now() + ms; Date.now() < end && alive(pid);) await new Promise((r) => setTimeout(r, 50));
  return !alive(pid);
}
const others = [];
afterEach(() => { for (const c of others.splice(0)) { try { c.kill('SIGKILL'); } catch { /* gone */ } } killKeepAlives(); });

describe('keepAliveScript', () => {
  it('starts with the marker, and contains no bare empty-callback timer', () => {
    const src = keepAliveScript({ anchorPid: 4242 });
    expect(src.startsWith(KEEPALIVE_MARKER)).toBe(true);
    expect(EMPTY_TIMER_RE.test(src)).toBe(false);
    expect(keepAliveScript({ anchorPid: 4242, prelude: 'A;', postlude: 'B;' })).toMatch(/^\/\*we-keepalive\*\/A;\n\{.*\}\nB;$/s);
  });
  it('refuses a missing anchor or lifetime', () => {
    expect(() => keepAliveScript({ anchorPid: 1 })).toThrow(/anchorPid/);
    expect(() => keepAliveScript({ anchorPid: 4242, maxLifetimeMs: 0 })).toThrow(/maxLifetimeMs/);
  });
  it('anchors to the env pid when set, else the fallback', () => {
    expect(keepAliveAnchorPid({ [KEEPALIVE_ANCHOR_ENV]: '777' }, 5)).toBe(777);
    expect(keepAliveAnchorPid({}, 5)).toBe(5);
    expect(keepAliveAnchorPid({ [KEEPALIVE_ANCHOR_ENV]: 'x' }, 5)).toBe(5);
  });
});

describe('a keep-alive ends on its own', () => {
  it('exits once its anchor pid is gone', async () => {
    const anchor = spawn(process.execPath, ['-e', keepAliveScript({ anchorPid: process.pid, maxLifetimeMs: 30_000 })], { stdio: 'ignore' });
    others.push(anchor);
    const child = spawnKeepAlive({ anchorPid: anchor.pid });
    await new Promise((r) => setTimeout(r, 400));
    expect(alive(child.pid)).toBe(true);
    anchor.kill('SIGKILL');
    expect(await waitGone(child.pid)).toBe(true);
  });
  it('exits after its max lifetime even with a live anchor', async () => {
    const child = spawnKeepAlive({ anchorPid: process.pid, maxLifetimeMs: 300 });
    expect(await waitGone(child.pid)).toBe(true);
  });
  it('a SIGKILLed spawner leaves no orphan (its exit hooks never ran — the anchor watch does it)', async () => {
    const parent = spawn(process.execPath, ['--input-type=module', '-e',
      `import { spawnKeepAlive } from ${JSON.stringify(HELPER)};\n`
      + 'const c = spawnKeepAlive({ anchorPid: process.pid, detached: true }); console.log(c.pid); setTimeout(() => process.exit(0), 30000);',
    ], { stdio: ['ignore', 'pipe', 'ignore'] });
    others.push(parent);
    let out = '';
    parent.stdout.on('data', (b) => { out += b; });
    for (const end = Date.now() + 5_000; !out.includes('\n') && Date.now() < end;) await new Promise((r) => setTimeout(r, 25));
    const childPid = Number(out.trim());
    expect(alive(childPid)).toBe(true);
    parent.kill('SIGKILL');
    await once(parent, 'exit');
    expect(await waitGone(childPid)).toBe(true);
  });
  it('a spawner that exits normally kills its tracked keep-alives at once', async () => {
    const parent = spawn(process.execPath, ['--input-type=module', '-e',
      `import { spawnKeepAlive } from ${JSON.stringify(HELPER)};\n`
      + 'const c = spawnKeepAlive({ anchorPid: process.ppid }); console.log(c.pid); setTimeout(() => process.exit(0), 300);',
    ], { stdio: ['ignore', 'pipe', 'ignore'] });
    others.push(parent);
    let out = '';
    parent.stdout.on('data', (b) => { out += b; });
    await once(parent, 'exit');
    expect(await waitGone(Number(out.trim()), 1_000)).toBe(true);
  });
  it('killKeepAlives kills every tracked child', async () => {
    const a = spawnKeepAlive({ anchorPid: process.pid });
    const b = spawnKeepAlive({ anchorPid: process.pid, detached: true });
    killKeepAlives();
    expect(await waitGone(a.pid)).toBe(true);
    expect(await waitGone(b.pid)).toBe(true);
  });
});

describe('check:standards — findUnmanagedKeepAlives', () => {
  const at = (files) => findUnmanagedKeepAlives(files).map((f) => `${f.file}:${f.line}`);
  it('flags an idle timer in any spelling — interval or timeout, spaced, unspaced, a space before (, empty function, async, multi-line', () => {
    const content = [
      "spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)']);", // keepalive-guard: not-a-spawn (scan fixture)
      'const X = "setInterval(()=>{},1000)";', // keepalive-guard: not-a-spawn (scan fixture)
      'setInterval (function () {}, 5);', // keepalive-guard: not-a-spawn (scan fixture)
      'setInterval(() => {',
      '}, 1000);',
      'setInterval(() => tick(), 1000);',
      'setInterval(async () => {}, 1000);', // keepalive-guard: not-a-spawn (scan fixture)
      "spawn(node, ['-e', 'setTimeout(() => {}, 60000)']);", // keepalive-guard: not-a-spawn (scan fixture)
      'setTimeout(()=>{},30000)', // keepalive-guard: not-a-spawn (scan fixture)
      'setTimeout(() => process.exit(0), 30000);',
      'await new Promise((r) => setTimeout(r, 50));',
      'setInterval(_ => {}, 1000);', // keepalive-guard: not-a-spawn (scan fixture)
      'setInterval(function (unused) {}, 1000);', // keepalive-guard: not-a-spawn (scan fixture)
      'setInterval(() => {/* idle */}, 1000);', // keepalive-guard: not-a-spawn (scan fixture)
      String.raw`x("setInterval(() => {\n}, 1000)");`, // keepalive-guard: not-a-spawn (scan fixture)
      'setInterval((a, b) => { tick(a, b); }, 1000);',
    ].join('\n');
    expect(at([{ file: 'scripts/a.mjs', content }])).toEqual(['scripts/a.mjs:1', 'scripts/a.mjs:2', 'scripts/a.mjs:3', 'scripts/a.mjs:4', 'scripts/a.mjs:7', 'scripts/a.mjs:8', 'scripts/a.mjs:9', 'scripts/a.mjs:12', 'scripts/a.mjs:13', 'scripts/a.mjs:14', 'scripts/a.mjs:15']);
  });
  it('exempts only the helper and a line ENDING in the not-a-spawn comment — not the marker text inside a string', () => {
    const idle = 'setInterval(()=>{},1000)'; // keepalive-guard: not-a-spawn (scan fixture)
    expect(at([{ file: 'scripts/lib/test-keepalive.mjs', content: idle }])).toEqual([]);
    expect(at([{ file: 'scripts/b.mjs', content: `x('${idle}'); // keepalive-guard: not-a-spawn (fixture)` }])).toEqual([]);
    expect(at([{ file: 'scripts/c.mjs', content: `x('${idle} keepalive-guard: not-a-spawn');` }])).toEqual(['scripts/c.mjs:1']);
    expect(at([{ file: 'scripts/d.mjs', content: `x("${idle}"); // keepalive-guard: not-a-spawn "quoted"` }])).toEqual(['scripts/d.mjs:1']);
  });
});

describe('spawnKeepAlive signal hooks keep the spawner\'s own signal behaviour', () => {
  const run = async (src) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', `import { spawnKeepAlive } from ${JSON.stringify(HELPER)};\n${src}`], { stdio: ['ignore', 'pipe', 'ignore'] });
    others.push(p);
    let out = '';
    p.stdout.on('data', (b) => { out += b; });
    for (const end = Date.now() + 5_000; !out.includes('\n') && Date.now() < end;) await new Promise((r) => setTimeout(r, 25));
    const childPid = Number(out.trim());
    p.kill('SIGTERM');
    const [code, signal] = await once(p, 'exit');
    return { code, signal, childGone: await waitGone(childPid) };
  };
  it('with no handler of its own, SIGTERM still terminates it (by signal) and its keep-alive goes too', async () => {
    expect(await run('const c = spawnKeepAlive({ anchorPid: process.ppid }); console.log(c.pid); setTimeout(() => process.exit(0), 30000);'))
      .toEqual({ code: null, signal: 'SIGTERM', childGone: true });
  });
  it('with its own graceful once-handler, that handler decides the exit — never re-signalled', async () => {
    expect(await run("process.once('SIGTERM', () => setTimeout(() => process.exit(7), 200)); const c = spawnKeepAlive({ anchorPid: process.ppid }); console.log(c.pid); setTimeout(() => process.exit(0), 30000);"))
      .toEqual({ code: 7, signal: null, childGone: true });
  });
});
