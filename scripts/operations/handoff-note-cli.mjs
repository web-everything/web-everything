#!/usr/bin/env node
import { openSync, writeSync, closeSync, fstatSync, readSync, constants } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { handoffHome } from './handoff-home.mjs';
import { handoffNoteOperation } from './handoff-note.mjs';
import { createRegistry } from './registry.mjs';
import { createMemoryRunStore } from './run-store.mjs';
import { runOperationCli } from './cli-adapter.mjs';

/** O_APPEND without O_CREAT refuses missing handoffs, including deletion races. */
export function appendHandoffNote({ line }, { dir = handoffHome() } = {}) {
  if (typeof line !== 'string' || /[\r\n]/.test(line)) throw new TypeError('handoff-note: expected one line');
  const fd = openSync(join(dir, 'handoff-webeverything.md'), constants.O_RDWR | constants.O_APPEND);
  try {
    const size = fstatSync(fd).size, last = Buffer.alloc(1);
    if (size) readSync(fd, last, 0, 1, size - 1);
    const separator = size && last[0] !== 10 ? '\n' : '';
    const bytes = Buffer.from(`${separator}${line}\n`);
    for (let offset = 0; offset < bytes.length;) {
      const count = writeSync(fd, bytes, offset, bytes.length - offset);
      if (!count) throw new Error('handoff-note: append made no progress');
      offset += count;
    }
  } finally { closeSync(fd); }
  return { appended: true };
}

export async function main(argv = process.argv.slice(2)) {
  const declaration = handoffNoteOperation(), registry = createRegistry(); registry.register(declaration);
  const result = await runOperationCli({ declaration, registry, argv, store: createMemoryRunStore(), newRunId: () => 'handoff-note',
    sinks: { 'handoff-note.append': (payload) => appendHandoffNote(payload) } });
  process.stdout.write(`${result.lines.join('\n')}\n`); process.exitCode = result.code;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { process.stderr.write(`${e.message}\n`); process.exitCode = 1; });
