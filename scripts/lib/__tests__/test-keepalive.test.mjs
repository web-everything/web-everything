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
import { findUnmanagedKeepAlives } from '../../check-standards-rules.mjs';

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
    expect(findUnmanagedKeepAlives([{ file: 'scripts/x.mjs', content: `spawn(n, ['-e', ${JSON.stringify(src)}]);` }])).toEqual([]);
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

describe('check:standards — findUnmanagedKeepAlives (parsed, not pattern-matched)', () => {
  // Each case is a whole FILE handed to the scanner. The fixture strings themselves carry a real exemption
  // comment in THIS file's source, so this test file never trips the scan it tests.
  const scan = (content, file = 'scripts/x.mjs') => findUnmanagedKeepAlives([{ file, content }]);
  const flagged = (content) => scan(content).filter((f) => f.reason === 'idle-timer').map((f) => f.line);
  it('flags an empty-bodied callback whatever its comments, parameters, async or parentheses', () => {
    const cases = [
      'setInterval(() => {}, 1000);', // keepalive-helper-ok: scan fixture
      'setInterval(()=>{},1e9)', // keepalive-helper-ok: scan fixture
      'setInterval (function () {}, 5);', // keepalive-helper-ok: scan fixture
      'setInterval(async () => {}, 1000);', // keepalive-helper-ok: scan fixture
      'setInterval(async function named(a, b) {}, 1000);', // keepalive-helper-ok: scan fixture
      'setInterval(_ => {}, 1000);', // keepalive-helper-ok: scan fixture
      'setInterval(function (unused) {}, 1000);', // keepalive-helper-ok: scan fixture
      'setInterval(() => {/* idle */}, 1000);', // keepalive-helper-ok: scan fixture
      'setInterval(/* idle */ () => {}, 1000);', // keepalive-helper-ok: scan fixture (audit 3)
      'setInterval((x = f()) => {}, 1000);', // keepalive-helper-ok: scan fixture (audit 3)
      'setInterval((()=>{}),1000);', // keepalive-helper-ok: scan fixture (audit 2)
      'setInterval/*idle*/(()=>{},1000);', // keepalive-helper-ok: scan fixture (audit 2)
      'setInterval(() => {\n  // nothing\n}, 1000);', // keepalive-helper-ok: scan fixture (multi-line)
      'globalThis.setTimeout(() => {}, 60000);', // keepalive-helper-ok: scan fixture
      "globalThis['setInterval'](() => {}, 1000);", // keepalive-helper-ok: scan fixture (audit 4)
      'window["setTimeout"](() => {}, 1000);', // keepalive-helper-ok: scan fixture (audit 4)
      'timers()[`setInterval`](() => {}, 1000);', // keepalive-helper-ok: scan fixture (audit 4)
      '(setInterval)(() => {}, 1000);', // keepalive-helper-ok: scan fixture (audit 4)
      '((globalThis.setInterval))(() => {}, 1000);', // keepalive-helper-ok: scan fixture (audit 4)
      'globalThis?.setInterval(() => {}, 1000);', // keepalive-helper-ok: scan fixture
      'setTimeout(() => {}, 30000);', // keepalive-helper-ok: scan fixture
    ];
    for (const c of cases) expect(flagged(c), c).toEqual([1]);
  });
  it('flags idle timers inside child source handed over as strings and templates, nested too', () => {
    const cases = [
      "spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)']);", // keepalive-helper-ok: scan fixture
      "const s = `require('fs').writeFileSync(${p}, '1'); setTimeout(() => {}, 60000);`;", // keepalive-helper-ok: scan fixture
      "spawn(node, ['-e', \"require('child_process').spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'])\"]);", // keepalive-helper-ok: scan fixture (nested)
      'x("setInterval(() => {\\n}, 1000)");', // keepalive-helper-ok: scan fixture (escaped newline in generated source)
    ];
    for (const c of cases) expect(flagged(c), c).toEqual([1]);
  });
  it('leaves real work alone', () => {
    const cases = [
      'setInterval(() => tick(), 1000);',
      'setInterval((a, b) => { tick(a, b); }, 1000);',
      'setTimeout(() => process.exit(0), 30000);',
      'await new Promise((r) => setTimeout(r, 50));',
      "const msg = 'use setInterval for polling';",
      "obj['setIntervalX'](() => {}, 1000);",
      "x('node -e \\'setInterval(()=>{},1000)\\' is a bash string here');",
    ];
    for (const c of cases) expect(flagged(c), c).toEqual([]);
  });
  it('exempts only a real `// keepalive-helper-ok: <reason>` line comment attached to the call', () => {
    const idle = 'setInterval(()=>{},1000)'; // keepalive-helper-ok: scan fixture
    expect(flagged(`${idle}; // keepalive-helper-ok: fixture only, never spawned`)).toEqual([]);
    expect(flagged(`// keepalive-helper-ok: fixture only, never spawned\n${idle};`)).toEqual([]);
    expect(flagged(`spawn(n, [\n  '-e',\n  '${idle}', // keepalive-helper-ok: fixture only\n]);`)).toEqual([]);
    // no reason given
    expect(flagged(`${idle}; // keepalive-helper-ok:`)).toEqual([1]);
    // the marker inside a string, a template or a generated child source exempts nothing (audit 2)
    expect(flagged(`x('${idle} // keepalive-helper-ok: x');`)).toEqual([1]);
    expect(flagged('const source = `setInterval(()=>{},1000); // keepalive-helper-ok: x\n`;')).toEqual([1]); // keepalive-helper-ok: scan fixture
    // a block comment is not the exemption, and a comment on an unrelated earlier statement does not carry over
    expect(flagged(`${idle}; /* keepalive-helper-ok: x */`)).toEqual([1]);
    expect(flagged(`// keepalive-helper-ok: about the next line only\nfoo();\n${idle};`)).toEqual([3]);
    // the old line-suffix marker no longer exempts
    expect(flagged(`${idle}; // keepalive-guard: not-a-spawn`)).toEqual([1]);
  });
  it('an unparseable file is a finding (fail loud); the helper itself and non-JS files are not scanned', () => {
    expect(scan('setInterval(() => {}, 1000')).toMatchObject([{ reason: 'unparseable', line: 1 }]); // keepalive-helper-ok: scan fixture
    expect(scan('setInterval(() => {}, 1000);', 'scripts/lib/test-keepalive.mjs')).toEqual([]); // keepalive-helper-ok: scan fixture
    expect(scan('setInterval(() => {}, 1000);', 'scripts/notes.md')).toEqual([]); // keepalive-helper-ok: scan fixture
    expect(scan('const t: number = 1;\nsetInterval((): void => {}, 1000);', 'scripts/x.ts').map((f) => f.reason)).toEqual(['idle-timer']); // keepalive-helper-ok: scan fixture
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
