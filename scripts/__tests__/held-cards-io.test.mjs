import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { main } from '../held-cards-io.mjs';

const dirs = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function harness({ load = 1, fail = '', count = 1 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'held-cards-'));
  dirs.push(dir);
  fs.mkdirSync(path.join(dir, '.git'));
  const list = path.join(dir, 'cards.md'), state = path.join(dir, 'state.json');
  fs.writeFileSync(list, '1. **First.** scripts/lib/jury-core.mjs\n    More text\n2. **Second.** body\n');
  const calls = [], out = [], errors = [];
  let num = 4000;
  const deps = {
    env: { WE_HELD_CARDS_PATH: list, WE_HELD_CARDS_STATE: state },
    stdout: { write: s => out.push(s) }, stderr: { write: s => errors.push(s) },
    readFile: fs.readFileSync, writeFile: fs.writeFileSync,
    loadavg: () => [load], now: () => new Date('2026-10-05T18:40:00Z'),
    exec: (bin, args, options) => {
      calls.push({ bin, args, options });
      if (bin === 'gh') return JSON.stringify(Array.from({ length: count }, (_, i) => ({ number: i + 1 })));
      if (args.includes('acquire')) return `progress\n{"ignored":true}\n${JSON.stringify({ lane: 'lane-1', path: dir, holder: 'session-1' })}\n`;
      if (args.includes('file-item')) {
        if (fail === 'item' && args.includes('--title=First')) throw new Error('item failed');
        return JSON.stringify({ run: { verdict: { num: ++num, rel: `backlog/${num}.md` } } });
      }
      if (args.includes(fail)) throw new Error(`${fail} failed`);
      if (args.includes('open-pr')) {
        fs.appendFileSync(list, '3. **Concurrent addition.** keep me\n');
        return JSON.stringify({ run: { pr: { number: 4242 } } });
      }
      return '{}';
    },
  };
  return { dir, list, state, calls, out, errors, deps, run: args => main(args, deps),
    text: () => fs.readFileSync(list, 'utf8'), matching: arg => calls.filter(c => c.args.includes(arg)) };
}

