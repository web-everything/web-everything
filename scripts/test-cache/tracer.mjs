/**
 * @file scripts/test-cache/tracer.mjs
 * @description prepare-124 S3 — the shadow-only runtime tracer. `installTracer` wraps the `node:fs` read/list/stat
 * functions, the `node:child_process` spawn functions and `net.Socket#connect`, then calls
 * `module.syncBuiltinESMExports()` so a named import (`import { readFileSync } from 'node:fs'`) sees the wrapper too
 * (the missing step in the setup-file attempt noted in vitest.setup.ts). Every wrapper records and then calls the
 * original with the original arguments: the tracer never changes what a test does, with ONE exception that is the whole
 * point for subprocesses — it adds `--import <child-tracer>` to the child's NODE_OPTIONS (when `childTrace` is given) so
 * `node` children report the files and modules they load.
 *
 * Recording never throws and never touches the fs itself. Events are deduplicated and capped.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import cp from 'node:child_process';
import net from 'node:net';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { buildSpawnArgs, describeSpawn, parseSpawnArgs } from '../lib/test-cache-trace.mjs';

const FS_OPS = {
  readFileSync: 'read', readFile: 'read', createReadStream: 'read',
  readdirSync: 'list', readdir: 'list', opendirSync: 'list', opendir: 'list',
  statSync: 'stat', lstatSync: 'stat', stat: 'stat', lstat: 'stat', accessSync: 'stat', access: 'stat', readlinkSync: 'stat',
  existsSync: 'exists', openSync: 'read', open: 'read',
};
const SPAWNS = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'];

/** A deduplicating, capped event recorder. */
export function createRecorder({ cap = 20000 } = {}) {
  const seen = new Set();
  const events = [];
  return {
    record(ev) {
      try {
        if (events.length >= cap) return;
        const key = ev.k === 'spawn' ? `${ev.kind}|${ev.cmd}|${ev.cwd}|${ev.args.join('\u0001')}` : `${ev.k}|${ev.p ?? `${ev.host}:${ev.port}${ev.path ?? ''}`}`;
        if (seen.has(key)) return;
        seen.add(key);
        events.push(ev);
      } catch { /* the tracer never breaks a test */ }
    },
    events: () => events.slice(),
  };
}

function toPath(arg) {
  if (typeof arg === 'string') return arg.startsWith('file:') ? fileURLToPath(arg) : resolve(arg);
  if (arg instanceof URL) return fileURLToPath(arg);
  if (Buffer.isBuffer(arg)) return resolve(arg.toString());
  return null;
}

const isWriteFlag = (flags) => typeof flags === 'string' ? !/^r(?!\+)/.test(flags) : typeof flags === 'number' && (flags & 3) !== 0;

function copyProps(from, to) {
  for (const k of Reflect.ownKeys(from)) {
    if (k === 'length' || k === 'name' || k === 'prototype') continue;
    try { Object.defineProperty(to, k, Object.getOwnPropertyDescriptor(from, k)); } catch { /* best effort */ }
  }
}

/**
 * Install the wrappers.
 * @param {{record: (ev: object) => void, childTrace?: {traceFile: string, importUrl: string}}} opts
 * @returns {() => void} uninstall (restores every original and re-syncs the ESM exports)
 */
export function installTracer({ record, childTrace } = {}) {
  const restore = [];
  const patch = (obj, name, make) => {
    const orig = obj[name];
    if (typeof orig !== 'function') return;
    const wrapped = make(orig);
    copyProps(orig, wrapped);
    obj[name] = wrapped;
    restore.push(() => { obj[name] = orig; });
  };

  for (const [name, op] of Object.entries(FS_OPS)) {
    for (const target of [fs, fsp]) {
      patch(target, name, (orig) => function tracedFs(...a) {
        try {
          if ((name === 'openSync' || name === 'open') && isWriteFlag(a[1])) return orig.apply(this, a);
          const p = toPath(a[0]);
          if (p) record({ k: op, p });
        } catch { /* ignore */ }
        return orig.apply(this, a);
      });
    }
  }

  for (const kind of SPAWNS) {
    patch(cp, kind, (orig) => function tracedSpawn(...a) {
      let args = a;
      try {
        const parsed = parseSpawnArgs(kind, a);
        record(describeSpawn(kind, parsed, { execPath: process.execPath, cwd: process.cwd() }));
        if (childTrace) {
          const env = parsed.options.env ?? process.env;
          const flag = `--import ${childTrace.importUrl}`;
          if (!String(env.NODE_OPTIONS ?? '').includes(childTrace.importUrl)) {
            parsed.options = { ...parsed.options, env: { ...env, NODE_OPTIONS: [env.NODE_OPTIONS, flag].filter(Boolean).join(' '), WE_TRACE_FILE: childTrace.traceFile } };
            args = buildSpawnArgs(kind, parsed);
          }
        }
      } catch { args = a; }
      return orig.apply(this, args);
    });
  }

  patch(net.Socket.prototype, 'connect', (orig) => function tracedConnect(...a) {
    try {
      const o = a[0];
      if (o && typeof o === 'object' && !Array.isArray(o)) record(o.path ? { k: 'net', path: String(o.path) } : { k: 'net', host: o.host ?? 'localhost', port: o.port });
      else if (typeof o === 'number' || (typeof o === 'string' && /^\d+$/.test(o))) record({ k: 'net', host: typeof a[1] === 'string' ? a[1] : 'localhost', port: Number(o) });
      else if (typeof o === 'string') record({ k: 'net', path: o });
    } catch { /* ignore */ }
    return orig.apply(this, a);
  });

  syncBuiltinESMExports();
  return () => {
    while (restore.length) restore.pop()();
    syncBuiltinESMExports();
  };
}
