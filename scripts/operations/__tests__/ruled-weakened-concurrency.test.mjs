/** Deterministic process interleaving: an append waits across pruning's snapshot and replacement. */
import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout, clearTimeout } from 'node:timers';
import { readStore, rewriteStore } from '../ruled-weakened-store.mjs';

const sha = 'a'.repeat(40);
const origin = 'https://example.test/team/a.git';
const repository = createHash('sha256').update(origin).digest('hex');
const entry = ref => ({ ref, sha, ruling: 'R12', findings: ['finding'], actor: 'operator', quote: 'approved', at: '2026-11-19T12:00:00Z', repository });
let root;
afterEach(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); });

it('an operator append during pruning waits for replacement and survives compaction', async () => {
  root = fs.mkdtempSync(join(process.env.TMPDIR, 'waiver-concurrency-'));
  const path = join(root, 'store.jsonl');
  rewriteStore({ entries: [entry('gone'), entry('current')], path });
  const processes = [];
  const child = code => {
    const proc = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['pipe', 'ignore', 'pipe', 'ipc'] });
    processes.push(proc);
    let stderr = '';
    proc.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8192); });
    const exited = once(proc, 'exit').then(([code]) => ({ code, stderr }));
    return { proc, exited };
  };
  const message = async ({ proc, exited }, expected) => {
    let timer;
    try {
      const [value] = await Promise.race([
        once(proc, 'message'),
        exited.then(result => { throw Error(`Child exited before ${expected}: ${result.stderr}`); }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(Error(`Timed out waiting for ${expected}`)), 5000); }),
      ]);
      expect(value).toBe(expected);
    } finally { clearTimeout(timer); }
  };
  let unblock;
  try {
    const pruner = child(`
      import fs from 'node:fs';
      import { pruneStore } from ${JSON.stringify(pathToFileURL(resolve('scripts/operations/ruled-weakened-prune.mjs')).href)};
      pruneStore({ path: ${JSON.stringify(path)}, log: () => {}, exec: (_cmd, args) => {
        if (args.includes('get-url')) return { status: 0, stdout: ${JSON.stringify(origin)} };
        if (args.includes('ls-remote')) {
          process.send('snapshot-read');
          fs.readSync(0, Buffer.alloc(1), 0, 1, null);
          return { status: 0, stdout: ${JSON.stringify(sha + '\trefs/heads/current\n')} };
        }
        return { status: 1 };
      } });
    `);
    unblock = () => { if (!pruner.proc.stdin.destroyed && !pruner.proc.stdin.writableEnded) pruner.proc.stdin.end('!'); };
    await message(pruner, 'snapshot-read');
    const writer = child(`
      import fs from 'node:fs';
      import { appendEntry } from ${JSON.stringify(pathToFileURL(resolve('scripts/operations/ruled-weakened-store.mjs')).href)};
      let notified = false;
      appendEntry(${JSON.stringify(entry('new'))}, { path: ${JSON.stringify(path)}, lockOptions: {
        waitMs: 5000, io: { renameSync: (from, to) => {
          try { return fs.renameSync(from, to); }
          catch (error) {
            if (['EEXIST', 'ENOTEMPTY'].includes(error.code) && !notified) { notified = true; process.send('append-blocked'); }
            throw error;
          }
        } },
      } });
    `);
    await message(writer, 'append-blocked');
    expect(readStore({ path }).entries.map(e => e.ref)).toEqual(['gone', 'current']);
    unblock();
    for (const result of await Promise.all([pruner.exited, writer.exited])) expect(result.code, result.stderr).toBe(0);
    expect(readStore({ path }).entries.map(e => e.ref)).toEqual(['current', 'new']);
    expect(fs.readdirSync(root)).toEqual(['store.jsonl']);
  } finally {
    unblock?.();
    await Promise.all(processes.map(async proc => {
      if (proc.exitCode === null && proc.signalCode === null) { const exited = once(proc, 'exit'); proc.kill(); await exited; }
    }));
  }
}, 10000);