describe('held cards CLI with isolated files and fake subprocesses', () => {
  it('adds with numbering and structured metadata, lists pending and all', async () => {
    const h = harness();
    expect(await h.run(['add', '--title=Third.', '--body=hello', '--size=5', '--scope=we:x.mjs', '--parent=3383'])).toBe(0);
    expect(h.text()).toContain('3. **Third.** hello\n    (held 2026-10-05 14:40 ET)');
    expect(h.text()).toContain('"scope":["we:x.mjs"]');
    expect(h.out.join('')).toContain('held as item 3');
    fs.appendFileSync(h.list, '4. **Done.** BUILT\n');
    await h.run(['list', '--json']);
    expect(JSON.parse(h.out.at(-1))).toHaveLength(3);
    await h.run(['list', '--all', '--json']);
    expect(JSON.parse(h.out.at(-1)).at(-1).doneReason).toBe('BUILT');
    expect(h.calls).toHaveLength(0);
  });
  it('keeps every card when several processes add at the same moment', async () => {
    const h = harness();
    // Each worker pauses between its read and its write, so unlocked writers would all read the same list.
    const driver = path.join(h.dir, 'slow-add.mjs');
    fs.writeFileSync(driver, `import fs from 'node:fs';
import { main } from ${JSON.stringify(path.resolve('scripts/held-cards-io.mjs'))};
const pause = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
const writeFile = (file, data, enc) => { if (String(file) === process.env.WE_HELD_CARDS_PATH) pause(); fs.writeFileSync(file, data, enc); };
process.exitCode = await main(['add', '--title=' + process.argv[2]], { writeFile });
`);
    const titles = ['Alpha.', 'Beta.', 'Gamma.', 'Delta.'];
    const codes = await Promise.all(titles.map(title => new Promise((resolve) => {
      const child = spawn(process.execPath, [driver, title], { env: { ...process.env, ...h.deps.env }, stdio: 'ignore' });
      child.on('exit', resolve);
    })));
    expect(codes).toEqual([0, 0, 0, 0]);
    const numbers = [...h.text().matchAll(/^(\d+)\. \*\*(\w+)\./gm)].map(m => [Number(m[1]), m[2]]);
    expect(numbers.map(([, title]) => title).sort()).toEqual(['Alpha', 'Beta', 'Delta', 'First', 'Gamma', 'Second']);
    expect(new Set(numbers.map(([num]) => num)).size).toBe(6);
    expect(fs.existsSync(`${h.list}.lock`)).toBe(false);
  }, 20000);
  it('saves status and detects growth on the next observation', async () => {
    const h = harness();
    expect(await h.run(['status'])).toBe(0);
    expect(h.out.join('')).toContain('QUIET — ok to file 2 held cards');
    expect(JSON.parse(fs.readFileSync(h.state)).openPrs).toBe(2);
    fs.writeFileSync(h.state, JSON.stringify({ openPrs: 1 }));
    expect(await h.run(['status', '--json'])).toBe(1);
    expect(JSON.parse(h.out.at(-1)).reasons).toContain('PR queue grew 1 → 2');
    expect(await h.run(['status'])).toBe(0);
    const busy = harness({ load: 30 });
    expect(await busy.run(['status'])).toBe(1);
    expect(busy.out.join('')).toContain('load 30 ≥ 15');
  });
  it('does not mutate or acquire on busy filing and does not exec for dry run', async () => {
    const h = harness({ load: 30 });
    const before = h.text();
    expect(await h.run(['file'])).toBe(1);
    expect(h.calls.every(c => c.bin === 'gh')).toBe(true);
    expect(fs.existsSync(h.state)).toBe(false);
    expect(h.text()).toBe(before);
    h.calls.length = 0;
    expect(await h.run(['file', '--dry-run', '--json'])).toBe(0);
    expect(JSON.parse(h.out.at(-1))).toHaveLength(2);
    expect(h.calls).toHaveLength(0);
    expect(h.text()).toBe(before);
  });
  it('files in one lane and PR, releases, and preserves concurrent additions', async () => {
    const h = harness();
    expect(await h.run(['file', `--repo-root=${h.dir}`])).toBe(0);
    for (const arg of ['acquire', 'commit', 'verify', 'open-pr', 'release']) expect(h.matching(arg)).toHaveLength(1);
    expect(h.matching('file-item')).toHaveLength(2);
    expect(h.matching('file-item').every(c => c.options.cwd === h.dir)).toBe(true);
    expect(h.matching('commit')[0].args.slice(-3)).toEqual(['--', 'backlog/4001.md', 'backlog/4002.md']);
    expect(h.matching('release')[0].args).toContain('--session=session-1');
    expect(h.text().match(/FILED .*PR #4242/g)).toHaveLength(2);
    expect(h.text()).toContain('3. **Concurrent addition.** keep me\n');
    const bodyArg = h.matching('open-pr')[0].args.find(a => a.startsWith('--bodyFile='));
    expect(fs.readFileSync(bodyArg.slice(11), 'utf8')).toContain('Held item 1 → 4001: First');
  });
  it('refuses a second filing run while one is in progress, so no card is filed twice', async () => {
    const h = harness();
    let nested, started = false;
    const exec = h.deps.exec;
    h.deps.exec = (bin, args, options) => {
      // Start the second run while the first is between planning and marking FILED.
      if (args.includes('file-item') && !started) {
        started = true;
        nested = h.run(['file', '--blocking', `--repo-root=${h.dir}`]);
      }
      return exec(bin, args, options);
    };
    expect(await h.run(['file', '--blocking', `--repo-root=${h.dir}`])).toBe(0);
    expect(await nested).toBe(1);
    expect(h.errors.join('')).toContain('another held-cards filing run is in progress');
    for (const arg of ['acquire', 'commit', 'open-pr', 'release']) expect(h.matching(arg)).toHaveLength(1);
    expect(h.matching('file-item')).toHaveLength(2);
    expect(h.text().match(/FILED/g)).toHaveLength(2);
    expect(fs.existsSync(`${h.list}.filing.lock`)).toBe(false);
  });
  it('stops and still releases its lane when its filing lock was taken over mid-run', async () => {
    const h = harness();
    const exec = h.deps.exec;
    h.deps.exec = (bin, args, options) => {
      if (args.includes('file-item') && args.includes('--title=First')) {
        // Another run reclaimed the lock as stale and took it: a different owner now holds the lock path.
        const lock = `${h.list}.filing.lock`;
        fs.rmSync(lock, { recursive: true });
        fs.mkdirSync(lock);
        fs.writeFileSync(path.join(lock, 'owner'), JSON.stringify({ nonce: 'someone-else', pid: 1, host: 'other' }));
      }
      return exec(bin, args, options);
    };
    // Linux reuses a freed inode number, so pin it: the takeover must be caught by the owner token, never the inode.
    const realStat = fs.statSync;
    const spy = vi.spyOn(fs, 'statSync').mockImplementation((p, ...rest) => {
      const st = realStat(p, ...rest);
      return String(p) === `${h.list}.filing.lock` && st ? Object.assign(Object.create(Object.getPrototypeOf(st)), st, { ino: 424242 }) : st;
    });
    const before = h.text();
    try { expect(await h.run(['file', '--blocking'])).toBe(1); } finally { spy.mockRestore(); }
    expect(h.errors.join('')).toContain('lost');
    expect(h.matching('open-pr')).toHaveLength(0);
    expect(h.matching('release')).toHaveLength(1);
    expect(h.text()).toBe(before);
    // The first run's release must leave the second owner's lock standing.
    expect(fs.existsSync(`${h.list}.filing.lock`)).toBe(true);
    fs.rmSync(`${h.list}.filing.lock`, { recursive: true });
  });
  it('files each held card once when several processes run file at the same moment', async () => {
    const h = harness();
    const log = path.join(h.dir, 'calls.log');
    const driver = path.join(h.dir, 'slow-file.mjs');
    fs.writeFileSync(driver, `import fs from 'node:fs';
import { main } from ${JSON.stringify(path.resolve('scripts/held-cards-io.mjs'))};
const pause = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
const note = (what) => fs.appendFileSync(process.env.CALLS_LOG, what + '\\n');
const exec = (bin, args) => {
  if (args.includes('acquire')) return JSON.stringify({ lane: 'lane-1', path: process.env.LANE_DIR, holder: 'session-' + process.pid });
  if (args.includes('file-item')) { pause(); note('file-item'); return JSON.stringify({ verdict: { num: 5000 + process.pid, rel: 'backlog/' + process.pid + '.md' } }); }
  if (args.includes('open-pr')) { note('open-pr'); return JSON.stringify({ number: 4300 }); }
  return '{}';
};
process.exitCode = await main(['file', '--blocking'], { exec });
`);
    const env = { ...process.env, ...h.deps.env, CALLS_LOG: log, LANE_DIR: h.dir };
    const codes = await Promise.all([0, 1, 2].map(() => new Promise((resolve) => {
      const child = spawn(process.execPath, [driver], { env, stdio: 'ignore' });
      child.on('exit', resolve);
    })));
    // One run files both cards and the rest back off (1) or find nothing left (0); never a second filing.
    expect(codes.filter(code => code === 0).length).toBeGreaterThanOrEqual(1);
    const calls = fs.readFileSync(log, 'utf8').trim().split('\n');
    expect(calls.filter(call => call === 'file-item')).toHaveLength(2);
    expect(calls.filter(call => call === 'open-pr')).toHaveLength(1);
    expect(h.text().match(/FILED/g)).toHaveLength(2);
    expect(fs.existsSync(`${h.list}.filing.lock`)).toBe(false);
  }, 30000);
  it('continues after an item failure and leaves that item unmarked', async () => {
    const h = harness({ fail: 'item' });
    expect(await h.run(['file', '--blocking'])).toBe(0);
    expect(h.calls.some(c => c.bin === 'gh')).toBe(false);
    expect(h.text().split('\n')[0]).not.toContain('FILED');
    expect(h.text()).toContain('2. **Second.** body — **FILED');
    expect(h.errors.join('')).toContain('NOT FILED 1');
    expect(h.matching('release')).toHaveLength(1);
  });
  it.each(['open-pr', 'verify', 'file-item'])('releases and marks nothing on %s failure', async fail => {
    const h = harness({ fail });
    // Fail every item, as distinct from the single-item failure fixture.
    if (fail === 'file-item') {
      const exec = h.deps.exec;
      h.deps.exec = (bin, args, options) => {
        if (args.includes('file-item')) throw new Error('all items failed');
        return exec(bin, args, options);
      };
    }
    const before = h.text();
    expect(await h.run(['file'])).toBe(1);
    expect(h.text()).toBe(before);
    expect(h.matching('release')).toHaveLength(1);
    if (fail === 'verify') expect(h.matching('open-pr')).toHaveLength(0);
  });
  // A lane we do hold (lane + holder) is still released; one we cannot name is not.
  it.each([[{}, 0], [{ lane: 'lane-1', path: '/x' }, 0], [{ holder: 'session-1', path: '/x' }, 0], [{ lane: 'lane-1', holder: 'session-1' }, 1]])(
    'reports the real cause on a malformed lane acquisition %j', async (acquired, releases) => {
      const h = harness();
      const exec = h.deps.exec;
      h.deps.exec = (bin, args, options) => {
        if (args.includes('acquire')) { h.calls.push({ bin, args, options }); return JSON.stringify(acquired); }
        // The real lane-pool refuses a release with no lane/session, which is what masked the cause.
        if (args.includes('release') && args.some(a => a.endsWith('=undefined'))) throw new Error('release: --lane is required');
        return exec(bin, args, options);
      };
      const before = h.text();
      expect(await h.run(['file', '--blocking'])).toBe(1);
      expect(h.errors.join('')).toContain('invalid lane acquisition result');
      expect(h.errors.join('')).not.toContain('release');
      expect(h.matching('release')).toHaveLength(releases);
      expect(h.text()).toBe(before);
    });
  it('still releases a well-formed lane when filing fails', async () => {
    const h = harness({ fail: 'verify' });
    expect(await h.run(['file', '--blocking'])).toBe(1);
    expect(h.matching('release')).toHaveLength(1);
  });
  it('does nothing when all cards are done', async () => {
    const h = harness();
    fs.writeFileSync(h.list, '1. **Done.** BUILT\n');
    expect(await h.run(['file'])).toBe(0);
    expect(h.calls).toHaveLength(0);
    expect(h.out.join('')).toContain('nothing to file');
  });
});
