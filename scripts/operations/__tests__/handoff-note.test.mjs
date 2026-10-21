import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planHandoffNote, handoffNoteOperation } from '../handoff-note.mjs';
import { appendHandoffNote } from '../handoff-note-cli.mjs';
import { createRegistry } from '../registry.mjs';
import { createMemoryRunStore } from '../run-store.mjs';
import { runOperationCli } from '../cli-adapter.mjs';

describe('handoff-note', () => {
  it.each([
    ['2026-01-15T15:04:00Z', '10:04'], ['2026-07-15T15:04:00Z', '11:04'],
    ['2026-03-08T06:59:00Z', '01:59'], ['2026-03-08T07:00:00Z', '03:00'],
    ['2026-11-01T05:59:00Z', '01:59'], ['2026-11-01T06:00:00Z', '01:00'],
    ['2026-07-15T04:00:00Z', '00:00'],
  ])('formats %s across DST as %s ET', (at, time) => {
    expect(planHandoffNote({ text: 'one\r\ntwo\n three', at }).line).toBe(`- ${time} ET: one two three`);
  });
  it.each(['', ' \n\t', null, undefined])('refuses empty text %s', (text) => {
    expect(() => planHandoffNote({ text, at: '2026-07-15T15:04:00Z' })).toThrow(/text/);
  });
  it.each(['invalid', '2026-07-15', '2026-07-15T15:04:00'])('refuses invalid or unzoned at %s', (at) => {
    expect(() => planHandoffNote({ text: 'note', at })).toThrow(/ISO/);
  });
  it('declares plan → write, defaults to injected now, and appends exactly one line through its sink', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'handoff-note-')), path = join(dir, 'handoff-webeverything.md');
    try {
      writeFileSync(path, 'existing\n');
      const declaration = handoffNoteOperation({ now: () => new Date('2026-07-15T15:04:00Z') });
      expect(declaration.steps.map((s) => [s.name, s.step.kind])).toEqual([['plan', 'compute'], ['write', 'effect']]);
      const registry = createRegistry(); registry.register(declaration);
      const result = await runOperationCli({ declaration, registry, argv: ['--text=hello\nworld'],
        store: createMemoryRunStore(), newRunId: () => 'handoff-note-test',
        sinks: { 'handoff-note.append': (payload) => appendHandoffNote(payload, { dir }) } });
      expect(result.code).toBe(0);
      expect(readFileSync(path, 'utf8')).toBe('existing\n- 11:04 ET: hello world\n');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it.each(['existing', 'existing\n', ''])('appends a separate note line to %j', (initial) => {
    const dir = mkdtempSync(join(tmpdir(), 'handoff-note-')), path = join(dir, 'handoff-webeverything.md');
    try {
      writeFileSync(path, initial);
      appendHandoffNote({ line: '- 10:00 ET: note' }, { dir });
      const prefix = initial && !initial.endsWith('\n') ? `${initial}\n` : initial;
      expect(readFileSync(path, 'utf8')).toBe(`${prefix}- 10:00 ET: note\n`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('refuses a missing handoff and multiline sink payloads', () => {
    const dir = mkdtempSync(join(tmpdir(), 'handoff-note-'));
    try {
      expect(() => appendHandoffNote({ line: '- 10:00 ET: note' }, { dir })).toThrow(/ENOENT/);
      expect(() => appendHandoffNote({ line: 'one\ntwo' }, { dir })).toThrow(/one line/);
      expect(() => readFileSync(join(dir, 'handoff-webeverything.md'))).toThrow(/ENOENT/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
